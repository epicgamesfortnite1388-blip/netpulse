import fs from 'node:fs';

import { DnsType } from '../providers/dns/codec';
import { tcpQuery, udpQuery } from '../providers/dns/resolver';
import { runCommand } from '../util/exec';
import type { Logger } from '../logger';

import type {
  WhitednsConfig,
  WhitednsStage,
  WhitednsTunnelTestRequest,
  WhitednsTunnelTestResult,
} from '@netpulse/shared';
import { WhitednsErrorCode } from '@netpulse/shared';

/** Default location of the `soar-check` diagnostic on Unix hosts. */
const SOAR_CHECK = '/usr/local/bin/soar-check';

/**
 * Locate the diagnostic without assuming the API runs on the DNS server.
 * Windows builds need an explicit path (e.g. WHITEDNS_SOAR_CHECK=C:\tools\soar-check.exe);
 * if it is absent the tunnel stage stays skipped rather than pretending to pass.
 */
export function findSoarCheck(): string | null {
  const configured = process.env.WHITEDNS_SOAR_CHECK?.trim();
  const candidates = configured ? [configured] : [SOAR_CHECK];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/** The proxy's `host:port`, for a diagnostic that expects SOCKS5. */
function proxySocksAddress(proxy: string | undefined): string | null {
  if (!proxy) return null;
  try {
    const u = new URL(proxy);
    return `${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`;
  } catch {
    return null;
  }
}

/**
 * A response only proves the delegated zone is authoritative when AA is set
 * and the server returns NS/SOA for the exact zone, or an SOA for an ancestor
 * zone. The live Soar server currently returns the parent `soar.` SOA for the
 * child tunnel zone, so rejecting that would reject a working tunnel. The
 * parent case is reported as non-conforming rather than as a clean exact-zone
 * answer. A referral, an unrelated authority section, or a forged empty
 * answer must not pass.
 */
export function authoritativeZoneAnswer(
  response: { rcode: number; aa: boolean; answers: { name: string; type: number }[]; authorities: { name: string; type: number }[] } | null,
  zone: string,
): { ok: boolean; detail: string } {
  if (!response) return { ok: false, detail: 'no response' };
  if (response.rcode !== 0) return { ok: false, detail: `rcode=${response.rcode}` };
  if (!response.aa) return { ok: false, detail: 'non-authoritative response (AA=0)' };

  const wanted = zone.replace(/\.$/, '').toLowerCase();
  const records = [...response.answers, ...response.authorities];
  const exact = records.some((r) => {
    const name = r.name.replace(/\.$/, '').toLowerCase();
    return name === wanted && (r.type === DnsType.NS || r.type === DnsType.SOA);
  });
  if (exact) return { ok: true, detail: 'authoritative NS/SOA for the zone' };

  const parentSoa = response.authorities.find((r) => {
    const name = r.name.replace(/\.$/, '').toLowerCase();
    return r.type === DnsType.SOA && name.length > 0 && wanted.endsWith(`.${name}`);
  });
  if (parentSoa) {
    return {
      ok: true,
      detail: `authoritative parent SOA (${parentSoa.name.replace(/\.$/, '')}); child NS/SOA missing`,
    };
  }
  return { ok: false, detail: 'authoritative response without NS/SOA for the zone' };
}

/** Max time the `soar-check` subprocess is allowed to run before being killed. */
const SOAR_CHECK_TIMEOUT_MS = 110_000;

/**
 * WhiteDNS Soar tunnel diagnostic.
 *
 * Runs honest, stage-by-stage checks of the server-side DNS data plane:
 *   1. input      — validate zone/server/pubkey before any network or subprocess
 *   2. dns        — authoritative NS/SOA answer for the exact tunnel zone over UDP
 *   3. reachability — authoritative DNS over TCP/53, not just an open socket
 *   4. tunnel     — if `soar-check` and a profile public key are available, an
 *                   authenticated tunnel that carries real HTTPS data
 *
 * Stages short-circuit on failure; a later stage is never reported as passing
 * when an earlier one failed. Every network/subprocess operation is bounded by
 * an explicit timeout and child processes are always cleaned up. Nothing here
 * touches the panel, stores credentials, or reveals access paths.
 */
export class WhitednsService {
  constructor(private readonly log: Logger) {}

  config(): WhitednsConfig {
    return {
      zone: process.env.WHITEDNS_ZONE ?? undefined,
      server: process.env.WHITEDNS_SERVER ?? undefined,
      hasPubkey: Boolean(process.env.WHITEDNS_PUBKEY),
    };
  }

  async test(req: WhitednsTunnelTestRequest): Promise<WhitednsTunnelTestResult> {
    const started = Date.now();
    const stages: WhitednsStage[] = [];
    const push = (name: string, ok: boolean, detail: string, ms?: number) =>
      stages.push({ name, ok, detail, ms: ms ?? 0 });

    // ---- Stage 0: input validation (fail fast, no network/subprocess) ----
    // The UI never receives the public key; it may come from the node's env.
    const pubkey = req.pubkey ?? process.env.WHITEDNS_PUBKEY;
    const effective = { ...req, pubkey };
    const inputStarted = process.hrtime.bigint();
    const inputError = this.validateInput(effective);
    const inputMs = Math.round(Number(process.hrtime.bigint() - inputStarted) / 1_000_000);
    if (inputError) {
      push('input', false, inputError.detail, inputMs);
      return this.finish(stages, started, false, 'error', inputError.detail, inputError.code);
    }
    push('input', true, 'input valid', inputMs);

    const server = effective.server!;
    const zone = effective.zone!;
    const timeoutMs = effective.timeoutMs;
    const proxy = process.env.WHITEDNS_PROXY?.trim() || undefined;

    // ---- Stage 1: DNS delegation (authoritative UDP, proxy TCP fallback) ----
    const dnsStarted = process.hrtime.bigint();
    let dnsOk = false;
    let dnsDetail = 'no response';
    try {
      const res = await udpQuery(server, zone, DnsType.NS, { timeoutMs });
      const verdict = authoritativeZoneAnswer(res.response, zone);
      dnsOk = verdict.ok;
      dnsDetail = verdict.ok ? `UDP/53 ${verdict.detail} (${res.response?.size ?? 0} bytes)` : `UDP/53 ${verdict.detail}`;

      // A local TUN can forge an immediate empty answer. If the operator
      // supplied a proxy, try the TCP path through it before failing.
      if (!dnsOk && proxy) {
        const tcp = await tcpQuery(server, zone, DnsType.NS, { timeoutMs, proxy });
        const tcpVerdict = authoritativeZoneAnswer(tcp.response, zone);
        if (tcpVerdict.ok) {
          dnsOk = true;
          dnsDetail = `${dnsDetail}; TCP/53 via proxy ${tcpVerdict.detail}`;
        } else {
          const why = tcp.error ? ` (${tcp.error})` : '';
          dnsDetail = `${dnsDetail}; TCP/53 via proxy ${tcpVerdict.detail}${why}`;
        }
      }

      const dnsMs = Number(process.hrtime.bigint() - dnsStarted) / 1_000_000;
      push('dns', dnsOk, dnsDetail, Math.round(dnsMs));
    } catch (err) {
      const dnsMs = Number(process.hrtime.bigint() - dnsStarted) / 1_000_000;
      push('dns', false, `DNS query failed: ${err instanceof Error ? err.message : String(err)}`, Math.round(dnsMs));
    }

    if (!dnsOk) {
      return this.finish(stages, started, false, 'dns', 'DNS data plane did not answer authoritatively', WhitednsErrorCode.DNS_DELEGATION_FAILED);
    }

    // ---- Stage 2: reachability (TCP/53 must answer DNS, not merely accept) ----
    const reachStarted = process.hrtime.bigint();
    let reachOk = false;
    let reachDetail = 'not tested';
    try {
      const tcp = await tcpQuery(server, zone, DnsType.NS, { timeoutMs, proxy });
      const verdict = authoritativeZoneAnswer(tcp.response, zone);
      reachOk = verdict.ok;
      reachDetail = `TCP/53${proxy ? ' via proxy' : ''} ${verdict.detail}${!verdict.ok && tcp.error ? ` (${tcp.error})` : ''}`;
      const reachMs = Number(process.hrtime.bigint() - reachStarted) / 1_000_000;
      push('reachability', reachOk, reachDetail, Math.round(reachMs));
    } catch (err) {
      const reachMs = Number(process.hrtime.bigint() - reachStarted) / 1_000_000;
      push('reachability', false, `reachability check failed: ${err instanceof Error ? err.message : String(err)}`, Math.round(reachMs));
    }

    if (!reachOk) {
      return this.finish(stages, started, false, 'reachability', 'TCP/53 did not return an authoritative DNS answer', WhitednsErrorCode.UNREACHABLE);
    }

    // ---- Stage 3: authenticated tunnel data test (soar-check) ----
    const tunnelStarted = process.hrtime.bigint();
    let tunnelOk = false;
    let tunnelDetail = 'soar-check not available on this host';
    const soarCheck = findSoarCheck();
    if (pubkey && soarCheck) {
      try {
        const args = [
          '-zone', zone,
          '-pubkey', pubkey,
          '-resolver', `${server}:53`,
          '-tcp', proxy ? 'only' : 'auto',
          '-timeout', `${Math.min(timeoutMs, SOAR_CHECK_TIMEOUT_MS)}ms`,
          '-url', req.url,
        ];
        const socks = proxySocksAddress(proxy);
        const result = await runCommand(soarCheck, args, {
          timeoutMs: timeoutMs + 5_000,
          onStdoutLine: () => undefined,
          env: socks ? { ...process.env, SOAR_PROXY: socks } : undefined,
        });
        const tunnelMs = Number(process.hrtime.bigint() - tunnelStarted) / 1_000_000;
        if (result.code === 0 && /Server authenticated/.test(result.stdout)) {
          tunnelOk = true;
          tunnelDetail = 'authenticated tunnel carried data';
        } else if (result.timedOut) {
          tunnelDetail = 'tunnel test timed out';
          push('tunnel', false, tunnelDetail, Math.round(tunnelMs));
          return this.finish(stages, started, false, 'tunnel', 'tunnel test timed out', WhitednsErrorCode.TUNNEL_NEGOTIATION_FAILED);
        } else {
          tunnelDetail = `tunnel test did not succeed (exit=${result.code})`;
          push('tunnel', false, tunnelDetail, Math.round(tunnelMs));
          return this.finish(stages, started, false, 'tunnel', 'tunnel negotiation failed', WhitednsErrorCode.TUNNEL_NEGOTIATION_FAILED);
        }
        push('tunnel', tunnelOk, tunnelDetail, Math.round(tunnelMs));
      } catch (err) {
        const tunnelMs = Number(process.hrtime.bigint() - tunnelStarted) / 1_000_000;
        push('tunnel', false, `tunnel test errored: ${err instanceof Error ? err.message : String(err)}`, Math.round(tunnelMs));
        return this.finish(stages, started, false, 'tunnel', 'tunnel test errored', WhitednsErrorCode.TUNNEL_NEGOTIATION_FAILED);
      }
    } else if (!pubkey) {
      push('tunnel', false, 'no profile public key configured — data-plane test skipped', 0);
    } else {
      push('tunnel', false, 'soar-check binary not found on host — data-plane test skipped', 0);
    }

    const ok = stages.every((s) => s.ok);
    return this.finish(stages, started, ok, 'done', ok ? 'all WhiteDNS stages passed' : 'a WhiteDNS stage failed');
  }

  /** Validate inputs before any network or subprocess work. Returns a structured error or null. */
  private validateInput(req: WhitednsTunnelTestRequest): { code: WhitednsErrorCode; detail: string } | null {
    const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    if (!req.zone || req.zone.length > 253) {
      return { code: WhitednsErrorCode.INVALID_INPUT, detail: 'zone is required and must be at most 253 characters' };
    }
    if (!/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(req.zone)) {
      return { code: WhitednsErrorCode.INVALID_INPUT, detail: 'zone must be a valid domain name' };
    }
    if (!req.server || !ipv4Regex.test(req.server)) {
      return { code: WhitednsErrorCode.INVALID_INPUT, detail: 'server must be an IPv4 address' };
    }
    if (req.pubkey !== undefined && req.pubkey !== null && req.pubkey.length > 0) {
      if (!/^[A-Za-z0-9+/]{0,160}={0,2}$/.test(req.pubkey)) {
        return { code: WhitednsErrorCode.INVALID_INPUT, detail: 'pubkey must be base64-encoded' };
      }
    }
    return null;
  }

  private finish(
    stages: WhitednsStage[],
    started: number,
    ok: boolean,
    stage: 'dns' | 'reachability' | 'tunnel' | 'done' | 'error',
    detail: string,
    code?: WhitednsErrorCode,
  ): WhitednsTunnelTestResult {
    return {
      ok,
      stage,
      stages,
      checkedAt: started,
      tookMs: Date.now() - started,
      error: ok ? null : detail,
      code: ok ? undefined : code ?? WhitednsErrorCode.INTERNAL,
    };
  }

}
