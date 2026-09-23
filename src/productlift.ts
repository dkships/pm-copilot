const PAGE_DELAY_MS = 250;
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 10; // API max per request
// Backstop against an endpoint that keeps reporting hasMore: 500 pages is
// 5,000 posts, far beyond any real portal.
const MAX_PAGES = 500;
const MAX_429_RETRIES = 3;
const RETRY_BACKOFF_MS = 2_000;
// A Retry-After beyond this fails fast rather than hanging the tool call.
const MAX_RETRY_WAIT_MS = 30_000;
// The raw post list doesn't depend on any tool parameter (date and vote
// filtering run client-side), so one download serves every call for a while.
const POSTS_CACHE_TTL_MS = 5 * 60 * 1000;
const HTTP_TOO_MANY_REQUESTS = 429;

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

export interface FetchPostsOptions {
  maxPages?: number;
  pageDelayMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    const allPosts: PostSummary[] = [];
    let skip = 0;

    for (let pageNum = 1; ; pageNum++) {
      if (pageNum > maxPages) {
        throw new Error(
          `ProductLift portal "${this.portal.name}" returned more than ${maxPages} pages; stopped paging`
        );
      }

      const page = await this.apiGet<PaginatedResponse<PostSummary>>(
        "/api/v1/posts",
        { skip: String(skip), limit: String(PAGE_SIZE) }
      );

      // A 200 with no data array (an error body) must fail the portal, not
      // end paging early and get cached as the full list.
      if (!Array.isArray(page.data)) {
        throw new Error(
          `ProductLift portal "${this.portal.name}" returned a malformed page at skip=${skip}`
        );
      }
      const data = page.data;
      allPosts.push(...data);

      if (!page.hasMore || data.length === 0) {
        break;
      }

      skip += data.length;
      await sleep(pageDelayMs);
    }

    this.postsCache = { posts: allPosts, fetchedAt: Date.now() };
    return allPosts;
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

  async fetchFeatureRequests(
    includeComments: boolean,
    statusFilter?: string
  ): Promise<FeatureRequestsResult> {
    let posts = await this.fetchPosts();

    // Filter by status BEFORE the comment-fetch loop so filtered-out posts
    // cost no comment API calls. Matches the formatted-status semantics:
    // status name compared case-insensitively, null-status posts excluded.
    if (statusFilter !== undefined) {
      posts = posts.filter(
        (p) => p.status?.name?.toLowerCase() === statusFilter.toLowerCase()
      );
    }

    const requests: FeatureRequest[] = [];
    let commentFailures = 0;

    for (const post of posts) {
      let comments: Comment[] = [];
      // A post that reports zero comments costs no call; a missing count
      // still fetches.
      const mayHaveComments = (post.comments_count ?? 1) > 0;
      if (includeComments && mayHaveComments) {
        await sleep(PAGE_DELAY_MS);
        try {
          comments = await this.fetchComments(post.id);
        } catch {
          // Returned without comments, and counted so the caller can warn.
          commentFailures++;
        }
      }

      requests.push({
        ...post,
        comments,
        portal: this.portal.name,
      });
    }

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
