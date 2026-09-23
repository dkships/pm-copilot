/**
 * How one data source fared in a fetch. "unconfigured" means the source was
 * never set up, which is a valid setup, not a failure.
 */
export type SourceStatus = "unconfigured" | "ok" | "failed";

/**
 * True when every configured source failed, so the caller should return an
 * error instead of an empty analysis. Nothing configured also counts: there is
 * nothing to analyze.
 *
 *   [failed, ok, unconfigured]           -> false (one source answered)
 *   [unconfigured, failed, unconfigured] -> true  (the only source failed)
 */
export function allConfiguredFailed(statuses: SourceStatus[]): boolean {
  const configured = statuses.filter((s) => s !== "unconfigured");
  return configured.every((s) => s === "failed");
}
