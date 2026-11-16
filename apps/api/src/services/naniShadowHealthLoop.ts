import type { Logger } from '../logger';

const DEFAULT_INTERVAL_MS = 5 * 60_000;

/**
 * Advisory API-health loop.
 *
 * Runs NANI's shadow health pass on a timer. The pass calls
 * `assessApiHealth` against every configured provider but does not update
 * registry health, publish events, trip circuit breakers, or start recovery.
 * Results stay in the NANI shadow buffer for diagnostics only.
 *
 * Runs are serialised: a slow probe cannot stack passes, and the timer is
 * unref'd so it never keeps the process alive.
 */
export class NaniShadowHealthLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private enabled = false;
  private running = false;

  constructor(
    private readonly runPass: () => Promise<unknown>,
    private readonly log: Logger,
    private readonly intervalMs: number = DEFAULT_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.log.info(
      { intervalMs: this.intervalMs },
      'nani shadow api-health loop started (advisory only)',
    );
    this.scheduleNext();
  }

  stop(): void {
    this.enabled = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** One pass. Never throws; failures are logged and the loop continues. */
  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runPass();
    } catch (err) {
      this.log.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'nani shadow api-health pass failed (no action taken)',
      );
    } finally {
      this.running = false;
    }
  }

  private scheduleNext(): void {
    if (!this.enabled) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce().finally(() => this.scheduleNext());
    }, this.intervalMs);
    this.timer.unref?.();
  }
}
