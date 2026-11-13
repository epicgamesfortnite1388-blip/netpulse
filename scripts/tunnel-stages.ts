/**
 * Staged tunnel latency (Iran-ready requirement 2, lab half).
 *
 * Requirement 2 asks for separate DNS, TCP, TLS and HTTP stage results per path
 * rather than one end-to-end number, because collapsing them hides *which* stage
 * a censor is attacking. This measures the stages against a live local SOCKS5
 * tunnel and, importantly, records where DNS actually happens.
 *
 * Requires a tunnel already listening (default 127.0.0.1:1819 — the Aether bind
 * port). Run: npx tsx scripts/tunnel-stages.ts [port]
 */
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import { socks5Connect } from '../apps/api/src/vpn/aetherProvider.js';

const PORT = Number(process.argv[2] ?? 1819);
const HOST = 'api.ipify.org';
const REPEATS = 20;

type Sample = {
  dnsMs: number | null;
  socksMs: number | null;
  tlsMs: number | null;
  httpMs: number | null;
  totalMs: number;
  error: string | null;
};

function stats(values: number[]) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return {
    min: s[0],
    median: s[Math.floor(s.length / 2)],
    p90: s[Math.min(s.length - 1, Math.floor(s.length * 0.9))],
    max: s[s.length - 1],
  };
}

/** TCP + greeting + CONNECT to an IP literal: no name crosses the SOCKS layer. */
async function oneRound(): Promise<Sample> {
  const t0 = Date.now();
  let dnsMs: number | null = null;
  let socksMs: number | null = null;
  let tlsMs: number | null = null;
  let httpMs: number | null = null;

  let ip: string;
  const dnsStart = Date.now();
  try {
    ip = (await dns.lookup(HOST, { family: 4 })).address;
    dnsMs = Date.now() - dnsStart;
  } catch (err) {
    return { dnsMs: null, socksMs: null, tlsMs: null, httpMs: null, totalMs: Date.now() - t0, error: `dns: ${(err as Error).message}` };
  }

  const socksStart = Date.now();
  const conn = await socks5Connect(PORT, ip, 443, 12_000);
  socksMs = Date.now() - socksStart;
  if (!conn) {
    return { dnsMs, socksMs, tlsMs: null, httpMs: null, totalMs: Date.now() - t0, error: 'socks5 connect refused' };
  }

  const tlsStart = Date.now();
  const tlsErr = await new Promise<string | null>((resolve) => {
    const t = tls.connect({ socket: conn.socket, servername: HOST, rejectUnauthorized: false }, () => {
      tlsMs = Date.now() - tlsStart;
      const httpStart = Date.now();
      t.write(`GET /?format=json HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\nUser-Agent: netpulse-stages\r\n\r\n`);
      let data = '';
      t.on('data', (c: Buffer) => {
        data += c.toString('utf8');
        if (data.includes('\r\n\r\n') && data.length > 40) {
          httpMs = Date.now() - httpStart;
          t.destroy();
          conn.socket.destroy();
          resolve(null);
        }
      });
      t.on('error', (e) => resolve(`http: ${e.message}`));
      setTimeout(() => {
        t.destroy();
        conn.socket.destroy();
        resolve(httpMs === null ? 'http: timeout' : null);
      }, 15_000).unref();
    });
    t.on('error', (e) => resolve(`tls: ${e.message}`));
    setTimeout(() => {
      t.destroy();
      conn.socket.destroy();
      resolve('tls: timeout');
    }, 15_000).unref();
  });

  if (tlsErr) {
    conn.socket.destroy();
    return { dnsMs, socksMs, tlsMs, httpMs: null, totalMs: Date.now() - t0, error: tlsErr };
  }
  return { dnsMs, socksMs, tlsMs, httpMs, totalMs: Date.now() - t0, error: null };
}

/**
 * Does the tunnel accept a hostname at the SOCKS layer (ATYP 0x03)? If it does
 * not, every name is resolved by the local resolver — outside the tunnel — which
 * is a DNS leak that has to be stated, not hidden.
 */
async function domainFormAccepted(): Promise<boolean> {
  const conn = await socks5Connect(PORT, 'one.one.one.one', 80, 10_000);
  if (!conn) return false;
  conn.socket.destroy();
  return true;
}

(async () => {
  const samples: Sample[] = [];
  const accepted = await domainFormAccepted();
  console.log(`domain-form SOCKS5 (ATYP 0x03) accepted: ${accepted}`);

  for (let i = 0; i < REPEATS; i++) {
    const s = await oneRound();
    samples.push(s);
    if (s.error) console.log(`  #${i + 1} error: ${s.error}`);
  }

  const ok = samples.filter((s) => s.error === null);
  const report = {
    generatedAt: new Date().toISOString(),
    tunnelPort: PORT,
    target: HOST,
    repeats: REPEATS,
    completed: ok.length,
    dnsRunsThrough: accepted ? 'tunnel (ATYP 0x03)' : 'local resolver (tunnel refuses ATYP 0x03)',
    domainFormAccepted: accepted,
    stages: {
      dns: stats(ok.map((s) => s.dnsMs!).filter((v) => v !== null)),
      socksConnect: stats(ok.map((s) => s.socksMs!).filter((v) => v !== null)),
      tlsHandshake: stats(ok.map((s) => s.tlsMs!).filter((v) => v !== null)),
      httpFirstByte: stats(ok.map((s) => s.httpMs!).filter((v) => v !== null)),
      endToEnd: stats(ok.map((s) => s.totalMs)),
    },
    failures: samples.filter((s) => s.error).map((s) => s.error),
    samples,
  };

  fs.writeFileSync('reports/accounting/TUNNEL_STAGES_2026-11-03.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ completed: report.completed, dnsRunsThrough: report.dnsRunsThrough, stages: report.stages }, null, 2));
})();
