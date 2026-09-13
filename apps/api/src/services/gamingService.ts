import net from 'node:net';

import type {
  GameDefinition,
  GameEndpoint,
  GameEndpointResult,
  GameRegionResult,
  GamingComparison,
  GamingScore,
  GamingSessionSample,
  GamingSessionState,
  GamingTestResult,
  ProbeMethod,
  QualityBand,
  ReachabilityStatus,
  ScoreComponent,
} from '@netpulse/shared';

import type { GamingRepository, TestsRepository } from '../db/repositories';
import type { PlatformNetworkController } from '../providers/platform/types';
import { httpProbe } from '../util/httpProbe';
import { resolveTarget } from '../util/targetGuard';
import { tlsProbe } from '../util/tlsProbe';
import { GAME_CATALOG, gameById } from './gameCatalog';
import type { EventService } from './eventService';

import type { RealtimeBus } from '../realtime/bus';
import type { IpInfoService } from './ipInfoService';
import { detectVpnState } from '../vpn/vpnState';
import type { VpnRegistry } from '../vpn/vpnService';

import type { Logger } from '../logger';

const REGION_WEIGHTS = { latency: 0.3, loss: 0.25, jitter: 0.2, stability: 0.15, reachability: 0.1 } as const;
const MAX_CONCURRENCY = 6;
const DEFAULT_PROBE_TIMEOUT_MS = 2_500;

interface ProbeOutcome {
  latencyMs: number | null;
  lossPct: number | null;
  jitterMs: number | null;
  tlsVersion: string | null;
  reachability: ReachabilityStatus;
  error: string | null;
  method: ProbeMethod;
}

export interface GamingTestRequest {
  gameId: string;
  timeoutMs?: number;
}

export interface SessionRequest {
  gameId: string;
  /** optional hostname of a server you own/play on (e.g. a Minecraft server) */
  customTarget?: string;
  port?: number;
  intervalMs?: number;
}

export class GamingService {
  private readonly sessions = new Map<string, SessionRuntime>();

  constructor(
    private readonly deps: {
      controller: PlatformNetworkController;
      tests: TestsRepository;
      gaming: GamingRepository;
      events: EventService;
      ipInfo: IpInfoService;
      bus: RealtimeBus;
      vpn: VpnRegistry;
      log: Logger;
    },
  ) {}

  listGames(): GameDefinition[] {
    return GAME_CATALOG;
  }

  /* ------------------------------ game tests ------------------------------ */

  async runGameTest(req: GamingTestRequest, testIdOverride?: string): Promise<GamingTestResult> {
    const game = gameById(req.gameId);
    if (!game) throw Object.assign(new Error(`Unknown game '${req.gameId}'`), { statusCode: 400, code: 'unknown_game' });
    const timeoutMs = Math.min(Math.max(req.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS, 500), 5_000);
    const testId = testIdOverride ?? crypto.randomUUID();
    this.deps.tests.create(testId, 'gaming', { gameId: game.id });

    const startedAt = Date.now();
    const byRegion = groupEndpointsByRegion(game);
    const results: GameRegionResult[] = [];
    let measured = 0;
    const total = byRegion.size;

    const queue: { regionId: string; regionName: string; endpoints: GameEndpoint[] }[] = [...byRegion.values()];
    const worker = async () => {
      for (;;) {
        const region = queue.shift();
        if (!region) return;
        const endpointResults: GameEndpointResult[] = [];
        // measure up to 2 endpoints per region (prefer purpose=latency)
        const chosen = [...region.endpoints].sort((a, b) => Number(b.purpose === 'latency') - Number(a.purpose === 'latency')).slice(0, 2);
        for (const endpoint of chosen) {
          const outcome = await this.probeEndpoint(endpoint, timeoutMs);
          endpointResults.push({
            endpoint,
            resolvedIp: null,
            method: outcome.method,
            latencyMs: outcome.latencyMs,
            lossPct: outcome.lossPct,
            jitterMs: outcome.jitterMs,
            tlsVersion: outcome.tlsVersion,
            reachability: outcome.reachability,
            error: outcome.error,
          });
        }
        results.push(this.rollupRegion(game.id, region.regionId, region.regionName, endpointResults));
        measured += 1;
        this.deps.bus.publish(testId, {
          type: 'test:progress',
          testId,
          task: 'gaming-region',
          pct: Math.round((measured / total) * 90),
          message: `${game.name}: ${region.regionName} measured`,
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, Math.max(byRegion.size, 1)) }, () => worker()));

    this.rankRegions(results);
    const score = this.buildScore(game.id, results);
    const durationMs = Date.now() - startedAt;
    // probes use ordinary sockets, so when a tunnel owns the default route the
    // numbers measured here ARE the tunnel path — record and label that state
    const vpn = await detectVpnState(this.deps.vpn);
    if (vpn.connected) {
      const suffix = ` Measured through the VPN tunnel${vpn.serverName ? ` (${vpn.serverName})` : ''}.`;
      for (const region of results) region.reason += suffix;
    }
    const result: GamingTestResult = {
      testId,
      gameId: game.id,
      gameName: game.name,
      startedAt,
      durationMs,
      regions: results,
      score,
      vpnActive: vpn.connected,
      vpnProviderId: vpn.connected ? vpn.providerId : null,
      vpnServerName: vpn.connected ? vpn.serverName : null,
    };
    this.deps.tests.finish(testId, {
      status: 'done',
      summary: {
        gameId: game.id,
        regions: results.length,
        best: results.find((r) => r.rank === 1)?.regionName ?? null,
        score: score?.score ?? null,
        vpnActive: vpn.connected,
      },
      result,
    });
    this.deps.events.record('info', 'gaming', `Gaming test ${game.name}: ${results.length} region(s) measured`, { testId, gameId: game.id });
    this.deps.bus.publish(testId, { type: 'test:done', testId, result });
    return result;
  }

  /** Measure one documented endpoint with the probe matching its protocol. */
  async probeEndpoint(endpoint: GameEndpoint, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<ProbeOutcome & { resolvedIp: string | null }> {
    let ips: string[] = [];
    try {
      const target = await resolveTarget(endpoint.hostname);
      ips = target.ips;
    } catch {
      return { latencyMs: null, lossPct: null, jitterMs: null, tlsVersion: null, reachability: 'dns-failure', error: 'DNS resolution failed or target is not a public address', method: 'tcp-connect', resolvedIp: null };
    }
    const ip = ips[0];
    if (!ip) {
      return { latencyMs: null, lossPct: null, jitterMs: null, tlsVersion: null, reachability: 'dns-failure', error: 'No address records found', method: 'tcp-connect', resolvedIp: null };
    }
    const family = net.isIP(ip) === 6 ? 6 : 4;
    const port = endpoint.port ?? 443;

    const fail = (reachability: ReachabilityStatus, error: string, method: ProbeMethod): ProbeOutcome & { resolvedIp: string | null } => ({
      latencyMs: null, lossPct: null, jitterMs: null, tlsVersion: null, reachability, error, method, resolvedIp: ip,
    });

    if (endpoint.protocol === 'icmp') {
      try {
        const ping = await this.deps.controller.icmpPing(ip, { count: 4, timeoutMs, family });
        if (ping.received === 0) return fail('timeout', 'ICMP timeout — either ICMP is blocked or the host is down (a blocked ICMP does not mean the service is offline)', 'icmp-rtt');
        return {
          latencyMs: ping.avg ?? ping.median ?? null,
          lossPct: ping.lossPct,
          jitterMs: ping.jitterMs,
          tlsVersion: null,
          reachability: 'reachable',
          error: null,
          method: 'icmp-rtt',
          resolvedIp: ip,
        };
      } catch (err) {
        return fail('unknown', err instanceof Error ? err.message : 'ICMP probe failed', 'icmp-rtt');
      }
    }

    if (endpoint.protocol === 'tcp') {
      const probe = await this.deps.controller.tcpProbe(ip, port, timeoutMs, family);
      if (!probe.ok) {
        const refused = (probe.error ?? '').toLowerCase().includes('refused');
        return fail(refused ? 'connection-refused' : probe.error === 'timeout' ? 'timeout' : 'unreachable', probe.error ?? 'TCP connect failed', 'tcp-connect');
      }
      return { latencyMs: probe.ms, lossPct: null, jitterMs: null, tlsVersion: null, reachability: 'reachable', error: null, method: 'tcp-connect', resolvedIp: ip };
    }

    if (endpoint.protocol === 'tls') {
      const probe = await tlsProbe(ip, port, timeoutMs, endpoint.hostname, family);
      if (!probe.ok) {
        const refused = (probe.error ?? '').toLowerCase().includes('refused');
        return fail(refused ? 'connection-refused' : probe.error === 'timeout' ? 'timeout' : 'unreachable', probe.error ?? 'TLS handshake failed', 'tls-handshake');
      }
      return { latencyMs: probe.ms, lossPct: null, jitterMs: null, tlsVersion: probe.tlsVersion ?? null, reachability: 'reachable', error: null, method: 'tls-handshake', resolvedIp: ip };
    }

    // https
    const http = await httpProbe({ host: ip, port, sni: endpoint.hostname, tls: true, timeoutMs, family, method: 'HEAD', path: '/' });
    if (!http.ok) {
      return fail(http.error === 'timeout' ? 'timeout' : 'unreachable', http.error ?? 'HTTP request failed', 'http');
    }
    return { latencyMs: http.ms, lossPct: null, jitterMs: null, tlsVersion: null, reachability: 'reachable', error: null, method: 'http', resolvedIp: ip };
  }

  private rollupRegion(gameId: string, regionId: string, regionName: string, endpoints: GameEndpointResult[]): GameRegionResult {
    const latencies = endpoints.map((e) => e.latencyMs).filter((v): v is number => v != null);
    const latencyMs = latencies.length > 0 ? Math.min(...latencies) : null;
    const reachable = endpoints.some((e) => e.reachability === 'reachable');
    const firstError = endpoints.find((e) => e.reachability !== 'reachable');
    const reachability: ReachabilityStatus = reachable ? 'reachable' : (firstError?.reachability ?? 'unknown');
    const lossPct = endpoints.length > 0 && endpoints.every((e) => e.lossPct != null) ? Math.max(...(endpoints.map((e) => e.lossPct ?? 0))) : null;

    const latencyScore = latencyMs == null ? 0 : latencyScoreFor(latencyMs);
    const neutral = 70;
    const reach = reachable ? 100 : 0;
    const score = latencyMs == null
      ? null
      : Math.round(
          (REGION_WEIGHTS.latency * latencyScore
            + REGION_WEIGHTS.loss * (lossPct != null ? lossScoreFor(lossPct) : neutral)
            + REGION_WEIGHTS.jitter * neutral
            + REGION_WEIGHTS.stability * neutral
            + REGION_WEIGHTS.reachability * reach) * 10,
        ) / 10;

    let reason: string;
    if (!reachable) reason = 'No endpoint in this region answered — not reachable from your network right now.';
    else if (latencyMs == null) reason = 'Reachable but no latency could be measured.';
    else if (latencyMs <= 60) reason = `Low latency (${Math.round(latencyMs)} ms) to the documented service endpoint.`;
    else if (latencyMs <= 120) reason = `Moderate latency (${Math.round(latencyMs)} ms).`;
    else reason = `High latency (${Math.round(latencyMs)} ms) — expect degraded responsiveness.`;
    if (endpoints.every((e) => e.lossPct == null)) reason += ' Loss/jitter not measured (TCP/TLS probe only).';

    return {
      gameId,
      regionId,
      regionName,
      latencyMs,
      jitterMs: null,
      lossPct,
      score,
      reachability,
      rank: null,
      rankLabel: null,
      reason,
      endpoints,
    };
  }

  private rankRegions(results: GameRegionResult[]): void {
    const ranked = [...results].sort((a, b) => {
      if (a.score == null && b.score == null) return 0;
      if (a.score == null) return 1;
      if (b.score == null) return -1;
      return b.score - a.score;
    });
    ranked.forEach((r, i) => {
      if (r.score == null || !r.endpoints.some((e) => e.reachability === 'reachable')) {
        r.rank = null;
        r.rankLabel = 'not-recommended';
        return;
      }
      const unstable = (r.latencyMs ?? 0) > 200 || (r.lossPct ?? 0) > 2;
      if (i === 0 && !unstable) {
        r.rank = 1;
        r.rankLabel = 'best-region';
      } else if (i === 1 && !unstable) {
        r.rank = 2;
        r.rankLabel = 'second-best';
      } else {
        r.rank = i + 1;
        r.rankLabel = unstable ? 'unstable' : null;
      }
    });
  }

  /* -------------------------------- score --------------------------------- */

  private buildScore(gameId: string, results: GameRegionResult[]): GamingScore | null {
    const best = results.find((r) => r.rank === 1);
    const components: ScoreComponent[] = [];
    if (!best || best.latencyMs == null) {
      return {
        score: null,
        components: [
          { key: 'latency', label: 'Latency', band: 'no-data', detail: 'No region measured — run a game test first.' },
        ],
      };
    }

    const latencyBand = bandFor(best.latencyMs, [35, 60, 100]);
    components.push({ key: 'latency', label: 'Latency', band: latencyBand, detail: `${Math.round(best.latencyMs)} ms to ${best.regionName} (best region)` });
    components.push({ key: 'jitter', label: 'Jitter', band: 'no-data', detail: 'No jitter measurement in the quick test — run a session monitor for jitter.' });
    components.push({
      key: 'packet-loss', label: 'Packet loss', band: bandFor(best.lossPct ?? 0, [0.1, 0.5, 2]), detail: best.lossPct == null ? 'Not measured (TCP/TLS probe only).' : `${best.lossPct}% loss to ${best.regionName}`,
    });
    components.push({ key: 'stability', label: 'Stability', band: 'no-data', detail: 'Needs session-monitor history — start one for stability grading.' });
    components.push({ key: 'bufferbloat', label: 'Bufferbloat', band: 'no-data', detail: 'Run a bufferbloat test and it will be folded into this score.' });
    components.push({ key: 'route', label: 'Route quality', band: 'no-data', detail: 'No route data for this target yet — trace the region endpoint to grade the route.' });

    const gradeWeight: Record<QualityBand, number> = { excellent: 95, good: 80, fair: 60, poor: 25, 'no-data': 0 };
    const known = components.filter((c) => c.band !== 'no-data');
    const score = known.length > 0
      ? Math.round(known.reduce((acc, c) => acc + gradeWeight[c.band], 0) / known.length)
      : null;
    void gameId;
    return { score, components };
  }

  /* --------------------------- session monitor ----------------------------- */

  startSession(req: SessionRequest): GamingSessionState {
    const game = gameById(req.gameId);
    if (!game) throw Object.assign(new Error(`Unknown game '${req.gameId}'`), { statusCode: 400, code: 'unknown_game' });
    const existing = [...this.sessions.values()].find((s) => s.state.running && s.state.gameId === game.id);
    if (existing) return existing.state;

    const target = this.pickSessionTarget(game, req);
    const intervalMs = Math.min(Math.max(req.intervalMs ?? 10_000, 5_000), 60_000);
    const sessionId = crypto.randomUUID();
    const state: GamingSessionState = {
      sessionId,
      gameId: game.id,
      startedAt: Date.now(),
      running: true,
      intervalMs,
      samples: [],
      events: [],
    };
    const runtime: SessionRuntime = {
      state,
      target,
      timer: null,
      lastLatencies: [],
      baseline: null,
      prevOnline: true,
    };
    this.sessions.set(sessionId, runtime);
    this.deps.events.record('info', 'gaming', `Session monitor started for ${game.name} (${target.label}, every ${intervalMs / 1000}s)`, { sessionId, gameId: game.id });

    const tick = () => void this.tick(sessionId);
    runtime.timer = setInterval(tick, intervalMs);
    // sample immediately, then on the interval
    setTimeout(tick, 300);
    return state;
  }

  private pickSessionTarget(game: GameDefinition, req: SessionRequest): { host: string; port: number; label: string; protocol: GameEndpoint['protocol']; sni: string | null } {
    if (req.customTarget) {
      if (!/^[a-zA-Z0-9._-]+$/.test(req.customTarget)) {
        throw Object.assign(new Error('Invalid target hostname'), { statusCode: 400, code: 'invalid_target' });
      }
      return { host: req.customTarget, port: req.port ?? 443, label: req.customTarget, protocol: 'tcp', sni: null };
    }
    const first = game.endpoints.find((e) => e.purpose === 'latency') ?? game.endpoints[0];
    if (!first) throw Object.assign(new Error(`Game '${game.name}' has no bundled endpoints to monitor`), { statusCode: 400, code: 'no_endpoints' });
    return { host: first.hostname, port: first.port ?? 443, label: `${game.name} (${first.hostname})`, protocol: first.protocol, sni: first.hostname };
  }

  private async tick(sessionId: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (!runtime || !runtime.state.running) return;

    const endpoint: GameEndpoint = {
      hostname: runtime.target.host,
      protocol: runtime.target.protocol,
      port: runtime.target.port,
      purpose: 'custom',
      verified: false,
    };
    const t0 = Date.now();
    let outcome;
    try {
      outcome = await this.probeEndpoint(endpoint, Math.min(runtime.state.intervalMs - 200, 2_500));
    } catch (err) {
      outcome = { latencyMs: null, lossPct: null, jitterMs: null, tlsVersion: null, reachability: 'unknown' as ReachabilityStatus, error: err instanceof Error ? err.message : 'probe error', method: 'tcp-connect' as ProbeMethod, resolvedIp: null };
    }
    const online = outcome.reachability === 'reachable';
    const latency = outcome.latencyMs;

    // jitter proxy: difference between consecutive samples
    const prev = runtime.lastLatencies[runtime.lastLatencies.length - 1];
    const jitter = latency != null && prev != null ? Math.abs(latency - prev) : null;
    runtime.lastLatencies.push(latency);
    if (runtime.lastLatencies.length > 20) runtime.lastLatencies.shift();

    let publicIp: string | null = null;
    try {
      const info = await this.deps.ipInfo.lookup(4);
      publicIp = info.ip ?? null;
    } catch {
      // best effort — IP lookup may be offline
    }
    // label the sample by the current tunnel state (VPN can change mid-session)
    const vpnState = await detectVpnState(this.deps.vpn);

    // spike detection against a rolling baseline
    if (online && latency != null) {
      const okSamples = runtime.lastLatencies.filter((v): v is number => v != null);
      if (!runtime.baseline && okSamples.length >= 3) {
        runtime.baseline = median(okSamples);
      }
      if (runtime.baseline != null && latency > Math.max(runtime.baseline * 2, runtime.baseline + 35)) {
        this.recordSessionEvent(runtime, `Latency spike: ${Math.round(runtime.baseline)} ms → ${Math.round(latency)} ms`);
      }
    }
    if (online !== runtime.prevOnline) {
      if (online) this.recordSessionEvent(runtime, 'Network recovered');
      else this.recordSessionEvent(runtime, 'Connectivity interruption');
      runtime.prevOnline = online;
    }
    if (online && (outcome.lossPct ?? 0) > 2) {
      this.recordSessionEvent(runtime, `Packet-loss burst: ${outcome.lossPct}%`);
    }

    const sample: GamingSessionSample = {
      ts: t0,
      latencyMs: latency,
      jitterMs: jitter,
      lossPct: online ? outcome.lossPct : 100,
      online,
      publicIp,
      vpnActive: vpnState.connected,
    };
    runtime.state.samples.push(sample);
    if (runtime.state.samples.length > 1000) runtime.state.samples.splice(0, runtime.state.samples.length - 1000);
    try {
      this.deps.gaming.insertSessionSample({
        sessionId,
        gameId: runtime.state.gameId,
        endpoint: runtime.target.host,
        ts: t0,
        latencyMs: latency,
        jitterMs: jitter,
        lossPct: sample.lossPct,
        online,
        publicIp,
        vpnActive: vpnState.connected,
      });
    } catch (err) {
      this.deps.log.warn({ err }, 'failed to persist gaming session sample');
    }
    this.deps.bus.publish(sessionId, { type: 'gaming:sample', sessionId, sample });
  }

  private recordSessionEvent(runtime: SessionRuntime, message: string): void {
    const ev = { ts: Date.now(), message };
    runtime.state.events.push(ev);
    if (runtime.state.events.length > 200) runtime.state.events.shift();
    this.deps.events.record('warn', 'gaming', `Session: ${message}`, { sessionId: runtime.state.sessionId, gameId: runtime.state.gameId });
    this.deps.bus.publish(runtime.state.sessionId, { type: 'gaming:event', sessionId: runtime.state.sessionId, event: ev });
  }

  stopSession(sessionId: string): GamingSessionState | null {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) return null;
    if (runtime.timer) clearInterval(runtime.timer);
    runtime.state.running = false;
    runtime.timer = null;
    this.deps.events.record('info', 'gaming', 'Session monitor stopped', { sessionId: runtime.state.sessionId, gameId: runtime.state.gameId });
    // Evict terminated sessions so the in-memory map cannot grow without
    // bound across a long-running sidecar (samples/events were persisted).
    this.sessions.delete(sessionId);
    return runtime.state;
  }

  listSessions(): GamingSessionState[] {
    return [...this.sessions.values()].map((r) => r.state);
  }

  async sessionDetail(sessionId: string): Promise<GamingSessionState> {
    const mem = this.sessions.get(sessionId)?.state;
    if (mem) return mem;
    const db = this.deps.gaming.sessionSamples(sessionId, 500);
    return {
      sessionId,
      gameId: db[0]?.gameId ?? 'unknown',
      startedAt: db[0]?.ts ?? Date.now(),
      running: false,
      intervalMs: 10_000,
      samples: db.map((s) => ({ ts: s.ts, latencyMs: s.latencyMs, jitterMs: s.jitterMs, lossPct: s.lossPct, online: s.online, publicIp: s.publicIp, vpnActive: s.vpnActive })),
      events: [],
    };
  }

  /* ----------------------------- comparisons ------------------------------- */

  async captureComparison(gameId: string, mode: 'direct' | 'vpn', serverName?: string): Promise<{ comparisonId: string; latencyMs: number | null; note: string }> {
    const game = gameById(gameId);
    if (!game) throw Object.assign(new Error(`Unknown game '${gameId}'`), { statusCode: 400, code: 'unknown_game' });
    const testId = crypto.randomUUID();
    this.deps.tests.create(testId, 'gaming', { gameId, mode });
    const byRegion = groupEndpointsByRegion(game);
    const regions = [...byRegion.values()].slice(0, 3);
    const latencies: number[] = [];
    const jitters: number[] = [];
    for (const region of regions) {
      const endpoint = region.endpoints.find((e) => e.purpose === 'latency') ?? region.endpoints[0];
      if (!endpoint) continue;
      // two consecutive probes per front door give a jitter estimate — the
      // noise floor the direct-vs-VPN comparison is guarded against
      const [a, b] = await Promise.all([this.probeEndpoint(endpoint, 2_500), this.probeEndpoint(endpoint, 2_500)]);
      const latA = a.latencyMs;
      const latB = b.latencyMs;
      if (latA != null && latB != null) {
        latencies.push(Math.min(latA, latB));
        jitters.push(Math.abs(latA - latB));
      } else if (latA != null) latencies.push(latA);
      else if (latB != null) latencies.push(latB);
    }
    const latencyMs = latencies.length > 0 ? Math.min(...latencies) : null;
    const jitterMs = jitters.length > 0 ? median(jitters) : null;
    const comparisonId = crypto.randomUUID();
    const note = latencies.length === 0
      ? 'No endpoint answered during this capture.'
      : `Measured ${latencies.length} region front door(s) twice; best ${Math.round(latencyMs ?? 0)} ms, jitter ${Math.round((jitterMs ?? 0) * 10) / 10} ms.`;
    this.deps.gaming.insertComparison({
      id: comparisonId,
      testId,
      gameId,
      mode,
      serverName: mode === 'vpn' ? (serverName ?? 'VPN tunnel') : null,
      latencyMs,
      jitterMs,
      lossPct: null,
      score: null,
      notes: note,
    });
    this.deps.tests.finish(testId, { status: 'done', summary: { gameId, mode, latencyMs, note }, result: { comparisonId, latencyMs, note } });
    this.deps.events.record('info', 'gaming', `Comparison capture (${mode}) for ${game.name}: ${latencyMs == null ? 'no answer' : `${Math.round(latencyMs)} ms`}`, { gameId });
    return { comparisonId, latencyMs, note };
  }

  async comparisonFor(gameId: string): Promise<GamingComparison> {
    const game = gameById(gameId);
    const gameName = game?.name ?? gameId;
    const direct = this.deps.gaming.latestForMode(gameId, 'direct');
    const vpn = this.deps.gaming.latestForMode(gameId, 'vpn');

    const pair = (direct?.latencyMs ?? null) != null && (vpn?.latencyMs ?? null) != null;
    let winner: 'direct' | 'vpn' | null = null;
    let differenceMs: number | null = null;
    let confidence: 'high' | 'medium' | 'low' = 'low';
    let reason = 'Run a Direct capture and a VPN capture to compare the two paths.';
    if (pair) {
      const d = direct?.latencyMs ?? 0;
      const v = vpn?.latencyMs ?? 0;
      differenceMs = Math.abs(d - v);
      // only recommend a switch when the delta exceeds the measured jitter
      // (the noise floor of the capture) — never a sub-jitter flip-flop
      const jitter = Math.max(direct?.jitterMs ?? 0, vpn?.jitterMs ?? 0);
      const minDelta = Math.max(jitter, 2);
      if (differenceMs < minDelta) {
        reason = `Direct and VPN latencies are within measurement noise (jitter ~${Math.round(jitter * 10) / 10} ms) — no evidence the VPN helps or hurts routing to this game.`;
      } else {
        winner = d < v ? 'direct' : 'vpn';
        confidence = differenceMs >= Math.max(minDelta * 2, 15) ? 'high' : 'medium';
        reason = winner === 'vpn'
          ? `The VPN path measured ${Math.round(differenceMs)} ms faster (${Math.round(d)} ms → ${Math.round(v)} ms), beyond the measured jitter (~${Math.round(jitter * 10) / 10} ms). Note: this compares service-endpoint RTT, not in-game match-server routing.`
          : `The direct path measured ${Math.round(differenceMs)} ms faster (${Math.round(d)} ms → ${Math.round(v)} ms), beyond the measured jitter (~${Math.round(jitter * 10) / 10} ms). The VPN is not improving routing to this game right now.`;
      }
    }
    return {
      gameId,
      gameName,
      direct: direct ? { id: direct.id, gameId, mode: 'direct', serverName: null, latencyMs: direct.latencyMs, jitterMs: direct.jitterMs, lossPct: direct.lossPct, createdAt: direct.createdAt } : null,
      vpn: vpn ? { id: vpn.id, gameId, mode: 'vpn', serverName: vpn.serverName, latencyMs: vpn.latencyMs, jitterMs: vpn.jitterMs, lossPct: vpn.lossPct, createdAt: vpn.createdAt } : null,
      winner,
      differenceMs,
      confidence,
      reason,
    };
  }
}

interface SessionRuntime {
  state: GamingSessionState;
  target: { host: string; port: number; label: string; protocol: GameEndpoint['protocol']; sni: string | null };
  timer: NodeJS.Timeout | null;
  lastLatencies: (number | null)[];
  baseline: number | null;
  prevOnline: boolean;
}

function groupEndpointsByRegion(game: GameDefinition): Map<string, { regionId: string; regionName: string; endpoints: GameEndpoint[] }> {
  const map = new Map<string, { regionId: string; regionName: string; endpoints: GameEndpoint[] }>();
  for (const r of game.regions) map.set(r.id, { regionId: r.id, regionName: r.name, endpoints: [] });
  for (const ep of game.endpoints) {
    const regionId = ep.region ?? (game.regions.length === 1 ? game.regions[0]!.id : 'global');
    if (!map.has(regionId)) map.set(regionId, { regionId, regionName: regionId === 'global' ? 'Global' : regionId, endpoints: [] });
    map.get(regionId)!.endpoints.push(ep);
  }
  return map;
}

function latencyScoreFor(ms: number): number {
  if (ms <= 30) return 100;
  if (ms <= 60) return 90;
  if (ms <= 100) return 75;
  if (ms <= 150) return 55;
  if (ms <= 250) return 30;
  return 10;
}

function lossScoreFor(pct: number): number {
  if (pct <= 0.1) return 100;
  if (pct <= 0.5) return 90;
  if (pct <= 2) return 60;
  return 15;
}

/** map a measured value to a quality band using ascending thresholds. */
function bandFor(value: number, thresholds: [number, number, number]): QualityBand {
  if (value <= thresholds[0]!) return 'excellent';
  if (value <= thresholds[1]!) return 'good';
  if (value <= thresholds[2]!) return 'fair';
  return 'poor';
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}
