import net from 'node:net';

import type { EndpointProbeResult, EndpointStatus, ScanCandidateRow, ScanConfig, ScanSummary, ScanValidateRequest } from '@netpulse/shared';
import { scoreEndpoint } from '@netpulse/shared';

import type { RealtimeBus } from '../realtime/bus';
import type { ScanRepository, TestsRepository } from '../db/repositories';
import type { PlatformNetworkController } from '../providers/platform/types';
import { fetchCloudflareTrace } from '../providers/ipinfo/cloudflareTrace';
import { cfCleanVerdict, cfDownloadProbe, cfStabilityHold, cfTraceProbe, CF_DOWNLOAD_HOST, coloLabel } from '../util/cfProbe';
import { httpProbe } from '../util/httpProbe';
import { isPrivateIp, resolveTarget } from '../util/targetGuard';
import { tlsProbe } from '../util/tlsProbe';
import type { SettingsService } from './settingsService';
import type { EventService } from './eventService';

import type { Logger } from '../logger';

/** Ports considered safe/useful for endpoint probing (TLS + common CF alt ports). */
const ALLOWED_PORTS = new Set([80, 443, 2053, 2083, 2087, 2096, 8443]);
const MAX_CANDIDATES = 2048;
const DEFAULT_CONCURRENCY = 64;

function statusFor(score: number | null, reachable: boolean): { status: EndpointStatus; label: string } {
  if (!reachable) return { status: 'unreachable', label: 'Unreachable' };
  if (score == null) return { status: 'reachable', label: 'Reachable' };
  if (score >= 85) return { status: 'excellent', label: 'Low latency — Recommended' };
  if (score >= 70) return { status: 'good', label: 'Good' };
  if (score >= 50) return { status: 'fair', label: 'Fair' };
  return { status: 'poor', label: 'Poor' };
}

export interface EndpointTestRequest {
  target: string;
  port?: number;
  sni?: string;
  timeoutMs?: number;
  icmp?: boolean;
}

export class EndpointService {
  private readonly cancelling = new Set<string>();

  constructor(
    private readonly deps: {
      controller: PlatformNetworkController;
      tests: TestsRepository;
      scans: ScanRepository;
      events: EventService;
      settings: SettingsService;
      bus: RealtimeBus;
      log: Logger;
    },
  ) {}

  /* ------------------------------ single test ----------------------------- */

  async testEndpoint(req: EndpointTestRequest): Promise<{ testId: string; result: EndpointProbeResult }> {
    const { tests, events, controller } = this.deps;
    const testId = crypto.randomUUID();
    const port = req.port ?? 443;
    if (!ALLOWED_PORTS.has(port)) {
      throw Object.assign(new Error(`Port ${port} is not on the endpoint allowlist`), { statusCode: 400, code: 'port_not_allowed', hint: `Allowed ports: ${[...ALLOWED_PORTS].join(', ')}` });
    }

    const target = await resolveTarget(req.target);
    const ip = target.ips[0]!;
    const family = net.isIP(ip) === 6 ? 6 : 4;
    const sni = req.sni || (net.isIP(ip) === 0 ? ip : undefined);
    const timeoutMs = req.timeoutMs ?? 3_000;

    tests.create(testId, 'endpoint', { ...req, resolvedIp: ip });

    const result: EndpointProbeResult = {
      endpoint: ip,
      port,
      family,
      tcpMs: null,
      tlsMs: null,
      httpMs: null,
      httpStatus: null,
      tlsError: null,
      icmpAvgMs: null,
      packetLoss: null,
      score: null,
      status: 'unreachable',
      label: 'Unreachable',
    };

    try {
      const tcp = await controller.tcpProbe(ip, port, timeoutMs, family);
      result.tcpMs = tcp.ms;
      if (!tcp.ok) {
        tests.finish(testId, { status: 'done', summary: { endpoint: ip, status: 'unreachable' }, result: { testId, result } });
        events.record('warn', 'network', `Endpoint ${ip}:${port} unreachable (TCP)`, { testId });
        return { testId, result };
      }

      const tls = await tlsProbe(ip, port, timeoutMs, sni, family);
      result.tlsMs = tls.ms;
      result.tlsError = tls.error ?? null;

      const http = await httpProbe({ host: ip, port, sni, tls: port !== 80, timeoutMs, family, method: 'HEAD', path: '/' });
      result.httpMs = http.ms;
      result.httpStatus = http.status;

      if (req.icmp) {
        try {
          const ping = await controller.icmpPing(ip, { count: 3, timeoutMs: 1_000, family });
          result.icmpAvgMs = ping.avg;
          result.packetLoss = ping.lossPct;
        } catch {
          // ICMP may be blocked; TCP/TLS/HTTP numbers remain
        }
      }

      const scored = scoreEndpoint(
        { connectMs: result.tcpMs != null ? result.tcpMs + (result.tlsMs ?? 0) : null, httpMs: result.httpMs, packetLossPct: result.packetLoss },
        this.deps.settings.get().optimization.weights,
      );
      result.score = scored.score;
      const reachable = true;
      const { status, label } = statusFor(scored.score, reachable);
      result.status = status;
      result.label = label;

      tests.finish(testId, { status: 'done', summary: { endpoint: ip, port, tcpMs: result.tcpMs, tlsMs: result.tlsMs, httpMs: result.httpMs, score: result.score, status }, result: { testId, result } });
      events.record('info', 'network', `Endpoint ${ip}:${port} — ${label} (score ${scored.score ?? '—'})`, { testId });
      return { testId, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      tests.finish(testId, { status: 'error', error: message });
      throw err;
    }
  }

  /* -------------------------------- scanner ------------------------------- */

  /** Expand CIDR ranges into candidate endpoints (bounded, SSRF-safe). */
  expandCandidates(config: ScanConfig): { endpoint: string; port: number }[] {
    const out: { endpoint: string; port: number }[] = [];
    for (const cidr of config.cidrs) {
      const trimmed = cidr.trim();
      if (!trimmed) continue;
      if (net.isIP(trimmed) !== 0) {
        for (const port of config.ports) out.push({ endpoint: trimmed, port });
        continue;
      }
      const m = trimmed.match(/^([\d.]+)\/(\d{1,2})$/);
      if (!m) throw Object.assign(new Error(`Invalid CIDR: ${cidr}`), { statusCode: 400, code: 'invalid_cidr' });
      const bits = Number(m[2]);
      // Large published ranges (e.g. Cloudflare's 104.16.0.0/13, 172.64.0.0/13)
      // are allowed: the scan tests maxCandidates SAMPLED endpoints, never the
      // full space, so a big range costs the same as a small one. /0–/7 stay
      // rejected (unbounded 'the whole internet' scans).
      if (!Number.isInteger(bits) || bits < 8 || bits > 32) {
        throw Object.assign(new Error(`CIDR ${cidr} must be between /8 and /32`), { statusCode: 400, code: 'cidr_too_large' });
      }
      // Defense in depth: never expand private/reserved space, even when the
      // route-level literal check is bypassed by a programmatic caller.
      if (isPrivateIp(m[1]!)) {
        throw Object.assign(new Error(`CIDR ${cidr} is a private or reserved range and cannot be scanned`), { statusCode: 400, code: 'private_target_not_allowed' });
      }
      const baseInt = ipv4ToInt(m[1]!);
      if (baseInt == null) throw Object.assign(new Error(`Invalid CIDR: ${cidr}`), { statusCode: 400, code: 'invalid_cidr' });
      const size = 2 ** (32 - bits);
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      const start = (baseInt & mask) >>> 0;
      // Deterministic stride sampling: spread maxCandidates evenly across the
      // range instead of always taking its first IPs (edge anycast ranges are
      // homogeneous, but sampling the whole span is still more honest).
      const cidrsLeft = config.cidrs.slice(config.cidrs.indexOf(trimmed)).filter((c) => c.trim()).length || 1;
      const remaining = config.maxCandidates - out.length;
      const budget = Math.max(1, Math.floor(remaining / cidrsLeft));
      const stride = size > budget ? Math.floor(size / budget) : 1;
      for (let i = 0, taken = 0; i < size && taken < budget && out.length < config.maxCandidates; i += stride, taken++) {
        const ip = intToIpv4((start + i) >>> 0);
        for (const port of config.ports) out.push({ endpoint: ip, port });
      }
      if (out.length >= config.maxCandidates) break;
    }
    return out;
  }

  async startScan(config: ScanConfig, testIdOverride?: string): Promise<ScanSummary> {
    const { scans, tests, events, bus } = this.deps;
    const testId = testIdOverride ?? crypto.randomUUID();

    // harden the config
    const safeConfig: ScanConfig = {
      cidrs: config.cidrs.slice(0, 16),
      ports: config.ports.filter((p) => ALLOWED_PORTS.has(p)).slice(0, 4),
      concurrency: Math.min(Math.max(config.concurrency || DEFAULT_CONCURRENCY, 1), 256),
      timeoutMs: Math.min(Math.max(config.timeoutMs || 1_500, 300), 5_000),
      maxCandidates: Math.min(Math.max(config.maxCandidates || 256, 16), MAX_CANDIDATES),
    };
    if (safeConfig.ports.length === 0) safeConfig.ports = [443];
    if (safeConfig.cidrs.length === 0) {
      throw Object.assign(new Error('No CIDR ranges or endpoints provided'), { statusCode: 400, code: 'no_targets' });
    }

    const candidates = this.expandCandidates(safeConfig);
    scans.createScan(testId, { ...safeConfig });
    tests.create(testId, 'scan', { ...safeConfig, discovered: candidates.length });

    const summary: ScanSummary = {
      id: testId,
      status: 'running',
      config: safeConfig,
      startedAt: Date.now(),
      finishedAt: null,
      discovered: candidates.length,
      tested: 0,
      alive: 0,
    };

    bus.publish(testId, { type: 'scan:progress', scanId: testId, tested: 0, total: candidates.length, message: `Scanning ${candidates.length} endpoints` });

    // staged pipeline (async, cancellable): TCP -> TLS -> HTTP
    void this.executeScan(testId, candidates, safeConfig, summary).catch((err) => {
      this.deps.log.error({ err }, 'scan crashed');
    });

    events.record('info', 'network', `Scan started: ${candidates.length} endpoints on ports ${safeConfig.ports.join('/')}`, { testId });
    return summary;
  }

  private async executeScan(testId: string, candidates: { endpoint: string; port: number }[], config: ScanConfig, summary: ScanSummary): Promise<void> {
    const { scans, bus, controller, events } = this.deps;
    const queue = [...candidates];
    let tested = 0;
    let alive = 0;
    const total = candidates.length;

    const worker = async (): Promise<void> => {
      for (;;) {
        if (this.cancelling.has(testId)) return;
        const item = queue.shift();
        if (!item) return;

        const tcp = await controller.tcpProbe(item.endpoint, item.port, config.timeoutMs, net.isIP(item.endpoint) === 6 ? 6 : 4);
        if (!tcp.ok) {
          tested += 1;
          continue;
        }
        // Cloudflare edges drop SNI-less TLS (no shared default certificate for
        // arbitrary anycast IPs), so the handshake must carry a CF hostname as
        // SNI — exactly the SNI the trace/download probes use below.
        const tls = item.port === 80 ? null : await tlsProbe(item.endpoint, item.port, config.timeoutMs, CF_DOWNLOAD_HOST, net.isIP(item.endpoint) === 6 ? 6 : 4);
        // Discovery's HTTP stage is a /cdn-cgi/trace GET (SenPaiScanner method):
        // it proves the IP is a genuine Cloudflare edge and reveals which colo/
        // region it routes to. Bare HEAD reachability would hide that.
        const trace = tls?.ok || item.port === 80
          ? await cfTraceProbe(item.endpoint, item.port, config.timeoutMs)
          : null;
        const httpStatus = trace?.status ?? null;
        const httpMs = trace && trace.status != null && trace.status < 400 ? trace.ms : null;
        const colo = trace?.colo ?? null;
        const loc = trace?.loc ?? null;

        const scored = scoreEndpoint(
          { connectMs: tcp.ms != null ? tcp.ms + (tls?.ms ?? 0) : null, httpMs },
          this.deps.settings.get().optimization.weights,
        );
        const { status, label } = statusFor(scored.score, true);

        const rowId = scans.addCandidate({
          scanId: testId,
          endpoint: item.endpoint,
          port: item.port,
          tcpMs: tcp.ms,
          tlsMs: tls?.ms ?? null,
          httpMs,
          httpStatus,
          icmpAvgMs: null,
          score: scored.score,
          status,
          label,
          colo,
          loc,
        });

        tested += 1;
        alive += 1;
        bus.publish(testId, {
          type: 'scan:candidate',
          scanId: testId,
          candidate: {
            id: rowId,
            scanId: testId,
            endpoint: item.endpoint,
            port: item.port,
            tcpMs: tcp.ms,
            tlsMs: tls?.ms ?? null,
            httpMs,
            httpStatus,
            ok: true,
            stage: 'http',
            icmpAvgMs: null,
            colo,
            loc,
            lossPct: null,
            jitterMs: null,
            downloadMbps: null,
            ttfbMs: null,
            validated: false,
            clean: null,
            score: scored.score,
            status,
            label,
            favorite: false,
          },
        });
        bus.publish(testId, { type: 'scan:progress', scanId: testId, tested, total });
      }
    };

    await Promise.all(Array.from({ length: Math.min(config.concurrency, 256) }, () => worker()));

    const cancelled = this.cancelling.has(testId);
    this.cancelling.delete(testId);
    summary.status = cancelled ? 'cancelled' : 'completed';
    summary.tested = tested;
    summary.alive = alive;
    summary.finishedAt = Date.now();
    scans.finishScan(testId, { status: cancelled ? 'cancelled' : 'completed', discovered: total, tested, alive });
    this.deps.tests.finish(testId, { status: cancelled ? 'cancelled' : 'done', summary: { discovered: total, tested, alive }, result: { discovered: total, tested, alive } });
    events.record('info', 'network', `Scan ${testId.slice(0, 8)}: ${alive} alive of ${tested} tested`, { testId });
    bus.publish(testId, { type: 'scan:done', scanId: testId, tested, total, message: cancelled ? 'Scan cancelled' : 'Scan completed' });
  }

  cancelScan(scanId: string): void {
    this.cancelling.add(scanId);
  }

  listScans() {
    return this.deps.scans.listScans();
  }

  scanDetail(scanId: string) {
    return { scan: this.deps.scans.getScan(scanId), candidates: this.deps.scans.candidates(scanId) };
  }

  /* --------------------- shortlist validation (post-stop) ------------------ */

  /**
   * SenPaiScanner "post-stop speed test": once discovery has a green
   * shortlist, validate that shortlist with multi-try latency (loss/jitter),
   * an idle-hold DPI stability check, and a real download through each edge.
   * A discovery hit that cannot carry traffic is not clean.
   */
  validateScan(scanId: string, req: ScanValidateRequest): { validationId: string; scanId: string; queued: number } {
    const { scans, tests, events, bus } = this.deps;
    const scan = scans.getScan(scanId);
    if (!scan) throw Object.assign(new Error(`Scan "${scanId}" not found`), { statusCode: 404, code: 'not_found' });
    if (scan.status !== 'completed') {
      throw Object.assign(new Error('Validate a scan only after discovery has completed'), { statusCode: 409, code: 'scan_not_finished' });
    }
    if (this.validating.has(scanId)) {
      throw Object.assign(new Error('This scan is already being validated'), { statusCode: 409, code: 'validation_in_progress' });
    }

    const all: ScanCandidateRow[] = scans.candidates(scanId).map((c) => ({ ...c, ok: true, stage: 'http', status: c.status as EndpointStatus }));
    let targets: ScanCandidateRow[];
    if (req.candidateIds && req.candidateIds.length > 0) {
      const wanted = new Set(req.candidateIds);
      targets = all.filter((c) => wanted.has(c.id)).slice(0, 50);
    } else {
      // default: the best alive endpoints by discovery score (score = higher is better)
      targets = all
        .filter((c) => c.status !== 'unreachable' && c.status !== 'untested')
        .sort((a, b) => (b.score ?? -1) - (a.score ?? -1))
        .slice(0, 20);
    }
    if (targets.length === 0) {
      throw Object.assign(new Error('No alive candidates to validate — run a scan first'), { statusCode: 400, code: 'no_candidates' });
    }

    const tries = Math.min(Math.max(req.tries ?? 3, 2), 5);
    const downloadBytes = Math.min(Math.max(req.downloadBytes ?? 4_000_000, 1_000_000), 50_000_000);
    const concurrency = Math.min(Math.max(req.concurrency ?? 4, 1), 8);
    const validationId = crypto.randomUUID();
    this.validating.add(scanId);

    void this.runValidation(validationId, scanId, targets, { tries, downloadBytes, concurrency }).catch((err) => {
      this.deps.log.error({ err, scanId }, 'scan validation crashed');
      this.validating.delete(scanId);
    });

    tests.create(validationId, 'scan', { kind: 'validate', scanId, targets: targets.length, tries, downloadBytes });
    events.record('info', 'network', `Validating ${targets.length} Cloudflare endpoints from scan ${scanId.slice(0, 8)} (${tries} tries, ${downloadBytes / 1e6} MB download each)`, {
      scanId,
      testId: validationId,
    });
    bus.publish(scanId, { type: 'scan:validate:progress', scanId, tested: 0, total: targets.length });
    return { validationId, scanId, queued: targets.length };
  }

  private readonly validating = new Set<string>();

  private async runValidation(
    validationId: string,
    scanId: string,
    targets: ScanCandidateRow[],
    opts: { tries: number; downloadBytes: number; concurrency: number },
  ): Promise<void> {
    const { scans, bus, tests, events } = this.deps;
    const queue = [...targets];
    const total = queue.length;
    let tested = 0;
    let cleanCount = 0;
    const results: Record<string, unknown>[] = [];

    const worker = async (): Promise<void> => {
      for (;;) {
        if (!this.validating.has(scanId)) return; // cancelled
        const row = queue.shift();
        if (!row) return;

        const { endpoint, port } = row;
        const latencies: number[] = [];
        let successes = 0;
        let stabilityOk = true;
        let colo: string | null = null;
        let loc: string | null = null;
        let httpStatus: number | null = null;

        for (let i = 0; i < opts.tries; i++) {
          if (!this.validating.has(scanId)) break;
          const trace = await cfTraceProbe(endpoint, port, 3_000);
          if (trace.ok && trace.ms != null && trace.colo) {
            const held = port === 80 ? true : await cfStabilityHold(endpoint, port);
            if (held) {
              latencies.push(trace.ms);
              successes += 1;
              colo = trace.colo;
              loc = trace.loc;
            } else {
              stabilityOk = false;
            }
          }
          if (!colo) {
            colo = trace.colo;
            loc = trace.loc;
          }
          if (trace.status != null) httpStatus = trace.status;
          if (i < opts.tries - 1) await new Promise((r) => setTimeout(r, 60));
        }

        const avgMs = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null;
        const lossPct = latencies.length > 0 ? Math.round(((opts.tries - latencies.length) / opts.tries) * 1000) / 10 : 100;
        const variance = latencies.length > 1 ? latencies.reduce((a, b) => a + (b - avgMs!) ** 2, 0) / (latencies.length - 1) : 0;
        const jitterMs = latencies.length > 1 ? Math.round(Math.sqrt(variance) * 100) / 100 : null;

        // one real download through this edge (port 80 has no https __down front)
        const download = port === 80 ? null : await cfDownloadProbe(endpoint, port, opts.downloadBytes, 15_000);
        const downloadMbps = download?.ok ? download.mbps : null;
        const ttfbMs = download?.ttfbMs ?? null;
        const downloadAttempted = port !== 80;

        const verdict = cfCleanVerdict({
          tries: opts.tries,
          successes,
          avgMs,
          colo,
          downloadAttempted,
          downloadMbps,
        });
        const reason = stabilityOk ? null : 'connection reset while idle — DPI interference';
        if (reason) verdict.reasons.unshift(reason);
        verdict.clean = verdict.clean && stabilityOk;

        let status: EndpointStatus;
        let label: string;
        if (verdict.clean) {
          const mbps = downloadMbps ?? 0;
          status = mbps >= 25 ? 'excellent' : mbps >= 5 ? 'good' : 'fair';
          label = downloadMbps != null
            ? `Clean · ${downloadMbps.toFixed(1)} Mbps · ${avgMs != null ? `${avgMs.toFixed(0)} ms` : '—'}`
            : `Clean · ${avgMs != null ? `${avgMs.toFixed(0)} ms` : '—'}`;
        } else {
          status = 'poor';
          label = verdict.reasons[0] ?? 'Fails validation';
        }

        scans.updateCandidateValidation(row.id, {
          lossPct,
          jitterMs,
          downloadMbps,
          ttfbMs,
          validated: true,
          clean: verdict.clean,
          status,
          label,
          score: row.score,
          colo,
          loc,
        });

        tested += 1;
        if (verdict.clean) cleanCount += 1;
        results.push({
          id: row.id,
          endpoint,
          port,
          colo,
          loc,
          avgMs: avgMs != null ? Math.round(avgMs * 100) / 100 : null,
          lossPct,
          jitterMs,
          downloadMbps,
          ttfbMs,
          clean: verdict.clean,
          reasons: verdict.reasons,
          httpStatus,
        });
        bus.publish(scanId, {
          type: 'scan:validate:candidate',
          scanId,
          candidate: {
            id: row.id,
            scanId,
            endpoint,
            port,
            tcpMs: row.tcpMs,
            tlsMs: row.tlsMs,
            httpMs: row.httpMs,
            httpStatus,
            ok: true,
            stage: 'http',
            icmpAvgMs: null,
            colo,
            loc,
            lossPct,
            jitterMs,
            downloadMbps,
            ttfbMs,
            validated: true,
            clean: verdict.clean,
            score: row.score,
            status,
            label,
            favorite: row.favorite,
          },
        });
        bus.publish(scanId, { type: 'scan:validate:progress', scanId, tested, total, clean: cleanCount });
      }
    };

    await Promise.all(Array.from({ length: Math.min(opts.concurrency, targets.length) }, () => worker()));
    const cancelled = !this.validating.has(scanId);
    this.validating.delete(scanId);

    tests.finish(validationId, {
      status: cancelled ? 'cancelled' : 'done',
      summary: { kind: 'validate', scanId, tested, clean: cleanCount, total },
      result: { scanId, tested, clean: cleanCount, total, cancelled, results },
    });
    events.record('info', 'network', `Validation ${scanId.slice(0, 8)}: ${cleanCount} clean of ${tested} endpoints`, { scanId, testId: validationId });
    bus.publish(scanId, {
      type: 'scan:validate:done',
      scanId,
      tested,
      total,
      clean: cleanCount,
      message: cancelled ? 'Validation cancelled' : `Validation finished — ${cleanCount} clean of ${tested}`,
    });
  }

  cancelValidation(scanId: string): void {
    this.validating.delete(scanId);
  }

  /** The Cloudflare datacenter this machine's traffic exits from. */
  async localEdge(): Promise<{ reachable: boolean; colo: string | null; loc: string | null; label: string | null }> {
    try {
      const trace = await fetchCloudflareTrace(4, 6_000);
      if (!trace?.colo) return { reachable: false, colo: null, loc: null, label: null };
      return { reachable: true, colo: trace.colo, loc: trace.loc ?? null, label: coloLabel(trace.colo) };
    } catch {
      return { reachable: false, colo: null, loc: null, label: null };
    }
  }

  setFavorite(candidateId: number, favorite: boolean): void {
    this.deps.scans.setFavorite(candidateId, favorite);
  }
}

function ipv4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function intToIpv4(int: number): string {
  return [(int >>> 24) & 255, (int >>> 16) & 255, (int >>> 8) & 255, int & 255].join('.');
}
