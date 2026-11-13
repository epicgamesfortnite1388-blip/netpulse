/**
 * Leak checks for the Aether path (Iran-ready requirements 2 and 4).
 *
 * Three questions this answers, none of which a handshake can:
 *
 *  1. Does this host have IPv6 egress at all? If it does, an app that does not
 *     force IPv4 can leave the tunnel on v6 while the v4 traffic is tunnelled.
 *  2. Does the tunnel accept an IPv6 target (SOCKS5 ATYP 0x04)? If it does not,
 *     v6 traffic can never be tunnelled, which is a coverage gap — and also means
 *     the only way to stay inside the tunnel is to force v4.
 *  3. Is the IPv6 egress address, if any, different from the tunnel's? A v6
 *     address that matches the baseline is a leak; one that matches the tunnel
 *     would be coverage.
 *
 * Requires a tunnel on 127.0.0.1:1819.
 * Run: npx tsx scripts/leak-test.ts [port]
 */
import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';

import { fetchExitIpThroughSocks, socks5RelayCheck } from '../apps/api/src/vpn/aetherProvider.js';

const PORT = Number(process.argv[2] ?? 1819);
const V6_TARGET = '2606:4700:4700::1111'; // 1.1.1.1 over IPv6, a public anycast address

/** Raw SOCKS5 CONNECT with an IPv6 target (ATYP 0x04), which the helper does not cover. */
function socks5ConnectIpv6(
  port: number,
  address: string,
  targetPort: number,
  timeoutMs = 8_000,
): Promise<{ ok: boolean; rep: number | null; detail: string; socket?: net.Socket }> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: '127.0.0.1', port, timeout: timeoutMs });
    let buf = Buffer.alloc(0);
    let stage: 'greeting' | 'connect' = 'greeting';
    const finish = (ok: boolean, rep: number | null, detail: string): void => {
      clearTimeout(timer);
      if (!ok) sock.destroy();
      resolve(ok ? { ok, rep, detail, socket: sock } : { ok, rep, detail });
    };
    const timer = setTimeout(() => finish(false, null, 'timeout'), timeoutMs);
    sock.on('error', (e) => finish(false, null, e.message));
    sock.on('connect', () => sock.write(Buffer.from([0x05, 0x01, 0x00])));
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greeting') {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return finish(false, null, `greeting refused: ${buf[1]}`);
        buf = buf.subarray(2);
        stage = 'connect';
        const packed = Buffer.alloc(16);
        const words = address.split('::');
        const head = words[0] ? words[0].split(':').filter(Boolean) : [];
        const tail = words[1] ? words[1].split(':').filter(Boolean) : [];
        head.forEach((w, i) => packed.writeUInt16BE(parseInt(w, 16), i * 2));
        tail.forEach((w, i) => packed.writeUInt16BE(parseInt(w, 16), (8 - tail.length + i) * 2));
        sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x04]), packed, Buffer.from([targetPort >> 8, targetPort & 0xff])]));
        return;
      }
      if (buf.length < 4) return;
      const rep = buf[1]!;
      finish(rep === 0x00, rep, rep === 0x00 ? 'CONNECT accepted' : `reply ${rep}`);

    });
  });
}

async function v6Egress(): Promise<{ reachable: boolean; address: string | null; note: string }> {
  try {
    const ctl = AbortSignal.timeout(6_000);
    const res = await fetch('https://api6.ipify.org?format=json', { signal: ctl });
    if (!res.ok) return { reachable: false, address: null, note: `HTTP ${res.status}` };
    const body = (await res.json()) as { ip?: string };
    return { reachable: true, address: body.ip ?? null, note: 'direct IPv6 fetch succeeded' };
  } catch (err) {
    return { reachable: false, address: null, note: (err as Error).message.slice(0, 120) };
  }
}

(async () => {
  const relay = await socks5RelayCheck(PORT);
  const v4Exit = relay ? await fetchExitIpThroughSocks(PORT) : null;
  const egress6 = await v6Egress();
  const tunnel6 = relay ? await socks5ConnectIpv6(PORT, V6_TARGET, 443) : { ok: false, rep: null, detail: 'no tunnel' };

  /** IPv6 CONNECT being accepted is not the same claim as IPv6 bytes flowing. */
  const ipv6DataPlane = await new Promise<{ tls: boolean; note: string }>((resolve) => {
    if (!tunnel6.ok || !('socket' in tunnel6) || !tunnel6.socket) {
      resolve({ tls: false, note: 'no accepted IPv6 CONNECT to test' });
      return;
    }
    const sock = tunnel6.socket;
    const timer = setTimeout(() => {
      sock.destroy();
      resolve({ tls: false, note: 'TLS handshake timeout over IPv6' });
    }, 12_000);
    const t = tls.connect({ socket: sock, servername: 'cloudflare-dns.com', rejectUnauthorized: false }, () => {
      clearTimeout(timer);
      const cert = t.getPeerCertificate();
      const subject = cert && cert.subject ? String(cert.subject.CN ?? '') : '';
      t.destroy();
      sock.destroy();
      resolve({ tls: true, note: `TLS ok over IPv6, cert CN=${subject || 'unknown'}` });
    });
    t.on('error', (e) => {
      clearTimeout(timer);
      sock.destroy();
      resolve({ tls: false, note: `TLS failed over IPv6: ${e.message}` });
    });
  });

  const findings: string[] = [];
  if (!egress6.reachable && ipv6DataPlane.tls) {
    findings.push(`This host has no direct IPv6 egress, but the tunnel carried an IPv6 TLS handshake to ${V6_TARGET} (${ipv6DataPlane.note}). IPv6 is covered *through* the tunnel — there is no v6 path outside it to leak onto, and no v6 coverage gap in the tunnel itself.`);
  } else if (!egress6.reachable) {
    findings.push('This host has no working IPv6 egress, so there is no IPv6 path to leak onto from here. IPv6 leak risk on a dual-stack network is NOT covered by this run.');
  } else if (!tunnel6.ok) {
    findings.push(`This host DOES have IPv6 egress (${egress6.address}) and the tunnel refuses IPv6 targets (${tunnel6.detail}). An app that does not force IPv4 would therefore leave the tunnel on v6 — a real leak on dual-stack networks.`);
  } else {
    findings.push('IPv6 is both available on this host and accepted by the tunnel; compare the v6 exit against the tunnel exit to decide whether it is covered.');
  }
  findings.push('DNS was measured separately (DNS_TUNNEL_PROOF): resolution now happens through the tunnel on TCP/53, so names no longer go to the local resolver.');

  const report = {
    generatedAt: new Date().toISOString(),
    tunnelPort: PORT,
    relay,
    ipv4Exit: v4Exit,
    ipv6Egress: egress6,
    tunnelAcceptsIpv6: tunnel6.ok,
    tunnelIpv6Reply: tunnel6.rep,
    tunnelIpv6Detail: tunnel6.detail,
    ipv6DataPlane,
    findings,
    notCovered: [
      'IPv6 through the tunnel (no coverage to test until IPv6 targets are accepted).',
      'UDP/QUIC leak behaviour — the SOCKS listener is TCP-only here.',
      'Traffic from another interface or a second resolver configured by the OS.',
    ],
  };

  fs.writeFileSync('reports/accounting/LEAK_TEST_2026-11-03.json', JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        relay,
        ipv4Exit: v4Exit,
        ipv6: egress6,
        tunnelIpv6: { ok: tunnel6.ok, rep: tunnel6.rep, detail: tunnel6.detail },
        ipv6DataPlane,
        findings,
      },
      null,
      2,
    ),
  );
})();
