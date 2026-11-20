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

/** How the MAP confidence should be presented, and where the number came from. */
export interface CalibrationDisplay {
  /** Confidence to show: always the raw posterior until external outcomes exist. */
  confidence: number;
  /** False until an externally observed outcome calibrates the map. */
  calibrated: boolean;
  /** One line saying where the number came from, for the header. */
  note: string;
}

/**
 * Present the raw MAP posterior honestly.
 *
 * F-02: the engine's `map_confidence_calibrated` is derived by comparing the
 * leading hypothesis with the same likelihood table that produced it. It is a
 * self-consistency value, not empirical calibration against a measured
 * external outcome. It must never be labelled "calibrated confidence".
 */
export function calibrationDisplay(view: {
  map_label: string | null;
  hypotheses: HypothesisProbabilityDto[];
  map_confidence_calibrated: number | null;
  calibration_samples: number;
}): CalibrationDisplay | null {
  const raw = view.hypotheses.find((h) => h.label === view.map_label);
  if (!raw) return null;
  const samples = Number.isFinite(view.calibration_samples) ? view.calibration_samples : 0;
  const selfConsistency = view.map_confidence_calibrated;
  if (selfConsistency !== null && Number.isFinite(selfConsistency)) {
    return {
      confidence: raw.posterior,
      calibrated: false,
      note: `raw posterior; self-consistency index available from ${samples} internal checks (not externally calibrated)`,
    };
  }
  return {
    confidence: raw.posterior,
    calibrated: false,
    note: `raw posterior, ${samples} internal consistency check${samples === 1 ? '' : 's'} recorded`,
  };
}

/** Signed percentage-point change from prior to posterior, e.g. "+12.4 pp". */
export function formatShift(shift: number): string {
  const pp = (Number.isFinite(shift) ? shift : 0) * 100;
  return `${pp >= 0 ? '+' : ''}${pp.toFixed(1)} pp`;
}
