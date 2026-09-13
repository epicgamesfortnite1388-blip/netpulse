export function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    const v = sorted[mid];
    return v !== undefined ? v : null;
  }
  const a = sorted[mid - 1];
  const b = sorted[mid];
  return a !== undefined && b !== undefined ? (a + b) / 2 : null;
}

/** Linear-interpolated percentile, 0..100. Returns null on empty input. */
export function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] ?? null;
  const idx = (Math.max(0, Math.min(100, p)) / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const a = sorted[lo];
  const b = sorted[hi];
  if (a === undefined || b === undefined) return null;
  return a + (b - a) * (idx - lo);
}

/**
 * Jitter = mean absolute difference between successive latency samples
 * (RFC 3550 style smoothed variation, simplified).
 * Returns null when fewer than 2 samples.
 */
export function jitterMs(samples: number[]): number | null {
  if (samples.length < 2) return null;
  let sum = 0;
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    if (prev === undefined || cur === undefined) continue;
    sum += Math.abs(cur - prev);
  }
  return sum / (samples.length - 1);
}

export function lossPct(sent: number, received: number): number {
  if (sent <= 0) return 0;
  return Math.max(0, Math.min(100, ((sent - received) / sent) * 100));
}

export function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
