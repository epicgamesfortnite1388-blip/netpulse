import { SCAN_PROFILES, type DiscoveryOutcome, type DiscoveryReport, type ScanDepth } from '@netpulse/shared';

/**
 * Rendering rules for a discovery report.
 *
 * Kept pure and unit-tested because these are the rules that decide what the
 * UI is allowed to state. Three of them matter more than the rest:
 *
 *   - a probe that FAILED is never reported as a validated depth, even though
 *     the wire format carries the depth that was attempted for it
 *   - an unmeasured latency is never rendered as a number (no 0, no estimate)
 *   - a run that found nothing says exactly that, rather than showing counts
 *     that read like a result
 */

export type ReportState = 'no-candidates' | 'nothing-passed' | 'found';

/** What actually happened, in one of three states — never a middle ground. */
export function reportState(report: DiscoveryReport): ReportState {
  if (report.probed === 0) return 'no-candidates';
  return report.passed === 0 ? 'nothing-passed' : 'found';
}

/** Outcomes that passed at the profile's depth. The only source of depth claims. */
export function passingOutcomes(report: DiscoveryReport): DiscoveryOutcome[] {
  return report.outcomes.filter((o) => o.failure === null);
}

export function failedOutcomes(report: DiscoveryReport): DiscoveryOutcome[] {
  return report.outcomes.filter((o) => o.failure !== null);
}

/**
 * The deepest depth actually VALIDATED in this run, or null when nothing
 * passed. Derived from passing outcomes only — a failed candidate's `depth`
 * records the probe that was run, not evidence, so it cannot raise this.
 */
export function validatedDepth(report: DiscoveryReport): ScanDepth | null {
  const rank: Record<ScanDepth, number> = { tcp: 0, tls: 1, proxy: 2 };
  let best: ScanDepth | null = null;
  for (const o of passingOutcomes(report)) {
    if (best === null || rank[o.depth] > rank[best]) best = o.depth;
  }
  return best;
}

/**
 * Noun phrase for a depth — what the evidence literally was. Phrased as a
 * noun so it composes with a verb without stuttering ("completed a completed
 * TLS handshake" was the bug this avoids).
 */
export function depthPhrase(depth: ScanDepth): string {
  if (depth === 'proxy') return 'a real request carried through the node';
  if (depth === 'tls') return 'a completed TLS handshake';
  return 'an answered TCP handshake';
}

/** One line stating what was proven, or that nothing was. */
export function validatedSummary(report: DiscoveryReport): string {
  const depth = validatedDepth(report);
  if (depth === null) return 'Nothing was validated — no candidate reached this profile’s depth.';
  return `Validated: ${report.passed} of ${report.probed} candidate${report.probed === 1 ? '' : 's'} reached ${depthPhrase(depth)}.`;
}

/** Latency as a real measurement, or null when it was never measured. */
export function formatLatency(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  return `${Math.round(ms)} ms`;
}

export interface FailureGroup {
  reason: string;
  count: number;
}

/**
 * Failure reasons counted verbatim — no classification, no inferred cause.
 * The API reports one string per failure; showing the exact strings (grouped
 * only by equality) is the difference between reporting and guessing.
 */
export function failureBreakdown(report: DiscoveryReport): FailureGroup[] {
  const counts = new Map<string, number>();
  for (const o of failedOutcomes(report)) {
    const reason = (o.failure ?? '').trim() || 'failed (no reason reported)';
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/**
 * How much of the profile's probe budget the run actually used, stated from
 * the real counts (the profile cap is a ceiling, never an expectation).
 */
export function budgetNote(report: DiscoveryReport): string {
  const cap = SCAN_PROFILES[report.profile]?.candidateLimit ?? 0;
  if (report.probed === 0) return 'No candidate was available to probe.';
  if (report.probed >= cap) return `Probed the profile’s full ${cap}-candidate budget.`;
  return `Probed ${report.probed} of the profile’s ${cap}-candidate budget — the candidate pool ran out first.`;
}

/**
 * A profile that validates through a local core cannot do so when no core is
 * installed. This is derived from the engines endpoint, not from parsing
 * failure text, so it is a fact about the machine rather than a guess about an
 * error message.
 */
export function needsMissingCore(profile: string, effectiveEngine: string | null | undefined): boolean {
  const depth = SCAN_PROFILES[profile as keyof typeof SCAN_PROFILES]?.depth;
  return depth === 'proxy' && !effectiveEngine;
}

/** Compact label for one candidate row. Real fields only; missing ones are omitted. */
export function outcomeLabel(o: DiscoveryOutcome): string {
  return o.name ? o.name : o.host;
}
