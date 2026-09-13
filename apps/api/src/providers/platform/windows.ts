import type { MtuProbeResult, PingResult, RouteHop, TcpProbeResult, TraceResult } from '@netpulse/shared';

import { runCommand } from '../../util/exec';
import { finalizePingStats, parseWindowsPing } from '../../util/pingParse';
import { parseTraceLine, parseTracerouteOutput } from '../../util/traceParse';
import { tcpProbe } from '../../util/tcpProbe';
import fs from 'node:fs';
import path from 'node:path';

import type { IcmpPingOptions, PlatformNetworkController, TracerouteOptions } from './types';

export class WindowsNetworkController implements PlatformNetworkController {
  readonly id = 'windows';

  async icmpPing(ip: string, opts: IcmpPingOptions): Promise<PingResult> {
    const args: string[] = ['-n', String(opts.count), '-w', String(opts.timeoutMs)];
    if (opts.family === 4) args.push('-4');
    if (opts.family === 6) args.push('-6');
    args.push(ip);

    let completed = 0;
    const startedAt = Date.now();
    const exec = await runCommand('ping', args, {
      timeoutMs: opts.timeoutMs * opts.count + 5_000,
      onStdoutLine: (line) => {
        if (/TTL/i.test(line) || /timed out|unreachable|превыш|недоступен/i.test(line)) {
          completed += 1;
          opts.onProgress?.(completed, opts.count);
        }
      },
    });

    const parsed = parseWindowsPing(exec.stdout, opts.count);
    const stats = finalizePingStats(parsed);
    const couldNotResolve = /could not find host|не удалось обнаружить/i.test(exec.stdout);
    if (couldNotResolve || (exec.code === null && !parsed.samples.length)) {
      throw new Error(`Ping failed for ${ip}: host unreachable or blocked`);
    }

    return {
      method: 'icmp',
      target: ip,
      resolvedIp: ip,
      family: opts.family ?? null,
      samples: parsed.samples,
      sent: parsed.sent ?? opts.count,
      received: parsed.received ?? 0,
      lossPct: parsed.lossPct ?? 100,
      min: stats.min,
      avg: stats.avg,
      max: stats.max,
      median: stats.medianVal,
      jitterMs: stats.jitterVal,
      durationMs: Date.now() - startedAt,
      parseQuality: parsed.quality,
    };
  }

  tcpProbe(host: string, port: number, timeoutMs: number, family?: 4 | 6): Promise<TcpProbeResult> {
    return tcpProbe(host, port, timeoutMs, family);
  }

  async systemDnsServers(): Promise<string[]> {
    // PowerShell output is locale-independent: one address per line.
    const res = await runCommand(
      'powershell',
      ['-NoProfile', '-Command', '(Get-DnsClientServerAddress -AddressFamily IPv4).ServerAddresses'],
      { timeoutMs: 10_000 },
    );
    return res.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^\d{1,3}(\.\d{1,3}){3}$/.test(l));
  }

  async traceroute(ip: string, opts: TracerouteOptions): Promise<TraceResult> {
    const args = ['-d', '-h', String(opts.maxHops), '-w', String(opts.timeoutMs)];
    if (opts.family === 4) args.push('-4');
    if (opts.family === 6) args.push('-6');
    args.push(ip);

    const startedAt = Date.now();
    const exec = await runCommand('tracert', args, {
      // generous ceiling: worst case = hops * (timeout + probe overhead)
      timeoutMs: Math.min(opts.maxHops * (opts.timeoutMs + 500) * 3 + 10_000, 120_000),
      onStdoutLine: (line) => {
        const parsedLine = parseTraceLine(line);
        if (parsedLine) {
          const hop: RouteHop = {
            hop: parsedLine.hop,
            ip: parsedLine.ip,
            hostname: null,
            latencyMs:
              parsedLine.rtts.length > 0
                ? Math.round((parsedLine.rtts.reduce((a, b) => a + b, 0) / parsedLine.rtts.length) * 10) / 10
                : null,
            packetLoss: parsedLine.stars > 0 ? Math.round((parsedLine.stars / Math.max(1, parsedLine.probes)) * 1000) / 10 : null,
            asn: null,
            org: null,
            country: null,
            status: parsedLine.ip === null ? 'no_response' : 'ok',
          };
          opts.onHop?.(hop);
        }
      },
    });

    const parsed = parseTracerouteOutput(exec.stdout);
    if (!parsed.parsed) {
      throw new Error(
        `traceroute produced no parseable hops for ${ip}` +
          (exec.timedOut ? ' (timed out)' : ''),
      );
    }

    const responsive = parsed.hops.filter((h) => h.latencyMs != null);
    const last = responsive[responsive.length - 1] ?? null;
    return {
      target: ip,
      resolvedIp: ip,
      family: opts.family,
      hops: parsed.hops,
      totalHops: parsed.hops.length,
      totalLatencyMs: last?.latencyMs ?? null,
      durationMs: Date.now() - startedAt,
    };
  }

  async mtuProbe(ip: string, opts: { timeoutMs: number; family?: 4 | 6 }): Promise<MtuProbeResult> {
    const testedAt = Date.now();
    const familyArgs = opts.family === 6 ? ['-6'] : ['-4'];

    const attempt = async (payload: number): Promise<boolean> => {
      const exec = await runCommand(
        'ping',
        [...familyArgs, '-f', '-l', String(payload), '-n', '1', '-w', String(opts.timeoutMs), ip],
        { timeoutMs: opts.timeoutMs + 3_000 },
      );
      // exit 0 = at least one reply (locale-independent); DF-too-large yields no reply
      return exec.code === 0;
    };

    // binary search the largest unfragmented payload (v4 header+icmp = 28 bytes)
    let low = 0; // small payloads always fit
    let high = opts.family === 6 ? 1452 : 1472;
    // sanity: even a minimal probe must pass, otherwise DF ping is unavailable
    if (!(await attempt(64))) {
      return {
        mtu: null,
        probablePath: null,
        testedAt,
        error: 'MTU probing unavailable: ping with the do-not-fragment flag was rejected on every size. Some networks or firewalls block DF-flagged probes.',
      };
    }
    while (low + 1 < high) {
      const mid = Math.floor((low + high) / 2);
      if (await attempt(mid)) low = mid;
      else high = mid;
    }

    const mtu = low + 28;
    const probablePath =
      mtu >= 1500 ? 'Full-size Ethernet (1500)' :
      mtu >= 1492 ? 'PPPoE (1492)' :
      mtu >= 1480 ? 'Tunnel/VPN overhead (~1480)' :
      mtu >= 1460 ? 'Tunnel/VPN overhead (~1460)' :
      mtu >= 1280 ? 'Reduced MTU (VPN or mobile network)' :
      'Severely reduced MTU (< 1280)';

    return { mtu, probablePath, testedAt };
  }

  async detectVpnBinaries(): Promise<Record<string, boolean>> {
    const out: Record<string, boolean> = { wireguard: false, openvpn: false, singbox: false };
    // wireguard.exe default install location
    const candidates = [
      path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'WireGuard', 'wireguard.exe'),
      path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'WireGuard', 'wireguard.exe'),
    ];
    out.wireguard = candidates.some((p) => fs.existsSync(p));
    const where = async (bin: string): Promise<boolean> =>
      runCommand('where', [bin], { timeoutMs: 5_000 })
        .then((r) => r.code === 0)
        .catch(() => false);
    out.openvpn = await where('openvpn');
    out.singbox = await where('sing-box');
    return out;
  }
}
