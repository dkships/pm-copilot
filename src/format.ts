/**
 * Format layer — shapes raw API objects into the scrubbed, analysis-ready
 * structures that leave the server. PII scrubbing happens here, before any
 * text enters analysis or a tool response.
 *
 * Everything in this module is pure: no clients, no env, no module state.
 */

import type { Conversation } from "./helpscout.js";
import type { FeatureRequest } from "./productlift.js";
import type {
  AnalysisResult,
  DetailLevel,
  SignalType,
  ThemeMatch,
  FormattedConversation,
  FormattedFeatureRequest,
} from "./feedback-analyzer.js";
import { scrubPii, scrubPiiArray } from "./pii-scrubber.js";

// ── Formatting (PII scrubbing happens here) ──

// PII categories found while formatting are collected into an explicit
// per-request sink (never a module global — concurrent tool calls interleave).
export function formatConversation(
  conv: Conversation,
  piiSink: Set<string>
): FormattedConversation {
  // Thread bodies are excluded by design — subject + preview carry the customer voice
  const rawMessages = [conv.preview].filter(Boolean);
  const { texts: customerMessages, piiCategoriesFound } = scrubPiiArray(rawMessages);
  const subjectScrub = scrubPii(conv.subject ?? "");
  const previewScrub = scrubPii(conv.preview ?? "");
  for (const cat of [...piiCategoriesFound, ...subjectScrub.piiCategoriesFound, ...previewScrub.piiCategoriesFound]) {
    piiSink.add(cat);
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
    threadCount: conv.threads ?? 0,
  };
}

export function formatFeatureRequest(
  req: FeatureRequest,
  piiSink: Set<string>
): FormattedFeatureRequest {
  const titleScrub = scrubPii(req.title);
  const descScrub = scrubPii(req.description);
  for (const cat of [...titleScrub.piiCategoriesFound, ...descScrub.piiCategoriesFound]) {
    piiSink.add(cat);
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
    url: req.url,
    created_at: req.created_at,
    updated_at: req.updated_at,
    comments: req.comments.map((c) => {
      const commentScrub = scrubPii(c.comment);
      for (const cat of commentScrub.piiCategoriesFound) piiSink.add(cat);
      // Commenter names are deliberately dropped — only the role leaves the
      // server, consistent with the voter-identity exclusion.
      return {
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
  // Generic support-agent phrasing
  /we're aiming to .* get back to you/i,
  /before i proceed/i,
];

export function isLikelyAgentResponse(text: string): boolean {
  if (!text || text.length === 0) return true;
  for (const pattern of AGENT_RESPONSE_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

// ── Shared response-shaping helpers ──

export function toErrorResult(error: unknown) {
  const message = error instanceof Error ? error.message : "Unknown error";
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true as const,
  };
}

export function buildLookupMaps(
  conversations: FormattedConversation[],
  featureRequests: FormattedFeatureRequest[]
): {
  convMap: Map<string, FormattedConversation>;
  reqMap: Map<string, FormattedFeatureRequest>;
} {
  const convMap = new Map<string, FormattedConversation>();
  for (const conv of conversations) convMap.set(`hs-${conv.id}`, conv);
  const reqMap = new Map<string, FormattedFeatureRequest>();
  for (const req of featureRequests) reqMap.set(`pl-${req.id}`, req);
  return { convMap, reqMap };
}

export function signalTypeOf(
  theme: ThemeMatch
): "convergent" | "reactive" | "proactive" {
  if (theme.convergent) return "convergent";
  return theme.reactive_count > 0 ? "reactive" : "proactive";
}

const MAX_TITLES = 50;

export function capTitles(dataPoints: ThemeMatch["data_points"]): {
  data_points_total: number;
  data_point_titles: string[];
  data_point_titles_truncated?: true;
} {
  const allTitles = dataPoints.map((dp) => dp.title);
  return {
    data_points_total: allTitles.length,
    data_point_titles: allTitles.slice(0, MAX_TITLES),
    ...(allTitles.length > MAX_TITLES && {
      data_point_titles_truncated: true as const,
    }),
  };
}

// ── Quote extraction for product plans ──

export function extractQuotesForTheme(
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

      // Prefer customer message that isn't agent text, fall back to subject.
      // Collapse whitespace so embedded newlines can't break markdown output.
      const msg = (conv.customerMessages[0] ?? "").replace(/\s+/g, " ").trim();
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
          const msg = customerComment.comment.replace(/\s+/g, " ").trim();
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

export function buildEvidenceSummary(theme: ThemeMatch): string {
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

export function trimAnalysisForDetail(
  analysis: AnalysisResult,
  level: DetailLevel,
  conversations: FormattedConversation[],
  featureRequests: FormattedFeatureRequest[]
): unknown {
  if (level === "full") return analysis;

  const { convMap, reqMap } = buildLookupMaps(conversations, featureRequests);

  const themes = analysis.themes.map((theme) => {
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
      signal_type: signalTypeOf(theme),
      reactive_count: theme.reactive_count,
      proactive_count: theme.proactive_count,
      evidence_summary: buildEvidenceSummary(theme),
      representative_quotes: quotes,
    };

    if (level === "summary") return base;

    // standard: add sub-scores + data point titles (capped)
    return {
      ...base,
      frequency_score: theme.frequency_score,
      severity_score: theme.severity_score,
      vote_momentum_score: theme.vote_momentum_score,
      ...capTitles(theme.data_points),
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
