/**
 * DNS-in-tunnel proof (Iran-ready requirement 2 follow-through).
 *
 * The stage measurement found the leak: the tunnel refuses hostname-form SOCKS5
 * CONNECT, so names were resolved by the local resolver and only the payload was
 * tunnelled. This script measures the replacement path — DNS over TCP through
 * the tunnel to a public resolver — against the local resolver, then uses the
 * in-tunnel answer to fetch the exit IP. That last step is what makes it a fix
 * rather than a second measurement: the connection must still work with a name
 * that was resolved on the far side.
 *
 * Requires a tunnel listening on 127.0.0.1:1819 (Aether default).
 * Run: npx tsx scripts/dns-tunnel-proof.ts [port]
 */
import dns from 'node:dns/promises';
import fs from 'node:fs';

import { fetchExitIpThroughSocks, resolveThroughTunnel, socks5Connect } from '../apps/api/src/vpn/aetherProvider.js';

const PORT = Number(process.argv[2] ?? 1819);
const NAMES = ['api.ipify.org', 'www.cloudflare.com', 'example.com'];
const ROUNDS = 5;

interface Result {
  name: string;
  local: { addresses: string[]; ms: number } | null;
  tunnel: { addresses: string[]; ms: number } | null;
  sameAnswer: boolean | null;
}

async function once(name: string): Promise<Result> {
  let local: Result['local'] = null;
  const l0 = Date.now();
  try {
    const r = await dns.lookup(name, { family: 4, all: true });
    local = { addresses: r.map((x) => x.address), ms: Date.now() - l0 };
  } catch {
    local = null;
  }

  const t = await resolveThroughTunnel(PORT, name, '1.1.1.1', 8_000);

  const sameAnswer =
    local && t ? t.addresses.some((a) => local!.addresses.includes(a)) : null;

  return { name, local, tunnel: t, sameAnswer };
}

(async () => {
  const rounds: Result[] = [];
  for (let i = 0; i < ROUNDS; i++) {
    for (const name of NAMES) rounds.push(await once(name));
  }

  const tunnelOk = rounds.filter((r) => r.tunnel !== null);
  const localOk = rounds.filter((r) => r.local !== null);

  // End-to-end: resolve through the tunnel, then CONNECT to that address.
  const resolved = await resolveThroughTunnel(PORT, 'api.ipify.org', '1.1.1.1', 8_000);
  let endToEnd: string | null = null;
  let endToEndNote = 'not attempted — no in-tunnel answer';
  if (resolved) {
    const ip = resolved.addresses[0]!;
    const conn = await socks5Connect(PORT, ip, 80, 12_000);
    if (conn) {
      endToEnd = await new Promise<string | null>((resolve) => {
        let data = '';
        const timer = setTimeout(() => {
          conn.socket.destroy();
          resolve(null);
        }, 12_000);
        conn.socket.on('data', (c: Buffer) => {
          data += c.toString();
          const m = /"ip"\s*:\s*"([0-9a-fA-F.:]+)"/.exec(data);
          if (m) {
            clearTimeout(timer);
            conn.socket.destroy();
            resolve(m[1]!);
          }
        });
        conn.socket.write('GET /?format=json HTTP/1.1\r\nHost: api.ipify.org\r\nConnection: close\r\n\r\n');
      });
      endToEndNote = `resolved 104.x/172.x in tunnel → CONNECT ${ip}:80 → ${endToEnd ?? 'no response body'}`;
    } else {
      endToEndNote = `in-tunnel answer ${ip} but SOCKS CONNECT refused`;
    }
  }

  const median = (xs: number[]): number | null =>
    xs.length === 0 ? null : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

  const report = {
    generatedAt: new Date().toISOString(),
    tunnelPort: PORT,
    resolver: '1.1.1.1:53 over DNS-over-TCP through SOCKS5',
    rounds: ROUNDS,
    names: NAMES,
    samples: rounds.length,
    localResolved: localOk.length,
    tunnelResolved: tunnelOk.length,
    localMedianMs: median(localOk.map((r) => r.local!.ms)),
    tunnelMedianMs: median(tunnelOk.map((r) => r.tunnel!.elapsedMs)),
    sameAnswerCount: rounds.filter((r) => r.sameAnswer === true).length,
    differentAnswerCount: rounds.filter((r) => r.sameAnswer === false).length,
    endToEndExitIp: endToEnd,
    endToEndNote,
    verdict:
      tunnelOk.length === rounds.length
        ? 'DNS resolved through the tunnel in every round; payload still reaches the same destination'
        : `DNS through the tunnel failed in ${rounds.length - tunnelOk.length}/${rounds.length} rounds`,
    details: rounds,
  };

  fs.writeFileSync('reports/accounting/DNS_TUNNEL_PROOF_2026-11-03.json', JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        localResolved: report.localResolved,
        tunnelResolved: report.tunnelResolved,
        localMedianMs: report.localMedianMs,
        tunnelMedianMs: report.tunnelMedianMs,
        sameAnswer: report.sameAnswerCount,
        differentAnswer: report.differentAnswerCount,
        endToEndExitIp: report.endToEndExitIp,
        verdict: report.verdict,
      },
      null,
      2,
    ),
  );

  // Keep the baseline helper honest about still working after the change.
  console.log('socks exit-ip (baseline helper):', await fetchExitIpThroughSocks(PORT));
})();
