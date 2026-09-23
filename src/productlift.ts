const PAGE_DELAY_MS = 250;
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 10; // API max per request
// Backstop against an endpoint that keeps reporting hasMore: 500 pages is
// 5,000 posts, far beyond any real portal.
const MAX_PAGES = 500;
const MAX_429_RETRIES = 3;
const RETRY_BACKOFF_MS = 2_000;
// ProductLift allows 120 requests per 60s window (x-ratelimit-limit) and
// asks for up to the rest of the window on a 429. Longer than one window
// means something is off: fail fast rather than hang the tool call.
const MAX_RETRY_WAIT_MS = 60_000;
// The raw post list doesn't depend on any tool parameter (date and vote
// filtering run client-side), so one download serves every call for a while.
const POSTS_CACHE_TTL_MS = 5 * 60 * 1000;
const HTTP_TOO_MANY_REQUESTS = 429;
// Requests in flight per portal, for both post pages and comments. Sequential
// fetching took 33s to page a 544-post portal and pushed an analysis with
// comments past the 60s MCP client timeout. 429s are retried if this runs
// into the portal's rate limit.
const REQUEST_CONCURRENCY = 6;

export interface PortalConfig {
  name: string;
  baseUrl: string; // e.g. https://roadmap.example.com
  apiKey: string;
}

export interface PostSummary {
  id: string;
  title: string;
  description: string;
  status?: { id: number; name: string; color: string } | null;
  category?: { id: number; name: string; color: string } | null;
  votes_count?: number;
  comments_count?: number;
  created_at: string;
  updated_at: string;
  url?: string;
}

export interface Comment {
  id: string | number;
  comment: string;
  author: {
    id: string;
    name: string;
    role: string;
  };
  pinned_to_top: boolean;
  tagged_for_changelog: boolean;
  parent_id: string | null;
  created_at: string | null;
  updated_at: string | null;
  url: string;
}

// ProductLift API paginated response (skip/limit style)
interface PaginatedResponse<T> {
  data: T[];
  hasMore: boolean;
  total: number;
  skip: number;
  limit: number;
}

// Simple response (non-paginated)
interface DataResponse<T> {
  data: T;
}

export interface FeatureRequest extends PostSummary {
  comments: Comment[];
  portal: string;
}

export interface FeatureRequestsResult {
  requests: FeatureRequest[];
  // Posts whose comments could not be fetched; they are returned with none.
  commentFailures: number;
}

export type FeatureSort = "votes" | "recent";

export interface FeatureRequestOptions {
  includeComments?: boolean;
  // Case-insensitive status name; null-status posts never match.
  status?: string;
  // Posts to keep after the status filter and sort, per portal.
  limit?: number;
  // Omitted keeps the API's order.
  sort?: FeatureSort;
}

export interface FetchPostsOptions {
  maxPages?: number;
  pageDelayMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Map over items with at most `limit` calls in flight; results keep input order. */
async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  // Each worker claims the next unclaimed item until none are left.
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

export class ProductLiftClient {
  private portal: PortalConfig;
  private postsCache: { posts: PostSummary[]; fetchedAt: number } | null = null;

  constructor(portal: PortalConfig) {
    this.portal = portal;
  }

  get portalName(): string {
    return this.portal.name;
  }

  static filterRecent(posts: PostSummary[], sinceDaysAgo: number): PostSummary[] {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - sinceDaysAgo);
    // An unparseable created_at fails the >= comparison and is excluded — fails safe.
    return posts.filter((p) => new Date(p.created_at) >= cutoff);
  }

  static sortByVotes(posts: PostSummary[], limit: number): PostSummary[] {
    return [...posts]
      .sort((a, b) => (b.votes_count ?? 0) - (a.votes_count ?? 0))
      .slice(0, limit);
  }

  static sortByRecency(posts: PostSummary[], limit: number): PostSummary[] {
    // An unparseable created_at sorts last rather than poisoning the order.
    const createdMs = (p: PostSummary) => {
      const ms = new Date(p.created_at).getTime();
      return Number.isFinite(ms) ? ms : -Infinity;
    };
    return [...posts].sort((a, b) => createdMs(b) - createdMs(a)).slice(0, limit);
  }

  private async apiGet<T>(
    path: string,
    params?: Record<string, string>,
    retryCount = 0
  ): Promise<T> {
    const url = new URL(`${this.portal.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.portal.apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    // Honour Retry-After when present, otherwise back off exponentially.
    if (res.status === HTTP_TOO_MANY_REQUESTS && retryCount < MAX_429_RETRIES) {
      const retryAfterSecs = Number(res.headers.get("retry-after"));
      const waitMs =
        Number.isFinite(retryAfterSecs) && retryAfterSecs > 0
          ? retryAfterSecs * 1000
          : RETRY_BACKOFF_MS * 2 ** retryCount;
      if (waitMs > MAX_RETRY_WAIT_MS) {
        throw new Error(
          `ProductLift rate limit for ${this.portal.name}: asked to wait ${Math.round(waitMs / 1000)}s`
        );
      }
      await sleep(waitMs);
      return this.apiGet(path, params, retryCount + 1);
    }

    if (res.status === 401 || res.status === 403) {
      const text = await res.text();
      throw new Error(
        `ProductLift auth failed (${res.status}) for portal "${this.portal.name}": ` +
        `Check API key in .env. ${text}`
      );
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `ProductLift API error (${res.status}) for ${this.portal.name} on ${path}: ${text}`
      );
    }

    return (await res.json()) as T;
  }

  async fetchPosts(options: FetchPostsOptions = {}): Promise<PostSummary[]> {
    if (this.postsCache && Date.now() - this.postsCache.fetchedAt < POSTS_CACHE_TTL_MS) {
      return this.postsCache.posts;
    }

    const maxPages = options.maxPages ?? MAX_PAGES;
    const pageDelayMs = options.pageDelayMs ?? PAGE_DELAY_MS;

    // The first page reports the total, so the rest can be fetched in
    // parallel by skip offset:
    //
    //   page 1 (skip 0) ──> total = 35, page size = 10
    //   skip 10 ┐
    //   skip 20 ├─ REQUEST_CONCURRENCY at a time
    //   skip 30 ┘
    //   last page still says hasMore? ──> continue one page at a time
    const first = await this.fetchPostsPage(0);
    const pages: PaginatedResponse<PostSummary>[] = [first];
    const pageSize = first.data.length;

    if (first.hasMore && pageSize > 0 && Number.isFinite(first.total)) {
      const skips: number[] = [];
      for (let skip = pageSize; skip < first.total; skip += pageSize) {
        skips.push(skip);
      }
      if (skips.length + 1 > maxPages) {
        throw this.tooManyPages(maxPages);
      }
      pages.push(
        ...(await mapConcurrent(skips, REQUEST_CONCURRENCY, async (skip) => {
          await sleep(pageDelayMs);
          return this.fetchPostsPage(skip);
        }))
      );
    }

    // Sequential tail: covers a missing total, and posts added after page 1.
    let last = pages[pages.length - 1] ?? first;
    let skip = pages.reduce((sum, p) => sum + p.data.length, 0);
    while (last.hasMore && last.data.length > 0) {
      if (pages.length >= maxPages) {
        throw this.tooManyPages(maxPages);
      }
      await sleep(pageDelayMs);
      last = await this.fetchPostsPage(skip);
      pages.push(last);
      skip += last.data.length;
    }

    // Offsets can shift if a post is added or removed mid-fetch; keep the
    // first copy of each id.
    const seen = new Set<string>();
    const allPosts = pages
      .flatMap((p) => p.data)
      .filter((post) => {
        if (seen.has(post.id)) {
          return false;
        }
        seen.add(post.id);
        return true;
      });

    this.postsCache = { posts: allPosts, fetchedAt: Date.now() };
    return allPosts;
  }

  private async fetchPostsPage(skip: number): Promise<PaginatedResponse<PostSummary>> {
    const page = await this.apiGet<PaginatedResponse<PostSummary>>("/api/v1/posts", {
      skip: String(skip),
      limit: String(PAGE_SIZE),
    });

    // A 200 with no data array (an error body) must fail the portal, not end
    // paging early and get cached as the full list.
    if (!Array.isArray(page.data)) {
      throw new Error(
        `ProductLift portal "${this.portal.name}" returned a malformed page at skip=${skip}`
      );
    }
    return page;
  }

  private tooManyPages(maxPages: number): Error {
    return new Error(
      `ProductLift portal "${this.portal.name}" returned more than ${maxPages} pages; stopped paging`
    );
  }

  async fetchComments(postId: string): Promise<Comment[]> {
    const res = await this.apiGet<DataResponse<Comment[]> | PaginatedResponse<Comment>>(
      `/api/v1/posts/${postId}/comments`
    );
    if (Array.isArray(res.data)) {
      return res.data;
    }
    return res.data ? [res.data] : [];
  }

  async fetchFeatureRequests(options: FeatureRequestOptions): Promise<FeatureRequestsResult> {
    let posts = await this.fetchPosts();

    // Filter, sort and limit BEFORE the comment-fetch loop so dropped posts
    // cost no comment API calls. Status matches the formatted-status
    // semantics: name compared case-insensitively, null-status posts excluded.
    const { status } = options;
    if (status !== undefined) {
      posts = posts.filter((p) => p.status?.name?.toLowerCase() === status.toLowerCase());
    }

    const limit = options.limit ?? posts.length;
    if (options.sort === "votes") {
      posts = ProductLiftClient.sortByVotes(posts, limit);
    } else if (options.sort === "recent") {
      posts = ProductLiftClient.sortByRecency(posts, limit);
    } else {
      posts = posts.slice(0, limit);
    }

    if (options.includeComments) {
      return this.withComments(posts);
    }
    return {
      requests: posts.map((post) => ({ ...post, comments: [], portal: this.portal.name })),
      commentFailures: 0,
    };
  }

  /**
   * Fetch comments for the given posts, one call each, REQUEST_CONCURRENCY at
   * a time, with results in the input order. A post that reports zero comments
   * costs no call; a missing count still fetches. A failed fetch returns the
   * post without comments and is counted so the caller can warn.
   */
  async withComments(posts: PostSummary[]): Promise<FeatureRequestsResult> {
    let commentFailures = 0;

    const requests = await mapConcurrent(posts, REQUEST_CONCURRENCY, async (post) => {
      let comments: Comment[] = [];
      const mayHaveComments = (post.comments_count ?? 1) > 0;
      if (mayHaveComments) {
        await sleep(PAGE_DELAY_MS);
        try {
          comments = await this.fetchComments(post.id);
        } catch {
          commentFailures++;
        }
      }
      return { ...post, comments, portal: this.portal.name };
    });

    return { requests, commentFailures };
  }
}

/**
 * Parse portal configs from environment variables.
 * Format: PRODUCTLIFT_PORTALS="name1|url1|key1,name2|url2|key2"
 * Or single portal: PRODUCTLIFT_PORTAL_URL + PRODUCTLIFT_API_KEY + PRODUCTLIFT_PORTAL_NAME
 */
export function parsePortalConfigs(): PortalConfig[] {
  const portals = process.env.PRODUCTLIFT_PORTALS;
  if (portals) {
    return portals.split(",").map((entry, index) => {
      const parts = entry.trim().split("|");
      const name = parts[0]?.trim();
      const baseUrl = parts[1]?.trim();
      const apiKey = parts.slice(2).join("|").trim(); // rejoin — tokens may contain |
      if (!name || !baseUrl || !apiKey) {
        // Never echo any part of the entry: it holds the API key (a key-only
        // entry would even parse as the name), and this message is surfaced
        // in tool descriptions and list_sources.
        throw new Error(
          `Invalid PRODUCTLIFT_PORTALS format in entry ${index + 1}. ` +
            'Expected "name|url|key" per entry.'
        );
      }
      return { name, baseUrl: baseUrl.replace(/\/$/, ""), apiKey };
    });
  }

  // Fall back to single portal config
  const url = process.env.PRODUCTLIFT_PORTAL_URL;
  const key = process.env.PRODUCTLIFT_API_KEY;
  const name = process.env.PRODUCTLIFT_PORTAL_NAME ?? "default";

  if (url && key) {
    return [{ name, baseUrl: url.replace(/\/$/, ""), apiKey: key }];
  }

  return [];
}
