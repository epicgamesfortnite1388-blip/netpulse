/**
 * Negative controls for the tunnel proof path (Iran-ready requirement 4).
 *
 * The exit-IP proof is only worth something if it says NO when there is no
 * tunnel. Every case here is designed to produce something that *looks* like a
 * working client — an open SOCKS5 port, a running process, a plausible log — and
 * the harness passes only when `socks5RelayCheck` and the exit-IP proof both
 * refuse to certify it.
 *
 * Controls:
 *   C1 blocked peer      TEST-NET-1 address, no route out
 *   C2 occupied port     our own listener sits on the bind port (port open, not us)
 *   C3 corrupt identity  garbage in the identity file the tunnel would use
 *   C4 fallback          after every failure above, direct egress is unchanged
 *
 * Nothing here needs a working tunnel; a machine that cannot connect at all is
 * the expected environment. Run: npx tsx scripts/negative-controls.ts
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { socks5RelayCheck, fetchExitIpThroughSocks } from '../apps/api/src/vpn/aetherProvider.js';

const AETHER_BIN = path.join(process.cwd(), 'aether', process.platform === 'win32' ? 'aether.exe' : 'aether');
const BASELINE_EXPECTED = '83.229.87.141';
const READY_WAIT_MS = 40_000;

type CaseResult = {
  id: string;
  intent: string;
  portOpen: boolean;
  relay: boolean;
  exitIp: string | null;
  processExitedEarly: boolean;
  logTail: string[];
  verdict: 'PASS' | 'FAIL';
  why: string;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function portOpen(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port, timeout: timeoutMs }, () => {
      s.destroy();
      resolve(true);
    });
    s.on('error', () => {
      s.destroy();
      resolve(false);
    });
    s.on('timeout', () => {
      s.destroy();
      resolve(false);
    });
  });
}

/** Kill the process and its children; Aether spawns none today but be exact. */
function stopTree(pid: number) {
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      /* already gone */
    }
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

async function baselineIp(): Promise<string | null> {
  try {
    const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(15_000) });
    const j = (await r.json()) as { ip?: string };
    return j.ip ?? null;
  } catch {
    return null;
  }
}

type RunOptions = { port: number; configDir: string; extraArgs: string[] };

/** Start Aether, wait for the port or an early exit, then measure honestly. */
async function runCase(id: string, intent: string, opts: RunOptions): Promise<CaseResult> {
  const log: string[] = [];
  const child = spawn(AETHER_BIN, [
    '--bind', `127.0.0.1:${opts.port}`,
    '--config', path.join(opts.configDir, 'aether.toml'),
    '--log-level', 'info',
    ...opts.extraArgs,
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

  let exited = false;
  const onChunk = (b: Buffer) => {
    for (const line of b.toString().split(/\r?\n/)) {
      if (line.trim()) log.push(line.trim().slice(0, 200));
    }
  };
  child.stdout?.on('data', onChunk);
  child.stderr?.on('data', onChunk);
  child.once('exit', () => {
    exited = true;
  });

  const deadline = Date.now() + READY_WAIT_MS;
  let open = false;
  while (Date.now() < deadline && !open && !exited) {
    open = await portOpen(opts.port, 500);
    if (!open) await sleep(1_000);
  }
  // Give a would-be tunnel the same grace the app gives before declaring it ready.
  if (open && !exited) await sleep(6_000);

  const relay = open ? await socks5RelayCheck(opts.port, 12_000) : false;
  const exitIp = relay ? await fetchExitIpThroughSocks(opts.port, 15_000) : null;

  if (child.pid) stopTree(child.pid);
  await sleep(1_500);

  // The control passes when nothing certified a tunnel. A relay that answers but
  // yields no exit IP is still unresolved data, so it is not a pass.
  const certified = relay && exitIp !== null;
  return {
    id,
    intent,
    portOpen: open,
    relay,
    exitIp,
    processExitedEarly: exited && !open,
    logTail: log.slice(-4),
    verdict: certified ? 'FAIL' : 'PASS',
    why: certified
      ? `a tunnel was certified when the setup was meant to fail (relay=${relay}, exit=${exitIp})`
      : open
        ? 'port answered but no tunnel was certified'
        : 'no listener, no tunnel — nothing to certify',
  };
}

function makeConfigDir(name: string, identity?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `np-negctl-${name}-`));
  fs.writeFileSync(path.join(dir, 'aether.toml'), '# negative-control config — intentionally minimal\n');
  if (identity !== undefined) fs.writeFileSync(path.join(dir, 'aether-masque.toml'), identity);
  return dir;
}

(async () => {
  if (!fs.existsSync(AETHER_BIN)) {
    console.error(`FAIL — Aether binary missing at ${AETHER_BIN}; install it first (installAether)`);
    process.exitCode = 2;
    return;
  }

  const before = await baselineIp();
  console.log(`baseline egress before controls: ${before ?? 'unreachable'}`);

  const results: CaseResult[] = [];

  // C1 — blocked peer: TEST-NET-1 is never routeable, so the scan cannot find a way out.
  results.push(await runCase('C1', 'blocked peer (TEST-NET-1) must not yield a tunnel', {
    port: 2919,
    configDir: makeConfigDir('c1'),
    extraArgs: ['--masque', '--peer', '192.0.2.1:443', '--startup-secs', '25'],
  }));

  // C2 — occupied port: an open port that is NOT a tunnel must not be certified.
  const squat = net.createServer((s) => s.destroy());
  await new Promise<void>((r) => squat.listen(2920, '127.0.0.1', () => r()));
  results.push(await runCase('C2', 'a port we opened ourselves must not be certified as a tunnel', {
    port: 2920,
    configDir: makeConfigDir('c2'),
    extraArgs: ['--masque', '--peer', '192.0.2.1:443', '--startup-secs', '15'],
  }));
  squat.close();

  // C3 — corrupt identity: garbage where the key would be read.
  results.push(await runCase('C3', 'a corrupt identity file must not produce a tunnel', {
    port: 2921,
    configDir: makeConfigDir('c3', 'this is not valid toml [[[\nprivate_key = "not-a-key"\n'),
    extraArgs: ['--masque', '--startup-secs', '15'],
  }));

  // C4 — fallback: the failures above must not have moved the machine's egress.
  const after = await baselineIp();
  const unchanged = before !== null && after === before;
  results.push({
    id: 'C4',
    intent: 'a failed tunnel must leave the machine on its normal egress',
    portOpen: false,
    relay: false,
    exitIp: after,
    processExitedEarly: false,
    logTail: [],
    verdict: unchanged ? 'PASS' : 'FAIL',
    why: unchanged
      ? `egress unchanged at ${after}`
      : `egress moved: before=${before ?? 'null'} after=${after ?? 'null'} (expected ${BASELINE_EXPECTED} on this host)`,
  });

  const failed = results.filter((r) => r.verdict === 'FAIL');
  const doc = {
    generatedAt: new Date().toISOString(),
    binary: AETHER_BIN,
    baselineBefore: before,
    baselineAfter: after,
    cases: results,
    summary: {
      total: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      verdict: failed.length === 0 ? 'PASS' : 'FAIL',
    },
  };
  fs.mkdirSync('reports/accounting', { recursive: true });
  fs.writeFileSync('reports/accounting/NEGATIVE_CONTROLS_2026-11-03.json', JSON.stringify(doc, null, 2));

  for (const r of results) {
    console.log(`\n[${r.verdict}] ${r.id} — ${r.intent}`);
    console.log(`      portOpen=${r.portOpen} relay=${r.relay} exit=${r.exitIp ?? 'null'} exitedEarly=${r.processExitedEarly}`);
    console.log(`      ${r.why}`);
    for (const l of r.logTail) console.log(`      | ${l}`);
  }
  console.log(`\n${doc.summary.verdict}: ${doc.summary.passed}/${doc.summary.total} controls behaved`);
  if (failed.length) process.exitCode = 1;
})();
