import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import os from 'node:os';

import type {
  IpFamily,
  MapConnectionRow,
  MapGeo,
  MapHop,
  MapLocalInfo,
  MapMeasurement,
  MapObservation,
  MapEndpointStatus,
  MapSweepResult,
  MapSweepRow,
  NetworkTarget,
  PingResult,
  TraceResult,
} from '@netpulse/shared';
import { coloInfo, diffObservations, summarizeLatencies } from '@netpulse/shared';

import type { RealtimeBus } from '../realtime/bus';
import type { MapObservationsRepository, ScanRepository, ServersRepository } from '../db/repositories';
import type { PlatformNetworkController } from '../providers/platform/types';
import type { VpnRegistry } from '../vpn/vpnService';
import { detectVpnState } from '../vpn/vpnState';
import type { VpnStateSummary } from '../vpn/vpnState';
import { udpQuery } from '../providers/dns/resolver';
import { cfTraceProbe } from '../util/cfProbe';
import { runCommand } from '../util/exec';
import { httpProbe } from '../util/httpProbe';
import { tlsProbe } from '../util/tlsProbe';
import { parseCymruOrigin } from '../util/traceParse';
import { processNamesForPids } from '../util/processNames';
import { familyOfIp, pickIp, resolveTarget } from '../util/targetGuard';
import { DNS_PROVIDER_GROUPS, primaryResolvers } from './dnsResolverCatalog';
import type { IpInfoService } from './ipInfoService';
import type { RouteService } from './routeService';
import type { EventService } from './eventService';
import { listGames } from './gameCatalog';

import type { Logger } from '../logger';

/** Country-level centroid approximations for hops whose ASN lookup reports a
 *  country but no city. GeoIP never proves where a router physically sits —
 *  these are clearly labeled as approximate, country-level estimates. */
const COUNTRY_GEO: Record<string, { lat: number; lon: number; city: string }> = {
  AE: { lat: 25.2, lon: 55.27, city: 'Dubai' },
  AT: { lat: 48.21, lon: 16.37, city: 'Vienna' },
  AU: { lat: -33.87, lon: 151.21, city: 'Sydney' },
  BE: { lat: 50.85, lon: 4.35, city: 'Brussels' },
  BG: { lat: 42.7, lon: 23.32, city: 'Sofia' },
  BY: { lat: 53.9, lon: 27.57, city: 'Minsk' },
  CA: { lat: 45.42, lon: -75.7, city: 'Ottawa' },
  CH: { lat: 47.38, lon: 8.54, city: 'Zurich' },
  CZ: { lat: 50.09, lon: 14.42, city: 'Prague' },
  DE: { lat: 50.11, lon: 8.68, city: 'Frankfurt' },
  DK: { lat: 55.68, lon: 12.57, city: 'Copenhagen' },
  EG: { lat: 30.04, lon: 31.24, city: 'Cairo' },
  ES: { lat: 40.42, lon: -3.7, city: 'Madrid' },
  FI: { lat: 60.17, lon: 24.94, city: 'Helsinki' },
  FR: { lat: 48.86, lon: 2.35, city: 'Paris' },
  GB: { lat: 51.51, lon: -0.13, city: 'London' },
  GR: { lat: 37.98, lon: 23.73, city: 'Athens' },
  HK: { lat: 22.32, lon: 114.17, city: 'Hong Kong' },
  HU: { lat: 47.5, lon: 19.04, city: 'Budapest' },
  IL: { lat: 32.09, lon: 34.78, city: 'Tel Aviv' },
  IN: { lat: 19.08, lon: 72.88, city: 'Mumbai' },
  IR: { lat: 35.69, lon: 51.39, city: 'Tehran' },
  IT: { lat: 45.46, lon: 9.19, city: 'Milan' },
  JP: { lat: 35.68, lon: 139.65, city: 'Tokyo' },
  KR: { lat: 37.57, lon: 126.98, city: 'Seoul' },
  KW: { lat: 29.38, lon: 47.98, city: 'Kuwait City' },
  KZ: { lat: 51.17, lon: 71.43, city: 'Astana' },
  LU: { lat: 49.61, lon: 6.13, city: 'Luxembourg' },
  NL: { lat: 52.37, lon: 4.9, city: 'Amsterdam' },
  NO: { lat: 59.91, lon: 10.75, city: 'Oslo' },
  OM: { lat: 23.59, lon: 58.38, city: 'Muscat' },
  PK: { lat: 33.68, lon: 73.05, city: 'Islamabad' },
  PL: { lat: 52.23, lon: 21.01, city: 'Warsaw' },
  QA: { lat: 25.29, lon: 51.53, city: 'Doha' },
  RO: { lat: 44.43, lon: 26.1, city: 'Bucharest' },
  RU: { lat: 55.76, lon: 37.62, city: 'Moscow' },
  SA: { lat: 24.71, lon: 46.68, city: 'Riyadh' },
  SE: { lat: 59.33, lon: 18.06, city: 'Stockholm' },
  SG: { lat: 1.35, lon: 103.82, city: 'Singapore' },
  SK: { lat: 48.15, lon: 17.11, city: 'Bratislava' },
  TR: { lat: 41.01, lon: 28.98, city: 'Istanbul' },
  TW: { lat: 25.03, lon: 121.57, city: 'Taipei' },
  UA: { lat: 50.45, lon: 30.52, city: 'Kyiv' },
  US: { lat: 38.9, lon: -77.04, city: 'Washington, D.C.' },
  UZ: { lat: 41.3, lon: 69.24, city: 'Tashkent' },
  ZA: { lat: -26.2, lon: 28.05, city: 'Johannesburg' },
};

/** Games that get map targets (documented endpoints only); others stay in the Gaming page. */
const MAP_GAME_PRIORITY = ['valorant', 'league-of-legends', 'cs2', 'dota2', 'fortnite', 'roblox', 'minecraft', 'overwatch-2', 'apex-legends', 'pubg', 'rocket-league', 'destiny-2', 'final-fantasy-xiv', 'call-of-duty', 'rainbow-six-siege'];

export interface MeasureRequest {
  targetId?: string;
  /** custom target (user input) */
  custom?: { host: string; protocol?: string; port?: number; name?: string; family?: IpFamily | 'auto' };
}

const MAX_CONCURRENT = 3;
const PROBE_TIMEOUT_MS = 3_000;

function countryCentroidGeo(country: string | null): MapGeo | null {
  if (!country) return null;
  const c = COUNTRY_GEO[country.toUpperCase()];
  if (!c) return null;
  return {
    lat: c.lat,
    lon: c.lon,
    city: c.city,
    country: null,
    countryCode: country.toUpperCase(),
    confidence: { source: 'geoip', confidence: 'low', label: 'Approximate location — country-level GeoIP estimate' },
  };
}

export class MapService {
  private readonly running = new Set<string>();

  constructor(
    private readonly deps: {
      controller: PlatformNetworkController;
      route: RouteService;
      ipInfo: IpInfoService;
      vpn: VpnRegistry;
      scans: ScanRepository;
      servers: ServersRepository;
      observations: MapObservationsRepository;
      events: EventService;
      bus: RealtimeBus;
      log: Logger;
      /** Geo-verified proxy nodes for the map (IP-evidence locations only). */
      verifiedNodes?: () => Array<{ id: string; label: string; host: string; port: number; protocol: string; region: string | null; source: string }>;
    },
  ) {}

  /* ------------------------------- targets -------------------------------- */

  listTargets(): NetworkTarget[] {
    const targets: NetworkTarget[] = [];
    const push = (t: NetworkTarget) => targets.push(t);

    // DNS: one benchmarkable resolver per provider group (the default set),
    // plus EVERY Iranian sanction resolver — the geo-filtered use case.
    for (const group of DNS_PROVIDER_GROUPS) {
      const usable = group.resolvers.filter((r) => r.ipv4 && !r.skipBenchmarkReason);
      const candidates = group.regional ? usable : usable.slice(0, 1);
      for (const r of candidates) {
        push({
          id: `dns:${r.id}`,
          type: 'dns',
          name: `${r.name}${group.regional ? ' · sanction' : ''}`,
          host: r.ipv4!,
          port: 53,
          protocol: 'udp',
          expectedRegion: group.regional ? 'Iran (sanction resolver)' : null,
          source: group.homepage ?? 'DNS resolver catalog',
        });
      }
    }
    for (const r of primaryResolvers()) {
      if (r.ipv4) {
        push({
          id: `dns:${r.id}`,
          type: 'dns',
          name: r.name,
          host: r.ipv4,
          port: 53,
          protocol: 'udp',
          source: 'DNS resolver catalog',
        });
      }
    }

    // Gaming: documented regional front doors, one latency/login endpoint per
    // region (bounded to 4 regions per game to keep the map readable).
    for (const game of listGames().filter((g) => MAP_GAME_PRIORITY.includes(g.id))) {
      const seen = new Set<string>();
      for (const ep of game.endpoints) {
        if (ep.purpose !== 'latency' && ep.purpose !== 'login') continue;
        if (ep.region == null || seen.has(ep.region) || seen.size >= 6) continue;
        seen.add(ep.region);
        const regionName = game.regions.find((r) => r.id === ep.region)?.name ?? ep.region;
        // Service front doors are HTTPS on 443; the catalog's `tcp` purpose
        // marks the RTT probe, and 443 is the documented service port.
        push({
          id: `game:${game.id}:${ep.region}`,
          type: 'game',
          name: `${game.name} · ${regionName}`,
          host: ep.hostname,
          port: ep.port ?? 443,
          protocol: ep.protocol === 'https' || ep.protocol === 'tls' ? 'tls' : 'tcp',
          expectedRegion: regionName,
          source: ep.source,
        });
      }
    }

    // Cloudflare: measured edges from the scanner (colo-deduped, real data) + speed test front.
    push({
      id: 'cloudflare:speed',
      type: 'cloudflare',
      name: 'Cloudflare speed test',
      host: 'speed.cloudflare.com',
      port: 443,
      protocol: 'https',
      expectedRegion: 'nearest edge',
      source: 'speed.cloudflare.com (official)',
    });
    const scans = this.deps.scans.listScans(5);
    const latestCompleted = scans.find((s) => s.status === 'completed');
    if (latestCompleted) {
      const seen = new Set<string>();
      for (const c of this.deps.scans.candidates(latestCompleted.id)) {
        if (!c.colo || seen.has(c.colo)) continue;
        seen.add(c.colo);
        const info = coloInfo(c.colo);
        push({
          id: `cloudflare:colo:${c.colo}`,
          type: 'cloudflare',
          name: `Cloudflare ${info?.city ?? c.colo}`,
          host: c.endpoint,
          port: 443,
          protocol: 'https',
          expectedRegion: coloInfo(c.colo)?.city ?? c.colo,
          source: `Cloudflare scan ${latestCompleted.id.slice(0, 8)} (measured edge)`,
        });
        if (seen.size >= 10) break;
      }
    }

    // VPN profiles (endpoints the user configured).
    for (const profile of this.deps.vpn.listProfiles()) {
      if (!profile.endpoint) continue;
      const host = profile.endpoint.replace(/^\[/, '').replace(/\]$/, '').split(':')[0] ?? profile.endpoint;
      const port = Number(profile.endpoint.split(':').pop());
      push({
        id: `vpn:${profile.id}`,
        type: 'vpn',
        name: `VPN · ${profile.name}`,
        host,
        port: Number.isFinite(port) ? port : profile.protocol === 'wireguard' ? 51820 : undefined,
        protocol: profile.protocol === 'wireguard' ? 'wg' : profile.protocol === 'openvpn' ? 'udp' : 'tcp',
        expectedRegion: null,
        source: 'VPN profile',
      });
    }

    // User-configured servers.
    for (const server of this.deps.servers.list()) {
      if (!server.enabled) continue;
      push({
        id: `vps:${server.id}`,
        type: 'vps',
        name: server.name,
        host: server.ipv4 ?? server.host,
        port: server.port ?? undefined,
        protocol: server.protocol ?? 'tcp',
        expectedRegion: server.region ?? server.city ?? server.country ?? null,
        source: 'Servers',
      });
    }

    // Verified proxy nodes with IP-evidence geolocation. Only nodes that
    // actually geolocated (lat/lon from the node's public IP, never from its
    // name/TLD/remark) appear on the map — unknown locations stay off rather
    // than being invented. Bounded to the freshest 12 to keep the map readable.
    for (const node of this.deps.verifiedNodes?.() ?? []) {
      push({
        id: `node:${node.id}`,
        type: 'custom',
        name: node.label,
        host: node.host,
        port: node.port,
        protocol: node.protocol,
        expectedRegion: node.region,
        source: node.source,
      });
    }

    // dedupe by id (group-first and primary resolver lists overlap)
    const seen = new Set<string>();
    return targets.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
  }

  targetById(id: string): NetworkTarget | null {
    return this.listTargets().find((t) => t.id === id) ?? null;
  }

  /* ------------------------------ measuring ------------------------------- */

  measure(req: MeasureRequest): { observationId: string } {
    if (this.running.size >= MAX_CONCURRENT) {
      throw Object.assign(new Error(`Up to ${MAX_CONCURRENT} measurements can run at once — wait for one to finish.`), {
        statusCode: 429,
        code: 'map_busy',
      });
    }
    const target = req.targetId ? this.targetById(req.targetId) : null;
    if (req.targetId && !target) {
      throw Object.assign(new Error(`Target "${req.targetId}" not found`), { statusCode: 404, code: 'not_found' });
    }
    let resolvedTarget: NetworkTarget;
    if (target) {
      resolvedTarget = target;
    } else if (req.custom?.host) {
      const protocol = req.custom.protocol ?? 'tcp';
      const port = req.custom.port ?? (protocol === 'tls' || protocol === 'https' ? 443 : protocol === 'dns' ? 53 : undefined);
      if (port == null) {
        throw Object.assign(new Error('A destination port is required for this protocol — ports are never guessed.'), {
          statusCode: 400,
          code: 'port_required',
        });
      }
      resolvedTarget = {
        id: `custom:${req.custom.host.toLowerCase()}:${port}:${protocol}`,
        type: 'custom',
        name: req.custom.name?.trim() || req.custom.host,
        host: req.custom.host.trim(),
        port,
        protocol,
        family: req.custom.family ?? 'auto',
        source: 'Custom target',
      };
    } else {
      throw Object.assign(new Error('Provide a target id or a custom host'), { statusCode: 400, code: 'no_target' });
    }

    const observationId = crypto.randomUUID();
    this.running.add(observationId);
    void this.runMeasurement(observationId, resolvedTarget).catch((err) => {
      this.deps.log.error({ err, target: resolvedTarget.id }, 'map measurement crashed');
      this.running.delete(observationId);
      this.deps.bus.publish('map', { type: 'map:error', targetId: resolvedTarget.id, message: err instanceof Error ? err.message : String(err) });
    });
    return { observationId };
  }

  private async runMeasurement(observationId: string, target: NetworkTarget): Promise<void> {
    const { controller, route, ipInfo, vpn, observations, events, bus } = this.deps;
    const startedAt = Date.now();
    const family = target.family && target.family !== 'auto' ? target.family : 4;
    const vpnState = await detectVpnState(vpn);
    const vpnLabel = vpnState.connected ? (vpnState.serverName ?? vpnState.providerId ?? 'VPN tunnel') : null;

    try {
      bus.publish('map', { type: 'map:progress', observationId, targetId: target.id, phase: 'resolve', message: `Resolving ${target.host}` });
      const resolved = await resolveTarget(target.host);
      const ip = pickIp(resolved.ips, family);
      const resolvedFamily = familyOfIp(ip);

      const measurements: MapMeasurement[] = [];
      const probeSamples = async (fn: () => Promise<number | null>, count: number): Promise<number[]> => {
        const values: number[] = [];
        for (let i = 0; i < count; i++) {
          try {
            const v = await fn();
            if (v != null) values.push(v);
          } catch {
            // sample failure counts as loss
          }
          if (i < count - 1) await new Promise((r) => setTimeout(r, 50));
        }
        return values;
      };

      // TCP connect (always when a port is configured)
      if (target.port != null && (target.protocol === 'tcp' || target.protocol === 'udp' || target.protocol === 'tls' || target.protocol === 'https' || target.protocol === 'wg' || target.protocol == null)) {
        const tcp = await probeSamples(() => controller.tcpProbe(ip, target.port!, PROBE_TIMEOUT_MS, resolvedFamily).then((r) => (r.ok ? r.ms : null)), 3);
        const s = summarizeLatencies(tcp);
        measurements.push({
          method: 'tcp',
          protocol: target.protocol === 'udp' ? 'udp' : 'tcp',
          port: target.port ?? null,
          latencyMs: s.medianMs,
          samples: s.samples,
          minMs: s.minMs,
          avgMs: s.avgMs,
          p95Ms: s.p95Ms,
          maxMs: s.maxMs,
          jitterMs: s.jitterMs,
          lossPct: tcp.length > 0 ? Math.round(((3 - tcp.length) / 3) * 1000) / 10 : 100,
          ok: tcp.length >= 1,
        });
      }

      // TLS handshake when the protocol calls for it
      if (target.protocol === 'tls' || target.protocol === 'https' || (target.port === 443 && target.protocol == null)) {
        const tls = await probeSamples(
          () => tlsProbe(ip, target.port ?? 443, PROBE_TIMEOUT_MS, target.host, resolvedFamily).then((r) => (r.ok ? r.ms : null)),
          3,
        );
        const s = summarizeLatencies(tls);
        measurements.push({
          method: 'tls',
          protocol: 'tcp',
          port: target.port ?? 443,
          latencyMs: s.medianMs,
          samples: s.samples,
          minMs: s.minMs,
          avgMs: s.avgMs,
          p95Ms: s.p95Ms,
          maxMs: s.maxMs,
          jitterMs: s.jitterMs,
          lossPct: tls.length > 0 ? Math.round(((3 - tls.length) / 3) * 1000) / 10 : 100,
          ok: tls.length >= 1,
        });
      }

      // HTTPS GET when the target is an HTTP(S) service
      if (target.protocol === 'https') {
        const http = await probeSamples(
          () => httpProbe({ host: ip, port: target.port ?? 443, sni: target.host, tls: true, timeoutMs: PROBE_TIMEOUT_MS, method: 'GET' }).then((r) => (r.ok && r.ms != null ? r.ms : null)),
          2,
        );
        const s = summarizeLatencies(http);
        measurements.push({
          method: 'https',
          protocol: 'tcp',
          port: target.port ?? 443,
          latencyMs: s.medianMs,
          samples: s.samples,
          minMs: s.minMs,
          avgMs: s.avgMs,
          p95Ms: s.p95Ms,
          maxMs: s.maxMs,
          jitterMs: s.jitterMs,
          lossPct: http.length > 0 ? Math.round(((2 - http.length) / 2) * 1000) / 10 : 100,
          ok: http.length >= 1,
        });
      }

      // DNS query RTT through the resolver itself
      if (target.type === 'dns') {
        const dnsSamples = await probeSamples(
          () => udpQuery(ip, 'cloudflare.com', 1, { timeoutMs: PROBE_TIMEOUT_MS }).then((r) => (r.ms ?? null)),
          3,
        );
        const s = summarizeLatencies(dnsSamples);
        measurements.push({
          method: 'dns',
          protocol: 'udp',
          port: target.port ?? 53,
          latencyMs: s.medianMs,
          samples: s.samples,
          minMs: s.minMs,
          avgMs: s.avgMs,
          p95Ms: s.p95Ms,
          maxMs: s.maxMs,
          jitterMs: s.jitterMs,
          lossPct: dnsSamples.length > 0 ? Math.round(((3 - dnsSamples.length) / 3) * 1000) / 10 : 100,
          ok: dnsSamples.length >= 1,
        });
      }

      // Traceroute with ASN enrichment (reuses the RouteService pipeline)
      bus.publish('map', { type: 'map:progress', observationId, targetId: target.id, phase: 'trace', message: `Tracing route to ${ip}` });
      let trace: TraceResult | null = null;
      let analysisNote: string | null = null;
      try {
        const r = await route.runTrace({ target: ip, family: resolvedFamily, maxHops: 24, measureLoss: false });
        trace = r.trace;
        const interesting = r.analysis.findings
          .filter((f) => f.severity !== 'info')
          .map((f) => f.message)
          .slice(0, 2);
        analysisNote = interesting.length > 0 ? interesting.join(' ') : null;
      } catch {
        trace = null;
      }

      // Geography: known endpoints get high confidence, everything else is a
      // clearly-labeled country-level estimate; never a claimed exact location.
      // The destination is the resolved IP (or, when the CDN never answers ICMP,
      // the deepest hop actually reached) — never an arbitrary transit router.
      const destIp = trace?.resolvedIp ?? [...(trace?.hops ?? [])].reverse().find((h) => h.ip)?.ip ?? null;
      const hops: MapHop[] = await Promise.all((trace?.hops ?? []).map(async (h, i) => {
        let geo: MapGeo | null = null;
        if (h.ip != null) {
          if (i === 0 && (h.ip.startsWith('192.168.') || h.ip.startsWith('10.') || h.ip.startsWith('172.'))) {
            // local gateway — place near our own connection's geo (approximate)
            geo = await awaitLocalGeo(ipInfo);
          } else if (h.ip === destIp) {
            geo = await awaitDestinationGeo(h.ip, target, trace);
          } else {
            geo = countryCentroidGeo(h.country);
          }
        }
        return {
          hop: h.hop,
          ip: h.ip,
          hostname: h.hostname,
          latencyMs: h.latencyMs,
          packetLoss: h.packetLoss,
          asn: h.asn,
          org: h.org,
          country: h.country,
          status: h.status,
          geo,
        };
      }));

      // Destination geography: any target fronted by Cloudflare (games, custom
      // hosts, VPSes behind CF) gets its real serving edge via a colo trace;
      // everything else gets the country from the trace hop or a direct Team
      // Cymru lookup. Never claims an exact physical location.
      async function awaitDestinationGeo(destIpAddr: string, t: NetworkTarget, tr: typeof trace): Promise<MapGeo | null> {
        if (t.type === 'cloudflare' || t.type === 'game' || t.type === 'custom' || t.type === 'vps') {
          try {
            const probe = await cfTraceProbe(destIpAddr, 443, 4_000);
            if (probe.colo) {
              const info = coloInfo(probe.colo);
              if (info?.lat != null && info.lon != null) {
                return {
                  lat: info.lat,
                  lon: info.lon,
                  city: info.city ?? null,
                  country: info.country ?? null,
                  countryCode: info.countryCode ?? null,
                  confidence: { source: 'known-endpoint', confidence: 'high', label: `Known endpoint — Cloudflare ${info.code} (${info.city})` },
                };
              }
            }
          } catch {
            // fall through to country estimate
          }
        }
        const country = tr?.hops.find((h) => h.ip === destIpAddr)?.country ?? (await cymruCountry(destIpAddr));
        return countryCentroidGeo(country);
      }

      async function cymruCountry(ipAddr: string): Promise<string | null> {
        if (ipAddr.includes(':')) return null;
        const reversed = ipAddr.split('.').reverse().join('.');
        try {
          const txts = await dns.resolveTxt(`${reversed}.origin.asn.cymru.com`);
          const parsed = (txts ?? []).map((parts) => parts.join('')).map(parseCymruOrigin).find((v) => v !== null);
          return parsed?.country ?? null;
        } catch {
          return null;
        }
      }

      async function awaitLocalGeo(ipSvc: IpInfoService): Promise<MapGeo | null> {
        try {
          const info = await ipSvc.lookup(4);
          if (info.latitude != null && info.longitude != null) {
            return {
              lat: info.latitude,
              lon: info.longitude,
              city: info.city,
              country: info.country,
              countryCode: info.countryCode,
              confidence: { source: 'geoip', confidence: 'medium', label: 'Approximate location — GeoIP estimate of your connection' },
            };
          }
        } catch {
          // no geo — hop stays unplaced
        }
        return null;
      }

      const okMeasurement = measurements.find((m) => m.ok);
      const primaryLatency = measurements.find((m) => m.method === 'tcp' || m.method === 'dns')?.latencyMs ?? okMeasurement?.latencyMs ?? null;
      let status: MapEndpointStatus;
      let statusLabel: string;
      if (!okMeasurement) {
        status = 'unreachable';
        statusLabel = 'Unreachable';
      } else if (primaryLatency == null) {
        status = 'unknown';
        statusLabel = 'Reachable';
      } else if (primaryLatency <= 40) {
        status = 'excellent';
        statusLabel = 'Excellent';
      } else if (primaryLatency <= 80) {
        status = 'good';
        statusLabel = 'Good';
      } else if (primaryLatency <= 150) {
        status = 'fair';
        statusLabel = 'Moderate';
      } else {
        status = 'poor';
        statusLabel = 'Poor';
      }

      const previous = observations.latestForTarget(target.id, 1)[0] ?? null;
      const previousObservation = previous ? (previous.payload as MapObservation) : null;
      const observation: MapObservation = {
        id: observationId,
        target,
        family: resolvedFamily,
        resolvedIp: ip,
        protocol: target.protocol ?? 'tcp',
        port: target.port ?? null,
        vpnActive: vpnState.connected,
        vpnLabel,
        createdAt: startedAt,
        durationMs: Date.now() - startedAt,
        hops,
        measurements,
        status,
        statusLabel,
        note: analysisNote,
        insights: [],
      };

      const diff = diffObservations(observation, previousObservation);
      if (diff.changed) {
        observation.insights = [...diff.changes, ...(diff.insight ? [diff.insight] : [])];
        events.record('warn', 'routing', `Route changed for ${target.name}: ${diff.changes.join(' ')}`, { targetId: target.id, observationId });
      }
      if (vpnState.connected) {
        observation.insights.unshift(`Measured through the VPN tunnel${vpnLabel ? ` (${vpnLabel})` : ''}.`);
      }
      const asnPath = trace?.hops.filter((h) => h.asn != null).map((h) => h.asn).filter((v, i, a) => a.indexOf(v) === i) ?? [];
      if (asnPath.length > 0) {
        observation.insights.push(`ASN path: ${asnPath.join(' → ')}.`);
      }

      observations.insert({
        id: observationId,
        targetId: target.id,
        targetType: target.type,
        name: target.name,
        family: resolvedFamily,
        ip,
        protocol: target.protocol ?? 'tcp',
        port: target.port ?? null,
        vpnActive: vpnState.connected,
        payload: observation,
        createdAt: startedAt,
      });

      this.running.delete(observationId);
      events.record('info', 'network', `Map measurement ${target.name}: ${statusLabel} (${primaryLatency != null ? `${primaryLatency} ms` : 'no probe'})`, {
        targetId: target.id,
        observationId,
      });
      bus.publish('map', { type: 'map:observation', observationId, targetId: target.id, observation });
    } catch (err) {
      this.running.delete(observationId);
      const message = err instanceof Error ? err.message : String(err);
      bus.publish('map', { type: 'map:error', observationId, targetId: target.id, message });
      throw err;
    }
  }

  /* ------------------------------- history -------------------------------- */

  listObservations(options: { targetId?: string; limit?: number }) {
    return this.deps.observations.list({ targetId: options.targetId, limit: options.limit });
  }

  observation(id: string) {
    return this.deps.observations.get(id);
  }

  clearObservations(): { cleared: number } {
    const cleared = this.deps.observations.clear();
    this.deps.events.record('info', 'system', `Map history cleared (${cleared} observations removed)`);
    return { cleared };
  }

  compare(targetId: string) {
    const target = this.targetById(targetId);
    if (!target) throw Object.assign(new Error(`Target "${targetId}" not found`), { statusCode: 404, code: 'not_found' });
    const rows = this.deps.observations.latestForTarget(targetId, 2);
    const [current, previous] = rows;
    if (!current) {
      return { targetId, compared: false, note: 'No measurements yet for this target — measure it first.' };
    }
    const cur = current.payload as MapObservation;
    const prev = previous ? (previous.payload as MapObservation) : null;
    const diff = diffObservations(cur, prev);
    // Direct vs VPN honesty: only meaningful when the two runs used different paths
    const directVpn: { directMs: number | null; vpnMs: number | null; verdict: string } | null =
      prev && prev.vpnActive !== cur.vpnActive
        ? {
            directMs: (prev.vpnActive ? cur : prev).measurements.find((m) => m.method === 'tcp' || m.method === 'dns')?.latencyMs ?? null,
            vpnMs: (cur.vpnActive ? cur : prev).measurements.find((m) => m.method === 'tcp' || m.method === 'dns')?.latencyMs ?? null,
            verdict:
              prev.vpnActive && cur.vpnActive === false
                ? 'Tunnel was active in the earlier run; the current direct measurement is compared below.'
                : 'Current run goes through the tunnel; the earlier direct measurement is compared below.',
          }
        : null;
    return { targetId, compared: true, current: cur, previous: prev, diff, directVpn };
  }

  /* ---------------------------- local / source ---------------------------- */

  async localInfo(): Promise<MapLocalInfo> {
    const [info, vpn] = await Promise.all([
      this.deps.ipInfo.lookup(4).catch(() => null),
      detectVpnState(this.deps.vpn),
    ]);
    const geoConfidence =
      info?.latitude != null && info.longitude != null
        ? { source: 'geoip' as const, confidence: 'medium' as const, label: 'Approximate location — GeoIP estimate of your connection' }
        : null;
    return {
      publicIp: info?.ip ?? null,
      latitude: info?.latitude ?? null,
      longitude: info?.longitude ?? null,
      city: info?.city ?? null,
      countryCode: info?.countryCode ?? null,
      isp: info?.isp ?? null,
      vpn: { connected: vpn.connected, providerId: vpn.providerId, serverName: vpn.serverName, protocol: vpn.protocol },
      geoConfidence,
    };
  }

  /* --------------------------- active connections ------------------------- */
  // Local connection metadata only (addresses, ports, states) — never payloads.
  // Best-effort: some platforms / permissions may not expose it.

  /** Measured latencies by remote ip:port, filled by sweep probes; merged into rows. */
  private latencyByEndpoint = new Map<string, { ms: number; at: number }>();
  private static LATENCY_TTL_MS = 10 * 60_000;

  recordEndpointLatency(ip: string, port: number, ms: number): void {
    if (this.latencyByEndpoint.size > 2_000) this.latencyByEndpoint.clear();
    this.latencyByEndpoint.set(`${ip}:${port}`, { ms, at: Date.now() });
  }

  private endpointLatency(ip: string, port: number | null): number | null {
    if (port == null) {
      // any recent latency for this ip
      let best: number | null = null;
      const prefix = `${ip}:`;
      for (const [k, v] of this.latencyByEndpoint) {
        if (k.startsWith(prefix) && Date.now() - v.at < MapService.LATENCY_TTL_MS) best = v.ms;
      }
      return best;
    }
    const hit = this.latencyByEndpoint.get(`${ip}:${port}`);
    return hit && Date.now() - hit.at < MapService.LATENCY_TTL_MS ? hit.ms : null;
  }

  async activeConnections(limit = 60): Promise<{ available: boolean; reason?: string; rows: MapConnectionRow[] }> {
    if (process.platform !== 'win32') {
      return { available: false, reason: 'Active connection observation currently supports Windows (netstat).', rows: [] };
    }
    try {
      const [tcp, udp] = await Promise.all([
        runCommand('netstat', ['-ano', '-p', 'tcp'], { timeoutMs: 6_000 }),
        runCommand('netstat', ['-ano', '-p', 'udp'], { timeoutMs: 6_000 }).catch(() => null),
      ]);
      if (tcp.code !== 0) return { available: false, reason: 'netstat failed', rows: [] };

      type Raw = { protocol: 'tcp' | 'udp'; local: string; remote: string | null; state: string | null; pid: number | null };
      const raws: Raw[] = [];
      const parse = (out: string, protocol: 'tcp' | 'udp', establishedOnly: boolean) => {
        for (const line of out.split(/\r?\n/).slice(2)) {
          const parts = line.trim().split(/\s+/);
          if (parts.length < 4) continue;
          const [proto, local, remote, ...rest] = parts;
          if (proto == null || proto.toUpperCase() !== protocol.toUpperCase()) continue;
          let state: string | null = null;
          let pidRaw: string | null = null;
          if (protocol === 'tcp') {
            state = rest[0] ?? null;
            pidRaw = rest[1] ?? null;
          } else {
            pidRaw = rest[0] ?? null;
          }
          if (establishedOnly && state !== 'ESTABLISHED') continue;
          const pid = pidRaw ? Number(pidRaw) : null;
          const remoteVal = remote == null || remote === '0.0.0.0:0' || remote === '[::]:0' || remote === '*:*' ? null : remote;
          // UDP "connections" are unconnected sockets — only rows with a real remote matter
          if (protocol === 'udp' && remoteVal == null) continue;
          raws.push({
            protocol,
            local: local ?? '',
            remote: remoteVal,
            state: state ?? (protocol === 'udp' ? 'READY' : null),
            pid: Number.isFinite(pid) ? pid : null,
          });
        }
      };
      parse(tcp.stdout ?? '', 'tcp', true);
      if (udp?.code === 0) parse(udp.stdout ?? '', 'udp', false);

      // dedupe (same local/remote/proto), drop loopback + link-local noise,
      // and prefer TCP rows over duplicate UDP rows for the same endpoint
      const seen = new Set<string>();
      const rows: MapConnectionRow[] = [];
      for (const r of raws) {
        const ip = r.remote?.split(':')[0] ?? '';
        if (ip === '127.0.0.1' || ip === '::1' || ip === '0.0.0.0' || ip === '' || ip.endsWith('.255')) continue;
        if (ip.startsWith('169.254.') || ip.startsWith('224.') || ip.startsWith('239.')) continue;
        const key = `${r.protocol}|${r.local}|${r.remote}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const port = Number(r.remote?.split(':').pop());
        rows.push({
          pid: r.pid,
          process: null,
          protocol: r.protocol,
          local: r.local,
          remote: r.remote,
          state: r.state,
          remoteAsn: null,
          remoteOrg: null,
          remoteCountry: null,
          remoteIp: ip.includes(':') && ip.startsWith('[') ? ip.slice(1, -1) : ip,
          remoteCountryCode: null,
          latencyMs: this.endpointLatency(ip, Number.isFinite(port) ? port : null),
        });
        if (rows.length >= limit) break;
      }

      const [enriched, names] = await Promise.all([
        enrichConnections(rows),
        processNamesForPids(rows.map((r) => r.pid)),
      ]);
      for (const row of enriched) row.process = names.get(row.pid ?? -1) ?? null;
      return { available: true, rows: enriched };
    } catch (err) {
      return { available: false, reason: err instanceof Error ? err.message : String(err), rows: [] };
    }
  }

  /* ---------------------------- batch sweep -------------------------------- */
  // Server-side ping sweep over many game/DNS/VPN targets at once with bounded
  // concurrency. ICMP is tried first (true RTT); endpoints that filter ICMP
  // fall back to TCP-connect — every row says which method produced its number.

  private sweeps = new Map<string, MapSweepResult>();

  startSweep(targetIds: string[] | null): { sweepId: string; accepted: number } {
    const live = [...this.sweeps.values()].filter((s) => !s.completed);
    if (live.length > 0) {
      throw Object.assign(new Error('A sweep is already running — wait for it to finish.'), {
        statusCode: 429,
        code: 'sweep_busy',
      });
    }
    const all = this.listTargets();
    let targets: NetworkTarget[];
    if (targetIds && targetIds.length > 0) {
      const wanted = new Set(targetIds.slice(0, 60));
      targets = all.filter((t) => wanted.has(t.id));
    } else {
      // default: game + vpn + cloudflare targets (the sweep's main use case)
      targets = all.filter((t) => t.type === 'game' || t.type === 'vpn' || t.type === 'cloudflare');
    }
    if (targets.length === 0) {
      throw Object.assign(new Error('No sweepable targets matched (sweep covers game / VPN / Cloudflare targets).'), {
        statusCode: 400,
        code: 'no_targets',
      });
    }
    const sweepId = crypto.randomUUID();
    const result: MapSweepResult = {
      sweepId,
      sourceNote:
        'Catalog hosts are documented service/login front doors, not authoritative match servers — per-match UDP routing can differ.',
      startedAt: Date.now(),
      durationMs: null,
      rows: [],
      completed: false,
    };
    this.sweeps.set(sweepId, result);
    void this.runSweep(sweepId, targets).catch((err) => {
      this.deps.log.error({ err, sweepId }, 'map sweep crashed');
      const s = this.sweeps.get(sweepId);
      if (s && !s.completed) {
        s.completed = true;
        s.error = err instanceof Error ? err.message : String(err);
        this.deps.bus.publish('map', { type: 'map:sweep', sweepId, result: s });
      }
    });
    return { sweepId, accepted: targets.length };
  }

  sweep(sweepId: string): MapSweepResult | null {
    return this.sweeps.get(sweepId) ?? null;
  }

  private async runSweep(sweepId: string, targets: NetworkTarget[]): Promise<void> {
    const result = this.sweeps.get(sweepId);
    if (!result) return;
    const startedAt = Date.now();      const vpnState = await detectVpnState(this.deps.vpn); // labeled in a later pass; keeps tunnel-state awareness on the hot path
      const rows: MapSweepRow[] = [];
    const SWEEP_CONCURRENCY = 4;
    let index = 0;
    const worker = async () => {
      for (;;) {
        const t = targets[index++];
        if (t == null) return;
        rows.push(await this.sweepOne(t, vpnState));
        // incremental push so the UI ranks as results land
        result.rows = [...rows].sort(sortSweepRows);
        this.deps.bus.publish('map', { type: 'map:sweep', sweepId, result: { ...result, rows: result.rows } });
      }
    };
    await Promise.all(Array.from({ length: Math.min(SWEEP_CONCURRENCY, targets.length) }, worker));
    result.completed = true;
    result.durationMs = Date.now() - startedAt;
    result.rows = [...result.rows].sort(sortSweepRows);
    // bounded memory: keep only the most recent sweep around
    for (const [id, s] of this.sweeps) {
      if (id !== sweepId && s.completed) this.sweeps.delete(id);
    }
    this.deps.bus.publish('map', { type: 'map:sweep', sweepId, result });
  }

  private async sweepOne(t: NetworkTarget, _vpnState: VpnStateSummary): Promise<MapSweepRow> {
    const { controller } = this.deps;
    const base: MapSweepRow = {
      target: t,
      resolvedIp: null,
      latencyMs: null,
      jitterMs: null,
      lossPct: null,
      method: null,
      status: 'unknown',
      statusLabel: 'Unknown',
      country: null,
    };
    try {
      const family = t.family && t.family !== 'auto' ? t.family : 4;
      const resolved = await resolveTarget(t.host);
      const ip = pickIp(resolved.ips, family);
      base.resolvedIp = ip;

      let icmp: PingResult | null = null;
      try {
        icmp = await controller.icmpPing(ip, { count: 4, timeoutMs: 1_200, family: familyOfIp(ip) });
      } catch {
        icmp = null;
      }
      let latency: number | null = null;
      let jitter: number | null = null;
      let loss: number | null = null;
      let method: MapSweepRow['method'] = null;
      if (icmp && icmp.received > 0 && icmp.median != null) {
        latency = icmp.median;
        jitter = icmp.jitterMs;
        loss = icmp.lossPct;
        method = 'icmp';
      }
      // TCP fallback + cross-check when a port is known (skip wg/udp-only targets)
      const port = t.port ?? null;
      const tcpEligible = port != null && t.protocol !== 'wg' && t.protocol !== 'dns';
      if (tcpEligible && port != null) {
        const samples: number[] = [];
        for (let i = 0; i < 3; i++) {
          try {
            const r = await controller.tcpProbe(ip, port, 2_000, familyOfIp(ip));
            if (r.ok && r.ms != null) samples.push(r.ms);
          } catch {
            // counts as loss
          }
        }
        if (samples.length > 0) {
          const s = summarizeLatencies(samples);
          this.recordEndpointLatency(ip, port, s.medianMs ?? samples[0]!);
          // prefer ICMP (true RTT) when both exist; TCP is the fallback
          if (latency == null) {
            latency = s.medianMs;
            jitter = s.jitterMs;
            method = 'tcp';
          }
          loss = loss ?? Math.round(((3 - samples.length) / 3) * 1000) / 10;
        } else if (latency == null) {
          loss = 100;
        }
      }
      base.latencyMs = latency;
      base.jitterMs = jitter;
      base.lossPct = loss;
      base.method = method;
      if (latency == null) {
        base.status = 'unreachable';
        base.statusLabel = 'Unreachable';
        base.error = icmp ? 'ICMP answered but TCP probes failed' : 'No ICMP reply and no TCP path';
      } else if (latency <= 40) {
        base.status = 'excellent';
        base.statusLabel = 'Excellent';
      } else if (latency <= 80) {
        base.status = 'good';
        base.statusLabel = 'Good';
      } else if (latency <= 150) {
        base.status = 'fair';
        base.statusLabel = 'Moderate';
      } else {
        base.status = 'poor';
        base.statusLabel = 'Poor';
      }
      base.country = await cymruCountryOf(ip);
      return base;
    } catch (err) {
      base.status = 'unreachable';
      base.statusLabel = 'Unreachable';
      base.error = err instanceof Error ? err.message : String(err);
      return base;
    }
  }
}

async function enrichConnections(rows: MapConnectionRow[]): Promise<MapConnectionRow[]> {
  const remoteIps = [...new Set(rows.map((r) => r.remote?.split(':')[0]).filter((ip): ip is string => ip != null && !ip.includes('[') && ip !== '127.0.0.1' && !ip.startsWith('10.') && !ip.startsWith('192.168.')))].slice(0, 40);
  const asnByIp = new Map<string, { asn: number | null; org: string | null; country: string | null }>();
  let index = 0;
  const workers = Array.from({ length: 4 }, async () => {
    for (;;) {
      const ip: string | undefined = remoteIps[index++];
      if (!ip) return;
      const reversed = ip.split('.').reverse().join('.');
      try {
        const txts = await dns.resolveTxt(`${reversed}.origin.asn.cymru.com`);
        const flat = txts?.map((parts) => parts.join('')) ?? [];
        const parsed = flat.map(parseCymruOrigin).find((v) => v !== null);
        asnByIp.set(ip, parsed ?? { asn: null, org: null, country: null });
      } catch {
        asnByIp.set(ip, { asn: null, org: null, country: null });
      }
    }
  });
  await Promise.all(workers);
  return rows.map((r) => {
    const ip = r.remote?.split(':')[0] ?? null;
    const meta = ip ? asnByIp.get(ip) : null;
    return { ...r, remoteAsn: meta?.asn ?? null, remoteOrg: meta?.org ?? null, remoteCountry: meta?.country ?? null };
  });
}

/** Warm helper used by tests: our own host platform name. */
export function mapHostPlatform(): string {
  return os.platform();
}

/** Reachable first, then by latency; unreachable/unknown at the bottom. */
function sortSweepRows(a: MapSweepRow, b: MapSweepRow): number {
  const rank = (r: MapSweepRow): number => (r.latencyMs == null ? 9_999_999 : r.latencyMs);
  return rank(a) - rank(b);
}

/** Country of an IP via Team Cymru origin TXT (cached per run). IPv6 returns null. */
const countryCache = new Map<string, string | null>();
export async function cymruCountryOf(ip: string): Promise<string | null> {
  if (ip.includes(':')) return null;
  const hit = countryCache.get(ip);
  if (hit !== undefined) return hit;
  const reversed = ip.split('.').reverse().join('.');
  let country: string | null = null;
  try {
    const txts = await dns.resolveTxt(`${reversed}.origin.asn.cymru.com`);
    const parsed = (txts ?? []).map((parts) => parts.join('')).map(parseCymruOrigin).find((v) => v !== null);
    country = parsed?.country ?? null;
  } catch {
    country = null;
  }
  if (countryCache.size > 2_000) countryCache.clear();
  countryCache.set(ip, country);
  return country;
}