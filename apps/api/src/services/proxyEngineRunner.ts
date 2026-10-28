/**
 * Engine-aware proxy probe runner.
 *
 * Picks an available local core (xray or sing-box) honoring the user's
 * preference and the node's protocol, spawns it with the node's REAL secret
 * (from the at-rest vault — tests without credentials can never succeed for
 * authenticated protocols), tunnels a real HTTPS request through the core,
 * and reports the engine used alongside the measurement.
 */
import { PROXY_ENGINES, type ParsedNodeConfig, type ProxyEngineId, type ProxyEngineStatus } from '@netpulse/shared';

import { httpsViaConnectRef } from './proxyProbe';

import {
  PROXY_ENGINE_ORDER,
  configIsTestable,
  engineArgs,
  engineSupports,
  engineSupportsConfig,
  findEngineBinary,
  startCore,
  startMultiCore,
  type CoreRun,
  type MultiCoreNode,
  type ResolvedEngine,
} from './proxyCores';

/** HTTPS-through-CONNECT probe (shared with the legacy single-engine path). */
const httpsViaConnect = httpsViaConnectRef;

export interface EngineProbeOptions {
  secret: string | null;
  testUrl?: string;
  timeoutMs?: number;
  /** user preference from settings */
  preferred: 'auto' | ProxyEngineId;
  onEngineResolved?: (engine: ProxyEngineId | null) => void;
}

export interface EngineProbeResult {
  status: 'done' | 'failed';
  engine: ProxyEngineId | null;
  latencyMs: number | null;
  totalMs: number;
  tlsVersion: string | null;
  httpStatus: number | null;
  failureKind: 'engine_unavailable' | 'engine_start_failed' | 'handshake_failed' | 'target_failed' | null;
  error: string | null;
}

/** Failover order: user preference first, then the rest by capability. */
const ALL_ENGINES = PROXY_ENGINE_ORDER;

export function engineOrder(preferred: 'auto' | ProxyEngineId): ProxyEngineId[] {
  const rest = ALL_ENGINES.filter((e) => e !== preferred);
  return preferred === 'auto' ? [...ALL_ENGINES] : [preferred as ProxyEngineId, ...rest];
}

/** Enumerate local core availability (cheap: PATH existence checks). */
export function proxyEngineStatus(preferred: 'auto' | ProxyEngineId): ProxyEngineStatus {
  const engines: ProxyEngineStatus['engines'] = [];
  let effective: ProxyEngineId | null = null;

  for (const id of engineOrder(preferred)) {
    const bin = findEngineBinary(id);
    const available = bin !== null;
    // Labels and protocol coverage come from the shared engine table so the UI
    // and the backend can never advertise different capabilities.
    const meta = PROXY_ENGINES.find((e) => e.id === id);
    engines.push({
      id,
      label: meta?.label ?? id,
      available,
      path: bin,
      version: null, // version spawn is deferred to the health page probe
      protocols: meta ? [...meta.protocols] : [],
    });
    if (effective === null && available) effective = id;
  }
  return { engines, preferred, effective };
}

const PROBE_TIMEOUT_MS = 12_000;

/**
 * Probe a node through the best available engine. Never throws.
 */
export async function proxyProbeWithEngine(
  config: ParsedNodeConfig,
  opts: EngineProbeOptions,
): Promise<EngineProbeResult> {
  const started = Date.now();
  const testUrl = opts.testUrl ?? 'https://www.cloudflare.com/cdn-cgi/trace';
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;

  let parsed: URL;
  try {
    parsed = new URL(testUrl);
  } catch {
    return { status: 'failed', engine: null, latencyMs: null, totalMs: 0, tlsVersion: null, httpStatus: null, failureKind: 'target_failed', error: 'invalid test URL' };
  }
  const targetHost = parsed.hostname;
  const targetPort = Number(parsed.port) || 443;

  // ---- preflight: honestly reject configs no core can run ----
  const testable = configIsTestable(config);
  if (!testable.ok) {
    return {
      status: 'failed',
      engine: null,
      latencyMs: null,
      totalMs: Date.now() - started,
      tlsVersion: null,
      httpStatus: null,
      failureKind: 'engine_unavailable',
      error: testable.error,
    };
  }

  // ---- engine selection: preference ∩ availability ∩ protocol+config support ----
  const status = proxyEngineStatus(opts.preferred);
  const usable = status.engines.filter((e) => {
    if (!e.available || !engineSupports(e.id, config.protocol)) return false;
    return engineSupportsConfig(e.id, config).ok;
  });
  if (usable.length === 0) {
    const anyInstalled = status.engines.some((e) => e.available);
    const reasons = status.engines
      .filter((e) => e.available && engineSupports(e.id, config.protocol))
      .map((e) => engineSupportsConfig(e.id, config))
      .filter((r) => !r.ok)
      .map((r) => r.error);
    return {
      status: 'failed',
      engine: null,
      latencyMs: null,
      totalMs: Date.now() - started,
      tlsVersion: null,
      httpStatus: null,
      failureKind: 'engine_unavailable',
      error: reasons.length > 0
        ? reasons[0]!
        : anyInstalled
          ? `no installed core supports protocol ${config.protocol}`
          : 'no proxy core installed — install xray, sing-box or v2ray to test proxy latency',
    };
  }

  // ---- try engines in order: a core that rejects the config must not end
  // the probe while another installed core may accept it. ----
  let lastFailure: { failure: 'engine_unavailable' | 'engine_start_failed'; error: string; engine: ProxyEngineId } | null = null;
  for (const chosen of usable) {
    const engine: ResolvedEngine = { id: chosen.id, bin: chosen.path!, args: engineArgs(chosen.id) };
    opts.onEngineResolved?.(chosen.id);

    const run = await startCore(engine, config, opts.secret);
    if (!run.ok) {
      lastFailure = { failure: run.failure, error: run.error, engine: chosen.id };
      continue; // failover to the next installed core
    }

    const active: CoreRun = run.run;
    try {
      const result = await httpsViaConnect(active.inboundPort, targetHost, targetPort, timeoutMs);
      return {
        status: 'done',
        engine: chosen.id,
        latencyMs: result.latencyMs,
        totalMs: Date.now() - started,
        tlsVersion: result.tlsVersion,
        httpStatus: result.status,
        failureKind: null,
        error: null,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: 'failed',
        engine: chosen.id,
        latencyMs: null,
        totalMs: Date.now() - started,
        tlsVersion: null,
        httpStatus: null,
        failureKind: /timed out|rejected|reset/i.test(msg) ? 'handshake_failed' : 'target_failed',
        error: msg.slice(0, 200),
      };
    } finally {
      active.cleanup();
    }
  }

  return {
    status: 'failed',
    engine: lastFailure?.engine ?? null,
    latencyMs: null,
    totalMs: Date.now() - started,
    tlsVersion: null,
    httpStatus: null,
    failureKind: lastFailure?.failure ?? 'engine_start_failed',
    error: lastFailure
      ? `${lastFailure.engine} rejected the config: ${lastFailure.error}`
      : 'no engine could be started',
  };
}

/* ----------------------- batched (bulk) probing --------------------------- */

/**
 * How many nodes share one core process, and how many such cores run at once.
 *
 * The old bulk path spawned a core per node: ~8 concurrent probes meant 8
 * processes, 8 readiness waits and 8 teardowns at all times, and the spawn
 * dominated a fast node's measurement. Here one process serves a whole group,
 * so 8 nodes cost one spawn, and two groups keep the probe count (16) in the
 * same order as before instead of multiplying it.
 */
export const BULK_NODES_PER_CORE = 8;
export const BULK_CORES_IN_FLIGHT = 2;

export interface BulkProbeOptions {
  testUrl?: string;
  timeoutMs?: number;
  preferred: 'auto' | ProxyEngineId;
  /** Nodes per shared core (clamped 2..16). */
  nodesPerCore?: number;
  /** Shared cores running simultaneously (clamped 1..4). */
  coresInFlight?: number;
  /**
   * Called once per shared core immediately before it spawns, with the indexes
   * of the nodes it will probe. The caller uses this to open those tests' rows
   * (so a cancelled batch never leaves `running` rows for nodes it never ran).
   */
  onGroupStart?: (indexes: readonly number[]) => void;
  /** One result per settled node, as it settles. */
  onResult?: (index: number, result: EngineProbeResult) => void;
  /** Checked between cores; true stops starting new work. */
  shouldStop?: () => boolean;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

/**
 * Protocols whose outbound is meaningless without the node's credential: every
 * one of these carries a uuid or password, and the core refuses the whole
 * config file at startup when it is missing.
 *
 * Measured on xray 26.3.27: a credential-less shadowsocks node in a batch made
 * the core exit 23 during startup ("Shadowsocks password is not specified"),
 * which took the entire group down with it — the failure is not the node's
 * alone inside ONE process.
 */
const CREDENTIAL_PROTOCOLS = new Set(['vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria2', 'tuic']);

/**
 * Probe many nodes through as few core processes as possible.
 *
 * Nodes are grouped by the engine that can actually dial them and packed
 * `nodesPerCore` at a time. One core then answers on one inbound port per
 * node, with routing that pins node i to port i (see buildXrayMultiConfig),
 * and every node's probe runs concurrently against that process.
 *
 * Hysteria is never picked for a group: its client config holds a single
 * `server`, so batching would probe one node N times. hysteria2 nodes are
 * dialled by sing-box (which supports them) when it is installed; otherwise
 * they fall back to the single-node path, where the Hysteria client is the
 * right tool. `engine` on each result says which core measured it.
 *
 * Results are aligned with `entries`: a `null` means the node was not probed
 * because `shouldStop()` went true before its group started.
 */
export async function proxyProbeManyWithEngine(
  entries: readonly MultiCoreNode[],
  opts: BulkProbeOptions,
): Promise<Array<EngineProbeResult | null>> {
  const results: Array<EngineProbeResult | null> = new Array(entries.length).fill(null);
  if (entries.length === 0) return results;

  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const testUrl = opts.testUrl ?? 'https://www.cloudflare.com/cdn-cgi/trace';
  let parsed: URL;
  try {
    parsed = new URL(testUrl);
  } catch {
    const bad: EngineProbeResult = {
      status: 'failed', engine: null, latencyMs: null, totalMs: 0, tlsVersion: null, httpStatus: null,
      failureKind: 'target_failed', error: 'invalid test URL',
    };
    entries.forEach((_, i) => {
      results[i] = bad;
      opts.onResult?.(i, bad);
    });
    return results;
  }
  const targetHost = parsed.hostname;
  const targetPort = Number(parsed.port) || 443;

  const settle = (index: number, result: EngineProbeResult): void => {
    results[index] = result;
    opts.onResult?.(index, result);
  };
  const failed = (error: string, failureKind: EngineProbeResult['failureKind'], engine: ProxyEngineId | null = null): EngineProbeResult => ({
    status: 'failed', engine, latencyMs: null, totalMs: 0, tlsVersion: null, httpStatus: null, failureKind, error,
  });

  const status = proxyEngineStatus(opts.preferred);
  const byId = new Map(status.engines.map((e) => [e.id, e]));
  // Hysteria is excluded from grouping for the reason in the doc comment.
  const bulkOrder = engineOrder(opts.preferred).filter((id) => id !== 'hysteria');

  const groupIndexes = new Map<ProxyEngineId, number[]>();
  const singles: number[] = [];
  entries.forEach((entry, i) => {
    // Preflight failures are per-node and cost no process at all.
    const testable = configIsTestable(entry.config);
    if (!testable.ok) {
      settle(i, failed(testable.error, 'engine_unavailable'));
      return;
    }
    // No credential: a shared core cannot start at all, which would report
    // every sibling in the group as failed along with this node. Such a node
    // takes the single-node path, where the failure stays its own and a core
    // that can dial it without a credential (none today) still gets a chance.
    if (CREDENTIAL_PROTOCOLS.has(entry.config.protocol) && !entry.secret) {
      singles.push(i);
      return;
    }
    const engine = bulkOrder.find((id) => {
      const e = byId.get(id);
      return Boolean(e?.available) && engineSupports(id, entry.config.protocol) && engineSupportsConfig(id, entry.config).ok;
    });
    if (engine) {
      const list = groupIndexes.get(engine) ?? [];
      list.push(i);
      groupIndexes.set(engine, list);
    } else {
      // No shared core can dial this node. The single-node path may still have
      // one that can (the Hysteria client for hysteria2), and it reports the
      // honest reason when none can.
      singles.push(i);
    }
  });

  const nodesPerCore = clampInt(opts.nodesPerCore ?? BULK_NODES_PER_CORE, 2, 16);
  const coresInFlight = clampInt(opts.coresInFlight ?? BULK_CORES_IN_FLIGHT, 1, 4);

  type Job =
    | { kind: 'shared'; engine: ProxyEngineId; indexes: number[] }
    | { kind: 'single'; index: number };
  const jobs: Job[] = [];
  for (const [engine, indexes] of groupIndexes) {
    for (let i = 0; i < indexes.length; i += nodesPerCore) {
      jobs.push({ kind: 'shared', engine, indexes: indexes.slice(i, i + nodesPerCore) });
    }
  }
  for (const index of singles) jobs.push({ kind: 'single', index });

  const runShared = async (engine: ProxyEngineId, indexes: readonly number[]): Promise<void> => {
    opts.onGroupStart?.(indexes);
    const resolved = byId.get(engine);
    if (!resolved?.path) {
      const r = failed(`no installed core supports protocol ${entries[indexes[0]!]!.config.protocol}`, 'engine_unavailable', engine);
      for (const idx of indexes) settle(idx, r);
      return;
    }
    const startedAt = Date.now();
    const run = await startMultiCore(
      { id: engine, bin: resolved.path, args: engineArgs(engine) },
      indexes.map((idx) => entries[idx]!),
    );
    if (!run.ok) {
      // The whole batch could not start (missing/misbehaving core). That is an
      // environment result for every node in it, never a per-node claim.
      const r = failed(run.error, run.failure, engine);
      for (const idx of indexes) settle(idx, { ...r, totalMs: Date.now() - startedAt });
      return;
    }

    try {
      await Promise.all(indexes.map(async (idx, k) => {
        const port = run.run.inboundPorts[k]!;
        try {
          const r = await httpsViaConnect(port, targetHost, targetPort, timeoutMs);
          settle(idx, {
            status: 'done', engine, latencyMs: r.latencyMs, totalMs: Date.now() - startedAt,
            tlsVersion: r.tlsVersion, httpStatus: r.status, failureKind: null, error: null,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          settle(idx, {
            status: 'failed', engine, latencyMs: null, totalMs: Date.now() - startedAt,
            tlsVersion: null, httpStatus: null,
            failureKind: /timed out|rejected|reset/i.test(msg) ? 'handshake_failed' : 'target_failed',
            error: msg.slice(0, 200),
          });
        }
      }));
    } finally {
      // One process, one teardown — and it happens even if one probe threw.
      run.run.cleanup();
    }
  };

  const runSingle = async (index: number): Promise<void> => {
    const entry = entries[index]!;
    // Announced exactly like a shared group, with itself as the batch. The
    // service opens its test row on this callback, so without it a single-path
    // node — Hysteria 2 (never grouped), or any node no shared core can dial —
    // was probed and then dropped: `POST /nodes/test-batch` returned no entry
    // for it and its health counters never moved.
    opts.onGroupStart?.([index]);
    const result = await proxyProbeWithEngine(entry.config, {
      secret: entry.secret,
      testUrl,
      timeoutMs,
      preferred: opts.preferred,
    });
    settle(index, result);
  };

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < jobs.length) {
      if (opts.shouldStop?.()) return;
      const job = jobs[cursor++];
      if (!job) return;
      if (job.kind === 'shared') await runShared(job.engine, job.indexes);
      else await runSingle(job.index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(coresInFlight, jobs.length) }, worker));

  return results;
}
