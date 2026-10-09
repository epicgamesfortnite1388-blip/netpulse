import type { ProxyEngineId } from './proxyEngine';

/**
 * Gateway memory — the last-known-good gateways, in the order worth retrying.
 *
 * This is the "quick reconnect" idea: a free public node that provably carried
 * traffic a minute ago is a far better first guess than a fresh database scan,
 * so the app remembers the gateways it has personally verified and re-tests
 * them first. A remembered gateway is NEVER trusted on memory alone — every
 * quick-connect attempt still re-verifies by reading the exit IP through the
 * tunnel; memory only decides what to try first, never what to report.
 */
export interface GatewayMemoryEntry {
  nodeId: string;
  /** label captured at success time (node remarks change between imports) */
  name: string | null;
  /**
   * The gateway named from non-address data. `host` and `port` used to be
   * stored here "so an attempt is identifiable when the node has no remark",
   * but the retry already resolves the node by `nodeId`, and the pair is the
   * node's dial endpoint — part of its configuration, which no client may
   * read. A gateway is identified by its name; a nameless one by this label.
   */
  label: string;
  /** Always true. See `label`: the endpoint the gateway dials is never sent. */
  endpointHidden: true;
  protocol: string;
  engine: ProxyEngineId;
  /** exit IP read from a trace fetched THROUGH the tunnel, never asserted */
  exitIp: string | null;
  exitCountry: string | null;
  /** round-trip of the verification request through the tunnel (ms) */
  verifyMs: number | null;
  /** consecutive successful verifications (0 = its last attempt failed) */
  successStreak: number;
  successCount: number;
  failCount: number;
  firstSeenAt: number;
  lastSuccessAt: number;
  lastAttemptAt: number;
}

/** Persisted envelope — versioned so a future shape change can migrate. */
export interface GatewayMemoryState {
  version: 1;
  entries: GatewayMemoryEntry[];
  updatedAt: number;
}

export const GATEWAY_MEMORY_MAX = 12;

/** Fields a successful (verified) tunnel start contributes to memory. */
export interface GatewaySuccessInput {
  nodeId: string;
  name: string | null;
  /** See `GatewayMemoryEntry.label` — no host/port, by the same rule. */
  label: string;
  protocol: string;
  engine: ProxyEngineId;
  exitIp: string | null;
  exitCountry: string | null;
  verifyMs: number | null;
}

/**
 * Ordering score in [0,1]: how much a gateway deserves the next attempt.
 *
 *   freshness   50%  — a node proven minutes ago is likelier alive than one
 *                      proven yesterday (free public nodes churn fast)
 *   reliability 30%  — Laplace-smoothed success ratio over all attempts, so a
 *                      1-of-1 gateway does not outrank a 20-of-21 one
 *   streak      20%  — a currently-working gateway beats a flapping one
 */
export function gatewayScore(entry: GatewayMemoryEntry, now: number): number {
  const ageHours = Math.max(0, (now - entry.lastSuccessAt) / 3_600_000);
  const freshness = 1 / (1 + ageHours / 6);
  const reliability = (entry.successCount + 1) / (entry.successCount + entry.failCount + 2);
  const streak = Math.min(entry.successStreak, 5) / 5;
  return Number((freshness * 0.5 + reliability * 0.3 + streak * 0.2).toFixed(6));
}

/**
 * Retry order for quick-connect: gateways that verified on their LAST attempt
 * come first (best score first), then ones that failed last (still worth a
 * cheap retry — a node can come back, and the attempt is bounded).
 */
export function rankGatewaysForConnect(entries: GatewayMemoryEntry[], now = Date.now()): GatewayMemoryEntry[] {
  return [...entries].sort((a, b) => {
    const aProven = a.successStreak > 0 ? 1 : 0;
    const bProven = b.successStreak > 0 ? 1 : 0;
    if (aProven !== bProven) return bProven - aProven;
    const diff = gatewayScore(b, now) - gatewayScore(a, now);
    if (diff !== 0) return diff;
    // stable tiebreak: most recently seen first
    return b.lastAttemptAt - a.lastAttemptAt;
  });
}

/** Merge one verified success into the list (bounded, most-valuable kept). */
export function applyGatewaySuccess(
  entries: GatewayMemoryEntry[],
  input: GatewaySuccessInput,
  now: number,
): GatewayMemoryEntry[] {
  const existing = entries.find((e) => e.nodeId === input.nodeId);
  const merged: GatewayMemoryEntry = existing
    ? {
        ...existing,
        ...input,
        endpointHidden: true,
        successStreak: existing.successStreak + 1,
        successCount: existing.successCount + 1,
        lastSuccessAt: now,
        lastAttemptAt: now,
      }
    : {
        ...input,
        endpointHidden: true,
        successStreak: 1,
        successCount: 1,
        failCount: 0,
        firstSeenAt: now,
        lastSuccessAt: now,
        lastAttemptAt: now,
      };
  const next = [...entries.filter((e) => e.nodeId !== input.nodeId), merged];
  if (next.length <= GATEWAY_MEMORY_MAX) return sortByScore(next, now);
  return sortByScore(next, now).slice(0, GATEWAY_MEMORY_MAX);
}

/** Record a failed verification: the gateway stays (it may recover) but drops behind proven ones. */
export function applyGatewayFailure(entries: GatewayMemoryEntry[], nodeId: string, now: number): GatewayMemoryEntry[] {
  const next = entries.map((e) =>
    e.nodeId === nodeId
      ? { ...e, successStreak: 0, failCount: e.failCount + 1, lastAttemptAt: now }
      : e,
  );
  return sortByScore(next, now);
}

function sortByScore(entries: GatewayMemoryEntry[], now: number): GatewayMemoryEntry[] {
  return [...entries].sort((a, b) => {
    const diff = gatewayScore(b, now) - gatewayScore(a, now);
    if (diff !== 0) return diff;
    return b.lastAttemptAt - a.lastAttemptAt;
  });
}

/** Parse persisted state defensively — a malformed blob yields an empty memory, never a throw. */
export function parseGatewayMemory(raw: unknown): GatewayMemoryState {
  const empty: GatewayMemoryState = { version: 1, entries: [], updatedAt: 0 };
  if (typeof raw !== 'object' || raw === null) return empty;
  const entries = (raw as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return empty;
  const clean: GatewayMemoryEntry[] = [];
  for (const e of entries) {
    if (typeof e !== 'object' || e === null) continue;
    const r = e as Record<string, unknown>;
    if (typeof r['nodeId'] !== 'string' || !r['nodeId']) continue;
    if (typeof r['engine'] !== 'string') continue;
    const name = typeof r['name'] === 'string' ? r['name'] : null;
    clean.push({
      nodeId: r['nodeId'],
      name,
      // Blobs written before the endpoint was withheld carry host/port and no
      // label. They are kept (the gateway is still a gateway) and named from
      // the remark they already had — never from the host they used to store.
      label: typeof r['label'] === 'string' && r['label'] ? r['label'] : (name ?? 'Remembered gateway'),
      endpointHidden: true,
      protocol: typeof r['protocol'] === 'string' ? r['protocol'] : 'unknown',
      engine: r['engine'] as ProxyEngineId,
      exitIp: typeof r['exitIp'] === 'string' ? r['exitIp'] : null,
      exitCountry: typeof r['exitCountry'] === 'string' ? r['exitCountry'] : null,
      verifyMs: typeof r['verifyMs'] === 'number' ? r['verifyMs'] : null,
      successStreak: typeof r['successStreak'] === 'number' ? r['successStreak'] : 0,
      successCount: typeof r['successCount'] === 'number' ? r['successCount'] : 0,
      failCount: typeof r['failCount'] === 'number' ? r['failCount'] : 0,
      firstSeenAt: typeof r['firstSeenAt'] === 'number' ? r['firstSeenAt'] : 0,
      lastSuccessAt: typeof r['lastSuccessAt'] === 'number' ? r['lastSuccessAt'] : 0,
      lastAttemptAt: typeof r['lastAttemptAt'] === 'number' ? r['lastAttemptAt'] : 0,
    });
  }
  return { version: 1, entries: clean.slice(0, GATEWAY_MEMORY_MAX), updatedAt: Date.now() };
}
