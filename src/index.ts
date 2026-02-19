import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  HelpScoutClient,
  extractCustomerMessages,
  type Conversation,
} from "./helpscout.js";
import {
  ProductLiftClient,
  parsePortalConfigs,
} from "./productlift.js";
import type { FeatureRequest, Comment } from "./productlift.js";
import {
  analyzeFeedback,
  loadThemesConfig,
  type AnalysisResult,
  type SignalType,
  type DetailLevel,
  type ThemeMatch,
  type FormattedConversation,
  type FormattedFeatureRequest,
} from "./feedback-analyzer.js";
import { scrubPii, scrubPiiArray } from "./pii-scrubber.js";
import { METHODOLOGY_CONTENT, METHODOLOGY_VERSION } from "./methodology.js";

// HelpScout setup
const HELPSCOUT_APP_ID = process.env.HELPSCOUT_APP_ID;
const HELPSCOUT_APP_SECRET = process.env.HELPSCOUT_APP_SECRET;

if (!HELPSCOUT_APP_ID || !HELPSCOUT_APP_SECRET) {
  console.error(
    "Missing HELPSCOUT_APP_ID or HELPSCOUT_APP_SECRET in environment"
  );
  process.exit(1);
}

const helpscout = new HelpScoutClient(HELPSCOUT_APP_ID, HELPSCOUT_APP_SECRET);

// ProductLift setup
const portalConfigs = parsePortalConfigs();
const productliftClients = portalConfigs.map((c) => new ProductLiftClient(c));

const server = new McpServer({
  name: "pm-copilot",
  version: "0.2.0",
});

// ── Resources ──

server.registerResource(
  "methodology",
  "pm-copilot://methodology",
  {
    description:
      "Product planning methodology: signal weighting, convergent boost logic, " +
      "reactive vs proactive balancing, revenue vs satisfaction framework. " +
      `Version ${METHODOLOGY_VERSION}.`,
    mimeType: "text/markdown",
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "text/markdown",
        text: METHODOLOGY_CONTENT,
      },
    ],
  })
);

// Track PII categories found across all data in a request
let piiCategoriesLog: Set<string> = new Set();

function formatConversation(conv: Conversation): FormattedConversation {
  // Use thread content when available, fall back to subject + preview
  const rawMessages = conv.threads.length > 0
    ? extractCustomerMessages(conv)
    : [conv.preview].filter(Boolean);
  const { texts: customerMessages, piiCategoriesFound } = scrubPiiArray(rawMessages);
  const subjectScrub = scrubPii(conv.subject ?? "");
  const previewScrub = scrubPii(conv.preview ?? "");
  for (const cat of [...piiCategoriesFound, ...subjectScrub.piiCategoriesFound, ...previewScrub.piiCategoriesFound]) {
    piiCategoriesLog.add(cat);
  }
  return {
    id: conv.id,
    number: conv.number,
    subject: subjectScrub.text,
    status: conv.status,
    createdAt: conv.createdAt,
    closedAt: conv.closedAt,
    customerEmail: "[REDACTED]",
    tags: conv.tags?.map((t) => t.tag) ?? [],
    preview: previewScrub.text,
    customerMessages,
    threadCount: conv.threads.length,
  };
}

// ── Shared data fetching ──

interface FetchParams {
  timeframe_days: number;
  top_voted_limit: number;
  mailbox_id?: string;
  portal_name?: string;
}

interface FetchedData {
  conversations: FormattedConversation[];
  featureRequests: FormattedFeatureRequest[];
  analysis: AnalysisResult;
  piiCategoriesRedacted: string[];
  dataSources: string[];
  warnings: string[];
}

function filterClientsByPortal(portalName: string | undefined): ProductLiftClient[] {
  if (!portalName) return productliftClients;
  return productliftClients.filter(
    (_, i) => portalConfigs[i]?.name.toLowerCase() === portalName.toLowerCase()
  );
}

async function fetchProductLift(
  params: FetchParams,
  includeComments = false
): Promise<FormattedFeatureRequest[]> {
  if (portalConfigs.length === 0) return [];

  const clients = filterClientsByPortal(params.portal_name);
  if (clients.length === 0) return [];

  // Fetch all portals in parallel
  const results = await Promise.all(
    clients.map(async (client) => {
      const posts = await client.fetchPosts();

      const recent = ProductLiftClient.filterRecent(posts, params.timeframe_days);
      const topVoted = ProductLiftClient.sortByVotes(posts, params.top_voted_limit);

      const seenIds = new Set<string>();
      const combined = [...recent, ...topVoted].filter((p) => {
        if (seenIds.has(p.id)) return false;
        seenIds.add(p.id);
        return true;
      });

      const formatted: FormattedFeatureRequest[] = [];
      for (const post of combined) {
        let comments: Comment[] = [];
        if (includeComments) {
          try {
            comments = await client.fetchComments(post.id);
          } catch {
            // skip if comments unavailable
          }
        }

        formatted.push(
          formatFeatureRequest({
            ...post,
            comments,
            portal: params.portal_name ?? "all",
          })
        );
      }
      return formatted;
    })
  );

  return results.flat();
}

// ── Response cache ──

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  data: FetchedData;
  timestamp: number;
}

const fetchCache = new Map<string, CacheEntry>();

function cacheKey(params: FetchParams): string {
  return `${params.timeframe_days}|${params.mailbox_id ?? ""}|${params.portal_name ?? ""}|${params.top_voted_limit}`;
}

async function cachedFetchAndAnalyze(params: FetchParams): Promise<FetchedData> {
  const key = cacheKey(params);
  const cached = fetchCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    const ageSeconds = ((Date.now() - cached.timestamp) / 1000).toFixed(0);
    console.error(`[pm-copilot] Cache hit (key=${key}, age=${ageSeconds}s)`);
    return cached.data;
  }

  console.error(`[pm-copilot] Cache miss (key=${key}), fetching fresh data...`);
  const data = await fetchAndAnalyze(params);

  fetchCache.set(key, { data, timestamp: Date.now() });

  // Evict expired entries
  for (const [k, entry] of fetchCache) {
    if (Date.now() - entry.timestamp >= CACHE_TTL_MS) fetchCache.delete(k);
  }

  return data;
}

async function fetchAndAnalyze(params: FetchParams): Promise<FetchedData> {
  const piiCategories = new Set<string>();
  const prevLog = piiCategoriesLog;
  piiCategoriesLog = piiCategories;

  const warnings: string[] = [];

  // Fetch both sources independently — one failing doesn't block the other
  const [hsResult, plResult] = await Promise.allSettled([
    helpscout
      .fetchConversations({
        timeframeDays: params.timeframe_days,
        mailboxId: params.mailbox_id,
      })
      .then((convs) => convs.map(formatConversation)),
    fetchProductLift(params),
  ]);

  let conversations: FormattedConversation[] = [];
  if (hsResult.status === "fulfilled") {
    conversations = hsResult.value;
  } else {
    const msg = hsResult.reason instanceof Error
      ? hsResult.reason.message
      : String(hsResult.reason);
    warnings.push(`HelpScout fetch failed: ${msg}`);
    console.error(`[pm-copilot] HelpScout error: ${msg}`);
  }

  let featureRequests: FormattedFeatureRequest[] = [];
  if (plResult.status === "fulfilled") {
    featureRequests = plResult.value;
  } else {
    const msg = plResult.reason instanceof Error
      ? plResult.reason.message
      : String(plResult.reason);
    warnings.push(`ProductLift fetch failed: ${msg}`);
    console.error(`[pm-copilot] ProductLift error: ${msg}`);
  }

  // Restore previous PII log reference (in case of concurrent calls)
  piiCategoriesLog = prevLog;

  const config = loadThemesConfig();
  const analysis = analyzeFeedback(conversations, featureRequests, config);

  const dataSources = [
    ...(conversations.length > 0 ? ["helpscout_tickets"] : []),
    ...(featureRequests.length > 0 ? ["productlift_votes"] : []),
  ];

  console.error(
    `[pm-copilot] Data sent: ${JSON.stringify({
      data_sources: dataSources,
      pii_scrubbed: [...piiCategories],
      warnings: warnings.length,
    })}`
  );

  return {
    conversations,
    featureRequests,
    analysis,
    piiCategoriesRedacted: [...piiCategories],
    dataSources,
    warnings,
  };
}

// ── Tools ──

server.registerTool("synthesize_feedback", {
  title: "Synthesize Customer Feedback",
  description:
    "Cross-reference support tickets (HelpScout) and feature requests (ProductLift) " +
    "to find convergent signals. Returns theme-matched analysis with priority scores. " +
    "Convergent themes (appearing in both sources) get a 2x priority boost. " +
    `Configured portals: ${portalConfigs.length > 0 ? portalConfigs.map((c) => c.name).join(", ") : "none"}`,
  inputSchema: {
    timeframe_days: z
      .number()
      .int()
      .min(1)
      .max(90)
      .default(30)
      .describe("Number of days to look back (default: 30, max: 90)"),
    top_voted_limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe("Max feature requests to include by vote count (default: 50)"),
    mailbox_id: z
      .string()
      .optional()
      .describe("HelpScout mailbox ID to filter by (optional)"),
    portal_name: z
      .string()
      .optional()
      .describe("ProductLift portal name to filter by (optional)"),
    detail_level: z
      .enum(["summary", "standard", "full"])
      .default("summary")
      .describe(
        "Level of detail in response. " +
        "'summary' (default, ~20KB): scores, quotes, evidence summaries — optimized for LLM consumption. " +
        "'standard' (~100KB): adds data point titles per theme. " +
        "'full' (~600KB): all data points — for export/dashboard use, not LLM consumption."
      ),
  },
}, async ({ timeframe_days, top_voted_limit, mailbox_id, portal_name, detail_level }) => {
  try {
    const data = await cachedFetchAndAnalyze({
      timeframe_days,
      top_voted_limit,
      mailbox_id,
      portal_name,
    });

    const trimmedAnalysis = trimAnalysisForDetail(
      data.analysis,
      detail_level,
      data.conversations,
      data.featureRequests
    );

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              timeframe_days,
              detail_level,
              mailbox_id: mailbox_id ?? null,
              portal_name: portal_name ?? "all",
              top_voted_limit,
              fetched_at: new Date().toISOString(),
              pii_scrubbing_applied: true,
              pii_categories_redacted: data.piiCategoriesRedacted,
              ...(data.warnings.length > 0 && { warnings: data.warnings }),
              analysis: trimmedAnalysis,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error";
    return {
      content: [{ type: "text" as const, text: `Error: ${message}` }],
      isError: true,
    };
  }
});

function formatFeatureRequest(req: FeatureRequest): FormattedFeatureRequest {
  const titleScrub = scrubPii(req.title);
  const descScrub = scrubPii(req.description);
  for (const cat of [...titleScrub.piiCategoriesFound, ...descScrub.piiCategoriesFound]) {
    piiCategoriesLog.add(cat);
  }
  return {
    id: req.id,
    title: titleScrub.text,
    description: descScrub.text,
    status: req.status?.name ?? null,
    category: req.category?.name ?? null,
    votes_count: req.votes_count ?? 0,
    comments_count: req.comments_count ?? 0,
    portal: req.portal,
    created_at: req.created_at,
    updated_at: req.updated_at,
    comments: req.comments.map((c) => {
      const commentScrub = scrubPii(c.comment);
      for (const cat of commentScrub.piiCategoriesFound) piiCategoriesLog.add(cat);
      return {
        author: c.author.name,
        role: c.author.role,
        comment: commentScrub.text,
        created_at: c.created_at,
      };
    }),
  };
}

// ── Agent response detection ──

const AGENT_RESPONSE_PATTERNS: RegExp[] = [
  // Common agent closings & pleasantries
  /happy to help/i,
  /hope this helps/i,
  /let me know if/i,
  /don't hesitate/i,
  /do not hesitate/i,
  /feel free to/i,
  /is there anything else/i,
  /glad (to |you |we )/i,
  /pleasure (to |helping)/i,
  /(best|warm|kind) regards/i,
  // Apologies & acknowledgments
  /i apologize for/i,
  /we apologize for/i,
  /sorry for the inconvenience/i,
  /thank you for (reaching|contacting|writing|your patience)/i,
  /thanks for (reaching|contacting|writing|your patience)/i,
  /thanks (so much )?for checking in/i,
  /bringing this to our attention/i,
  // Agent action language
  /i've (checked|looked into|forwarded|sent|updated|resolved|fixed|escalated)/i,
  /we've (identified|checked|looked|resolved|fixed|addressed|updated|escalated)/i,
  /has been (resolved|fixed|addressed|updated|escalated)/i,
  /this has been flagged/i,
  /our (team|support|engineering|developers)/i,
  /i can help with that/i,
  // System / automated text
  /ai-generated draft/i,
  /your request .* could(n't| not) be created/i,
  /powered by/i,
  // AppSumo-specific agent templates
  /hey sumo-ling/i,
  /we're aiming to .* get back to you/i,
  /before i proceed/i,
];

function isLikelyAgentResponse(text: string): boolean {
  if (!text || text.length === 0) return true;
  for (const pattern of AGENT_RESPONSE_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

// ── Quote extraction for product plans ──

function extractQuotesForTheme(
  themeDataPoints: Array<{ id: string; source: SignalType; title: string }>,
  conversationMap: Map<string, FormattedConversation>,
  featureRequestMap: Map<string, FormattedFeatureRequest>,
  maxQuotes: number = 3
): string[] {
  const quotes: string[] = [];

  for (const dp of themeDataPoints) {
    if (quotes.length >= maxQuotes) break;

    if (dp.source === "REACTIVE") {
      const conv = conversationMap.get(dp.id);
      if (!conv) continue;

      // Prefer customer message that isn't agent text, fall back to subject
      const msg = conv.customerMessages[0] ?? "";
      if (msg && !isLikelyAgentResponse(msg)) {
        const truncated = msg.length > 200 ? msg.slice(0, 197) + "..." : msg;
        quotes.push(`[Support ticket] "${truncated}"`);
      } else if (conv.subject && !isLikelyAgentResponse(conv.subject)) {
        quotes.push(`[Support ticket] "${conv.subject}"`);
      }
      // Skip this data point if both are agent text — don't add a bad quote
    } else {
      const req = featureRequestMap.get(dp.id);
      if (req) {
        const customerComment = req.comments.find((c) => c.role !== "admin");
        if (customerComment && !isLikelyAgentResponse(customerComment.comment)) {
          const msg = customerComment.comment;
          const truncated = msg.length > 200 ? msg.slice(0, 197) + "..." : msg;
          quotes.push(`[Feature request, ${req.votes_count} votes] "${truncated}"`);
        } else {
          quotes.push(`[Feature request, ${req.votes_count} votes] "${req.title}"`);
        }
      }
    }
  }

  // If we couldn't find enough clean quotes, note it
  if (quotes.length === 0) {
    quotes.push("No direct customer quote available");
  }

  return quotes;
}

// ── Detail level trimming ──

function buildEvidenceSummary(theme: ThemeMatch): string {
  const total = theme.reactive_count + theme.proactive_count;
  const parts: string[] = [];
  if (theme.reactive_count > 0) parts.push(`${theme.reactive_count} support tickets`);
  if (theme.proactive_count > 0) parts.push(`${theme.proactive_count} feature requests`);
  let summary = `${total} signals (${parts.join(", ")}).`;
  if (theme.convergent) {
    summary += " Convergent — appears in both support and feature requests (2x priority boost).";
  }
  return summary;
}

function trimAnalysisForDetail(
  analysis: AnalysisResult,
  level: DetailLevel,
  conversations: FormattedConversation[],
  featureRequests: FormattedFeatureRequest[]
): unknown {
  if (level === "full") return analysis;

  const convMap = new Map<string, FormattedConversation>();
  for (const conv of conversations) convMap.set(`hs-${conv.id}`, conv);
  const reqMap = new Map<string, FormattedFeatureRequest>();
  for (const req of featureRequests) reqMap.set(`pl-${req.id}`, req);

  const themes = analysis.themes.map((theme) => {
    const signalType = theme.convergent
      ? "convergent"
      : theme.reactive_count > 0
        ? "reactive"
        : "proactive";
    const quotes = extractQuotesForTheme(
      theme.data_points,
      convMap,
      reqMap,
      3
    );

    const base = {
      theme_id: theme.theme_id,
      label: theme.label,
      category: theme.category,
      priority_score: theme.priority_score,
      convergent: theme.convergent,
      signal_type: signalType,
      reactive_count: theme.reactive_count,
      proactive_count: theme.proactive_count,
      evidence_summary: buildEvidenceSummary(theme),
      representative_quotes: quotes,
    };

    if (level === "summary") return base;

    // standard: add sub-scores + data point titles (capped at 50)
    const MAX_TITLES = 50;
    const allTitles = theme.data_points.map((dp) => dp.title);
    return {
      ...base,
      frequency_score: theme.frequency_score,
      severity_score: theme.severity_score,
      vote_momentum_score: theme.vote_momentum_score,
      data_points_total: allTitles.length,
      data_point_titles: allTitles.slice(0, MAX_TITLES),
      ...(allTitles.length > MAX_TITLES && {
        data_point_titles_truncated: true,
      }),
    };
  });

  const emergingLimit = level === "summary" ? 5 : 10;
  const emerging_themes = analysis.emerging_themes
    .slice(0, emergingLimit)
    .map((e) => {
      if (level === "summary") {
        return { pattern: e.ngram, frequency: e.frequency };
      }
      return {
        pattern: e.ngram,
        frequency: e.frequency,
        sample_titles: e.data_points.slice(0, 3).map((dp) => dp.title),
      };
    });

  return {
    config_version: analysis.config_version,
    known_themes_count: analysis.known_themes_count,
    total_data_points: analysis.total_data_points,
    reactive_count: analysis.reactive_count,
    proactive_count: analysis.proactive_count,
    themes,
    emerging_themes,
    unmatched_count: analysis.unmatched_count,
  };
}

server.registerTool("generate_product_plan", {
  title: "Generate Product Plan",
  description:
    "Build a prioritized product plan by cross-referencing HelpScout support tickets " +
    "and ProductLift feature requests. Optionally accepts business metrics from other " +
    "MCP servers (Metabase, GA, etc.) via kpi_context to inform prioritization. " +
    "References the pm-copilot://methodology resource for planning framework. " +
    "Returns top priorities with evidence, customer quotes, and recommended actions. " +
    `Configured portals: ${portalConfigs.length > 0 ? portalConfigs.map((c) => c.name).join(", ") : "none"}`,
  inputSchema: {
    timeframe_days: z
      .number()
      .int()
      .min(1)
      .max(90)
      .default(30)
      .describe("Number of days to look back (default: 30, max: 90)"),
    top_voted_limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .default(50)
      .describe("Max feature requests to include by vote count (default: 50)"),
    mailbox_id: z
      .string()
      .optional()
      .describe("HelpScout mailbox ID to filter by (optional)"),
    portal_name: z
      .string()
      .optional()
      .describe("ProductLift portal name to filter by (optional)"),
    kpi_context: z
      .string()
      .optional()
      .describe(
        "Optional business metrics context from other MCP servers (e.g. Metabase churn data, " +
        "GA traffic trends). Pass as free-text — Claude will use this to adjust prioritization."
      ),
    max_priorities: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(5)
      .describe("Max number of priorities to return (default: 5)"),
    preview_only: z
      .boolean()
      .default(false)
      .describe(
        "If true, returns only a summary of what data WOULD be sent (counts, date ranges, " +
        "data categories) without fetching or sending actual content. Use to audit data flow."
      ),
    detail_level: z
      .enum(["summary", "standard", "full"])
      .default("summary")
      .describe(
        "Level of detail in response. " +
        "'summary' (default): compact plan with scores, quotes, and evidence summaries. " +
        "'standard': adds data point titles per priority. " +
        "'full': appends the complete raw analysis for export use."
      ),
  },
}, async ({ timeframe_days, top_voted_limit, mailbox_id, portal_name, kpi_context, max_priorities, preview_only, detail_level }) => {
  try {
    // Preview mode: show what would be sent without fetching
    if (preview_only) {
      const previewSources = ["helpscout_tickets"];
      if (portalConfigs.length > 0) previewSources.push("productlift_votes");

      const filteredPortals = portal_name
        ? portalConfigs.filter((c) => c.name.toLowerCase() === portal_name.toLowerCase()).map((c) => c.name)
        : portalConfigs.map((c) => c.name);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                preview: true,
                description: "This is a preview of what data would be fetched and sent to Claude.",
                data_sources: previewSources,
                helpscout: {
                  will_fetch: "support conversations",
                  timeframe_days,
                  mailbox_filter: mailbox_id ?? "all",
                  fields_sent: ["subject (PII-scrubbed)", "customer messages (PII-scrubbed)", "tags", "thread count", "status"],
                  fields_NOT_sent: ["customer email (always redacted)", "agent responses", "internal notes", "attachments"],
                },
                productlift: {
                  will_fetch: portalConfigs.length > 0 ? "feature request posts + comments" : "SKIPPED (not configured)",
                  portals: filteredPortals,
                  top_voted_limit,
                  fields_sent: ["title (PII-scrubbed)", "description (PII-scrubbed)", "vote count", "comment text (PII-scrubbed)", "status"],
                  fields_NOT_sent: ["voter identities", "commenter emails", "internal admin notes"],
                },
                pii_scrubbing: {
                  enabled: true,
                  patterns_scrubbed: ["SSN", "credit card numbers (Luhn-validated)", "email addresses", "phone numbers"],
                  customer_email_field: "always replaced with [REDACTED]",
                },
                kpi_context_provided: !!kpi_context,
                kpi_context_note: kpi_context
                  ? "KPI context will be included verbatim in the plan output for Claude to reference."
                  : "No KPI context provided. Plan will be based on customer signals only.",
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // Full execution: fetch, analyze, build plan
    const data = await cachedFetchAndAnalyze({
      timeframe_days,
      top_voted_limit,
      mailbox_id,
      portal_name,
    });

    // Build lookup maps for quote extraction
    const conversationMap = new Map<string, FormattedConversation>();
    for (const conv of data.conversations) {
      conversationMap.set(`hs-${conv.id}`, conv);
    }
    const featureRequestMap = new Map<string, FormattedFeatureRequest>();
    for (const req of data.featureRequests) {
      featureRequestMap.set(`pl-${req.id}`, req);
    }

    // Build priorities from top themes
    const topThemes = data.analysis.themes.slice(0, max_priorities);

    const priorities = topThemes.map((theme, index) => {
      const signalType = theme.convergent
        ? "convergent"
        : theme.reactive_count > 0
          ? "reactive"
          : "proactive";

      const quotes = extractQuotesForTheme(
        theme.data_points,
        conversationMap,
        featureRequestMap
      );

      const base = {
        rank: index + 1,
        theme: theme.label,
        theme_id: theme.theme_id,
        category: theme.category,
        signal_type: signalType,
        priority_score: theme.priority_score,
        convergent: theme.convergent,
        evidence: {
          total_data_points: theme.data_points.length,
          support_tickets: theme.reactive_count,
          feature_requests: theme.proactive_count,
          ...(detail_level !== "summary" && {
            frequency_score: theme.frequency_score,
            severity_score: theme.severity_score,
            vote_momentum_score: theme.vote_momentum_score,
          }),
        },
        evidence_summary: buildEvidenceSummary(theme),
        customer_quotes: quotes,
      };

      if (detail_level === "summary") return base;

      // standard + full: add data point titles (capped at 50)
      const MAX_TITLES = 50;
      const allTitles = theme.data_points.map((dp) => dp.title);
      return {
        ...base,
        data_points_total: allTitles.length,
        data_point_titles: allTitles.slice(0, MAX_TITLES),
        ...(allTitles.length > MAX_TITLES && {
          data_point_titles_truncated: true,
        }),
      };
    });

    // Build emerging themes summary
    const emergingSummary = data.analysis.emerging_themes.slice(0, 3).map((e) => ({
      pattern: e.ngram,
      frequency: e.frequency,
      sample_titles: e.data_points.slice(0, 2).map((dp) => dp.title),
    }));

    const plan = {
      generated_at: new Date().toISOString(),
      methodology_version: METHODOLOGY_VERSION,
      methodology_resource: "pm-copilot://methodology",
      detail_level,
      timeframe_days,
      data_sources: data.dataSources,
      pii_scrubbing_applied: true,
      pii_categories_redacted: data.piiCategoriesRedacted,
      ...(data.warnings.length > 0 && { warnings: data.warnings }),
      summary: {
        total_signals_analyzed: data.analysis.total_data_points,
        reactive_signals: data.analysis.reactive_count,
        proactive_signals: data.analysis.proactive_count,
        themes_detected: data.analysis.themes.length,
        convergent_themes: data.analysis.themes.filter((t) => t.convergent).length,
        unmatched_signals: data.analysis.unmatched_count,
      },
      priorities,
      emerging_themes: emergingSummary,
      ...(kpi_context
        ? {
            kpi_context: {
              provided: true,
              note:
                "Business metrics provided below. Use the methodology at pm-copilot://methodology " +
                "to determine how these metrics should adjust the priority ranking above.",
              metrics: kpi_context,
            },
          }
        : {
            kpi_context: {
              provided: false,
              note:
                "No business metrics provided. Priorities are based on customer signals only. " +
                "For stronger prioritization, provide churn data, traffic trends, or revenue " +
                "metrics via the kpi_context parameter.",
            },
          }),
      ...(detail_level === "full" && {
        raw_analysis: data.analysis,
      }),
    };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(plan, null, 2),
        },
      ],
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error";
    return {
      content: [{ type: "text" as const, text: `Error: ${message}` }],
      isError: true,
    };
  }
});

server.registerTool("get_feature_requests", {
  title: "Get Feature Requests",
  description:
    "Pull feature requests from ProductLift portals. " +
    "Returns posts with vote counts, statuses, categories, and comments. " +
    "Use this to understand what customers are asking for and prioritize the roadmap. " +
    `Configured portals: ${portalConfigs.length > 0 ? portalConfigs.map((c) => c.name).join(", ") : "none (set PRODUCTLIFT_PORTALS or PRODUCTLIFT_PORTAL_URL in .env)"}`,
  inputSchema: {
    portal_name: z
      .string()
      .optional()
      .describe(
        "Filter to a specific portal by name. Omit to fetch from all configured portals."
      ),
    include_comments: z
      .boolean()
      .default(true)
      .describe("Include comments on each feature request (default: true)"),
  },
}, async ({ portal_name, include_comments }) => {
  if (portalConfigs.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: "Error: No ProductLift portals configured. Set PRODUCTLIFT_PORTALS or PRODUCTLIFT_PORTAL_URL + PRODUCTLIFT_API_KEY in .env",
        },
      ],
      isError: true,
    };
  }

  try {
    const clients = portal_name
      ? productliftClients.filter(
          (_, i) =>
            portalConfigs[i]?.name.toLowerCase() === portal_name.toLowerCase()
        )
      : productliftClients;

    if (clients.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: No portal found with name "${portal_name}". Available: ${portalConfigs.map((c) => c.name).join(", ")}`,
          },
        ],
        isError: true,
      };
    }

    const allRequests: FeatureRequest[] = [];
    for (const client of clients) {
      const requests = await client.fetchFeatureRequests(include_comments);
      allRequests.push(...requests);
    }

    const formatted = allRequests.map(formatFeatureRequest);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              portal_filter: portal_name ?? "all",
              total_feature_requests: formatted.length,
              fetched_at: new Date().toISOString(),
              feature_requests: formatted,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return {
      content: [{ type: "text" as const, text: `Error: ${message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server is now listening on stdio
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
