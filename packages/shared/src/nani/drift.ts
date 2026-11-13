/**
 * NANI — change detection for non-stationary networks.
 *
 * Networks change. A learner that treats a year of observations as one
 * distribution will keep recommending a route that stopped working. These
 * detectors are the cheap, explainable first line:
 *
 *  - **Page–Hinkley**: cumulative deviation from a running mean, so a sustained
 *    shift triggers even when individual values look ordinary.
 *  - **CUSUM**: two one-sided cumulative sums with a slack term, good for a
 *    sharp step change.
 *
 * Both are deterministic and have no dependencies. They report *that* the
 * distribution changed; they do not decide what to do — the caller reduces the
 * weight of stale evidence and re-explores.
 */

export interface DriftSignal {
  drift: boolean;
  statistic: number;
  /** Direction of the change: +1 worse, -1 better, 0 none. */
  direction: -1 | 0 | 1;
}

export interface PageHinkleyOptions {
  /** Allowed deviation before it accumulates (smaller = more sensitive). */
  delta: number;
  /** Detection threshold on the cumulative statistic. */
  threshold: number;
  /** Optional prior mean; otherwise the first observation seeds it. */
  initialMean?: number;
}

/**
 * Page–Hinkley test:
 *   m_t = m_(t-1) + (x_t − m_(t-1)) / t
 *   S_t = max(0, S_(t-1) + (x_t − m_t − δ))
 * A crossing of `threshold` signals a deterioration. We also run the mirrored
 * test (δ negated) to detect improvement, which matters: recovering capacity
 * should restore a route that had been demoted.
 */
export class PageHinkley {
  private mean: number;
  private count = 0;
  private up = 0;
  private down = 0;
  private readonly options: PageHinkleyOptions;

  constructor(options: Partial<PageHinkleyOptions> = {}) {
    this.options = { delta: 0.005, threshold: 0.5, ...options };
    this.mean = this.options.initialMean ?? 0;
    this.count = this.options.initialMean === undefined ? 0 : 1;
  }

  update(value: number): DriftSignal {
    this.count += 1;
    this.mean += (value - this.mean) / this.count;

    const deviation = value - this.mean;
    this.up = Math.max(0, this.up + deviation - this.options.delta);
    this.down = Math.max(0, this.down - deviation - this.options.delta);

    if (this.up > this.options.threshold) {
      const statistic = this.up;
      this.up = 0;
      this.down = 0;
      return { drift: true, statistic, direction: 1 };
    }
    if (this.down > this.options.threshold) {
      const statistic = this.down;
      this.up = 0;
      this.down = 0;
      return { drift: true, statistic, direction: -1 };
    }
    return { drift: false, statistic: Math.max(this.up, this.down), direction: 0 };
  }

  get runningMean(): number {
    return this.mean;
  }
}

export interface CusumOptions {
  /** Target mean of the in-control process. */
  target: number;
  /** Slack: deviations smaller than this do not accumulate. */
  slack: number;
  threshold: number;
}

/**
 * Two-sided CUSUM:
 *   S⁺_t = max(0, S⁺_(t-1) + (x_t − target) − slack)
 *   S⁻_t = max(0, S⁻_(t-1) − (x_t − target) − slack)
 */
export class Cusum {
  private positive = 0;
  private negative = 0;
  private readonly options: CusumOptions;

  constructor(options: CusumOptions) {
    this.options = options;
  }

  update(value: number): DriftSignal {
    const deviation = value - this.options.target;
    this.positive = Math.max(0, this.positive + deviation - this.options.slack);
    this.negative = Math.max(0, this.negative - deviation - this.options.slack);

    if (this.positive > this.options.threshold) {
      const statistic = this.positive;
      this.positive = 0;
      return { drift: true, statistic, direction: 1 };
    }
    if (this.negative > this.options.threshold) {
      const statistic = this.negative;
      this.negative = 0;
      return { drift: true, statistic, direction: -1 };
    }
    return { drift: false, statistic: Math.max(this.positive, this.negative), direction: 0 };
  }

  get statistics(): { positive: number; negative: number } {
    return { positive: this.positive, negative: this.negative };
  }
}
