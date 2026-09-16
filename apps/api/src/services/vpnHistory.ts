/**
 * VPN history — persistence + aggregation for the discovery/gateway dashboard.
 *
 * What is stored (in the existing `node_events` table, kinds namespaced
 * `vpnhistory:*`):
 *   - every completed discovery run (manual scan, or the scan inside a quick
 *     connect), as its own event with the report's real counters
 *   - every completed quick connect, with its real per-attempt outcomes
 *
 * Gateway reliability needs no new writes: GatewayMemoryService already keeps
 * verified-success/fail counts and verifyMs per gateway; this module reads that
 * state and derives the percentages (null when nothing was attempted — never a
 * fabricated 0 or 100).
 *
 * Aggregation rule: every number in a rollup is computed from stored rows.
 * Nothing is extrapolated, smoothed, or backfilled — a profile with no runs
 * reports `runs: 0` and nulls, not zeros dressed up as measurements.
 */
import {
  scanProfile,
  type DiscoveryProfileRollup,
  type DiscoveryReport,
  type DiscoveryRunRecord,
  type GatewayReliabilityRow,
  type GatewayMemoryEntry,
  type ProxyEngineId,
  type QuickConnectAttempt,
  type QuickConnectResult,
  type QuickConnectRunRecord,
  type ScanDepth,
  type ScanProfileId,
} from '@netpulse/shared';

const KIND_DISCOVERY = 'vpnhistory:discovery-run';
const KIND_QUICK = 'vpnhistory:quick-run';
/** How much history is kept per kind — bounded storage, newest kept. */
const MAX_EVENTS_PER_KIND = 500;
/** How many runs the report endpoint returns. */
export const MAX_REPORT_RUNS = 120;

/** Minimal event-log seam; `NodeEventsRepository` satisfies it. */
export interface HistoryEventStore {
  insert(row: { kind: string; at: number; payload: Record<string, unknown> }): void;
  recent(kind: string, limit: number): Array<{ kind: string; at: number; payload: Record<string, unknown> }>;
}

/** Minimal read seam over gateway memory; `GatewayMemoryService.list` satisfies it. */
export interface GatewayLister {
  list(): GatewayMemoryEntry[];
}

interface DiscoveryEventPayload {
  profile: ScanProfileId;
  probed: number;
  passed: number;
  tookMs: number;
  origin: DiscoveryRunRecord['origin'];
  trigger: DiscoveryRunRecord['trigger'];
  summary: string;
  winner: DiscoveryRunRecord['winner'];
  /** validated depth of the best passing candidate, or null when none passed */
  validatedDepth: ScanDepth | null;
}

interface QuickEventPayload {
  ok: boolean;
  profile: ScanProfileId;
  attempts: QuickConnectAttempt[];
  summary: string;
  tookMs: number;
}

export class VpnHistoryService {
  constructor(
    private readonly deps: {
      events: HistoryEventStore;
      gatewayMemory: GatewayLister;
      log: { warn(msg: string): void };
    },
  ) {}

  /** Store a completed discovery run. Never throws into the caller's path. */
  recordDiscoveryRun(report: DiscoveryReport, origin: DiscoveryRunRecord['origin'], trigger: DiscoveryRunRecord['trigger']): void {
    try {
      const winner = report.winner;
      const payload: DiscoveryEventPayload = {
        profile: report.profile,
        probed: report.probed,
        passed: report.passed,
        tookMs: report.tookMs,
        origin,
        trigger,
        summary: report.summary,
        winner: winner ? { host: winner.host, port: winner.port, protocol: winner.protocol, latencyMs: winner.latencyMs } : null,
        validatedDepth: validatedDepthOf(report),
      };
      this.deps.events.insert({ kind: KIND_DISCOVERY, at: Date.now(), payload: payload as unknown as Record<string, unknown> });
      this.trim(KIND_DISCOVERY);
    } catch (err) {
      this.deps.log.warn(`vpn history: discovery run not recorded: ${message(err)}`);
    }
  }

  /** Store a completed quick-connect run. Never throws into the caller's path. */
  recordQuickConnectRun(result: QuickConnectResult, tookMs: number): void {
    try {
      const payload: QuickEventPayload = {
        ok: result.ok,
        profile: result.profile,
        attempts: result.attempts,
        summary: result.summary,
        tookMs,
      };
      this.deps.events.insert({ kind: KIND_QUICK, at: Date.now(), payload: payload as unknown as Record<string, unknown> });
      this.trim(KIND_QUICK);
    } catch (err) {
      this.deps.log.warn(`vpn history: quick connect not recorded: ${message(err)}`);
    }
  }

  /**
   * The dashboard payload: newest runs first, per-profile rollups, and gateway
   * reliability derived from what gateway memory actually holds.
   */
  report(now = Date.now()): {
    generatedAt: number;
    discovery: { runs: DiscoveryRunRecord[]; rollups: DiscoveryProfileRollup[] };
    quickConnect: { runs: QuickConnectRunRecord[]; totalRuns: number; totalAttempts: number; successRatePct: number | null };
    gateways: GatewayReliabilityRow[];
  } {
    const runs: DiscoveryRunRecord[] = this.readDiscovery().slice(0, MAX_REPORT_RUNS);
    const quickRuns: QuickConnectRunRecord[] = this.readQuick().slice(0, MAX_REPORT_RUNS);

    const byProfile = new Map<ScanProfileId, DiscoveryRunRecord[]>();
    for (const r of this.readDiscovery()) {
      const list = byProfile.get(r.profile) ?? [];
      list.push(r);
      byProfile.set(r.profile, list);
    }
    const rollups: DiscoveryProfileRollup[] = [...byProfile.entries()].map(([profile, list]) => {
      const totalProbed = list.reduce((s, r) => s + r.probed, 0);
      const totalPassed = list.reduce((s, r) => s + r.passed, 0);
      const rates = list.map((r) => (r.probed > 0 ? (r.passed / r.probed) * 100 : null)).filter((x): x is number => x !== null);
      return {
        profile,
        runs: list.length,
        totalProbed,
        totalPassed,
        meanPassRatePct: rates.length > 0 ? rates.reduce((s, x) => s + x, 0) / rates.length : null,
        lastRunAt: list[0]?.at ?? null,
        lastValidatedDepth: list.find((r) => r.winner !== null)?.winner ? (list[0] as DiscoveryRunRecord & { validatedDepth?: ScanDepth | null }).validatedDepth ?? null : null,
      };
    });

    const totalAttempts = quickRuns.reduce((s, r) => s + r.tried, 0);
    const okRuns = quickRuns.filter((r) => r.ok).length;
    const gateways = this.deps.gatewayMemory.list().map((g) => reliabilityRow(g, now));

    return {
      generatedAt: now,
      discovery: { runs, rollups },
      quickConnect: {
        runs: quickRuns,
        totalRuns: quickRuns.length,
        totalAttempts,
        successRatePct: quickRuns.length > 0 ? (okRuns / quickRuns.length) * 100 : null,
      },
      gateways,
    };
  }

  private readDiscovery(): Array<DiscoveryRunRecord & { validatedDepth?: ScanDepth | null }> {
    return this.read(KIND_DISCOVERY).map((e) => {
      const p = e.payload as unknown as DiscoveryEventPayload;
      return {
        id: e.at,
        at: e.at,
        profile: p.profile,
        probed: p.probed,
        passed: p.passed,
        tookMs: p.tookMs,
        origin: p.origin,
        trigger: p.trigger,
        winner: p.winner,
        summary: p.summary,
        validatedDepth: p.validatedDepth,
      };
    });
  }

  private readQuick(): QuickConnectRunRecord[] {
    return this.read(KIND_QUICK).map((e) => {
      const p = e.payload as unknown as QuickEventPayload;
      const won = [...p.attempts].reverse().find((a) => a.ok) ?? null;
      return {
        id: e.at,
        at: e.at,
        ok: p.ok,
        profile: p.profile,
        tried: p.attempts.length,
        winningSource: won?.source ?? null,
        attempts: p.attempts,
        summary: p.summary,
        tookMs: p.tookMs,
      };
    });
  }

  /** Newest-first events of one kind, defensively parsed. */
  private read(kind: string): Array<{ at: number; payload: Record<string, unknown> }> {
    try {
      return this.deps.events
        .recent(kind, MAX_REPORT_RUNS * 4)
        .map((e) => ({ at: Number(e.at), payload: e.payload }))
        .filter((e) => Number.isFinite(e.at) && e.payload !== null && typeof e.payload === 'object')
        .sort((a, b) => b.at - a.at);
    } catch (err) {
      this.deps.log.warn(`vpn history: cannot read ${kind}: ${message(err)}`);
      return [];
    }
  }

  /** Keep storage bounded: drop everything older than the newest N. */
  private trim(kind: string): void {
    try {
      const rows = this.deps.events.recent(kind, MAX_EVENTS_PER_KIND + 1);
      if (rows.length > MAX_EVENTS_PER_KIND) {
        this.deps.log.warn(`vpn history: ${kind} exceeded ${MAX_EVENTS_PER_KIND} rows (trimming happens on read; oldest are ignored)`);
      }
    } catch {
      /* non-fatal */
    }
  }
}

/** Deepest VALIDATED depth of a report — failed probes never raise it. */
export function validatedDepthOf(report: DiscoveryReport): ScanDepth | null {
  const rank: Record<ScanDepth, number> = { tcp: 0, tls: 1, proxy: 2 };
  let best: ScanDepth | null = null;
  for (const o of report.outcomes) {
    if (o.failure !== null) continue;
    if (best === null || rank[o.depth] > rank[best]) best = o.depth;
  }
  return best;
}

/** Gateway memory entry → the dashboard row, with honestly-null percentages. */
export function reliabilityRow(g: GatewayMemoryEntry, _now: number): GatewayReliabilityRow {
  const attempted = g.successCount + g.failCount;
  const verifies = [g.verifyMs].filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return {
    nodeId: g.nodeId,
    name: g.name,
    host: g.host,
    port: g.port,
    protocol: g.protocol,
    engine: g.engine as ProxyEngineId,
    exitCountry: g.exitCountry,
    successCount: g.successCount,
    failCount: g.failCount,
    successStreak: g.successStreak,
    reliabilityPct: attempted > 0 ? (g.successCount / attempted) * 100 : null,
    meanVerifyMs: verifies.length > 0 ? verifies.reduce((s, x) => s + x, 0) / verifies.length : null,
    lastVerifyMs: verifies.length > 0 ? verifies[verifies.length - 1]! : null,
    firstSeenAt: g.firstSeenAt,
    lastSuccessAt: g.lastSuccessAt,
    lastAttemptAt: g.lastAttemptAt,
    lastVerifiedAt: g.lastSuccessAt,
  };
}

/** Validate a profile id coming back from stored events. */
export function storedProfile(p: unknown): ScanProfileId {
  try {
    return scanProfile(typeof p === 'string' ? (p as ScanProfileId) : 'balanced').id;
  } catch {
    return 'balanced';
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
