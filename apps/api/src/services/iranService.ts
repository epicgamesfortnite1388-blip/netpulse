import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

import type {
  ConnectivityMeasurement,
  ConnectivityTarget,
  IranConnectionSnapshot,
  IranDnsProbe,
  IranHttpProbe,
  IranIncident,
  IranRecommendation,
  IranReport,
  IranRouteProbe,
  IranSession,
  IranTcpProbe,
  IranTlsProbe,
} from '@netpulse/shared';

import { udpQuery } from '../providers/dns/resolver';
import { IRAN_CATALOG, catalogById } from './iranCatalog';
import { applyDifferential, buildSummary, classifyCell, diffIncidents, dnsDifferential, scoreCell } from './iranClassifier';

import type { RealtimeBus } from '../realtime/bus';
import type { EventService } from './eventService';
import type { RouteService } from './routeService';
import type { IpInfoService } from './ipInfoService';
import type { IranSessionsRepository, IranMeasurementsRepository } from '../db/repositories';
import type { VpnRegistry } from '../vpn/vpnService';
import type { Logger } from '../logger';

const PROBE_TIMEOUT_MS = 4_000;
const ALT_RESOLVER = '1.1.1.1';

/** Redirects may only continue to public hosts — never private/reserved ranges. */
function isSafeRedirect(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (net.isIP(u.hostname) !== 0) {
      return !isPrivateIp(u.hostname);
    }
    // resolve synchronously is not possible; block the obvious private literals
    const h = u.hostname.toLowerCase();
    return !(
      h === 'localhost' ||
      h.endsWith('.localhost') ||
      h === 'metadata.google.internal' ||
      h.endsWith('.internal') ||
      h.endsWith('.local')
    );
  } catch {
    return false;
  }
}

function isPrivateIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const parts = ip.split('.').map(Number);
    return (
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      parts[0] === 0 ||
      parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127
    );
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    return lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb') || lower.startsWith('::1') || lower.startsWith('::') && !lower.startsWith('::ffff:') && lower.length > 2;
  }
  return true;
}

export interface IranRunRequest {
  targetIds?: string[];
  /** connection ids: 'direct' plus 'vpn:<profileId>' for each profile */
  connections?: string[];
  repeats?: number;
  /** include per-target traceroute (slower); capped internally */
  includeRoute?: boolean;
  kind?: 'interactive' | 'scheduled';
}

export class IranService {
  private readonly running = new Set<string>();

  constructor(
    private readonly deps: {
      route: RouteService;
      ipInfo: IpInfoService;
      vpn: VpnRegistry;
      events: EventService;
      bus: RealtimeBus;
      sessions: IranSessionsRepository;
      measurements: IranMeasurementsRepository;
      log: Logger;
    },
  ) {}

  listCatalog(): { categories: { id: string; name: string; targets: ConnectivityTarget[] }[]; total: number } {
    const byCat = new Map<string, ConnectivityTarget[]>();
    for (const t of IRAN_CATALOG) {
      const list = byCat.get(t.category) ?? [];
      list.push(t);
      byCat.set(t.category, list);
    }
    const categories = [...byCat.entries()].map(([id, targets]) => ({ id, name: id, targets }));
    return { categories, total: IRAN_CATALOG.length };
  }

  catalogById(id: string): ConnectivityTarget | null {
    return catalogById(id);
  }

  /** Every testable connection: the direct internet path plus each VPN profile. */
  async listConnections(): Promise<IranConnectionSnapshot[]> {
    const profiles = this.deps.vpn.listProfiles();
    const connections: IranConnectionSnapshot[] = [
      { id: 'direct', name: 'Direct Internet', mode: 'direct', publicIp: null, isp: null, asn: null, country: null, vpnServerName: null, vpnProtocol: null, vpnEndpoint: null },
    ];
    for (const p of profiles) {
      connections.push({
        id: `vpn:${p.id}`,
        name: p.name,
        mode: 'vpn',
        publicIp: null,
        isp: null,
        asn: null,
        country: null,
        vpnServerName: p.name,
        vpnProtocol: p.protocol,
        vpnEndpoint: p.endpoint,
      });
    }
    // enrich direct snapshot with the public IP / ISP context (best effort, redactable)
    try {
      const info = await this.deps.ipInfo.lookup(4);
      connections[0] = {
        ...connections[0]!,
        publicIp: info.ip ?? null,
        isp: info.isp ?? null,
        asn: info.asn?.asn ?? null,
        country: info.country ?? null,
      };
    } catch {
      // context stays null — no fabricated identity
    }
    return connections;
  }

  /* ------------------------------ session run ----------------------------- */

  startSession(req: IranRunRequest): { sessionId: string } {
    const sessionId = crypto.randomUUID();
    void this.runSession(sessionId, req).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.log.warn({ err: message, sessionId }, 'iran session failed');
      this.deps.bus.publish(sessionId, { type: 'iran:error', sessionId, message });
      this.deps.events.record('warn', 'connectivity', `Iran connectivity test failed: ${message}`, { sessionId });
    });
    return { sessionId };
  }

  async runSession(sessionId: string, req: IranRunRequest): Promise<void> {
    if (this.running.has(sessionId)) return;
    this.running.add(sessionId);

    const targetIds = (req.targetIds ?? []).length > 0 ? req.targetIds! : [];
    const repeats = Math.min(Math.max(req.repeats ?? 1, 1), 5);
    const kind = req.kind ?? 'interactive';

    const connections = await this.listConnections();
    const requested = req.connections ?? connections.map((c) => c.id);
    const selected = connections.filter((c) => requested.includes(c.id));

    this.deps.sessions.create(sessionId, {
      kind,
      status: 'running',
      startedAt: Date.now(),
      connections: selected.map((c) => ({ ...c })),
      targetIds,
      progress: 0,
    });

    const startedAt = Date.now();
    const measurements: ConnectivityMeasurement[] = [];
    let done = 0;
    const total = targetIds.length * selected.length;

    try {
      for (const targetId of targetIds) {
        const target = catalogById(targetId);
        if (!target) continue;
        for (const conn of selected) {
          this.deps.bus.publish(sessionId, {
            type: 'iran:progress',
            sessionId,
            targetId,
            connectionId: conn.id,
            message: `Testing ${target.name} via ${conn.name}`,
          });
          const measurement = await this.measureTarget(target, conn, { repeats, includeRoute: req.includeRoute === true });
          measurements.push(measurement);
          this.deps.measurements.insert({
            id: crypto.randomUUID(),
            sessionId,
            targetId,
            connectionId: conn.id,
            connectionName: conn.name,
            payload: measurement,
            createdAt: Date.now(),
          });
          done++;
          this.deps.bus.publish(sessionId, {
            type: 'iran:measurement',
            sessionId,
            measurement,
          });
          this.deps.sessions.update(sessionId, { progress: Math.round((done / total) * 100) });
          this.deps.bus.publish(sessionId, {
            type: 'iran:progress',
            sessionId,
            targetId,
            connectionId: conn.id,
            pct: Math.round((done / total) * 100),
            message: `Completed ${target.name} via ${conn.name}`,
          });
        }
      }

      // differential pass per target across its cells
      const byTarget = new Map<string, ConnectivityMeasurement[]>();
      for (const m of measurements) {
        const list = byTarget.get(m.targetId) ?? [];
        list.push(m);
        byTarget.set(m.targetId, list);
      }
      const finalMeasurements: ConnectivityMeasurement[] = [];
      for (const cells of byTarget.values()) {
        finalMeasurements.push(
          ...applyDifferential(
            cells.map((m) => ({ connectionId: m.connectionId, connectionName: m.connectionName, measurement: m })),
          ),
        );
      }

      // scoring pass
      const scored = finalMeasurements.map((m) => ({ ...m, score: scoreCell(m) }));

      const summary = buildSummary(scored, selected.map((c) => ({ id: c.id, name: c.name })));
      this.deps.sessions.finish(sessionId, {
        status: 'done',
        completedAt: Date.now(),
        summary,
        progress: 100,
        durationMs: Date.now() - startedAt,
      });
      this.deps.events.record('info', 'connectivity', `Iran connectivity test completed: ${summary.reachable}/${summary.total} targets reachable`, {
        sessionId,
        reachable: summary.reachable,
        total: summary.total,
        healthScore: summary.healthScore,
      });
      this.deps.bus.publish(sessionId, { type: 'iran:done', sessionId, session: this.getSession(sessionId) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.sessions.update(sessionId, { status: 'error', error: message });
      this.deps.bus.publish(sessionId, { type: 'iran:error', sessionId, message });
      throw err;
    } finally {
      this.running.delete(sessionId);
    }
  }

  /* ------------------------------- probes --------------------------------- */

  private async measureTarget(
    target: ConnectivityTarget,
    conn: IranConnectionSnapshot,
    opts: { repeats: number; includeRoute: boolean },
  ): Promise<ConnectivityMeasurement> {
    const primaryHost = target.hostnames[0]!;
    const port = target.port ?? 443;
    const vpnConnected = conn.mode === 'vpn' ? await this.isProfileConnected(conn) : false;
    const endpointOnly = conn.mode === 'vpn' && !vpnConnected;

    const startedAt = Date.now();
    const dnsProbe = await this.dnsProbe(primaryHost);
    const altDns = dnsProbe.ok ? await this.dnsProbe(primaryHost, ALT_RESOLVER) : null;

    let tcp: IranTcpProbe | null = null;
    let tls: IranTlsProbe | null = null;
    let httpProbe: IranHttpProbe | null = null;
    let route: IranRouteProbe | null = null;

    if (endpointOnly && conn.vpnEndpoint) {
      // VPN profile not connected — probe only the tunnel endpoint itself.
      const ep = conn.vpnEndpoint;
      const [host, portStr] = ep.includes(':') ? [ep.split(':')[0]!, ep.split(':')[1]!] : [ep, String(port)];
      const endpointPort = Number(portStr) || port;
      tcp = await this.tcpProbe(host, endpointPort);
    } else {
      tcp = await this.tcpProbe(primaryHost, port);
      if (tcp.ok) tls = await this.tlsProbe(primaryHost, port);
      if (tls?.ok) httpProbe = await this.httpsProbe(primaryHost, port);
    }

    if (opts.includeRoute && conn.mode === 'direct' && dnsProbe.a?.[0]) {
      route = await this.routeProbe(dnsProbe.a[0], target.name);
    }

    // repeated passes — success rate across samples
    let successCount = 0;
    let samples = 1;
    if (opts.repeats > 1) {
      for (let i = 1; i < opts.repeats; i++) {
        const again = await this.tcpProbe(primaryHost, port);
        if (again.ok) successCount++;
        samples++;
      }
    }
    const baseOk = httpProbe?.ok === true;
    const successRate = samples === 0 ? 0 : (baseOk ? 1 + successCount : successCount) / samples;

    const classification = classifyCell({
      dns: dnsProbe,
      tcp,
      tls,
      http: httpProbe,
      route,
      vpnConnected,
      endpointOnly,
      repeats: samples,
      successRate,
      medianLatencyMs: httpProbe?.latencyMs ?? tls?.latencyMs ?? tcp?.latencyMs ?? null,
    });

    // fold DNS differential into evidence when the alternative resolver disagrees
    let classificationFinal = classification;
    if (altDns) {
      const diff = dnsDifferential(dnsProbe, altDns);
      if (diff.differs) {
        classificationFinal = {
          ...classification,
          evidence: [...classification.evidence, diff.note],
        };
      }
    }

    return {
      sessionId: '',
      targetId: target.id,
      connectionId: conn.id,
      connectionName: conn.name,
      samples,
      startedAt,
      durationMs: Date.now() - startedAt,
      dns: dnsProbe,
      tcp,
      tls,
      http: httpProbe,
      route,
      classification: classificationFinal,
      score: null,
    };
  }

  private async isProfileConnected(conn: IranConnectionSnapshot): Promise<boolean> {
    const profileId = conn.id.startsWith('vpn:') ? conn.id.slice(4) : null;
    if (!profileId) return false;
    const profile = this.deps.vpn.getProfile(profileId);
    if (!profile) return false;
    const provider = this.deps.vpn.get(profile.providerId);
    if (!provider) return false;
    try {
      const status = await Promise.race([
        provider.status(),
        new Promise<null>((resolve) => {
          const t = setTimeout(() => resolve(null), 2_000);
          t.unref?.();
        }),
      ]);
      return status?.connected === true;
    } catch {
      return false;
    }
  }

  private async dnsProbe(host: string, server?: string): Promise<IranDnsProbe> {
    if (server) {
      // literal resolver — direct UDP query so DNS transport is what we measure
      const res = await udpQuery(server, host, 1, { timeoutMs: PROBE_TIMEOUT_MS });
      const answers = res.response?.answers ?? [];
      const a = answers.filter((x) => x.type === 1).map((x) => String(x.data)).filter((v) => v);
      const nxdomain = res.response?.rcode === 3;
      return {
        ok: res.response?.rcode === 0 && a.length > 0,
        latencyMs: res.ms,
        resolver: server,
        a: a.length > 0 ? a : null,
        aaaa: null,
        cname: null,
        rcode: res.response != null ? String(res.response.rcode) : null,
        nxdomain,
        error: res.error ?? (nxdomain ? 'NXDOMAIN' : a.length === 0 ? 'no A records' : null),
      };
    }
    try {
      const start = process.hrtime.bigint();
      const [a, aaaa, cname] = await Promise.all([
        dns.resolve4(host).catch(() => [] as string[]),
        dns.resolve6(host).catch(() => [] as string[]),
        dns.resolveCname(host).catch(() => [] as string[]),
      ]);
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      return {
        ok: a.length > 0 || aaaa.length > 0,
        latencyMs: Math.round(ms * 100) / 100,
        resolver: null,
        a: a.length > 0 ? a : null,
        aaaa: aaaa.length > 0 ? aaaa : null,
        cname: cname.length > 0 ? cname : null,
        rcode: null,
        nxdomain: a.length === 0 && aaaa.length === 0 && cname.length === 0,
        error: null,
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: null,
        resolver: null,
        a: null,
        aaaa: null,
        cname: null,
        rcode: null,
        nxdomain: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async tcpProbe(host: string, port: number): Promise<IranTcpProbe> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      const start = process.hrtime.bigint();
      let done = false;
      const finish = (ok: boolean, error?: string, family?: 4 | 6) => {
        if (done) return;
        done = true;
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        socket.destroy();
        resolve({ ok, latencyMs: ok ? Math.round(ms * 100) / 100 : null, port, family: family ?? null, error: error ?? null });
      };
      socket.setTimeout(PROBE_TIMEOUT_MS);
      socket.once('connect', () => finish(true, undefined, socket.localAddress?.includes(':') ? 6 : 4));
      socket.once('timeout', () => finish(false, 'timeout'));
      socket.once('error', (err: Error) => finish(false, err.message));
      socket.connect({ host, port });
    });
  }

  private async tlsProbe(host: string, port: number): Promise<IranTlsProbe> {
    return new Promise((resolve) => {
      let socket: tls.TLSSocket | null = null;
      const start = process.hrtime.bigint();
      let done = false;
      const finish = (r: IranTlsProbe) => {
        if (done) return;
        done = true;
        try {
          socket?.destroy();
        } catch {
          // closed
        }
        resolve(r);
      };
      try {
        socket = tls.connect({
          host,
          port,
          servername: net.isIP(host) === 0 ? host : undefined,
          timeout: PROBE_TIMEOUT_MS,
          rejectUnauthorized: false, // report certificate authorization, never fake reachability
        });
      } catch (err) {
        finish({ ok: false, latencyMs: null, tlsVersion: null, authorized: null, error: err instanceof Error ? err.message : String(err) });
        return;
      }
      socket.once('secureConnect', () => {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        const s = socket;
        finish({
          ok: true,
          latencyMs: Math.round(ms * 100) / 100,
          tlsVersion: s?.getProtocol?.() ?? null,
          authorized: s?.authorized ?? null,
          error: null,
        });
      });
      socket.once('timeout', () => finish({ ok: false, latencyMs: null, tlsVersion: null, authorized: null, error: 'timeout' }));
      socket.once('error', (err: Error) => finish({ ok: false, latencyMs: null, tlsVersion: null, authorized: null, error: err.message }));
    });
  }

  private async httpsProbe(host: string, port: number): Promise<IranHttpProbe> {
    return new Promise((resolve) => {
      const start = process.hrtime.bigint();
      const redirectChain: string[] = [];
      let done = false;

      const request = (target: string, redirectsLeft: number) => {
        let url: URL;
        try {
          url = new URL(target);
        } catch {
          finish(false, null, null, null, 'invalid redirect target');
          return;
        }
        const transport = url.protocol === 'http:' ? http : https;
        const req = transport.request(
          {
            host: url.hostname,
            port: url.port ? Number(url.port) : url.protocol === 'http:' ? 80 : 443,
            path: `${url.pathname}${url.search}`,
            method: 'GET',
            timeout: PROBE_TIMEOUT_MS,
            headers: {
              'user-agent': 'NetPulse/1.0 (local connectivity diagnostics)',
              accept: '*/*',
              connection: 'close',
            },
            ...(url.protocol === 'https:' ? { servername: net.isIP(url.hostname) === 0 ? url.hostname : undefined, rejectUnauthorized: false } : {}),
          },
          (res) => {
            const ms = Number(process.hrtime.bigint() - start) / 1e6;
            const status = res.statusCode ?? null;
            if (status != null && status >= 300 && status < 400 && res.headers.location && redirectsLeft > 0) {
              redirectChain.push(target);
              const next = new URL(res.headers.location, target).toString();
              // never follow redirects into private networks
              if (!isSafeRedirect(next)) {
                finish(false, Math.round(ms * 100) / 100, status, null, `redirect to unsafe host: ${next}`);
                return;
              }
              res.resume();
              request(next, redirectsLeft - 1);
              return;
            }
            const contentType = typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : null;
            redirectChain.push(target);
            finish(true, Math.round(ms * 100) / 100, status, contentType, null);
            res.resume();
          },
        );
        req.once('timeout', () => {
          req.destroy();
          finish(false, null, null, null, 'timeout');
        });
        req.once('error', (err: Error) => finish(false, null, null, null, err.message));
        req.end();
      };

      const finish = (ok: boolean, latencyMs: number | null, status: number | null, contentType: string | null, error: string | null) => {
        if (done) return;
        done = true;
        resolve({
          ok,
          latencyMs: latencyMs != null ? Math.round(latencyMs * 100) / 100 : null,
          status,
          redirectChain,
          contentType,
          error,
        });
      };

      request(`https://${host}:${port}/`, 4);
    });
  }

  /* ------------------------------ history --------------------------------- */

  private async routeProbe(ip: string, name: string): Promise<IranRouteProbe | null> {
    try {
      const r = await this.deps.route.runTrace({ target: ip, family: 4, maxHops: 24, measureLoss: false });
    const asnPath = r.trace.hops
      .filter((h): h is typeof h & { asn: number; ip: string } => h.ip != null && h.asn != null)
      .map((h) => ({ hop: h.hop, asn: h.asn, org: h.org, country: h.country }));
      const responsive = r.trace.hops.filter((h) => h.latencyMs != null);
      return {
        ok: responsive.length > 0,
        hops: r.trace.hops.length,
        asnPath,
        latencyMs: responsive.length > 0 ? Math.max(...responsive.map((h) => h.latencyMs as number)) : null,
        note: null,
      };
    } catch {
      return { ok: false, hops: 0, asnPath: [], latencyMs: null, note: `Traceroute to ${name} failed` };
    }
  }

  listSessions(limit = 20): IranSession[] {
    return this.deps.sessions.list(limit)
      .map((r) => this.hydrateSession(r))
      .filter((s): s is IranSession => s != null);
  }

  getSession(id: string): IranSession | null {
    const row = this.deps.sessions.get(id);
    return row ? this.hydrateSession(row) : null;
  }

  private hydrateSession(row: { id: string; payload: unknown }): IranSession | null {
    try {
      const payload = (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as Partial<IranSession>;
      const session = payload as IranSession;
      const ms = this.deps.measurements.listBySession(row.id);
      return { ...session, id: row.id, measurements: ms.map((m) => m.payload as ConnectivityMeasurement) };
    } catch {
      return null;
    }
  }

  matrix(sessionId: string): { targetId: string; name: string; category: string; cells: { connectionId: string; connectionName: string; state: string; latencyMs: number | null; score: number | null }[] }[] {
    const session = this.getSession(sessionId);
    if (!session) return [];
    const byTarget = new Map<string, ConnectivityMeasurement[]>();
    for (const m of session.measurements) {
      const list = byTarget.get(m.targetId) ?? [];
      list.push(m);
      byTarget.set(m.targetId, list);
    }
    return [...byTarget.entries()].map(([targetId, cells]) => {
      const t = catalogById(targetId);
      return {
        targetId,
        name: t?.name ?? targetId,
        category: t?.category ?? 'Unknown',
        cells: cells.map((c) => ({
          connectionId: c.connectionId,
          connectionName: c.connectionName,
          state: c.classification.state,
          latencyMs: c.http?.latencyMs ?? c.tls?.latencyMs ?? c.tcp?.latencyMs ?? null,
          score: c.score?.total ?? null,
        })),
      };
    });
  }

  incidents(days = 30): IranIncident[] {
    const sessions = this.deps.sessions.list(50)
      .map((r) => this.hydrateSession(r))
      .filter((s): s is IranSession => s != null)
      .filter((s) => s.startedAt > Date.now() - days * 86_400_000)
      .sort((a, b) => a.startedAt - b.startedAt);
    const all: IranIncident[] = [];
    for (let i = 1; i < sessions.length; i++) {
      const prev = sessions[i - 1]!.measurements;
      const cur = sessions[i]!.measurements;
      all.push(...diffIncidents(prev, cur));
    }
    return all.sort((a, b) => b.observedAt - a.observedAt).slice(0, 200);
  }

  clearHistory(): { cleared: number } {
    const n = this.deps.measurements.clear();
    this.deps.sessions.clear();
    return { cleared: n };
  }

  /* ------------------------------- report --------------------------------- */

  report(sessionId: string, opts: { redactPublicIp?: boolean; redactHostnames?: boolean } = {}): IranReport | null {
    const session = this.getSession(sessionId);
    if (!session) return null;
    return {
      sessionId,
      generatedAt: Date.now(),
      connection: session.connections[0] ? { ...session.connections[0], publicIp: opts.redactPublicIp ? null : session.connections[0].publicIp } : null,
      targetResults: session.measurements.map((m) => ({
        targetId: m.targetId,
        name: opts.redactHostnames ? catalogById(m.targetId)?.name ?? '[redacted]' : catalogById(m.targetId)?.name ?? m.targetId,
        state: m.classification.state,
        assessment: m.classification.assessment,
        confidence: m.classification.confidence,
        latencyMs: m.http?.latencyMs ?? m.tls?.latencyMs ?? m.tcp?.latencyMs ?? null,
        score: m.score?.total ?? null,
      })),
      recommendations: this.recommendations(sessionId),
      privacy: { publicIpRedacted: opts.redactPublicIp === true, hostnamesRedacted: opts.redactHostnames === true },
    };
  }

  recommendations(sessionId: string): IranRecommendation[] {
    const session = this.getSession(sessionId);
    if (!session || session.measurements.length === 0) return [];
    const recs: IranRecommendation[] = [];
    const byTarget = new Map<string, ConnectivityMeasurement[]>();
    for (const m of session.measurements) {
      const list = byTarget.get(m.targetId) ?? [];
      list.push(m);
      byTarget.set(m.targetId, list);
    }
    for (const [targetId, cells] of byTarget) {
      const t = catalogById(targetId);
      const scored = cells.filter((c) => c.score != null);
      if (scored.length === 0) continue;
      const best = scored.sort((a, b) => (b.score!.total) - (a.score!.total))[0]!;
      const bestName = best.connectionName;
      const stable = best.classification.assessment === 'Likely Reachable';
      const latency = best.http?.latencyMs ?? best.tls?.latencyMs ?? best.tcp?.latencyMs;
      const evidence = [...best.classification.evidence.slice(0, 4)];
      const reason = stable
        ? `${bestName} is the best tested path for ${t?.name ?? targetId} (score ${best.score!.total}, ${latency != null ? `${Math.round(latency)} ms` : 'no latency sample'}).`
        : `No tested path is fully reliable for ${t?.name ?? targetId}; ${bestName} scored highest (${best.score!.total}).`;
      recs.push({
        targetId,
        targetName: t?.name ?? targetId,
        category: t?.category ?? null,
        connectionId: best.connectionId,
        connectionName: bestName,
        reason,
        evidence,
        confidence: best.classification.confidence,
        score: best.score!.total,
      });
    }
    // category-level: best connection across targets in the same category
    const byCat = new Map<string, { id: string; name: string; score: number; count: number }[]>();
    for (const r of recs) {
      if (!r.category) continue;
      const list = byCat.get(r.category) ?? [];
      const existing = list.find((x) => x.id === r.connectionId);
      if (existing) {
        existing.score += r.score ?? 0;
        existing.count++;
      } else {
        list.push({ id: r.connectionId, name: r.connectionName, score: r.score ?? 0, count: 1 });
      }
      byCat.set(r.category, list);
    }
    for (const [cat, list] of byCat) {
      const best = list.sort((a, b) => b.score / b.count - a.score / a.count)[0]!;
      recs.push({
        targetId: null,
        targetName: null,
        category: cat as ConnectivityTarget['category'],
        connectionId: best.id,
        connectionName: best.name,
        reason: `For the ${cat} category, ${best.name} scored best on average (${Math.round(best.score / best.count)} avg).`,
        evidence: [`Based on ${best.count} tested ${cat.toLowerCase()} targets in this session`],
        confidence: 'Medium',
        score: Math.round(best.score / best.count),
      });
    }
    return recs;
  }

  /** Curated one-click run: default target set across every connection. */
  curatedTargetIds(): string[] {
    return DEFAULT_IRAN_TARGET_IDS;
  }

  async alternateResolverNote(targetId: string, host?: string): Promise<string> {
    const target = catalogById(targetId) ?? (host ? { hostnames: [host] } as ConnectivityTarget : null);
    if (!target) return 'Unknown target.';
    const primary = target.hostnames[0]!;
    const sys = await this.dnsProbe(primary);
    const alt = await this.dnsProbe(primary, ALT_RESOLVER);
    return dnsDifferential(sys, alt).note;
  }
}

/** Curated default target set for the one-click Iran test (see DEFAULT_TEST_IDS in the catalog). */
import { DEFAULT_TEST_IDS as DEFAULT_IRAN_TARGET_IDS } from './iranCatalog';