import type { DnsBenchmarkRow, DnsLeakResolver, DnsLeakResult, DnsQualityLabel, DnsServerSpec, DnsTransport, DnssecDeepResult } from '@netpulse/shared';
import { dnsStatusForLatency, percentile } from '@netpulse/shared';

import { Rcode } from '../providers/dns/codec';
import type { RealtimeBus } from '../realtime/bus';
import type { DnsBenchmarksRepository, TestsRepository } from '../db/repositories';
import { recommendDns, type DnsRecommendationProfile, type DnsRecommendationResult } from './dnsRecommendation';
import type { DnsProviderMeta } from './dnsRecommendation';
import { DnsType } from '../providers/dns/codec';
import { dnssecValidating, dohQuery, dotQuery, knownResolverOrg, resolverEgressIp, udpQuery } from '../providers/dns/resolver';
import type { PlatformNetworkController } from '../providers/platform/types';
import { detectVpnState } from '../vpn/vpnState';
import type { VpnRegistry } from '../vpn/vpnService';
import { allResolvers, benchmarkable, primaryResolvers } from './dnsResolverCatalog';
import type { EventService } from './eventService';
import type { SettingsService } from './settingsService';
import type { AppSettings } from '@netpulse/shared';

import type { Logger } from '../logger';

export interface DnsTestRequest {
  providers?: string[];
  probes?: number;
  timeoutMs?: number;
  transport?: DnsTransport | 'both';
}

/** Canonical benchmark row — see @netpulse/shared DnsBenchmarkRow. */
export type DnsProviderResult = DnsBenchmarkRow;


export class DnsService {    constructor(
    private readonly deps: {
      controller: PlatformNetworkController;
      tests: TestsRepository;
      benchmarks: DnsBenchmarksRepository;
      events: EventService;
      settings: SettingsService;
      bus: RealtimeBus;
      vpn: VpnRegistry;
      log: Logger;
    },
  ) {}

  async measureProvider(
    spec: DnsServerSpec,
    opts: { probes: number; timeoutMs: number; transport: DnsTransport; vpnActive: boolean },
    testId?: string,
    index?: number,
    total?: number,
  ): Promise<DnsProviderResult> {
    void index;
    void total;
    const latencies: number[] = [];
    let timeouts = 0;
    let anyOk = false;
    let dnssec: boolean | null = null;

    const runQuery = async (): Promise<{ ms: number; ok: boolean }> => {
      if (opts.transport === 'doh') {
        if (!spec.dohUrl) return { ms: 0, ok: false };
        const res = await dohQuery(spec.dohUrl, 'example.com', DnsType.A, { timeoutMs: opts.timeoutMs });
        return { ms: res.ms, ok: res.response?.rcode === 0 };
      }
      if (opts.transport === 'dot') {
        if (!spec.dotHost) return { ms: 0, ok: false };
        const res = await dotQuery(spec.dotHost, 'example.com', DnsType.A, { timeoutMs: opts.timeoutMs });
        return { ms: res.ms, ok: res.response?.rcode === 0 };
      }
      const server = spec.ipv4;
      if (!server) return { ms: 0, ok: false };
      const res = await udpQuery(server, 'example.com', DnsType.A, { timeoutMs: opts.timeoutMs });
      return { ms: res.ms, ok: res.response?.rcode === 0 };
    };

    for (let i = 0; i < opts.probes; i++) {
      const res = await runQuery();
      if (res.ok) {
        latencies.push(res.ms);
        anyOk = true;
      } else {
        timeouts += 1;
      }
      if (testId && total) {
        this.deps.bus.publish(testId, {
          type: 'test:progress',
          testId,
          task: 'dns-probe',
          pct: Math.round((((index ?? 0) * opts.probes + i + 1) / (total * opts.probes)) * 90),
          message: `${spec.name}: ${i + 1}/${opts.probes} probes`,
        });
      }
    }

    // DNSSEC: validating resolvers SERVFAIL the deliberately broken zone
    if (spec.ipv4 && opts.transport === 'udp') {
      dnssec = await dnssecValidating(spec.ipv4, opts.timeoutMs);
    }

    // IPv6 reachability of the resolver (only meaningful when the network has IPv6)
    let ipv6Ok: boolean | null = null;
    if (spec.ipv6) {
      const v6 = await udpQuery(spec.ipv6, 'example.com', DnsType.A, { timeoutMs: Math.min(opts.timeoutMs, 1_500) });
      ipv6Ok = v6.response?.rcode === 0;
      if (ipv6Ok === false && v6.error === 'timeout') ipv6Ok = false;
    }

    const median = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    const min = latencies.length ? Math.min(...latencies) : null;
    const max = latencies.length ? Math.max(...latencies) : null;
    const avg = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null;
    const jitter = latencies.length >= 2 ? percentile(latencies.map((v, i, arr) => i === 0 ? 0 : Math.abs(v - arr[i - 1]!)), 50) : null;
    const successCount = latencies.length;
    const errors = opts.probes - successCount - timeouts;
    const reliability = opts.probes > 0 ? Math.round((successCount / opts.probes) * 1000) / 10 : null;
    const score = successCount > 0 && avg != null ? Math.round(Math.max(0, 100 - (avg * 0.5) - (jitter ?? 0) * 2 - (timeouts / opts.probes) * 100) * 10) / 10 : null;
    const hadAnySuccess = successCount > 0;
    const status: DnsQualityLabel = anyOk && avg != null ? dnsStatusForLatency(Math.round(avg), true) : (hadAnySuccess ? 'fair' : 'unreachable');

    return {
      providerId: spec.id,
      name: spec.name,
      transport: opts.transport,
      queries: opts.probes,
      ok: successCount,
      timeouts,
      errors,
      latencyMinMs: min == null ? null : Math.round(min * 100) / 100,
      latencyAvgMs: avg == null ? null : Math.round(avg * 100) / 100,
      latencyMedianMs: median == null ? null : Math.round(median * 100) / 100,
      latencyMaxMs: max == null ? null : Math.round(max * 100) / 100,
      latencyP95Ms: p95 == null ? null : Math.round(p95 * 100) / 100,
      jitterMs: jitter == null ? null : Math.round((jitter as number) * 100) / 100,
      reliabilityPct: reliability,
      status,
      score,
      dnssec,
      ipv6Ok,
      vpnActive: opts.vpnActive,
    };
  }

  async runTest(req: DnsTestRequest, testIdOverride?: string): Promise<{ testId: string; results: DnsProviderResult[] }> {
    const { tests, events } = this.deps;
    const testId = testIdOverride ?? crypto.randomUUID();
    tests.create(testId, 'dns', { ...req });

    try {
      const probes = Math.min(Math.max(req.probes ?? 4, 1), 10);
      const timeoutMs = req.timeoutMs ?? 2_000;
      // label the whole run by the VPN state at start: probes use ordinary
      // sockets, so when a tunnel owns the route the numbers ARE through it
      const vpnState = await detectVpnState(this.deps.vpn);
      const wanted = req.providers && req.providers.length > 0 ? new Set(req.providers) : null;
      const custom = this.deps.settings.get().network.customResolvers ?? [];
      const specs = wanted
        ? [...allResolvers(), ...custom].filter((p) => wanted.has(p.id) && benchmarkable(p))
        : [...primaryResolvers(), ...custom].filter(benchmarkable);
      const transport: DnsTransport = req.transport === 'doh' ? 'doh' : req.transport === 'dot' ? 'dot' : 'udp';

      const results: DnsProviderResult[] = [];
      let i = 0;
      for (const spec of specs) {
        if (transport === 'dot' && !spec.dotHost) {
          results.push({
            providerId: spec.id, name: spec.name, transport: 'dot', queries: 0, ok: 0, timeouts: 0, errors: 0,
            latencyMinMs: null, latencyAvgMs: null, latencyMedianMs: null, latencyMaxMs: null, latencyP95Ms: null, jitterMs: null,
            reliabilityPct: null, status: 'unreachable', score: null, dnssec: null, ipv6Ok: null,
            vpnActive: vpnState.connected,
            error: 'No DoT hostname configured',
          });
          continue;
        }
        const measureTransport: DnsTransport = req.transport === 'both' ? 'udp' : transport;
        const m = await this.measureProvider(spec, { probes, timeoutMs, transport: measureTransport, vpnActive: vpnState.connected }, testId, i, specs.length);
        results.push(m);
        if (req.transport === 'both' && spec.dohUrl) {
          const dohResult = await this.measureProvider(spec, { probes, timeoutMs, transport: 'doh', vpnActive: vpnState.connected }, testId, i, specs.length);
          results.push({ ...dohResult, name: `${dohResult.name} (DoH)`, providerId: `${dohResult.providerId}-doh` });
        }
        if (req.transport === 'both' && spec.dotHost && transport !== 'dot') {
          const dotResult = await this.measureProvider(spec, { probes, timeoutMs, transport: 'dot', vpnActive: vpnState.connected }, testId, i, specs.length);
          results.push({ ...dotResult, name: `${dotResult.name} (DoT)`, providerId: `${dotResult.providerId}-dot` });
        }
        i++;
      }

      try {
        this.deps.benchmarks.insertRows(results.map((r) => ({
          testId,
          providerId: r.providerId,
          providerName: r.name,
          transport: r.transport,
          queries: r.queries,
          ok: r.ok,
          timeouts: r.timeouts,
          errors: r.errors,
          latencyMinMs: r.latencyMinMs,
          latencyAvgMs: r.latencyAvgMs,
          latencyMedianMs: r.latencyMedianMs ?? null,
          latencyMaxMs: r.latencyMaxMs,
          latencyP95Ms: r.latencyP95Ms,
          jitterMs: r.jitterMs,
          reliabilityPct: r.reliabilityPct,
          score: r.score,
          dnssec: r.dnssec,
          ipv6Ok: r.ipv6Ok ?? null,
          vpnActive: r.vpnActive ?? false,
          error: r.error ?? null,
        })));
      } catch (err) {
        this.deps.log.warn({ err }, 'failed to persist DNS benchmark history');
      }
      tests.finish(testId, { status: 'done', summary: { providers: results.length, vpnActive: vpnState.connected, results: results.map((r) => ({ id: r.providerId, transport: r.transport, latencyAvgMs: r.latencyAvgMs, ok: r.ok, score: r.score })) }, result: { testId, results } });
      events.record('info', 'dns', `DNS test: ${results.filter((r) => r.ok).length}/${results.length} providers reachable`, { testId });
      this.deps.bus.publish(testId, { type: 'test:done', testId, result: { testId, results } });
      return { testId, results };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      tests.finish(testId, { status: 'error', error: message });
      throw err;
    }
  }

  /** Persisted history of benchmark rows, grouped into time series per provider+transport. */
  history(range: 'today' | '24h' | '7d' | '30d' = '24h', opts: { providerId?: string; transport?: DnsTransport } = {}) {
    const now = Date.now();
    let sinceTs: number;
    if (range === 'today') {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      sinceTs = d.getTime();
    } else {
      const hours = range === '24h' ? 24 : range === '7d' ? 24 * 7 : 24 * 30;
      sinceTs = now - hours * 3_600_000;
    }
    const rows = this.deps.benchmarks.history({ providerId: opts.providerId, transport: opts.transport, sinceTs });
    const groups = new Map<string, { providerId: string; name: string; transport: string; points: { ts: number; latencyAvgMs: number | null; reliabilityPct: number | null; timeouts: number; score: number | null }[] }>();
    for (const r of rows) {
      const key = `${r.providerId}|${r.transport}`;
      let g = groups.get(key);
      if (!g) {
        g = { providerId: r.providerId, name: r.providerName, transport: r.transport, points: [] };
        groups.set(key, g);
      }
      g.points.push({ ts: r.createdAt, latencyAvgMs: r.latencyAvgMs, reliabilityPct: r.reliabilityPct, timeouts: r.timeouts, score: r.score });
    }
    return { range, sinceTs, series: [...groups.values()] };
  }

  /** Recommendations from the latest completed benchmark batch. */
  recommend(profile: DnsRecommendationProfile, transport: DnsTransport = 'udp'): DnsRecommendationResult {
    const rows = this.deps.benchmarks.latestBatch({ transport });
    const vpnActive = rows.some((r) => r.vpnActive);
    const currentProviderId = this.deps.settings.get().network.dnsPreference;
    return recommendDns({
      rows: rows.map((r) => ({
        providerId: r.providerId,
        name: r.providerName,
        transport: r.transport,
        queries: r.queries,
        ok: r.ok,
        timeouts: r.timeouts,
        errors: r.errors,
        latencyMinMs: r.latencyMinMs,
        latencyAvgMs: r.latencyAvgMs,
        latencyMedianMs: r.latencyMedianMs,
        latencyMaxMs: r.latencyMaxMs,
        latencyP95Ms: r.latencyP95Ms,
        jitterMs: r.jitterMs,
        reliabilityPct: r.reliabilityPct,
        status: 'unknown' as DnsQualityLabel,
        score: r.score,
        dnssec: r.dnssec,
        ipv6Ok: r.ipv6Ok,
        vpnActive: r.vpnActive,
        error: r.error ?? undefined,
      })),
      profile,
      meta: this.resolverMeta(),
      currentProviderId,
      vpnActive,
    });
  }

  /** Metadata (category, claimed DNSSEC) for every catalog + custom resolver. */
  private resolverMeta(): Map<string, DnsProviderMeta> {
    const map = new Map<string, DnsProviderMeta>();
    const settings: AppSettings = this.deps.settings.get();
    for (const spec of [...allResolvers(), ...(settings.network.customResolvers ?? [])]) {
      map.set(spec.id, {
        providerId: spec.id,
        name: spec.name,
        category: spec.category,
        dnssec: spec.dnssec,
        verified: spec.verified,
      });
    }
    return map;
  }

  /**
   * Multi-signal DNSSEC diagnostic: probes the deliberately broken zone
   * `dnssec-failed.org` (a validating resolver must SERVFAIL it) and a signed
   * zone (`iana.org`) watching the authenticated-data bit. Rejects single-signal
   * certainty — the classification combines both probes.
   */
  async dnssecDeep(spec: DnsServerSpec, timeoutMs = 2_500): Promise<DnssecDeepResult> {
    const base = {
      providerId: spec.id,
      name: spec.name,
      transport: 'udp' as const,
      testedAt: Date.now(),
    };
    if (!spec.ipv4) {
      return { ...base, classification: 'unknown', brokenZone: 'error', signedNoError: null, adBit: null, detail: 'This resolver has no public plaintext address — run the check over DoH/DoT is not yet supported.' };
    }
    const [broken, signed] = await Promise.all([
      udpQuery(spec.ipv4, 'dnssec-failed.org', DnsType.A, { timeoutMs, dnssec: true }),
      udpQuery(spec.ipv4, 'iana.org', DnsType.A, { timeoutMs, dnssec: true }),
    ]);

    const brokenZone = broken.response === null
      ? broken.error === 'timeout' ? 'no-response' as const : 'error' as const
      : broken.response.rcode === Rcode.SERVFAIL ? 'servfail' as const : 'answered' as const;
    const signedNoError = signed.response === null ? null : signed.response.rcode === Rcode.NOERROR;
    const adBit = signed.response?.ad ?? null;

    let classification: DnssecDeepResult['classification'];
    let detail: string;
    if (brokenZone === 'servfail') {
      if (signedNoError === true && adBit === true) {
        classification = 'validating';
        detail = 'Broken zone SERVFAILed and the signed zone returned the authenticated-data bit — DNSSEC validation confirmed.';
      } else if (signedNoError === true) {
        classification = 'validating';
        detail = 'Broken zone SERVFAILed, but the authenticated-data bit was not advertised for the signed zone (some resolvers suppress AD unless requested).';
      } else {
        classification = 'validating';
        detail = 'Broken zone SERVFAILed. The signed-zone probe did not answer, so this rests on the broken-zone signal alone.';
      }
    } else if (brokenZone === 'answered') {
      classification = 'not-validating';
      detail = 'The deliberately broken zone answered instead of SERVFAIL — the resolver does not appear to enforce DNSSEC validation.';
    } else if (brokenZone === 'no-response') {
      classification = signedNoError === true ? 'unknown' : 'unreachable';
      detail = signedNoError === true
        ? 'Broken-zone probe timed out while the signed zone answered — result inconclusive.'
        : 'Neither probe answered — the resolver is unreachable from this network.';
    } else {
      classification = 'unknown';
      detail = `Probe error: ${broken.error ?? 'unknown'}`;
    }
    return { ...base, classification, brokenZone, signedNoError, adBit, detail };
  }

  /** Fastest provider from the last run — used for recommendations. */
  static bestProvider(results: DnsProviderResult[]): DnsProviderResult | null {
    const ok = results.filter((r) => r.ok > 0 && r.latencyAvgMs != null);
    if (ok.length === 0) return null;
    return ok.reduce((best, cur) => ((cur.latencyAvgMs as number) < (best.latencyAvgMs as number) ? cur : best));
  }

  /**
   * DNS leak analysis: identifies the egress resolver for every configured
   * system DNS server via `o-o.myaddr.l.google.com` / `whoami.cloudflare`
   * TXT queries. Flags unexpected resolvers (e.g. a VPN's resolver when the
   * tunnel should own DNS, or third-party resolvers you did not configure).
   */
  async leakTest(testIdOverride?: string): Promise<{ testId: string; result: DnsLeakResult }> {
    const { controller, tests, events } = this.deps;
    const testId = testIdOverride ?? crypto.randomUUID();
    tests.create(testId, 'dns_leak', {});

    const servers = await controller.systemDnsServers();
    const resolvers: DnsLeakResolver[] = [];
    const preferred = this.deps.settings.get().network.dnsPreference;

    for (const server of servers.slice(0, 6)) {
      const egress = await resolverEgressIp(server, 2_000);
      const hostname = egress ? await reverseOrNull(egress) : null;
      const org = egress ? knownResolverOrg(egress) : null;
      const expected = preferred == null || preferred === server || (org != null && org.toLowerCase().includes(preferred.toLowerCase()));
      resolvers.push({
        ip: egress ?? server,
        country: null,
        hostname,
        expected,
      });
    }

    const unexpected = resolvers.filter((r) => !r.expected);
    const leaked = resolvers.length > 0 && unexpected.length > 0;
    const explanation = resolvers.length === 0
      ? 'No system DNS servers could be enumerated, so the leak test is inconclusive on this platform.'
      : leaked
        ? `${unexpected.length} of ${resolvers.length} resolver egress points (${unexpected.map((r) => r.ip).join(', ')}) do not match your preferred DNS setting. Your DNS queries may be exiting through ${unexpected.length === 1 ? 'an unexpected resolver' : 'unexpected resolvers'}. Note: a backend DNS test cannot see browser-level WebRTC or OS-level resolver behavior beyond the configured servers.`
        : `All ${resolvers.length} configured resolver${resolvers.length === 1 ? '' : 's'} resolve through the expected egress. No resolver mismatch detected.`;

    const result: DnsLeakResult = {
      leaked,
      resolvers,
      explanation,
      testedAt: Date.now(),
    };

    tests.finish(testId, { status: 'done', summary: { servers: servers.length, leaked }, result });
    events.record(leaked ? 'warn' : 'info', 'dns', leaked ? `DNS leak check: ${unexpected.length} unexpected resolver(s)` : 'DNS leak check: no mismatch', { testId });
    this.deps.bus.publish(testId, { type: 'test:done', testId, result });
    return { testId, result };
  }
}

async function reverseOrNull(ip: string): Promise<string | null> {
  try {
    const dns = await import('node:dns/promises');
    return (await dns.reverse(ip))[0] ?? null;
  } catch {
    return null;
  }
}
