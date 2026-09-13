import type { MtuProbeResult, PingResult, RouteHop, TcpProbeResult, TraceResult } from '@netpulse/shared';

import { runCommand } from '../../util/exec';
import { finalizePingStats, parseUnixPing } from '../../util/pingParse';
import { parseTraceLine, parseTracerouteOutput } from '../../util/traceParse';
import { tcpProbe } from '../../util/tcpProbe';
import fs from 'node:fs';

import type { IcmpPingOptions, PlatformNetworkController, TracerouteOptions } from './types';

export class UnixNetworkController implements PlatformNetworkController {
  readonly id = 'unix';

  async icmpPing(ip: string, opts: IcmpPingOptions): Promise<PingResult> {
    const timeoutSec = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
    const args = ['-c', String(opts.count), '-W', String(timeoutSec), ip];
    const startedAt = Date.now();
    let completed = 0;
    const exec = await runCommand('ping', args, {
      timeoutMs: opts.timeoutMs * opts.count + 5_000,
      onStdoutLine: () => {
        completed += 1;
        opts.onProgress?.(completed, opts.count);
      },
    });
    const parsed = parseUnixPing(exec.stdout, opts.count);
    const stats = finalizePingStats(parsed);
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
    try {
      const text = fs.readFileSync('/etc/resolv.conf', 'utf8');
      return text
        .split(/\r?\n/)
        .filter((l) => /^nameserver\s/.test(l.trim()))
        .map((l) => l.trim().split(/\s+/)[1])
        .filter((v): v is string => v != null);
    } catch {
      return [];
    }
  }

  async traceroute(ip: string, opts: TracerouteOptions): Promise<TraceResult> {
    const timeoutSec = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
    const args = ['-n', '-q', '2', '-w', String(timeoutSec), '-m', String(opts.maxHops), ip];
    const startedAt = Date.now();

    const exec = await runCommand('traceroute', args, {
      timeoutMs: Math.min(opts.maxHops * (timeoutSec + 1) * 1000 + 10_000, 120_000),
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
      const missing = /not found|no such file/i.test(exec.stderr);
      throw new Error(
        missing
          ? 'traceroute is not installed on this system. Install it (e.g. `apt install traceroute`) and try again.'
          : `traceroute produced no parseable hops for ${ip}${exec.timedOut ? ' (timed out)' : ''}`,
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
    const timeoutSec = Math.max(1, Math.ceil(opts.timeoutMs / 1000));

    const attempt = async (payload: number): Promise<boolean> => {
      const exec = await runCommand(
        'ping',
        ['-M', 'do', '-s', String(payload), '-c', '1', '-W', String(timeoutSec), ip],
        { timeoutMs: opts.timeoutMs + 3_000 },
      );
      return exec.code === 0;
    };

    let low = 0;
    let high = opts.family === 6 ? 1452 : 1472;
    if (!(await attempt(64))) {
      return {
        mtu: null,
        probablePath: null,
        testedAt,
        error: 'MTU probing unavailable: ping with DF flag was rejected on every size.',
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
    const which = async (bin: string): Promise<boolean> =>
      runCommand('which', [bin], { timeoutMs: 5_000 }).then((r) => r.code === 0).catch(() => false);
    return {
      wireguard: (await which('wg')) && (await which('wg-quick')),
      openvpn: await which('openvpn'),
      singbox: await which('sing-box'),
    };
  }
}
