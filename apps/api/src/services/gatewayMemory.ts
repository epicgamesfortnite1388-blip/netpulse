/**
 * Gateway memory — the gateways the app has personally verified, kept across
 * restarts so a reconnect can try what last worked before scanning anything.
 *
 * Only a *verified* tunnel start is ever recorded: the entry is written after
 * an HTTPS trace has been fetched through the node, so "remembered" means
 * "provably carried traffic", not "was reported healthy".
 *
 * All ordering/merge logic lives in @netpulse/shared as pure functions; this
 * class is the persistence seam (the existing `settings` key-value table).
 * Every read is defensive — a corrupt or stale blob degrades to an empty
 * memory instead of breaking tunnel start.
 */
import {
  applyGatewayFailure,
  applyGatewaySuccess,
  parseGatewayMemory,
  rankGatewaysForConnect,
  type GatewayMemoryEntry,
  type GatewaySuccessInput,
} from '@netpulse/shared';

/** Minimal key-value persistence seam; `SettingsRepository` satisfies it. */
export interface GatewayStore {
  get(key: string): Record<string, unknown> | null;
  put(key: string, value: Record<string, unknown>): void;
}

const STORE_KEY = 'gatewayMemory';

export class GatewayMemoryService {
  private cache: GatewayMemoryEntry[] | null = null;

  constructor(
    private readonly deps: {
      store: GatewayStore;
      log?: { warn(msg: string): void };
    },
  ) {}

  /** All remembered gateways, newest success first. */
  list(): GatewayMemoryEntry[] {
    return [...this.entries()];
  }

  /** Retry order for quick-connect: proven last time first, best score first. */
  ranked(now = Date.now()): GatewayMemoryEntry[] {
    return rankGatewaysForConnect(this.entries(), now);
  }

  /** Record a verified tunnel start. */
  remember(input: GatewaySuccessInput, now = Date.now()): GatewayMemoryEntry[] {
    const next = applyGatewaySuccess(this.entries(), input, now);
    this.persist(next);
    return next;
  }

  /** Record a failed verification for a remembered gateway (it stays, demoted). */
  markFailed(nodeId: string, now = Date.now()): void {
    const current = this.entries();
    if (!current.some((e) => e.nodeId === nodeId)) return;
    this.persist(applyGatewayFailure(current, nodeId, now));
  }

  /** Forget one gateway, or everything when no id is given. */
  forget(nodeId?: string): GatewayMemoryEntry[] {
    const next = nodeId ? this.entries().filter((e) => e.nodeId !== nodeId) : [];
    this.persist(next);
    return next;
  }

  private entries(): GatewayMemoryEntry[] {
    if (this.cache) return this.cache;
    try {
      const raw = this.deps.store.get(STORE_KEY);
      this.cache = parseGatewayMemory(raw).entries;
    } catch (err) {
      this.deps.log?.warn(`gateway memory unreadable, starting empty: ${err instanceof Error ? err.message : String(err)}`);
      this.cache = [];
    }
    return this.cache;
  }

  private persist(entries: GatewayMemoryEntry[]): void {
    this.cache = entries;
    try {
      this.deps.store.put(STORE_KEY, {
        version: 1,
        entries: entries as unknown as Record<string, unknown>[],
        updatedAt: Date.now(),
      });
    } catch (err) {
      // Memory still works for this process; a failed write is not fatal.
      this.deps.log?.warn(`gateway memory write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
