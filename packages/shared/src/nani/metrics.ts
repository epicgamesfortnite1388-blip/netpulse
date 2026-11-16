/**
 * NANI — evaluation metrics that decide whether the intelligence is real.
 *
 * These are the release-gate numbers: a model that "looks good" but is
 * overconfident fails ECE; one that hedges everything fails log loss. Every
 * metric takes (probability, outcome) pairs so the same code scores the
 * diagnosis, the success predictor and the route selector.
 */

export interface Prediction {
  /** Predicted probability of success (or of the labelled class). */
  p: number;
  /** Observed outcome, 1 or 0. */
  y: 0 | 1;
}

const clampP = (p: number) => Math.min(1 - 1e-12, Math.max(1e-12, p));

/** Brier score: mean squared error of probabilities. Lower is better. */
export function brierScore(predictions: readonly Prediction[]): number {
  if (predictions.length === 0) return Number.NaN;
  let sum = 0;
  for (const { p, y } of predictions) sum += (p - y) ** 2;
  return sum / predictions.length;
}

/** Mean log loss (cross-entropy). Lower is better. */
export function logLoss(predictions: readonly Prediction[]): number {
  if (predictions.length === 0) return Number.NaN;
  let sum = 0;
  for (const { p, y } of predictions) {
    const q = clampP(p);
    sum += -(y * Math.log(q) + (1 - y) * Math.log(1 - q));
  }
  return sum / predictions.length;
}

export interface ReliabilityBin {
  lower: number;
  upper: number;
  count: number;
  meanConfidence: number;
  observedRate: number;
}

/** Reliability diagram bins. */
export function reliabilityBins(predictions: readonly Prediction[], bins = 10): ReliabilityBin[] {
  const n = Math.max(1, Math.floor(bins));
  const acc = Array.from({ length: n }, () => ({ count: 0, confidence: 0, positive: 0 }));
  for (const { p, y } of predictions) {
    const idx = Math.min(n - 1, Math.floor(clampP(p) * n));
    const bin = acc[idx];
    if (!bin) continue;
    bin.count += 1;
    bin.confidence += clampP(p);
    bin.positive += y;
  }
  return acc.map((bin, i) => ({
    lower: i / n,
    upper: (i + 1) / n,
    count: bin.count,
    meanConfidence: bin.count === 0 ? 0 : bin.confidence / bin.count,
    observedRate: bin.count === 0 ? 0 : bin.positive / bin.count,
  }));
}

/**
 * Expected Calibration Error: weighted mean |confidence − accuracy| across bins.
 * Lower is better; 0.05 is a reasonable target for a release gate.
 */
export function expectedCalibrationError(predictions: readonly Prediction[], bins = 10): number {
  if (predictions.length === 0) return Number.NaN;
  const reliability = reliabilityBins(predictions, bins);
  let ece = 0;
  for (const bin of reliability) {
    if (bin.count === 0) continue;
    ece += (bin.count / predictions.length) * Math.abs(bin.meanConfidence - bin.observedRate);
  }
  return ece;
}

export function meanOf(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Nearest-rank quantile (0..1). */
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = Math.min(1, Math.max(0, q)) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] ?? 0;
  if (lo === hi) return a;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (pos - lo);
}

export interface NaniLatencySummary {
  count: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

export function summarizeLatency(values: readonly number[]): NaniLatencySummary {
  return {
    count: values.length,
    mean: meanOf(values),
    p50: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    p99: quantile(values, 0.99),
  };
}

/**
 * Binary precision/recall/accuracy for diagnostic evaluation.
 *
 * `positive` is the class being scored (e.g. "the true cause was DNS"), so the
 * caller can evaluate one hypothesis at a time against the labelled corpus.
 */
export function binaryClassification(
  predicted: readonly boolean[],
  actual: readonly boolean[],
): { precision: number; recall: number; accuracy: number; truePositives: number; falsePositives: number; falseNegatives: number } {
  if (predicted.length !== actual.length || predicted.length === 0) {
    return { precision: Number.NaN, recall: Number.NaN, accuracy: Number.NaN, truePositives: 0, falsePositives: 0, falseNegatives: 0 };
  }
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let trueNegatives = 0;
  for (let i = 0; i < predicted.length; i += 1) {
    if (predicted[i] && actual[i]) truePositives += 1;
    else if (predicted[i] && !actual[i]) falsePositives += 1;
    else if (!predicted[i] && actual[i]) falseNegatives += 1;
    else trueNegatives += 1;
  }
  return {
    precision: truePositives / Math.max(1, truePositives + falsePositives),
    recall: truePositives / Math.max(1, truePositives + falseNegatives),
    accuracy: (truePositives + trueNegatives) / predicted.length,
    truePositives,
    falsePositives,
    falseNegatives,
  };
}

/* ------------------------ reliability diagrams by class --------------------- */

/** A prediction annotated with the network and destination classes it belongs to. */
export interface ClassifiedPrediction extends Prediction {
  /** Network condition / class label (e.g. "dns", "tcp", "tls"). */
  networkClass?: string;
  /** Destination class label (e.g. "remote-endpoint", "api", "gateway"). */
  destinationClass?: string;
}

/** A reliability diagram plus its summary statistics. */
export interface ReliabilityDiagram {
  bins: ReliabilityBin[];
  ece: number;
  count: number;
}

/** Build one reliability diagram from a set of predictions. */
export function reliabilityDiagram(
  predictions: readonly Prediction[],
  bins = 10,
): ReliabilityDiagram {
  return {
    bins: reliabilityBins(predictions, bins),
    ece: expectedCalibrationError(predictions, bins),
    count: predictions.length,
  };
}

/** Group predictions by a caller-supplied class key and diagram each group. */
export function reliabilityDiagramByClass(
  predictions: readonly Prediction[],
  classOf: (prediction: Prediction) => string,
  bins = 10,
): Record<string, ReliabilityDiagram> {
  const groups = new Map<string, Prediction[]>();
  for (const prediction of predictions) {
    const key = classOf(prediction);
    const list = groups.get(key);
    if (list) list.push(prediction);
    else groups.set(key, [prediction]);
  }
  const out: Record<string, ReliabilityDiagram> = {};
  for (const [key, list] of groups) {
    out[key] = reliabilityDiagram(list, bins);
  }
  return out;
}

/**
 * Evaluate reliability diagrams separately for every network class and
 * destination class combination present in `predictions`. Missing classes are
 * reported as `"unknown"` so callers always get a complete, keyed result.
 */
export function reliabilityDiagramByNetworkAndDestination(
  predictions: readonly ClassifiedPrediction[],
  bins = 10,
): Record<string, Record<string, ReliabilityDiagram>> {
  const networks = new Set<string>();
  const destinations = new Set<string>();
  for (const prediction of predictions) {
    networks.add(prediction.networkClass ?? 'unknown');
    destinations.add(prediction.destinationClass ?? 'unknown');
  }
  if (networks.size === 0) networks.add('unknown');
  if (destinations.size === 0) destinations.add('unknown');

  const out: Record<string, Record<string, ReliabilityDiagram>> = {};
  for (const network of networks) {
    out[network] = {};
    for (const destination of destinations) {
      const subset = predictions.filter(
        (prediction) =>
          (prediction.networkClass ?? 'unknown') === network &&
          (prediction.destinationClass ?? 'unknown') === destination,
      );
      out[network]![destination] = reliabilityDiagram(subset, bins);
    }
  }
  return out;
}
