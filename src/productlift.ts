const PAGE_DELAY_MS = 250;
const REQUEST_TIMEOUT_MS = 30_000;

export interface PortalConfig {
  name: string;
  baseUrl: string; // e.g. https://roadmap.tidycal.com
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

interface Status {
  id: number;
  name: string;
  color: string;
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

export class ProductLiftClient {
  private portal: PortalConfig;

  constructor(portal: PortalConfig) {
    this.portal = portal;
  }

  static filterRecent(posts: PostSummary[], sinceDaysAgo: number): PostSummary[] {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - sinceDaysAgo);
    return posts.filter((p) => new Date(p.created_at) >= cutoff);
  }

  static sortByVotes(posts: PostSummary[], limit: number): PostSummary[] {
    return [...posts]
      .sort((a, b) => (b.votes_count ?? 0) - (a.votes_count ?? 0))
      .slice(0, limit);
  }

  private async apiGet<T>(path: string, params?: Record<string, string>): Promise<T> {
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

  async fetchStatuses(): Promise<Status[]> {
    const res = await this.apiGet<DataResponse<Status[]> | PaginatedResponse<Status>>(
      "/api/v1/statuses"
    );
    return Array.isArray(res.data) ? res.data : [res.data];
  }

  async fetchPosts(): Promise<PostSummary[]> {
    const allPosts: PostSummary[] = [];
    let skip = 0;
    const limit = 10; // API max per request

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const page = await this.apiGet<PaginatedResponse<PostSummary>>(
        "/api/v1/posts",
        { skip: String(skip), limit: String(limit) }
      );

      allPosts.push(...page.data);

      if (!page.hasMore || page.data.length === 0) break;

      skip += page.data.length;
      await new Promise((resolve) => setTimeout(resolve, PAGE_DELAY_MS));
    }

    return allPosts;
  }

  async fetchComments(postId: string): Promise<Comment[]> {
    const res = await this.apiGet<DataResponse<Comment[]> | PaginatedResponse<Comment>>(
      `/api/v1/posts/${postId}/comments`
    );
    return Array.isArray(res.data) ? res.data : [res.data];
  }

  async fetchFeatureRequests(includeComments: boolean): Promise<FeatureRequest[]> {
    const posts = await this.fetchPosts();
    const requests: FeatureRequest[] = [];

    for (const post of posts) {
      let comments: Comment[] = [];
      if (includeComments) {
        await new Promise((resolve) => setTimeout(resolve, PAGE_DELAY_MS));
        try {
          comments = await this.fetchComments(post.id);
        } catch {
          // Some posts may not have comments accessible
          comments = [];
        }
      }

      requests.push({
        ...post,
        comments,
        portal: this.portal.name,
      });
    }

    return requests;
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
    return portals.split(",").map((entry) => {
      const parts = entry.trim().split("|");
      const name = parts[0];
      const baseUrl = parts[1];
      const apiKey = parts.slice(2).join("|"); // rejoin — tokens may contain |
      if (!name || !baseUrl || !apiKey) {
        throw new Error(
          `Invalid PRODUCTLIFT_PORTALS format. Expected "name|url|key" per entry, got: ${entry}`
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
