#!/usr/bin/env node
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
// The repo root, one level above dist/. .env and package.json are read from
// here, not the working directory: Claude Desktop launches the server from
// elsewhere, and a cwd-relative .env was silently never found.
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Make the project .env authoritative: override any stale value already exported
// in the shell/parent environment (e.g. an old PRODUCTLIFT_PORTALS). Without this,
// dotenv leaves pre-set vars untouched and edits to .env appear to have no effect.
// quiet: dotenv 17 otherwise logs to stdout, which is the MCP protocol channel.
loadEnv({ path: resolve(PROJECT_ROOT, ".env"), override: true, quiet: true });
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  HelpScoutClient,
  parseHelpScoutConfig,
  type Mailbox,
} from "./helpscout.js";
import { allConfiguredFailed, type SourceStatus } from "./source-status.js";
import {
  ProductLiftClient,
  parsePortalConfigs,
} from "./productlift.js";
import type { FeatureRequest, PortalConfig } from "./productlift.js";
import {
  ChatbaseClient,
  parseAgentConfigs,
  normalizeSourceFilter,
  CHATBASE_CONVERSATION_SOURCES,
  type AgentConfig,
} from "./chatbase.js";
import {
  analyzeFeedback,
  loadThemesConfig,
  type AnalysisResult,
  type FormattedConversation,
  type FormattedFeatureRequest,
  type FormattedDeflectedConversation,
} from "./feedback-analyzer.js";
import { scrubPii } from "./pii-scrubber.js";
import {
  formatConversation,
  formatFeatureRequest,
  formatDeflectedConversation,
  extractQuotesForTheme,
  buildEvidenceSummary,
  trimAnalysisForDetail,
  toErrorResult,
  buildLookupMaps,
  signalTypeOf,
  capTitles,
  buildThemeEvidence,
} from "./format.js";
import { METHODOLOGY_CONTENT, METHODOLOGY_VERSION } from "./methodology.js";

const { version: SERVER_VERSION } = createRequire(import.meta.url)(
  resolve(PROJECT_ROOT, "package.json")
) as { version: string };

const MAX_FEATURE_REQUEST_LIMIT = 500;
const DEFAULT_EVIDENCE_LIMIT = 25;
const MAX_EVIDENCE_LIMIT = 200;

// Every tool only reads from external APIs; clients can treat them as safe.
const READ_ONLY_TOOL = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

// HelpScout setup — optional, like the other sources. Without it there are no
// support tickets, so no severity scores and no convergence boost.
let helpscout: HelpScoutClient | null = null;
let helpscoutConfigError: string | undefined;
try {
  const config = parseHelpScoutConfig();
  if (config) {
    helpscout = new HelpScoutClient(config.appId, config.appSecret);
  }
} catch (error) {
  helpscoutConfigError = error instanceof Error ? error.message : String(error);
  console.error(`[pm-copilot] HelpScout config error: ${helpscoutConfigError}`);
}

function describeHelpScout(): string {
  if (helpscoutConfigError) {
    return `none (config error: ${helpscoutConfigError})`;
  }
  if (!helpscout) {
    return "none (set HELPSCOUT_APP_ID and HELPSCOUT_APP_SECRET in .env)";
  }
  return "configured";
}

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

// Chatbase setup — optional, and degrades the same way ProductLift does. Without
// an API key the deflection signal is simply absent from the analysis.
const CHATBASE_API_KEY = process.env.CHATBASE_API_KEY;
let agentConfigs: AgentConfig[] = [];
let agentConfigError: string | undefined;
try {
  agentConfigs = CHATBASE_API_KEY ? parseAgentConfigs() : [];
} catch (error) {
  agentConfigError = error instanceof Error ? error.message : String(error);
  console.error(`[pm-copilot] Chatbase config error: ${agentConfigError}`);
}
const chatbaseClients = CHATBASE_API_KEY
  ? agentConfigs.map((a) => new ChatbaseClient(CHATBASE_API_KEY, a))
  : [];

function describeAgents(): string {
  if (agentConfigError) return `none (config error: ${agentConfigError})`;
  if (!CHATBASE_API_KEY) return "none (set CHATBASE_API_KEY in .env)";
  if (agentConfigs.length === 0) {
    return "none (set CHATBASE_AGENTS or CHATBASE_AGENT_ID in .env)";
  }
  return agentConfigs.map((a) => a.name).join(", ");
}

// At least one source has to work, or every tool call would fail.
if (!helpscout && productliftClients.length === 0 && chatbaseClients.length === 0) {
  const hasConfigError = Boolean(helpscoutConfigError || portalConfigError || agentConfigError);
  console.error(
    "[pm-copilot] No data sources configured. Set HelpScout, ProductLift or Chatbase " +
      "credentials in .env (see .env.example)." +
      (hasConfigError ? " See the config errors above." : "")
  );
  process.exit(1);
}

const server = new McpServer({
  name: "pm-copilot",
  version: SERVER_VERSION,
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
  include_comments: boolean;
  mailbox_id?: string;
  portal_name?: string;
  agent_name?: string;
  source_filter?: string;
}

interface FetchedData {
  conversations: FormattedConversation[];
  featureRequests: FormattedFeatureRequest[];
  deflected: FormattedDeflectedConversation[];
  analysis: AnalysisResult;
  piiCategoriesRedacted: string[];
  dataSources: string[];
  warnings: string[];
  // True when every configured source failed — callers should return an error
  // instead of presenting an empty analysis as a successful result.
  fetchFailed: boolean;
  // True when any source or portal/agent failed. Such a result is returned
  // but cached only for PARTIAL_CACHE_TTL_MS, so a transient outage clears fast.
  partialFailure: boolean;
  fetchedAt: string;
}

function filterClientsByPortal(portalName: string | undefined): ProductLiftClient[] {
  if (!portalName) return productliftClients;
  return productliftClients.filter(
    (c) => c.portalName.toLowerCase() === portalName.toLowerCase()
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
  // Without HelpScout there is nothing to resolve against; fetchForTool warns.
  if (!helpscout) {
    return undefined;
  }

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

function filterClientsByAgent(agentName: string | undefined): ChatbaseClient[] {
  if (!agentName) return chatbaseClients;
  return chatbaseClients.filter(
    (c) => c.agentName.toLowerCase() === agentName.toLowerCase()
  );
}

interface SourceLeg {
  warnings: string[];
  // Clients (portals or agents) that were queried, and how many of them failed.
  // Informational warnings — an unknown filter value — are not failures.
  attempted: number;
  failed: number;
}

async function fetchChatbase(
  params: FetchParams,
  piiSink: Set<string>
): Promise<SourceLeg & { deflected: FormattedDeflectedConversation[] }> {
  if (chatbaseClients.length === 0) {
    // A filter with nothing to filter would otherwise be silently ignored while
    // the response metadata implies it was applied.
    return {
      deflected: [],
      attempted: 0,
      failed: 0,
      warnings: params.source_filter
        ? [
            `source_filter "${params.source_filter}" was ignored: no Chatbase agents are configured.`,
          ]
        : [],
    };
  }

  const clients = filterClientsByAgent(params.agent_name);
  if (clients.length === 0) {
    if (params.agent_name) {
      return {
        deflected: [],
        attempted: 0,
        failed: 0,
        warnings: [
          `No Chatbase agent named "${params.agent_name}". Configured: ${describeAgents()}`,
        ],
      };
    }
    return { deflected: [], attempted: 0, failed: 0, warnings: [] };
  }

  const warnings: string[] = [];
  let sourceFilter: string | undefined;
  if (params.source_filter) {
    const { filter, unknown } = normalizeSourceFilter(params.source_filter);
    sourceFilter = filter;
    if (unknown.length > 0) {
      warnings.push(
        `Unrecognized Chatbase conversation source(s): ${unknown.join(", ")}. ` +
          `Known values: ${CHATBASE_CONVERSATION_SOURCES.join(", ")}. ` +
          "Passed through as given — zero deflected conversations may mean the value is wrong."
      );
    }
  }

  // One agent per product, fetched in parallel and isolated — a single failing
  // agent becomes a warning rather than dropping every agent's data.
  const results = await Promise.allSettled(
    clients.map(async (client) => {
      const conversations = await client.fetchConversations(
        params.timeframe_days,
        sourceFilter
      );
      return conversations
        .map((c) => formatDeflectedConversation(c, client.agentName, piiSink))
        // A conversation with no customer turns carries no signal.
        .filter((c) => c.turnCount > 0);
    })
  );

  const deflected: FormattedDeflectedConversation[] = [];
  let failed = 0;
  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      deflected.push(...result.value);
    } else {
      failed++;
      const msg =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      warnings.push(
        scrubPii(`Chatbase agent "${clients[i]?.agentName}" fetch failed: ${msg}`).text
      );
    }
  });

  return { deflected, warnings, attempted: clients.length, failed };
}

async function fetchProductLift(
  params: FetchParams,
  piiSink: Set<string>
): Promise<SourceLeg & { requests: FormattedFeatureRequest[]; commentFailures: number }> {
  if (portalConfigs.length === 0) {
    // Same reasoning as the Chatbase leg: don't let a filter look applied.
    return {
      requests: [],
      commentFailures: 0,
      attempted: 0,
      failed: 0,
      warnings: params.portal_name
        ? [`portal_name "${params.portal_name}" was ignored: no ProductLift portals are configured.`]
        : [],
    };
  }

  const clients = filterClientsByPortal(params.portal_name);
  if (clients.length === 0) {
    // A typo'd portal name would otherwise read as "no feature requests".
    return {
      requests: [],
      commentFailures: 0,
      attempted: 0,
      failed: 0,
      warnings: [
        `No ProductLift portal named "${params.portal_name}". Configured: ${describePortals()}`,
      ],
    };
  }

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

      // Comment text is opt-in: one call per post with comments, so it
      // costs time, and it widens what customer text leaves the server.
      if (!params.include_comments) {
        return {
          formatted: combined.map((post) =>
            formatFeatureRequest({ ...post, comments: [], portal: client.portalName }, piiSink)
          ),
          commentFailures: 0,
        };
      }
      const { requests, commentFailures } = await client.withComments(combined);
      return {
        formatted: requests.map((r) => formatFeatureRequest(r, piiSink)),
        commentFailures,
      };
    })
  );

  const requests: FormattedFeatureRequest[] = [];
  const warnings: string[] = [];
  let failed = 0;
  let commentFailures = 0;
  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      requests.push(...result.value.formatted);
      commentFailures += result.value.commentFailures;
    } else {
      failed++;
      const msg =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      warnings.push(
        scrubPii(`ProductLift portal "${clients[i]?.portalName}" fetch failed: ${msg}`).text
      );
    }
  });

  if (commentFailures > 0) {
    warnings.push(
      `Comments could not be fetched for ${commentFailures} feature request(s); ` +
        "they are analyzed without comments."
    );
  }

  return { requests, commentFailures, warnings, attempted: clients.length, failed };
}

// ── Response cache ──

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
// A result with a failed source is cached briefly: long enough to absorb a
// burst of calls, short enough that a transient outage clears quickly. Not
// zero, because some failures persist (a Chatbase plan without API access)
// and would otherwise re-page every source on every call.
const PARTIAL_CACHE_TTL_MS = 30 * 1000;

interface CacheEntry {
  data: FetchedData;
  timestamp: number;
  ttlMs: number;
}

const fetchCache = new Map<string, CacheEntry>();

function cacheKey(params: FetchParams): string {
  // source_filter forks the whole entry even though it only affects the
  // Chatbase leg, so slicing one window by channel re-fetches HelpScout and
  // ProductLift each time. Correctness over efficiency; per-source caching is
  // the follow-up if channel slicing becomes a hot path.
  return `${params.timeframe_days}|${params.mailbox_id ?? ""}|${params.portal_name ?? ""}|${params.top_voted_limit}|${params.agent_name ?? ""}|${params.source_filter ?? ""}|${params.include_comments ? "comments" : ""}`;
}

async function cachedFetchAndAnalyze(params: FetchParams): Promise<FetchedData> {
  const key = cacheKey(params);
  const cached = fetchCache.get(key);
  if (cached && Date.now() - cached.timestamp < cached.ttlMs) {
    const ageSeconds = ((Date.now() - cached.timestamp) / 1000).toFixed(0);
    console.error(`[pm-copilot] Cache hit (key=${key}, age=${ageSeconds}s)`);
    return cached.data;
  }

  console.error(`[pm-copilot] Cache miss (key=${key}), fetching fresh data...`);
  const data = await fetchAndAnalyze(params);

  // Never cache a total failure, and cache a partial one only briefly.
  if (!data.fetchFailed) {
    const ttlMs = data.partialFailure ? PARTIAL_CACHE_TTL_MS : CACHE_TTL_MS;
    fetchCache.set(key, { data, timestamp: Date.now(), ttlMs });
  }

  // Evict expired entries
  for (const [k, entry] of fetchCache) {
    if (Date.now() - entry.timestamp >= entry.ttlMs) fetchCache.delete(k);
  }

  return data;
}

async function fetchAndAnalyze(params: FetchParams): Promise<FetchedData> {
  const piiCategories = new Set<string>();
  const warnings: string[] = [];
  if (!helpscout) {
    // The methodology reads "votes with zero tickets" as a want, not a need.
    // Without a ticket source that zero means "not measured", so say so.
    warnings.push(
      "HelpScout is not configured: ticket counts are absent, not zero, so severity and " +
        "convergence don't apply. Don't read zero tickets as low support demand."
    );
  }

  // Fetch every source independently — one failing doesn't block the others
  const [hsResult, plResult, cbResult] = await Promise.allSettled([
    helpscout
      ? helpscout
          .fetchConversations({
            timeframeDays: params.timeframe_days,
            mailboxId: params.mailbox_id,
          })
          .then((convs) => convs.map((c) => formatConversation(c, piiCategories)))
      : Promise.resolve([]),
    fetchProductLift(params, piiCategories),
    fetchChatbase(params, piiCategories),
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
  let productliftPartial = false;
  if (plResult.status === "fulfilled") {
    const leg = plResult.value;
    featureRequests = leg.requests;
    warnings.push(...leg.warnings);
    productliftFailed = leg.attempted > 0 && leg.failed === leg.attempted;
    productliftPartial = leg.failed > 0 || leg.commentFailures > 0;
  } else {
    productliftFailed = true;
    const msg = plResult.reason instanceof Error
      ? plResult.reason.message
      : String(plResult.reason);
    warnings.push(scrubPii(`ProductLift fetch failed: ${msg}`).text);
    console.error(`[pm-copilot] ProductLift error: ${msg}`);
  }

  let deflected: FormattedDeflectedConversation[] = [];
  let chatbaseFailed = false;
  let chatbasePartial = false;
  if (cbResult.status === "fulfilled") {
    const leg = cbResult.value;
    deflected = leg.deflected;
    warnings.push(...leg.warnings);
    chatbaseFailed = leg.attempted > 0 && leg.failed === leg.attempted;
    chatbasePartial = leg.failed > 0;
  } else {
    chatbaseFailed = true;
    const msg = cbResult.reason instanceof Error
      ? cbResult.reason.message
      : String(cbResult.reason);
    warnings.push(scrubPii(`Chatbase fetch failed: ${msg}`).text);
    console.error(`[pm-copilot] Chatbase error: ${msg}`);
  }

  // Total failure = every configured source failed. Any source may be
  // unconfigured: HelpScout-only, ProductLift-only and Chatbase-only setups are
  // all legitimate.
  const statusOf = (configured: boolean, failed: boolean): SourceStatus =>
    !configured ? "unconfigured" : failed ? "failed" : "ok";
  const fetchFailed = allConfiguredFailed([
    statusOf(helpscout !== null, hsResult.status === "rejected"),
    statusOf(portalConfigs.length > 0, productliftFailed),
    statusOf(chatbaseClients.length > 0, chatbaseFailed),
  ]);
  const partialFailure =
    hsResult.status === "rejected" ||
    plResult.status === "rejected" ||
    cbResult.status === "rejected" ||
    productliftPartial ||
    chatbasePartial;

  const config = loadThemesConfig();
  const analysis = analyzeFeedback(conversations, featureRequests, config, deflected);

  const dataSources = [
    ...(conversations.length > 0 ? ["helpscout_tickets"] : []),
    ...(featureRequests.length > 0 ? ["productlift_votes"] : []),
    ...(deflected.length > 0 ? ["chatbase_conversations"] : []),
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
    deflected,
    analysis,
    piiCategoriesRedacted: [...piiCategories],
    dataSources,
    warnings,
    fetchFailed,
    partialFailure,
    fetchedAt: new Date().toISOString(),
  };
}

// ── Tools ──

// Filters shared by synthesize_feedback and generate_product_plan.
const ANALYSIS_FILTERS = {
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
    .describe(
      "Top-voted feature requests to include per portal (default: 50). " +
      "Recent requests within the timeframe are always included as well."
    ),
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
  agent_name: z
    .string()
    .optional()
    .describe("Chatbase agent name to filter by (optional) — run list_sources to see names"),
  source_filter: z
    .string()
    .optional()
    .describe(
      "Chatbase conversation source(s) to filter by (optional), comma-separated for " +
      "multiple. Case-insensitive. Examples: 'Widget or Iframe', 'WhatsApp,API'. " +
      "Run list_sources to see available sources."
    ),
  include_comments: z
    .boolean()
    .default(false)
    .describe(
      "Also fetch customer comment text on feature requests (PII-scrubbed, commenter names and " +
      "admin replies dropped) for theme matching and quotes (default: false). Expect a modest " +
      "gain: a few extra matches per theme. Costs one API call per request with comments " +
      "against ProductLift's 120-a-minute limit, so on large portals a call can take close " +
      "to a minute."
    ),
};

interface AnalysisFilterArgs {
  timeframe_days: number;
  top_voted_limit: number;
  include_comments: boolean;
  mailbox_id?: string;
  mailbox_name?: string;
  portal_name?: string;
  agent_name?: string;
  source_filter?: string;
}

/**
 * Resolve the mailbox name and run the cached fetch + analysis. The name is
 * resolved here, at the handler boundary, so the cache key only ever sees an ID.
 */
async function fetchForTool(
  args: AnalysisFilterArgs
): Promise<{ data: FetchedData; resolvedMailboxId: string | undefined }> {
  const resolvedMailboxId = await resolveMailboxId(args.mailbox_name, args.mailbox_id);
  const cached = await cachedFetchAndAnalyze({
    timeframe_days: args.timeframe_days,
    top_voted_limit: args.top_voted_limit,
    include_comments: args.include_comments,
    // An ignored mailbox filter must not fork the cache entry.
    mailbox_id: helpscout ? resolvedMailboxId : undefined,
    portal_name: args.portal_name,
    agent_name: args.agent_name,
    source_filter: args.source_filter,
  });

  // Same reasoning as portal_name and agent_name: don't let a filter look
  // applied. Warn on a copy so the cached entry is never mutated.
  const mailboxFilter = args.mailbox_name ?? args.mailbox_id;
  if (helpscout || !mailboxFilter) {
    return { data: cached, resolvedMailboxId };
  }
  const warning = `Mailbox filter "${mailboxFilter}" was ignored: HelpScout is not configured.`;
  return { data: { ...cached, warnings: [...cached.warnings, warning] }, resolvedMailboxId };
}

function allSourcesFailed(warnings: string[]) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Error: all data sources failed to fetch.\n${warnings.join("\n")}`,
      },
    ],
    isError: true,
  };
}

server.registerTool("synthesize_feedback", {
  title: "Synthesize Customer Feedback",
  annotations: READ_ONLY_TOOL,
  description:
    "Cross-reference support tickets (HelpScout), feature requests (ProductLift) and AI " +
    "support agent conversations (Chatbase) to find convergent signals. Returns theme-matched " +
    "analysis with priority scores. Convergent themes (appearing in both support and feature " +
    "requests) get a 2x priority boost. Chat conversations count toward frequency and carry a " +
    "self_serve_failure_rate per theme, but do not change the boost. " +
    "Scoring follows the pm-copilot://methodology resource; scores are normalized " +
    "within a call and not comparable across calls. This is the lower-level analysis " +
    "tool — use generate_product_plan for a ranked plan with KPI context. " +
    `HelpScout: ${describeHelpScout()}. Configured portals: ${describePortals()}. ` +
    `Configured Chatbase agents: ${describeAgents()}`,
  inputSchema: {
    ...ANALYSIS_FILTERS,
    detail_level: z
      .enum(["summary", "standard", "full"])
      .default("summary")
      .describe(
        "Level of detail in response. " +
        "'summary' (default, ~15KB): scores, quotes, evidence summaries — optimized for LLM consumption. " +
        "'standard' (~85KB): adds data point titles per theme. " +
        "'full' (several hundred KB): all data points — for export/dashboard use, not LLM consumption."
      ),
  },
}, async ({ timeframe_days, top_voted_limit, include_comments, mailbox_id, mailbox_name, portal_name, agent_name, source_filter, detail_level }) => {
  try {
    const { data, resolvedMailboxId } = await fetchForTool({
      timeframe_days,
      top_voted_limit,
      include_comments,
      mailbox_id,
      mailbox_name,
      portal_name,
      agent_name,
      source_filter,
    });

    if (data.fetchFailed) {
      return allSourcesFailed(data.warnings);
    }

    const trimmedAnalysis = trimAnalysisForDetail(
      data.analysis,
      detail_level,
      data.conversations,
      data.featureRequests,
      data.deflected
    );

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              timeframe_days,
              detail_level,
              // Like source_filter below: only echo a filter that applied.
              mailbox_id: helpscout ? (resolvedMailboxId ?? null) : null,
              mailbox_name: helpscout ? (mailbox_name ?? null) : null,
              portal_name: portal_name ?? "all",
              agent_name: agent_name ?? (chatbaseClients.length > 0 ? "all" : null),
              // Only claim a filter when there is a Chatbase leg it applies to —
              // when unconfigured, fetchChatbase warns and this reads null.
              source_filter: chatbaseClients.length > 0 ? (source_filter ?? "all") : null,
              top_voted_limit,
              include_comments,
              // When the data was fetched — up to the cache TTL old on a hit.
              fetched_at: data.fetchedAt,
              pii_scrubbing_applied: true,
              pii_categories_redacted: data.piiCategoriesRedacted,
              ...(data.warnings.length > 0 && { warnings: data.warnings }),
              analysis: trimmedAnalysis,
            },
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
    ai_chat_conversations?: number;
    self_serve_failure_rate?: number | null;
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
    deflected_signals?: number;
    themes_detected: number;
    convergent_themes: number;
    unmatched_signals: number;
  };
  priorities: PlanPriorityForRender[];
  emerging: Array<{ pattern: string; frequency: number }>;
  kpiContext?: string;
  warnings: string[];
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
  const signalParts = [
    `${summary.reactive_signals} support tickets`,
    `${summary.proactive_signals} feature requests`,
  ];
  if (summary.deflected_signals !== undefined) {
    signalParts.push(`${summary.deflected_signals} AI chat conversations`);
  }
  lines.push(
    `**Signals:** ${summary.total_signals_analyzed} analyzed ` +
      `(${signalParts.join(", ")}) · ` +
      `${summary.themes_detected} themes (${summary.convergent_themes} convergent) · ` +
      `${summary.unmatched_signals} unmatched`
  );
  lines.push("");

  if (args.priorities.length > 0) {
    // The chat column only earns its place when a Chatbase source is configured.
    const hasChat = args.priorities.some(
      (p) => p.evidence.ai_chat_conversations !== undefined
    );
    lines.push("## Priorities");
    lines.push("");
    if (hasChat) {
      lines.push("| # | Theme | Score | Tickets | FRs | Chats | Self-serve fail | Signal |");
      lines.push("|---|-------|------:|--------:|----:|------:|----------------:|--------|");
    } else {
      lines.push("| # | Theme | Score | Tickets | FRs | Signal |");
      lines.push("|---|-------|------:|--------:|----:|--------|");
    }
    for (const p of args.priorities) {
      const chatCells = hasChat
        ? `${p.evidence.ai_chat_conversations ?? 0} | ` +
          `${
            p.evidence.self_serve_failure_rate === undefined ||
            p.evidence.self_serve_failure_rate === null
              ? "—"
              : `${Math.round(p.evidence.self_serve_failure_rate * 100)}%`
          } | `
        : "";
      lines.push(
        `| ${p.rank} | ${p.theme} | ${p.priority_score} | ` +
          `${p.evidence.support_tickets} | ${p.evidence.feature_requests} | ` +
          chatCells +
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

  if (args.warnings.length > 0) {
    lines.push("## Warnings");
    lines.push("");
    for (const w of args.warnings) {
      lines.push(`- ${w}`);
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
  annotations: READ_ONLY_TOOL,
  description:
    "Build a prioritized product plan by cross-referencing HelpScout support tickets, " +
    "ProductLift feature requests, and Chatbase AI support agent conversations. Optionally " +
    "accepts business metrics from other MCP servers (Metabase, GA, etc.) via kpi_context to " +
    "inform prioritization. References the pm-copilot://methodology resource for planning " +
    "framework. Returns top priorities with evidence, customer quotes, and recommended actions. " +
    "Use synthesize_feedback instead for the underlying theme analysis without plan framing. " +
    `HelpScout: ${describeHelpScout()}. Configured portals: ${describePortals()}. ` +
    `Configured Chatbase agents: ${describeAgents()}`,
  inputSchema: {
    ...ANALYSIS_FILTERS,
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
}, async ({ timeframe_days, top_voted_limit, include_comments, mailbox_id, mailbox_name, portal_name, agent_name, source_filter, kpi_context, max_priorities, preview_only, detail_level, format }) => {
  try {
    // Preview mode: show what would be sent without fetching
    if (preview_only) {
      const previewSources: string[] = [];
      if (helpscout) {
        previewSources.push("helpscout_tickets");
      }
      if (portalConfigs.length > 0) previewSources.push("productlift_votes");
      if (chatbaseClients.length > 0) previewSources.push("chatbase_conversations");

      const filteredPortals = portal_name
        ? portalConfigs.filter((c) => c.name.toLowerCase() === portal_name.toLowerCase()).map((c) => c.name)
        : portalConfigs.map((c) => c.name);

      const filteredAgents = agent_name
        ? agentConfigs.filter((a) => a.name.toLowerCase() === agent_name.toLowerCase()).map((a) => a.name)
        : agentConfigs.map((a) => a.name);

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
                  will_fetch: helpscout
                    ? "support conversation summaries (subject + preview, not full message bodies)"
                    : "SKIPPED (not configured)",
                  timeframe_days,
                  mailbox_filter: mailbox_name ?? mailbox_id ?? "all",
                  fields_sent: ["subject (PII-scrubbed)", "preview snippet (PII-scrubbed)", "tags", "status", "created/closed timestamps", "thread count"],
                  fields_NOT_sent: ["customer email (always redacted)", "full thread/message bodies (never fetched)", "attachments"],
                },
                productlift: {
                  will_fetch: portalConfigs.length === 0
                    ? "SKIPPED (not configured)"
                    : include_comments
                      ? "feature request posts plus comment text (include_comments: true)"
                      : "feature request posts (comment text is NOT fetched; set include_comments to add it)",
                  portals: filteredPortals,
                  top_voted_limit,
                  fields_sent: [
                    "title (PII-scrubbed)",
                    "description (PII-scrubbed)",
                    "url (PII-scrubbed)",
                    ...(include_comments ? ["customer comment text (PII-scrubbed; admin replies excluded)"] : []),
                    "vote count",
                    "comment count",
                    "status",
                    "timestamps",
                  ],
                  fields_NOT_sent: [
                    ...(include_comments ? [] : ["comment text (include_comments is false)"]),
                    "voter identities",
                    "commenter names and emails",
                    ...(include_comments ? ["admin/staff comment replies"] : []),
                  ],
                },
                chatbase: {
                  will_fetch: chatbaseClients.length > 0
                    ? "AI support agent conversations, customer turns only"
                    : "SKIPPED (not configured)",
                  agents: filteredAgents,
                  // Only meaningful when the Chatbase fetch actually runs.
                  ...(chatbaseClients.length > 0 && {
                    source_filter: source_filter ?? "all",
                  }),
                  timeframe_days,
                  fields_sent: ["customer messages (PII-scrubbed)", "channel", "answer confidence (min_score)", "turn count", "created timestamp"],
                  fields_NOT_sent: ["assistant/bot replies", "captured lead form submissions", "end-user identifiers", "country"],
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
              }
            ),
          },
        ],
      };
    }

    // Full execution: fetch, analyze, build plan.
    const { data } = await fetchForTool({
      timeframe_days,
      top_voted_limit,
      include_comments,
      mailbox_id,
      mailbox_name,
      portal_name,
      agent_name,
      source_filter,
    });

    if (data.fetchFailed) {
      return allSourcesFailed(data.warnings);
    }

    // Build lookup maps for quote extraction
    const {
      convMap: conversationMap,
      reqMap: featureRequestMap,
      deflectedMap,
    } = buildLookupMaps(data.conversations, data.featureRequests, data.deflected);

    // Build priorities from top themes
    const topThemes = data.analysis.themes.slice(0, max_priorities);

    const priorities = topThemes.map((theme, index) => {
      const quotes = extractQuotesForTheme(
        theme.data_points,
        conversationMap,
        featureRequestMap,
        3,
        deflectedMap
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
          ...(theme.deflected_count > 0 && {
            ai_chat_conversations: theme.deflected_count,
            self_serve_failure_rate: theme.self_serve_failure_rate,
            mean_answer_confidence: theme.mean_answer_confidence,
          }),
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
        ...(data.analysis.deflected_count > 0 && {
          deflected_signals: data.analysis.deflected_count,
        }),
        ...(data.analysis.chatbase_sources && {
          chatbase_sources: data.analysis.chatbase_sources,
        }),
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
            warnings: data.warnings,
          })
        : JSON.stringify(plan);

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

server.registerTool("get_theme_evidence", {
  title: "Get Theme Evidence",
  annotations: READ_ONLY_TOOL,
  description:
    "Drill into one theme from synthesize_feedback or generate_product_plan: returns the " +
    "individual support tickets, feature requests and AI chat conversations behind it, " +
    "newest first, with ticket numbers, request URLs, votes, channels and dates. Pass the " +
    "same filters as the analysis call within a few minutes to reuse its cached data (no " +
    "new API calls). Returns identifiers, metadata and scrubbed titles (for chats, the " +
    "opening customer message, truncated), not full conversations.",
  inputSchema: {
    theme_id: z
      .string()
      .describe("Theme to drill into, e.g. 'booking-scheduling' (the theme_id from the analysis)"),
    source: z
      .enum(["all", "tickets", "feature_requests", "chats"])
      .default("all")
      .describe("Which records to return (default: all)"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_EVIDENCE_LIMIT)
      .default(DEFAULT_EVIDENCE_LIMIT)
      .describe(
        `Max records per source (default: ${DEFAULT_EVIDENCE_LIMIT}, max: ${MAX_EVIDENCE_LIMIT}), ` +
        "so a high-volume source can't crowd out the others"
      ),
    ...ANALYSIS_FILTERS,
  },
}, async ({ theme_id, source, limit, timeframe_days, top_voted_limit, include_comments, mailbox_id, mailbox_name, portal_name, agent_name, source_filter }) => {
  try {
    // Validate before fetching, so a typo costs no API calls.
    const configuredThemes = loadThemesConfig().themes;
    const themeIds = configuredThemes.map((t) => t.id);
    if (!themeIds.includes(theme_id)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: unknown theme_id "${theme_id}". Available: ${themeIds.join(", ")}`,
          },
        ],
        isError: true,
      };
    }

    const { data } = await fetchForTool({
      timeframe_days,
      top_voted_limit,
      include_comments,
      mailbox_id,
      mailbox_name,
      portal_name,
      agent_name,
      source_filter,
    });

    if (data.fetchFailed) {
      return allSourcesFailed(data.warnings);
    }

    // A configured theme with no matches in this window is absent, not an error.
    const theme = data.analysis.themes.find((t) => t.theme_id === theme_id);
    const evidence = theme
      ? buildThemeEvidence(theme, data.conversations, data.featureRequests, data.deflected, {
          source,
          limit,
        })
      : { counts: { tickets: 0, feature_requests: 0, chats: 0 }, truncated: false, evidence: [] };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            theme_id,
            label: theme?.label ?? configuredThemes.find((t) => t.id === theme_id)?.label ?? null,
            priority_score: theme?.priority_score ?? null,
            ...(!theme && { note: "No matches for this theme in this window." }),
            source,
            limit,
            timeframe_days,
            fetched_at: data.fetchedAt,
            pii_scrubbing_applied: true,
            pii_categories_redacted: data.piiCategoriesRedacted,
            ...(data.warnings.length > 0 && { warnings: data.warnings }),
            ...evidence,
          }),
        },
      ],
    };
  } catch (error) {
    return toErrorResult(error);
  }
});

server.registerTool("get_feature_requests", {
  title: "Get Feature Requests",
  annotations: READ_ONLY_TOOL,
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
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_FEATURE_REQUEST_LIMIT)
      .optional()
      .describe(
        "Max feature requests to return per portal, applied after the status filter and sort " +
        "(optional). Recommended on large portals: comments are fetched only for what's kept."
      ),
    sort: z
      .enum(["votes", "recent"])
      .optional()
      .describe(
        "Order before the limit is applied: 'votes' (most voted first) or 'recent' (newest " +
        "first). Omit to keep the portal's own order."
      ),
  },
}, async ({ portal_name, include_comments, status, limit, sort }) => {
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

    // Fetch portals in parallel, each isolated — one failing portal becomes
    // a warning instead of dropping every portal's data
    const allRequests: FeatureRequest[] = [];
    const warnings: string[] = [];
    let commentFailures = 0;
    const results = await Promise.allSettled(
      clients.map((client) =>
        client.fetchFeatureRequests({
          includeComments: include_comments,
          status: status || undefined,
          limit,
          sort,
        })
      )
    );
    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        allRequests.push(...result.value.requests);
        commentFailures += result.value.commentFailures;
      } else {
        const reason = result.reason;
        const msg = reason instanceof Error ? reason.message : String(reason);
        const client = clients[i];
        warnings.push(
          scrubPii(`ProductLift portal "${client?.portalName}" fetch failed: ${msg}`).text
        );
      }
    });

    if (commentFailures > 0) {
      warnings.push(
        `Comments could not be fetched for ${commentFailures} feature request(s); ` +
          "they are returned without comments."
      );
    }

    if (allRequests.length === 0 && warnings.length > 0) {
      return {
        content: [{ type: "text" as const, text: `Error: ${warnings.join("; ")}` }],
        isError: true,
      };
    }

    // Status filtering happens in fetchFeatureRequests, before comments are
    // fetched, so filtered-out posts cost no comment API calls.
    const piiCategories = new Set<string>();
    const formatted = allRequests.map((r) => formatFeatureRequest(r, piiCategories));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              portal_filter: portal_name ?? "all",
              status_filter: status ?? "all",
              limit_per_portal: limit ?? null,
              sort: sort ?? null,
              total_feature_requests: formatted.length,
              fetched_at: new Date().toISOString(),
              pii_scrubbing_applied: true,
              pii_categories_redacted: [...piiCategories],
              ...(warnings.length > 0 && { warnings }),
              feature_requests: formatted,
            },
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
  annotations: READ_ONLY_TOOL,
  description:
    "List the data sources this server is connected to: HelpScout mailboxes (id + name), " +
    "ProductLift portals (name + url), and Chatbase agents (name), plus the conversation " +
    "source values accepted by the source_filter parameter. Use these names with the " +
    "mailbox_name / portal_name / agent_name / source_filter parameters on the other tools. " +
    "Read-only; never returns API keys or customer data.",
  inputSchema: {},
}, async () => {
  try {
    // Project explicit fields — never spread portalConfigs (it carries apiKey).
    const productlift_portals = portalConfigs.map((c) => ({
      name: c.name,
      baseUrl: c.baseUrl,
    }));

    // Agent ids are not secrets, but the account-wide API key lives outside this
    // config and is never included.
    const chatbase_agents = agentConfigs.map((a) => ({
      name: a.name,
      agentId: a.agentId,
    }));

    let helpscout_mailboxes: Mailbox[] = [];
    const warnings: string[] = [];
    if (helpscoutConfigError) {
      warnings.push(`HelpScout config error: ${helpscoutConfigError}`);
    }
    if (portalConfigError) {
      warnings.push(`ProductLift config error: ${portalConfigError}`);
    }
    if (agentConfigError) {
      warnings.push(`Chatbase config error: ${agentConfigError}`);
    }
    try {
      helpscout_mailboxes = helpscout ? await helpscout.fetchMailboxes() : [];
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      warnings.push(scrubPii(`HelpScout mailbox fetch failed: ${msg}`).text);
      console.error(`[pm-copilot] list_sources HelpScout error: ${msg}`);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              fetched_at: new Date().toISOString(),
              helpscout_configured: helpscout !== null,
              helpscout_mailboxes,
              productlift_portals,
              chatbase_agents,
              // The valid source_filter values — a fixed list from the Chatbase
              // docs, not queried per account.
              ...(agentConfigs.length > 0 && {
                chatbase_conversation_sources: [...CHATBASE_CONVERSATION_SOURCES],
              }),
              ...(warnings.length > 0 && { warnings }),
            },
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
