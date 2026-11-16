/**
 * Presentation helpers for the hypothesis view.
 *
 * The numbers come from the Rust diagnostic engine unchanged; these functions
 * only order them and turn them into percentages/labels. Nothing is derived
 * that the engine did not measure.
 */
import type { HypothesisProbabilityDto } from './naniApi';

/** One hypothesis prepared for rendering. */
export interface HypothesisRow extends HypothesisProbabilityDto {
  /** Posterior minus prior, in probability units (positive = evidence supported it). */
  shift: number;
  /** Posterior as a percentage for the bar width. */
  posteriorPct: number;
  /** Prior as a percentage, drawn as a marker on the same bar. */
  priorPct: number;
}

function pct(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.max(0, Math.min(1, p)) * 100;
}

/** Sort by posterior (most likely first) and attach the display values. */
export function toRows(hypotheses: HypothesisProbabilityDto[]): HypothesisRow[] {
  return [...hypotheses]
    .map((h) => ({
      ...h,
      shift: h.posterior - h.prior,
      posteriorPct: pct(h.posterior),
      priorPct: pct(h.prior),
    }))
    .sort((a, b) => b.posterior - a.posterior);
}

/** Information gains are small (0–3 nats); three decimals keep them readable. */
export function formatNats(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(3)} nats` : 'unavailable';
}

/** Signed percentage-point change from prior to posterior, e.g. "+12.4 pp". */
export function formatShift(shift: number): string {
  const pp = (Number.isFinite(shift) ? shift : 0) * 100;
  return `${pp >= 0 ? '+' : ''}${pp.toFixed(1)} pp`;
}
