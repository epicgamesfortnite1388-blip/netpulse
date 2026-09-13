import type { Logger } from '../logger';
import type { AppSettings } from '@netpulse/shared';
import type { NodesService } from './nodesService';

/**
 * Adaptive node test scheduler.
 *
 * Autonomous, bounded lifecycle management for the public-node database:
 *
 *   prioritize:  new nodes (never validated) > previously good nodes with
 *                stale measurements > unstable nodes (retest) > everything else
 *   execute:     cheap TCP probes in a small bounded batch per tick
 *   retire:      nodes unseen in sources for RETIRE_AFTER_MS and failing
 *                consecutively are marked stale (never deleted — history
 *                retention is the retention service's job)
 *
 * Every batch is capped; every tick is serialized; settings can disable the
 * whole engine. Nothing here runs proxy tests (engine-heavy); the UI and the
 * optimizer trigger those on demand.
 */
export class NodeTestScheduler {
  private timer: NodeJS.Timeout | null = null;
  private firstTick: NodeJS.Timeout | null = null;
  private running = false;
  private lastResult: TickResult | null = null;
  private started = false;

  constructor(
    private readonly deps: {
      nodes: NodesService;
      settings: { get: () => AppSettings; setOnChange?: (fn: () => void) => void };
      log: Logger;
      onTick?: (r: TickResult) => void;
    },
  ) {
    // A PUT /settings that touches automation re-arms immediately (same
    // pattern as ScheduleService).
    this.deps.settings.setOnChange?.(() => {
      if (this.started) {
        this.stop();
        this.start();
      }
    });
  }

  /** Read the user's automation setting (default: on, 30 min). */
  private config(): { enabled: boolean; intervalMin: number } {
    try {
      const s = this.deps.settings.get();
      const automation = (s as unknown as { automation?: { autoTestNodes?: { enabled?: boolean; intervalMinutes?: number } } }).automation;
      return {
        enabled: automation?.autoTestNodes?.enabled !== false,
        intervalMin: Math.max(10, Math.min(240, automation?.autoTestNodes?.intervalMinutes ?? 30)),
      };
    } catch {
      return { enabled: true, intervalMin: 30 };
    }
  }

  start(): void {
    this.started = true;
    const { enabled, intervalMin } = this.config();
    if (!enabled) return;
    this.stop();
    this.timer = setInterval(() => void this.tick(), intervalMin * 60_000);
    this.timer.unref();
    // First tick after a short delay so boot is never crowded.
    const t = setTimeout(() => void this.tick(), 45_000);
    t.unref();
    // stop() must be able to cancel BOTH timers — a leaked first-tick
    // timeout would fire even after the scheduler was stopped or the
    // feature disabled via settings.
    this.firstTick = t;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.firstTick) clearTimeout(this.firstTick);
    this.firstTick = null;
  }

  /** Re-read settings and re-arm. Safe to call at any time. */
  reconfigure(): void {
    if (!this.started) return;
    this.stop();
    this.start();
  }

  status(): { enabled: boolean; running: boolean; last: TickResult | null } {
    return { enabled: this.config().enabled, running: this.running, last: this.lastResult };
  }

  /** One bounded adaptive batch. Serialized — overlapping ticks are dropped. */
  async tick(): Promise<TickResult> {
    if (this.running) {
      return this.lastResult ?? { tested: 0, retired: 0, skippedRunning: true, prioritized: { neverValidated: 0, staleGood: 0, unstable: 0, rest: 0 } };
    }
    this.running = true;
    try {
      const out = await this.runBatch();
      this.lastResult = out;
      this.deps.onTick?.(out);
      return out;
    } finally {
      this.running = false;
    }
  }

  private async runBatch(): Promise<TickResult> {
    const svc = this.deps.nodes;
    const BATCH_TCP = 12;

    // ---- prioritization: read a small working set from the DB ----
    const prioritized = { neverValidated: 0, staleGood: 0, unstable: 0, rest: 0 };
    const candidates: string[] = [];

    const add = (id: string) => {
      if (candidates.length < BATCH_TCP && !candidates.includes(id)) candidates.push(id);
    };

    // 1. Never-validated nodes, newest first (fresh imports get first shot).
    const fresh = svc.pickNodesForAutoTest({ bucket: 'never-validated', limit: BATCH_TCP });
    prioritized.neverValidated = fresh.length;
    for (const n of fresh) add(n.id);

    // 2. Previously healthy nodes whose measurement is oldest (stale good).
    if (candidates.length < BATCH_TCP) {
      const staleGood = svc.pickNodesForAutoTest({ bucket: 'stale-good', limit: BATCH_TCP - candidates.length });
      prioritized.staleGood = staleGood.length;
      for (const n of staleGood) add(n.id);
    }
    // 3. Unstable nodes needing a retest (recently flapping).
    if (candidates.length < BATCH_TCP) {
      const unstable = svc.pickNodesForAutoTest({ bucket: 'unstable', limit: BATCH_TCP - candidates.length });
      prioritized.unstable = unstable.length;
      for (const n of unstable) add(n.id);
    }

    // ---- execution: cheap, bounded TCP probes ----
    let tested = 0;
    const results = await Promise.allSettled(
      candidates.map((id) => svc.testNode(id, 'tcp').then((r) => { tested += 1; return r; })),
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        this.deps.log.debug?.({ err: String(r.reason).slice(0, 120) }, 'auto node test failed');
      }
    }

    // ---- retirement: dead + unseen for 14 days → stale ----
    const retired = svc.retireStaleNodes();

    return { tested, retired, skippedRunning: false, prioritized };
  }
}

export interface TickResult {
  tested: number;
  retired: number;
  skippedRunning: boolean;
  prioritized: { neverValidated: number; staleGood: number; unstable: number; rest: number };
}
