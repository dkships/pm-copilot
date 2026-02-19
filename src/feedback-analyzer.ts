import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── Types ──

export type SignalType = "REACTIVE" | "PROACTIVE";
export type DetailLevel = "summary" | "standard" | "full";

export interface DataPoint {
  id: string;
  source: SignalType;
  title: string;
  text: string; // cleaned concat of all text
  created_at: string;
  metadata: {
    tags?: string[];
    votes?: number;
    comments_count?: number;
    thread_count?: number;
    portal?: string;
  };
}

export interface ThemeMatch {
  theme_id: string;
  label: string;
  category: string;
  reactive_count: number;
  proactive_count: number;
  convergent: boolean;
  frequency_score: number;
  severity_score: number;
  vote_momentum_score: number;
  priority_score: number;
  data_points: Array<{ id: string; source: SignalType; title: string }>;
}

export interface EmergingTheme {
  ngram: string;
  frequency: number;
  data_points: Array<{ id: string; source: SignalType; title: string }>;
}

export interface AnalysisResult {
  config_version: number;
  known_themes_count: number;
  total_data_points: number;
  reactive_count: number;
  proactive_count: number;
  themes: ThemeMatch[];
  emerging_themes: EmergingTheme[];
  unmatched_count: number;
}

export interface ThemeDefinition {
  id: string;
  label: string;
  keywords: string[];
  category: string;
}

export interface ThemesConfig {
  version: number;
  themes: ThemeDefinition[];
  stop_words: string[];
  emerging_theme_min_frequency: number;
}

// ── Formatted shapes from index.ts ──

export interface FormattedConversation {
  id: number;
  number: number;
  subject: string;
  status: string;
  createdAt: string;
  closedAt: string | null;
  customerEmail: string;
  tags: string[];
  preview: string;
  customerMessages: string[];
  threadCount: number;
}

export interface FormattedFeatureRequest {
  id: string;
  title: string;
  description: string;
  status: string | null;
  category: string | null;
  votes_count: number;
  comments_count: number;
  portal: string;
  created_at: string;
  updated_at: string;
  comments: Array<{
    author: string;
    role: string;
    comment: string;
    created_at: string | null;
  }>;
}

// ── Config loader ──

export function loadThemesConfig(): ThemesConfig {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const configPath = resolve(__dirname, "..", "themes.config.json");
  const raw = readFileSync(configPath, "utf-8");
  return JSON.parse(raw) as ThemesConfig;
}

// ── Data normalization ──

function conversationToDataPoint(conv: FormattedConversation): DataPoint {
  const textParts = [conv.subject, conv.preview, ...conv.customerMessages];
  return {
    id: `hs-${conv.id}`,
    source: "REACTIVE",
    title: conv.subject,
    text: textParts.join(" ").toLowerCase(),
    created_at: conv.createdAt,
    metadata: {
      tags: conv.tags,
      thread_count: conv.threadCount,
    },
  };
}

function featureRequestToDataPoint(req: FormattedFeatureRequest): DataPoint {
  const textParts = [
    req.title,
    req.description,
    ...req.comments.map((c) => c.comment),
  ];
  return {
    id: `pl-${req.id}`,
    source: "PROACTIVE",
    title: req.title,
    text: textParts.join(" ").toLowerCase(),
    created_at: req.created_at,
    metadata: {
      votes: req.votes_count,
      comments_count: req.comments_count,
      portal: req.portal,
    },
  };
}

// ── Theme matching ──

function matchesTheme(text: string, keywords: string[]): boolean {
  for (const kw of keywords) {
    if (kw.includes(" ")) {
      // Multi-word: substring match
      if (text.includes(kw.toLowerCase())) return true;
    } else {
      // Single-word: word boundary regex
      const regex = new RegExp(`\\b${escapeRegex(kw)}\\b`, "i");
      if (regex.test(text)) return true;
    }
  }
  return false;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Scoring ──

const SEVERITY_TAG_BOOST: Record<string, number> = {
  bug: 20,
  urgent: 25,
  escalation: 30,
  escalated: 30,
  critical: 25,
};

function computeSeverityScore(points: DataPoint[]): number {
  const reactive = points.filter((p) => p.source === "REACTIVE");
  if (reactive.length === 0) return 0;

  let totalScore = 0;
  const now = Date.now();

  for (const p of reactive) {
    let pointScore = 0;

    // Thread count contributes (more back-and-forth = more severe)
    const threads = p.metadata.thread_count ?? 1;
    pointScore += Math.min(threads * 10, 50); // cap at 50

    // Recency: exponential decay (half-life of 7 days)
    const ageMs = now - new Date(p.created_at).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    const recencyBoost = 30 * Math.exp(-ageDays / 7);
    pointScore += recencyBoost;

    // Tag boost
    for (const tag of p.metadata.tags ?? []) {
      const boost = SEVERITY_TAG_BOOST[tag.toLowerCase()];
      if (boost) {
        pointScore += boost;
        break; // only apply one tag boost per point
      }
    }

    totalScore += pointScore;
  }

  // Average per reactive point, cap at 100
  return Math.min(totalScore / reactive.length, 100);
}

function computeVoteMomentum(points: DataPoint[]): number {
  const proactive = points.filter((p) => p.source === "PROACTIVE");
  if (proactive.length === 0) return 0;

  let totalVotes = 0;
  let totalComments = 0;

  for (const p of proactive) {
    totalVotes += p.metadata.votes ?? 0;
    totalComments += p.metadata.comments_count ?? 0;
  }

  // Raw score: 80% votes + 20% comments
  return totalVotes * 0.8 + totalComments * 0.2;
}

// ── Emerging theme detection ──

function tokenize(text: string, stopWords: Set<string>): string[] {
  return text
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));
}

function extractNgrams(tokens: string[]): string[] {
  const ngrams: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    ngrams.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  for (let i = 0; i < tokens.length - 2; i++) {
    ngrams.push(`${tokens[i]} ${tokens[i + 1]} ${tokens[i + 2]}`);
  }
  return ngrams;
}

function detectEmergingThemes(
  unmatchedPoints: DataPoint[],
  stopWords: Set<string>,
  minFrequency: number
): EmergingTheme[] {
  // Count n-gram frequency across all unmatched points, tracking which points contain each
  const ngramToPoints = new Map<string, Set<number>>();

  for (let i = 0; i < unmatchedPoints.length; i++) {
    const tokens = tokenize(unmatchedPoints[i]!.text, stopWords);
    const ngrams = extractNgrams(tokens);
    const seen = new Set<string>();
    for (const ng of ngrams) {
      if (seen.has(ng)) continue; // count once per data point
      seen.add(ng);
      if (!ngramToPoints.has(ng)) ngramToPoints.set(ng, new Set());
      ngramToPoints.get(ng)!.add(i);
    }
  }

  // Sort by frequency descending
  const sorted = [...ngramToPoints.entries()]
    .filter(([, pts]) => pts.size >= minFrequency)
    .sort((a, b) => b[1].size - a[1].size);

  // Greedy clustering: claim data points
  const claimed = new Set<number>();
  const emerging: EmergingTheme[] = [];

  for (const [ngram, pointIndices] of sorted) {
    const unclaimed = [...pointIndices].filter((i) => !claimed.has(i));
    if (unclaimed.length < minFrequency) continue;

    for (const i of unclaimed) claimed.add(i);

    emerging.push({
      ngram,
      frequency: unclaimed.length,
      data_points: unclaimed.map((i) => {
        const p = unmatchedPoints[i]!;
        return { id: p.id, source: p.source, title: p.title };
      }),
    });
  }

  return emerging;
}

// ── Main analysis function ──

export function analyzeFeedback(
  conversations: FormattedConversation[],
  featureRequests: FormattedFeatureRequest[],
  config: ThemesConfig
): AnalysisResult {
  // Normalize to DataPoints
  const dataPoints: DataPoint[] = [
    ...conversations.map(conversationToDataPoint),
    ...featureRequests.map(featureRequestToDataPoint),
  ];

  // Match data points to themes
  const themeMatches = new Map<string, DataPoint[]>();
  const matchedIds = new Set<string>();

  for (const theme of config.themes) {
    themeMatches.set(theme.id, []);
  }

  for (const dp of dataPoints) {
    for (const theme of config.themes) {
      if (matchesTheme(dp.text, theme.keywords)) {
        themeMatches.get(theme.id)!.push(dp);
        matchedIds.add(dp.id);
      }
    }
  }

  // Compute raw scores for normalization
  const frequencyCounts: number[] = [];
  const rawVoteMomentums: number[] = [];

  for (const theme of config.themes) {
    const points = themeMatches.get(theme.id)!;
    frequencyCounts.push(points.length);
    rawVoteMomentums.push(computeVoteMomentum(points));
  }

  const maxFrequency = Math.max(...frequencyCounts, 1);
  const maxVoteMomentum = Math.max(...rawVoteMomentums, 1);

  // Build ThemeMatch results
  const themes: ThemeMatch[] = [];

  for (let i = 0; i < config.themes.length; i++) {
    const theme = config.themes[i]!;
    const points = themeMatches.get(theme.id)!;
    if (points.length === 0) continue;

    const reactiveCount = points.filter((p) => p.source === "REACTIVE").length;
    const proactiveCount = points.filter((p) => p.source === "PROACTIVE").length;
    const convergent = reactiveCount > 0 && proactiveCount > 0;

    const frequencyScore = (frequencyCounts[i]! / maxFrequency) * 100;
    const severityScore = computeSeverityScore(points);
    const voteMomentumScore =
      (rawVoteMomentums[i]! / maxVoteMomentum) * 100;

    const convergenceBoost = convergent ? 2 : 1;
    const priorityScore =
      (frequencyScore * 0.35 +
        severityScore * 0.35 +
        voteMomentumScore * 0.3) *
      convergenceBoost;

    themes.push({
      theme_id: theme.id,
      label: theme.label,
      category: theme.category,
      reactive_count: reactiveCount,
      proactive_count: proactiveCount,
      convergent,
      frequency_score: round2(frequencyScore),
      severity_score: round2(severityScore),
      vote_momentum_score: round2(voteMomentumScore),
      priority_score: round2(priorityScore),
      data_points: points.map((p) => ({
        id: p.id,
        source: p.source,
        title: p.title,
      })),
    });
  }

  // Sort by priority_score descending
  themes.sort((a, b) => b.priority_score - a.priority_score);

  // Emerging themes from unmatched data points
  const unmatchedPoints = dataPoints.filter((dp) => !matchedIds.has(dp.id));
  const stopWords = new Set(config.stop_words);
  const emergingThemes = detectEmergingThemes(
    unmatchedPoints,
    stopWords,
    config.emerging_theme_min_frequency
  );

  return {
    config_version: config.version,
    known_themes_count: config.themes.length,
    total_data_points: dataPoints.length,
    reactive_count: conversations.length,
    proactive_count: featureRequests.length,
    themes,
    emerging_themes: emergingThemes,
    unmatched_count: unmatchedPoints.length,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
