import os from 'node:os';

import type {
  BufferbloatGrade,
  BufferbloatResult,
  CgnatResult,
  DiagnosticFinding,
  DiagnosticReport,
  DiagnosticStep,
  IpInfo,
  MtuProbeResult,
} from '@netpulse/shared';
import { median } from '@netpulse/shared';

import type { RealtimeBus } from '../realtime/bus';
import type { BufferbloatRepository, TestsRepository } from '../db/repositories';
import type { PlatformNetworkController } from '../providers/platform/types';
import { CloudflareSpeedProvider } from '../providers/speed/cloudflare';
import { isPrivateIpv4 } from '../util/targetGuard';
import type { DnsService } from './dnsService';
import type { EventService } from './eventService';
import type { IpInfoService } from './ipInfoService';
import type { RouteService } from './routeService';
import type { SpeedService } from './speedService';
import type { SettingsService } from './settingsService';

import type { Logger } from '../logger';

const CGNAT_BASE = 0x64400000; // 100.64.0.0
const CGNAT_MASK = 0xffc00000; // /10

function isCgnatIpv4(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return false;
  const int = ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
  return (int & CGNAT_MASK) === CGNAT_BASE;
}

export interface BufferbloatOptions {
  /** load duration per direction, ms (clamped 3-12s) */
  loadDurationMs?: number;
  signal?: AbortSignal;
  testId?: string;
}

export class DiagnosticsService {
  constructor(
    private readonly deps: {
      controller: PlatformNetworkController;
      tests: TestsRepository;
      bufferbloat: BufferbloatRepository;
      events: EventService;
      settings: SettingsService;
      bus: RealtimeBus;
      log: Logger;
      ipInfo: IpInfoService;
      dns: DnsService;
      speed: SpeedService;
      route: RouteService;
    },
  ) {}

  /* --------------------------------- MTU ---------------------------------- */

  async mtuTest(target = '1.1.1.1', family?: 4 | 6, testIdOverride?: string): Promise<{ testId: string; result: MtuProbeResult }> {
    const { tests, controller } = this.deps;
    const testId = testIdOverride ?? crypto.randomUUID();
    tests.create(testId, 'mtu', { target, family });
    const ip = await resolveLiteral(target);
    const result = await controller.mtuProbe(ip, { timeoutMs: 1_500, family: family ?? (ip.includes(':') ? 6 : 4) });
    tests.finish(testId, { status: result.error ? 'error' : 'done', summary: { mtu: result.mtu, probablePath: result.probablePath }, result, error: result.error });
    this.deps.events.record(result.error ? 'warn' : 'info', 'network', result.error ?? `MTU to ${ip}: ${result.mtu} bytes (${result.probablePath})`, { testId });
    this.deps.bus.publish(testId, { type: 'test:done', testId, result });
    return { testId, result };
  }

  /* -------------------------------- CGNAT --------------------------------- */

  async cgnatCheck(): Promise<{ testId: string; result: CgnatResult }> {
    const { tests, events, ipInfo } = this.deps;
    const testId = crypto.randomUUID();
    tests.create(testId, 'cgnat', {});

    const evidence: string[] = [];
    let publicIp: string | null = null;
    let cgnatRangeHit: boolean | null = null;

    try {
      const info: IpInfo = await ipInfo.lookup(4, { force: true });
      publicIp = info.ip;
      if (publicIp && isCgnatIpv4(publicIp)) {
        cgnatRangeHit = true;
        evidence.push(`Your public IPv4 ${publicIp} is inside the reserved carrier-grade NAT range 100.64.0.0/10.`);
      } else if (publicIp && !isPrivateIpv4(publicIp)) {
        cgnatRangeHit = false;
        evidence.push(`Your public IPv4 ${publicIp} is a normal public address (not in the CGNAT range).`);
      }
    } catch (err) {
      this.deps.log.warn({ err }, 'cgnat: public IP lookup failed');
    }

    // local interface evidence
    const interfaces = os.networkInterfaces();
    let localIp: string | null = null;
    for (const list of Object.values(interfaces)) {
      for (const addr of list ?? []) {
        if (addr.family === 'IPv4' && !addr.internal) localIp = localIp ?? addr.address;
      }
    }
    if (localIp) {
      if (isCgnatIpv4(localIp)) {
        evidence.push(`Your device address ${localIp} is itself inside 100.64.0.0/10 — the ISP hands out CGNAT addresses directly.`);
      } else if (isPrivateIpv4(localIp)) {
        evidence.push(`Your device address ${localIp} is behind a local router (private range) — expected in most home networks.`);
      }
    }

    const detected = cgnatRangeHit === true;
    const explanation = detected
      ? `CGNAT detected. ${evidence.join(' ')} With CGNAT, inbound connections from the internet (port forwarding, self-hosting) require help from your ISP. Outbound speed and latency are usually unaffected.`
      : cgnatRangeHit === false
        ? `No CGNAT detected. ${evidence.join(' ')}`
        : `CGNAT status could not be determined: ${evidence.join(' ') || 'the public IP lookup failed'}.`;

    const result: CgnatResult = { detected, publicIp, cgnatRangeHit, explanation, testedAt: Date.now() };
    tests.finish(testId, { status: 'done', summary: { detected, publicIp }, result });
    events.record(detected ? 'info' : 'info', 'network', detected ? `CGNAT detected (public IP in 100.64.0.0/10)` : 'CGNAT check: no carrier NAT', { testId });
    return { testId, result };
  }

  /* ------------------------------ bufferbloat ------------------------------ */

  async bufferbloatTest(opts: BufferbloatOptions = {}): Promise<{ testId: string; result: BufferbloatResult }> {
    const { tests, bus, bufferbloat } = this.deps;
    const testId = opts.testId ?? crypto.randomUUID();
    const createdHere = !opts.testId;
    if (createdHere) tests.create(testId, 'bufferbloat', {});
    const loadMs = Math.min(Math.max(opts.loadDurationMs ?? 6_000, 3_000), 12_000);

    const result: BufferbloatResult = { idleLatencyMs: null, downloadLoadLatencyMs: null, uploadLoadLatencyMs: null, downloadIncreaseMs: null, uploadIncreaseMs: null, grade: null, explanation: null, testedAt: 0 };

    try {
      const emit = (pct: number, message: string) =>
        bus.publish(testId, { type: 'test:progress', testId, task: 'bufferbloat', pct, message });

      emit(2, 'Measuring idle latency');
      const idleSamples = await this.sampleLatency(8, 300);
      result.idleLatencyMs = median(idleSamples);
      if (result.idleLatencyMs == null) {
        throw new Error('Idle latency could not be measured (target 1.1.1.1:443 unreachable).');
      }

      emit(15, 'Download load — sampling latency');
      result.downloadLoadLatencyMs = await this.loadedLatency('download', loadMs, (pct) => emit(15 + Math.round(pct * 0.35), 'Download load — sampling latency'));

      emit(55, 'Upload load — sampling latency');
      result.uploadLoadLatencyMs = await this.loadedLatency('upload', Math.round(loadMs * 0.7), (pct) => emit(55 + Math.round(pct * 0.35), 'Upload load — sampling latency'));

      if (result.downloadLoadLatencyMs != null) result.downloadIncreaseMs = Math.round((result.downloadLoadLatencyMs - result.idleLatencyMs) * 10) / 10;
      if (result.uploadLoadLatencyMs != null) result.uploadIncreaseMs = Math.round((result.uploadLoadLatencyMs - result.idleLatencyMs) * 10) / 10;

      const worst = Math.max(result.downloadIncreaseMs ?? 0, result.uploadIncreaseMs ?? 0);
      result.grade = gradeFor(worst);
      result.explanation = explainBloat(result.grade, result.idleLatencyMs, result.downloadIncreaseMs, result.uploadIncreaseMs);
      result.testedAt = Date.now();

      if (createdHere) {
        bufferbloat.insert({ id: crypto.randomUUID(), testId, idleLatencyMs: result.idleLatencyMs, downloadLoadMs: result.downloadLoadLatencyMs, uploadLoadMs: result.uploadLoadLatencyMs, downloadIncreaseMs: result.downloadIncreaseMs, uploadIncreaseMs: result.uploadIncreaseMs, grade: result.grade });
        tests.finish(testId, { status: 'done', summary: { grade: result.grade, idle: result.idleLatencyMs, down: result.downloadIncreaseMs, up: result.uploadIncreaseMs }, result });
      }
      this.deps.events.record('info', 'network', `Bufferbloat: grade ${result.grade} (+${worst} ms under load)`, { testId });
      emit(100, 'Done');
      bus.publish(testId, { type: 'test:done', testId, result });
      return { testId, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.error = message;
      result.testedAt = Date.now();
      if (createdHere) tests.finish(testId, { status: 'error', error: message });
      throw err;
    }
  }

  private async sampleLatency(count: number, intervalMs: number): Promise<number[]> {
    const values: number[] = [];
    for (let i = 0; i < count; i++) {
      const probe = await this.deps.controller.tcpProbe('1.1.1.1', 443, 1_500);
      if (probe.ok && probe.ms != null) values.push(probe.ms);
      await sleep(intervalMs);
    }
    return values;
  }

  private async loadedLatency(direction: 'download' | 'upload', durationMs: number, onPct: (pct: number) => void): Promise<number | null> {
    const { controller } = this.deps;
    const samples: number[] = [];
    // generate real load directly through the speed provider (no test record)
    const provider = new CloudflareSpeedProvider();
    const window = durationMs + 2_000;
    const load = direction === 'download'
      ? provider.download({ durationMs, streams: 4 })
      : provider.upload({ durationMs, streams: 3 });

    const sampler = (async () => {
      const deadline = Date.now() + window;
      let last = Date.now();
      while (Date.now() < deadline) {
        const probe = await controller.tcpProbe('1.1.1.1', 443, 1_500);
        if (probe.ok && probe.ms != null) samples.push(probe.ms);
        const now = Date.now();
        if (now - last > 200) {
          onPct(Math.min(100, Math.round(((window - (deadline - now)) / window) * 100)));
          last = now;
        }
        await sleep(300);
      }
    })();

    await load.catch(() => undefined);
    await sampler;
    return median(samples);
  }

  /* --------------------------- complete diagnostic -------------------------- */

  async runCompleteDiagnostic(testIdOverride?: string): Promise<DiagnosticReport> {
    const { tests, bus, controller } = this.deps;
    const testId = testIdOverride ?? crypto.randomUUID();
    tests.create(testId, 'diagnostic', {});

    const steps: DiagnosticStep[] = [
      { id: 'ip', label: 'Public IP & ISP', status: 'pending' },
      { id: 'ping', label: 'Latency, jitter & loss', status: 'pending' },
      { id: 'dns', label: 'DNS benchmark', status: 'pending' },
      { id: 'dnsleak', label: 'DNS leak check', status: 'pending' },
      { id: 'speed', label: 'Download & upload', status: 'pending' },
      { id: 'bufferbloat', label: 'Bufferbloat under load', status: 'pending' },
      { id: 'mtu', label: 'MTU / path size', status: 'pending' },
      { id: 'cgnat', label: 'CGNAT detection', status: 'pending' },
      { id: 'route', label: 'Route to 1.1.1.1', status: 'pending' },
    ];

    const emit = (pct: number, message?: string) => bus.publish(testId, { type: 'test:progress', testId, task: 'diagnostic', pct, message });
    const setStep = (id: string, status: DiagnosticStep['status'], detail?: string) => {
      const step = steps.find((s) => s.id === id);
      if (step) {
        step.status = status;
        if (detail !== undefined) step.detail = detail;
      }
      const doneCount = steps.filter((s) => s.status === 'done' || s.status === 'skipped' || s.status === 'error').length;
      emit(Math.round((doneCount / steps.length) * 95), `${step?.label ?? id}: ${status}`);
    };

    const report: DiagnosticReport = {
      testId,
      startedAt: Date.now(),
      finishedAt: null,
      steps,
      health: { score: null, label: null, components: [] },
      findings: [],
      ip: null,
      speed: null,
      dns: null,
      dnsLeak: null,
      route: null,
      bufferbloat: null,
      mtu: null,
      cgnat: null,
    };

    /* IP */
    setStep('ip', 'running');
    try {
      const info = await this.deps.ipInfo.lookup(4, { force: true });
      report.ip = { ipv4: info.ip, ipv6: null, isp: info.isp, asn: info.asn?.asn ? `AS${info.asn.asn}` : null, country: info.countryCode, city: info.city };
      try {
        const v6 = await this.deps.ipInfo.lookup(6);
        report.ip.ipv6 = v6.ip;
      } catch {
        report.ip.ipv6 = null;
      }
      setStep('ip', 'done', `${info.ip} — ${info.isp ?? 'unknown ISP'}`);
    } catch (err) {
      setStep('ip', 'error', err instanceof Error ? err.message : 'lookup failed');
    }

    /* ping */
    setStep('ping', 'running');
    let pingStats: { avg: number | null; jitter: number | null; loss: number | null } | null = null;
    try {
      const ping = await controller.icmpPing('1.1.1.1', { count: 10, timeoutMs: 1_500, family: 4 });
      pingStats = { avg: ping.avg, jitter: ping.jitterMs, loss: ping.lossPct };
      setStep('ping', 'done', ping.avg != null ? `avg ${ping.avg} ms, jitter ${ping.jitterMs ?? '—'} ms, loss ${ping.lossPct}%` : 'no replies');
    } catch (err) {
      setStep('ping', 'error', err instanceof Error ? err.message : 'ping failed');
    }

    /* DNS */
    setStep('dns', 'running');
    try {
      const dnsRes = await this.deps.dns.runTest({ probes: 3 });
      report.dns = dnsRes.results;
      const best = dnsRes.results.filter((r) => r.ok > 0 && r.latencyAvgMs != null).sort((a, b) => (a.latencyAvgMs ?? 1e9) - (b.latencyAvgMs ?? 1e9))[0];
      setStep('dns', 'done', best ? `best: ${best.name} ${best.latencyAvgMs} ms` : 'no provider reachable');
    } catch (err) {
      setStep('dns', 'error', err instanceof Error ? err.message : 'dns test failed');
    }

    /* DNS leak */
    setStep('dnsleak', 'running');
    try {
      const leak = await this.deps.dns.leakTest();
      report.dnsLeak = leak.result;
      setStep('dnsleak', 'done', leak.result.leaked ? 'mismatch detected' : 'no mismatch');
    } catch (err) {
      setStep('dnsleak', 'error', err instanceof Error ? err.message : 'leak test failed');
    }

    /* speed */
    setStep('speed', 'running');
    try {
      const speed = await this.deps.speed.runTest({ durationMs: 6_000 }, { testId: `${testId}:speed`, signal: new AbortController().signal });
      report.speed = speed;
      setStep('speed', 'done', `↓ ${speed.downloadMbps ?? '—'} / ↑ ${speed.uploadMbps ?? '—'} Mbps`);
    } catch (err) {
      setStep('speed', 'error', err instanceof Error ? err.message : 'speed test failed');
    }

    /* bufferbloat */
    setStep('bufferbloat', 'running');
    try {
      const bloat = await this.bufferbloatTest({ testId: `${testId}:bloat`, loadDurationMs: 4_000 });
      report.bufferbloat = bloat.result;
      setStep('bufferbloat', 'done', `grade ${bloat.result.grade}`);
    } catch (err) {
      setStep('bufferbloat', 'error', err instanceof Error ? err.message : 'bufferbloat failed');
    }

    /* MTU */
    setStep('mtu', 'running');
    try {
      const mtu = await this.mtuTest('1.1.1.1', 4);
      report.mtu = mtu.result;
      setStep('mtu', mtu.result.error ? 'skipped' : 'done', mtu.result.error ?? `${mtu.result.mtu} bytes`);
    } catch (err) {
      setStep('mtu', 'error', err instanceof Error ? err.message : 'mtu failed');
    }

    /* CGNAT */
    setStep('cgnat', 'running');
    try {
      const cgnat = await this.cgnatCheck();
      report.cgnat = cgnat.result;
      setStep('cgnat', 'done', cgnat.result.detected ? 'CGNAT detected' : 'no CGNAT');
    } catch (err) {
      setStep('cgnat', 'error', err instanceof Error ? err.message : 'cgnat failed');
    }

    /* route */
    setStep('route', 'running');
    try {
      const route = await this.deps.route.runTrace({ target: '1.1.1.1', family: 4, maxHops: 12 }, `${testId}:route`);
      report.route = { ...route.trace, analysis: route.analysis };
      setStep('route', 'done', `${route.trace.totalHops} hops, score ${route.analysis.score ?? '—'}`);
    } catch (err) {
      setStep('route', 'error', err instanceof Error ? err.message : 'route failed');
    }

    /* health + findings from real measurements */
    const findings: DiagnosticFinding[] = [];
    if (pingStats?.avg != null) {
      findings.push(
        pingStats.avg <= 25
          ? { severity: 'good', title: 'Excellent latency', message: `Your average latency is ${pingStats.avg} ms — well within the range where real-time applications feel instant.` }
          : pingStats.avg <= 80
            ? { severity: 'info', title: 'Acceptable latency', message: `Average latency is ${pingStats.avg} ms. Fine for browsing and streaming; competitive gaming may feel slightly delayed.` }
            : { severity: 'warn', title: 'High latency', message: `Average latency is ${pingStats.avg} ms. Real-time applications (calls, games) may feel laggy.` },
      );
    }
    if ((pingStats?.loss ?? 0) > 0) {
      findings.push({ severity: 'warn', title: 'Packet loss detected', message: `${pingStats?.loss}% of probes to 1.1.1.1 were lost. Persistent loss degrades everything from web browsing to calls.` });
    }
    if (report.speed?.downloadMbps != null && report.speed.uploadMbps != null && report.speed.uploadMbps > 0 && report.speed.downloadMbps / report.speed.uploadMbps > 20) {
      findings.push({ severity: 'info', title: 'Strongly asymmetric link', message: `Download (${Math.round(report.speed.downloadMbps)} Mbps) is more than 20× the upload (${Math.round(report.speed.uploadMbps)} Mbps). Typical for consumer plans; affects video calls and backups.` });
    }
    if (report.bufferbloat?.grade && ['C', 'D', 'F'].includes(report.bufferbloat.grade)) {
      findings.push({
        severity: 'warn',
        title: 'Bufferbloat detected',
        message: `Latency rises by up to ${Math.max(report.bufferbloat.downloadIncreaseMs ?? 0, report.bufferbloat.uploadIncreaseMs ?? 0)} ms while the line is saturated (grade ${report.bufferbloat.grade}). Enable SQM/QoS on your router, or cap upload heavy apps, to keep calls responsive during downloads.`,
      });
    }
    if (report.bufferbloat?.grade && ['A', 'B'].includes(report.bufferbloat.grade)) {
      findings.push({ severity: 'good', title: 'Latency stays stable under load', message: `Latency increased by only ${Math.max(report.bufferbloat.downloadIncreaseMs ?? 0, report.bufferbloat.uploadIncreaseMs ?? 0)} ms under full load (grade ${report.bufferbloat.grade}) — good queue management.` });
    }
    if (report.dnsLeak?.leaked) {
      findings.push({ severity: 'warn', title: 'DNS resolver mismatch', message: report.dnsLeak.explanation });
    }
    if (report.cgnat?.detected) {
      findings.push({ severity: 'info', title: 'CGNAT network', message: 'Your ISP uses carrier-grade NAT. Inbound hosting needs ISP assistance; outbound performance is unaffected.' });
    }
    if (report.ip?.ipv6 == null) {
      findings.push({ severity: 'info', title: 'No IPv6 connectivity', message: 'IPv6 is not available on this network. Not a problem today, but some dual-stack services may prefer it when present.' });
    }
    if (report.mtu?.mtu != null && report.mtu.mtu < 1500) {
      findings.push({ severity: 'info', title: 'Reduced path MTU', message: `Largest unfragmented packet is ${report.mtu.mtu} bytes (${report.mtu.probablePath}). PPPoE or VPN overhead is present on this path.` });
    }
    report.findings = findings;

    // simple honest health from measured components
    const comps = report.health.components;
    void comps;
    const parts: number[] = [];
    if (pingStats?.avg != null) parts.push(pingStats.avg <= 25 ? 100 : pingStats.avg <= 50 ? 85 : pingStats.avg <= 100 ? 60 : pingStats.avg <= 150 ? 40 : 20);
    if ((pingStats?.loss ?? null) != null) parts.push((pingStats?.loss ?? 100) === 0 ? 100 : (pingStats?.loss ?? 100) <= 1 ? 80 : 40);
    if (report.bufferbloat?.grade) parts.push({ A: 100, B: 85, C: 65, D: 40, F: 20 }[report.bufferbloat.grade]);
    if (report.dns && report.dns.length > 0) {
      const bestDns = Math.min(...report.dns.filter((d) => d.ok > 0 && d.latencyAvgMs != null).map((d) => d.latencyAvgMs as number));
      if (Number.isFinite(bestDns)) parts.push(bestDns <= 15 ? 100 : bestDns <= 35 ? 85 : bestDns <= 60 ? 65 : 40);
    }
    report.health = {
      score: parts.length > 0 ? Math.round(parts.reduce((a, b) => a + b, 0) / parts.length) : null,
      label: null,
      components: steps.map((s) => ({ component: s.id, label: s.label, value: null, measured: s.status === 'done' })),
    };
    report.health.label = report.health.score == null ? null : report.health.score >= 85 ? 'Excellent' : report.health.score >= 70 ? 'Good' : report.health.score >= 50 ? 'Fair' : 'Poor';

    report.finishedAt = Date.now();
    tests.finish(testId, {
      status: 'done',
      summary: {
        health: report.health.score,
        findings: findings.length,
        speed: report.speed?.downloadMbps ?? null,
        routeHops: report.route?.totalHops ?? null,
      },
      result: report,
    });
    this.deps.events.record('info', 'network', `Complete diagnostic finished: health ${report.health.score ?? '—'}/100, ${findings.length} findings`, { testId });
    emit(100, 'Report ready');
    bus.publish(testId, { type: 'test:done', testId, result: report });
    return report;
  }
}

function gradeFor(increaseMs: number): BufferbloatGrade {
  if (increaseMs <= 5) return 'A';
  if (increaseMs <= 30) return 'B';
  if (increaseMs <= 60) return 'C';
  if (increaseMs <= 200) return 'D';
  return 'F';
}

function explainBloat(grade: BufferbloatGrade, idle: number | null, down: number | null, up: number | null): string {
  const parts = [`Idle latency ${idle ?? '—'} ms; under load it rose by ${down ?? '—'} ms (download) and ${up ?? '—'} ms (upload).`];
  switch (grade) {
    case 'A':
      parts.push('Excellent queue management — latency barely moves even when the line is saturated.');
      break;
    case 'B':
      parts.push('Good behavior; VoIP and gaming should remain smooth during most downloads.');
      break;
    case 'C':
      parts.push('Noticeable lag under load. Enabling SQM/QoS on the router would help calls during heavy transfers.');
      break;
    case 'D':
      parts.push('Significant bufferbloat. Real-time apps will stutter whenever the connection is saturated.');
      break;
    case 'F':
      parts.push('Severe bufferbloat — latency spikes badly under load. Router SQM/QoS or lower link saturation is strongly recommended.');
      break;
  }
  return parts.join(' ');
}

async function resolveLiteral(target: string): Promise<string> {
  if (/^[\d.]+$/.test(target) || target.includes(':')) return target;
  const dns = await import('node:dns/promises');
  const res = await dns.lookup(target, { family: 4 });
  return res.address;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
