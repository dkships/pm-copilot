#!/usr/bin/env node
import { config as loadEnv } from "dotenv";
// Make the project .env authoritative: override any stale value already exported
// in the shell/parent environment (e.g. an old PRODUCTLIFT_PORTALS). Without this,
// dotenv leaves pre-set vars untouched and edits to .env appear to have no effect.
loadEnv({ override: true });
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  HelpScoutClient,
  type Mailbox,
} from "./helpscout.js";
import {
  ProductLiftClient,
  parsePortalConfigs,
} from "./productlift.js";
import type { FeatureRequest, Comment, PortalConfig } from "./productlift.js";
import {
  analyzeFeedback,
  loadThemesConfig,
  type AnalysisResult,
  type FormattedConversation,
  type FormattedFeatureRequest,
} from "./feedback-analyzer.js";
import { scrubPii } from "./pii-scrubber.js";
import {
  formatConversation,
  formatFeatureRequest,
  extractQuotesForTheme,
  buildEvidenceSummary,
  trimAnalysisForDetail,
  toErrorResult,
  buildLookupMaps,
  signalTypeOf,
  capTitles,
} from "./format.js";
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

// ProductLift setup — a bad portal config degrades to zero portals instead of
// killing the HelpScout tools with it. The error is surfaced in tool
// descriptions and list_sources so it's discoverable from the client.
let portalConfigs: PortalConfig[] = [];
let portalConfigError: string | undefined;
try {
  portalConfigs = parsePortalConfigs();
} catch (error) {
  portalConfigError = error instanceof Error ? error.message : String(error);
  console.error(`[pm-copilot] ProductLift config error: ${portalConfigError}`);
}
const productliftClients = portalConfigs.map((c) => new ProductLiftClient(c));

function describePortals(): string {
  if (portalConfigError) return `none (config error: ${portalConfigError})`;
  if (portalConfigs.length === 0) {
    return "none (set PRODUCTLIFT_PORTALS or PRODUCTLIFT_PORTAL_URL in .env)";
  }
  return portalConfigs.map((c) => c.name).join(", ");
}

const server = new McpServer({
  name: "pm-copilot",
  version: "1.2.0",
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
  // True when every configured source failed — callers should return an error
  // instead of presenting an empty analysis as a successful result.
  fetchFailed: boolean;
}

function filterClientsByPortal(portalName: string | undefined): ProductLiftClient[] {
  if (!portalName) return productliftClients;
  return productliftClients.filter(
    (_, i) => portalConfigs[i]?.name.toLowerCase() === portalName.toLowerCase()
  );
}

/**
 * Resolve a mailbox name to its numeric ID. A provided mailbox_id wins
 * (back-compat). Otherwise the name is matched case-insensitively against the
 * live mailbox list. Throws a helpful error listing available names on no match.
 * Resolved at the handler boundary so the cache key only ever sees an ID.
 */
async function resolveMailboxId(
  mailboxName?: string,
  mailboxId?: string
): Promise<string | undefined> {
  if (mailboxId) return mailboxId;
  if (!mailboxName) return undefined;

  const mailboxes = await helpscout.fetchMailboxes();
  const match = mailboxes.find(
    (m) => m.name.toLowerCase() === mailboxName.toLowerCase()
  );
  if (!match) {
    const available = mailboxes.map((m) => m.name).join(", ") || "none";
    throw new Error(
      `No HelpScout mailbox named "${mailboxName}". Available: ${available}`
    );
  }
  return String(match.id);
}

async function fetchProductLift(
  params: FetchParams,
  piiSink: Set<string>,
  includeComments = false
): Promise<{ requests: FormattedFeatureRequest[]; warnings: string[] }> {
  if (portalConfigs.length === 0) return { requests: [], warnings: [] };

  const clients = filterClientsByPortal(params.portal_name);
  if (clients.length === 0) return { requests: [], warnings: [] };

  // Fetch portals in parallel, each isolated — one failing portal becomes a
  // warning instead of dropping every portal's data
  const results = await Promise.allSettled(
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
          formatFeatureRequest(
            {
              ...post,
              comments,
              portal: client.portalName,
            },
            piiSink
          )
        );
      }
      return formatted;
    })
  );

  const requests: FormattedFeatureRequest[] = [];
  const warnings: string[] = [];
  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      requests.push(...result.value);
    } else {
      const msg =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      warnings.push(
        scrubPii(`ProductLift portal "${clients[i]?.portalName}" fetch failed: ${msg}`).text
      );
    }
  });

  return { requests, warnings };
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

  // Never cache a total fetch failure — a transient outage shouldn't stick for 5 minutes
  if (!data.fetchFailed) {
    fetchCache.set(key, { data, timestamp: Date.now() });
  }

  // Evict expired entries
  for (const [k, entry] of fetchCache) {
    if (Date.now() - entry.timestamp >= CACHE_TTL_MS) fetchCache.delete(k);
  }

  return data;
}

async function fetchAndAnalyze(params: FetchParams): Promise<FetchedData> {
  const piiCategories = new Set<string>();
  const warnings: string[] = [];

  // Fetch both sources independently — one failing doesn't block the other
  const [hsResult, plResult] = await Promise.allSettled([
    helpscout
      .fetchConversations({
        timeframeDays: params.timeframe_days,
        mailboxId: params.mailbox_id,
      })
      .then((convs) => convs.map((c) => formatConversation(c, piiCategories))),
    fetchProductLift(params, piiCategories),
  ]);

  let conversations: FormattedConversation[] = [];
  if (hsResult.status === "fulfilled") {
    conversations = hsResult.value;
  } else {
    const msg = hsResult.reason instanceof Error
      ? hsResult.reason.message
      : String(hsResult.reason);
    warnings.push(scrubPii(`HelpScout fetch failed: ${msg}`).text);
    console.error(`[pm-copilot] HelpScout error: ${msg}`);
  }

  let featureRequests: FormattedFeatureRequest[] = [];
  let productliftFailed = false;
  if (plResult.status === "fulfilled") {
    featureRequests = plResult.value.requests;
    warnings.push(...plResult.value.warnings);
    productliftFailed =
      featureRequests.length === 0 && plResult.value.warnings.length > 0;
  } else {
    productliftFailed = true;
    const msg = plResult.reason instanceof Error
      ? plResult.reason.message
      : String(plResult.reason);
    warnings.push(scrubPii(`ProductLift fetch failed: ${msg}`).text);
    console.error(`[pm-copilot] ProductLift error: ${msg}`);
  }

  // Total failure = HelpScout failed AND ProductLift failed or isn't configured.
  // An unconfigured ProductLift alone is a legitimate HelpScout-only setup.
  const fetchFailed =
    hsResult.status === "rejected" &&
    (portalConfigs.length === 0 || productliftFailed);

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
    fetchFailed,
  };
}

// ── Tools ──

server.registerTool("synthesize_feedback", {
  title: "Synthesize Customer Feedback",
  description:
    "Cross-reference support tickets (HelpScout) and feature requests (ProductLift) " +
    "to find convergent signals. Returns theme-matched analysis with priority scores. " +
    "Convergent themes (appearing in both sources) get a 2x priority boost. " +
    `Configured portals: ${describePortals()}`,
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
      .describe("HelpScout mailbox ID to filter by (optional). Prefer mailbox_name."),
    mailbox_name: z
      .string()
      .optional()
      .describe(
        "HelpScout mailbox name to filter by (optional, case-insensitive). " +
        "Resolved to an ID automatically — run list_sources to see available names."
      ),
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
}, async ({ timeframe_days, top_voted_limit, mailbox_id, mailbox_name, portal_name, detail_level }) => {
  try {
    // Resolve name → ID at the handler boundary; the cache key only ever sees an ID.
    const resolvedMailboxId = await resolveMailboxId(mailbox_name, mailbox_id);
    const data = await cachedFetchAndAnalyze({
      timeframe_days,
      top_voted_limit,
      mailbox_id: resolvedMailboxId,
      portal_name,
    });

    if (data.fetchFailed) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: all data sources failed to fetch.\n${data.warnings.join("\n")}`,
          },
        ],
        isError: true,
      };
    }

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
              mailbox_id: resolvedMailboxId ?? null,
              mailbox_name: mailbox_name ?? null,
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
    return toErrorResult(error);
  }
});

// ── Markdown product brief ──

interface PlanPriorityForRender {
  rank: number;
  theme: string;
  category: string;
  signal_type: string;
  priority_score: number;
  convergent: boolean;
  evidence: {
    total_data_points: number;
    support_tickets: number;
    feature_requests: number;
  };
  evidence_summary: string;
  customer_quotes: string[];
}

function renderPlanMarkdown(args: {
  generatedAt: string;
  timeframeDays: number;
  dataSources: string[];
  summary: {
    total_signals_analyzed: number;
    reactive_signals: number;
    proactive_signals: number;
    themes_detected: number;
    convergent_themes: number;
    unmatched_signals: number;
  };
  priorities: PlanPriorityForRender[];
  emerging: Array<{ pattern: string; frequency: number }>;
  kpiContext?: string;
}): string {
  const { summary } = args;
  const lines: string[] = [];

  lines.push(`# Product Plan — ${args.timeframeDays}-day window`);
  lines.push("");
  lines.push(
    `_Generated ${args.generatedAt} · methodology v${METHODOLOGY_VERSION} · ` +
      `sources: ${args.dataSources.join(", ") || "none"}_`
  );
  lines.push("");
  lines.push(
    `**Signals:** ${summary.total_signals_analyzed} analyzed ` +
      `(${summary.reactive_signals} support tickets, ${summary.proactive_signals} feature requests) · ` +
      `${summary.themes_detected} themes (${summary.convergent_themes} convergent) · ` +
      `${summary.unmatched_signals} unmatched`
  );
  lines.push("");

  if (args.priorities.length > 0) {
    lines.push("## Priorities");
    lines.push("");
    lines.push("| # | Theme | Score | Tickets | FRs | Signal |");
    lines.push("|---|-------|------:|--------:|----:|--------|");
    for (const p of args.priorities) {
      lines.push(
        `| ${p.rank} | ${p.theme} | ${p.priority_score} | ` +
          `${p.evidence.support_tickets} | ${p.evidence.feature_requests} | ` +
          `${p.convergent ? "Convergent" : p.signal_type} |`
      );
    }
    lines.push("");

    for (const p of args.priorities) {
      lines.push(
        `### ${p.rank}. ${p.theme}  (${p.category} · score ${p.priority_score})`
      );
      lines.push(p.evidence_summary);
      const quotes = p.customer_quotes.filter(
        (q) => q && q !== "No direct customer quote available"
      );
      if (quotes.length > 0) {
        lines.push("");
        for (const q of quotes) lines.push(`- ${q}`);
      }
      lines.push("");
    }
  }

  if (args.emerging.length > 0) {
    lines.push("## Emerging themes");
    lines.push("");
    for (const e of args.emerging) {
      lines.push(`- ${e.pattern} (${e.frequency})`);
    }
    lines.push("");
  }

  if (args.kpiContext) {
    lines.push("## Business context (KPI)");
    lines.push("");
    lines.push(args.kpiContext);
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

server.registerTool("generate_product_plan", {
  title: "Generate Product Plan",
  description:
    "Build a prioritized product plan by cross-referencing HelpScout support tickets " +
    "and ProductLift feature requests. Optionally accepts business metrics from other " +
    "MCP servers (Metabase, GA, etc.) via kpi_context to inform prioritization. " +
    "References the pm-copilot://methodology resource for planning framework. " +
    "Returns top priorities with evidence, customer quotes, and recommended actions. " +
    `Configured portals: ${describePortals()}`,
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
      .describe("HelpScout mailbox ID to filter by (optional). Prefer mailbox_name."),
    mailbox_name: z
      .string()
      .optional()
      .describe(
        "HelpScout mailbox name to filter by (optional, case-insensitive). " +
        "Resolved to an ID automatically — run list_sources to see available names."
      ),
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
    format: z
      .enum(["json", "markdown"])
      .default("json")
      .describe(
        "Output format. 'json' (default): structured plan for composability / further analysis. " +
        "'markdown': a ready-to-read product brief (ranked table + quotes) for planning docs."
      ),
  },
}, async ({ timeframe_days, top_voted_limit, mailbox_id, mailbox_name, portal_name, kpi_context, max_priorities, preview_only, detail_level, format }) => {
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
                  will_fetch: "support conversation summaries (subject + preview, not full message bodies)",
                  timeframe_days,
                  mailbox_filter: mailbox_name ?? mailbox_id ?? "all",
                  fields_sent: ["subject (PII-scrubbed)", "preview snippet (PII-scrubbed)", "tags", "status", "created/closed timestamps", "thread count"],
                  fields_NOT_sent: ["customer email (always redacted)", "full thread/message bodies (never fetched)", "attachments"],
                },
                productlift: {
                  will_fetch: portalConfigs.length > 0 ? "feature request posts (comment text is NOT fetched by this tool)" : "SKIPPED (not configured)",
                  portals: filteredPortals,
                  top_voted_limit,
                  fields_sent: ["title (PII-scrubbed)", "description (PII-scrubbed)", "vote count", "comment count", "status", "timestamps"],
                  fields_NOT_sent: ["comment text (not fetched by this tool)", "voter identities", "commenter names and emails"],
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

    // Full execution: fetch, analyze, build plan.
    // Resolve name → ID at the handler boundary; the cache key only ever sees an ID.
    const resolvedMailboxId = await resolveMailboxId(mailbox_name, mailbox_id);
    const data = await cachedFetchAndAnalyze({
      timeframe_days,
      top_voted_limit,
      mailbox_id: resolvedMailboxId,
      portal_name,
    });

    if (data.fetchFailed) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: all data sources failed to fetch.\n${data.warnings.join("\n")}`,
          },
        ],
        isError: true,
      };
    }

    // Build lookup maps for quote extraction
    const { convMap: conversationMap, reqMap: featureRequestMap } =
      buildLookupMaps(data.conversations, data.featureRequests);

    // Build priorities from top themes
    const topThemes = data.analysis.themes.slice(0, max_priorities);

    const priorities = topThemes.map((theme, index) => {
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
        signal_type: signalTypeOf(theme),
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

      // standard + full: add data point titles (capped)
      return { ...base, ...capTitles(theme.data_points) };
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

    const text =
      format === "markdown"
        ? renderPlanMarkdown({
            generatedAt: plan.generated_at,
            timeframeDays: timeframe_days,
            dataSources: data.dataSources,
            summary: plan.summary,
            priorities,
            emerging: emergingSummary,
            kpiContext: kpi_context,
          })
        : JSON.stringify(plan, null, 2);

    return {
      content: [
        {
          type: "text" as const,
          text,
        },
      ],
    };
  } catch (error) {
    return toErrorResult(error);
  }
});

server.registerTool("get_feature_requests", {
  title: "Get Feature Requests",
  description:
    "Pull feature requests from ProductLift portals. " +
    "Returns posts with vote counts, statuses, categories, and comments. " +
    "Use this to understand what customers are asking for and prioritize the roadmap. " +
    `Configured portals: ${describePortals()}`,
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
    status: z
      .string()
      .optional()
      .describe(
        "Filter to feature requests with this status (optional, case-insensitive), " +
        "e.g. 'open', 'planned', 'completed'. Omit to return all statuses."
      ),
  },
}, async ({ portal_name, include_comments, status }) => {
  if (portalConfigs.length === 0) {
    const detail = portalConfigError
      ? `ProductLift config error: ${portalConfigError}`
      : "No ProductLift portals configured. Set PRODUCTLIFT_PORTALS or PRODUCTLIFT_PORTAL_URL + PRODUCTLIFT_API_KEY in .env";
    return {
      content: [{ type: "text" as const, text: `Error: ${detail}` }],
      isError: true,
    };
  }

  try {
    const clients = filterClientsByPortal(portal_name);

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

    // Fetch each portal independently — one failing portal becomes a warning
    const allRequests: FeatureRequest[] = [];
    const warnings: string[] = [];
    for (const client of clients) {
      try {
        const requests = await client.fetchFeatureRequests(include_comments);
        allRequests.push(...requests);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        warnings.push(
          scrubPii(`ProductLift portal "${client.portalName}" fetch failed: ${msg}`).text
        );
      }
    }

    if (allRequests.length === 0 && warnings.length > 0) {
      return {
        content: [{ type: "text" as const, text: `Error: ${warnings.join("; ")}` }],
        isError: true,
      };
    }

    const piiCategories = new Set<string>();
    const allFormatted = allRequests.map((r) => formatFeatureRequest(r, piiCategories));
    const formatted = status
      ? allFormatted.filter(
          (r) => r.status?.toLowerCase() === status.toLowerCase()
        )
      : allFormatted;

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              portal_filter: portal_name ?? "all",
              status_filter: status ?? "all",
              total_feature_requests: formatted.length,
              fetched_at: new Date().toISOString(),
              pii_scrubbing_applied: true,
              pii_categories_redacted: [...piiCategories],
              ...(warnings.length > 0 && { warnings }),
              feature_requests: formatted,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    return toErrorResult(error);
  }
});

server.registerTool("list_sources", {
  title: "List Configured Sources",
  description:
    "List the data sources this server is connected to: HelpScout mailboxes (id + name) and " +
    "ProductLift portals (name + url). Use these names with the mailbox_name / portal_name " +
    "parameters on the other tools. Read-only; never returns API keys or customer data.",
  inputSchema: {},
}, async () => {
  try {
    // Project explicit fields — never spread portalConfigs (it carries apiKey).
    const productlift_portals = portalConfigs.map((c) => ({
      name: c.name,
      baseUrl: c.baseUrl,
    }));

    let helpscout_mailboxes: Mailbox[] = [];
    const warnings: string[] = [];
    if (portalConfigError) {
      warnings.push(`ProductLift config error: ${portalConfigError}`);
    }
    try {
      helpscout_mailboxes = await helpscout.fetchMailboxes();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      warnings.push(`HelpScout mailbox fetch failed: ${msg}`);
      console.error(`[pm-copilot] list_sources HelpScout error: ${msg}`);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              fetched_at: new Date().toISOString(),
              helpscout_mailboxes,
              productlift_portals,
              ...(warnings.length > 0 && { warnings }),
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    return toErrorResult(error);
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
