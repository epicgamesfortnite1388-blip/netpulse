/**
 * Reconnection test for the Aether path.
 *
 * A tunnel that cannot come back is not a tunnel a user can rely on, and
 * "reconnects" is a claim that needs a timestamped kill and a timestamped
 * recovery — so this script does the kill itself rather than reading a log.
 *
 * Usage: npx tsx scripts/reconnect-test.ts <pid-to-stop> [port]
 *   <pid-to-stop> is the aether process this run owns; it is stopped with
 *   `taskkill /PID ... /F` (never by image name, which can match unrelated
 *   processes).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { fetchExitIpThroughSocks, socks5RelayCheck } from '../apps/api/src/vpn/aetherProvider.js';

const PID = Number(process.argv[2]);
const PORT = Number(process.argv[3] ?? 1819);
const BIN = path.resolve('aether/aether.exe');
const CONFIG = path.resolve('aether/aether.toml');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(value: boolean, timeoutMs: number): Promise<number | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const relay = await socks5RelayCheck(PORT, 4_000);
    if (relay === value) return Date.now();
    await sleep(500);
  }
  return null;
}

(async () => {
  if (!Number.isFinite(PID) || PID <= 0) throw new Error('usage: reconnect-test.ts <pid> [port]');
  if (!fs.existsSync(BIN)) throw new Error(`aether binary not found at ${BIN}`);

  const before = await socks5RelayCheck(PORT);
  const exitBefore = before ? await fetchExitIpThroughSocks(PORT) : null;
  if (!before) throw new Error('tunnel was not up before the test; refusing to measure a recovery from nothing');

  /* ------------------------------- take it down ------------------------------ */
  const killAt = Date.now();
  const killer = spawn('taskkill', ['/PID', String(PID), '/F'], { stdio: 'ignore' });
  await new Promise((r) => killer.on('exit', r));
  const downAt = await waitFor(false, 30_000);

  /* -------------------------------- bring it up ------------------------------ */
  const spawnAt = Date.now();
  const child = spawn(BIN, ['--bind', `127.0.0.1:${PORT}`, '--config', CONFIG, '--log-level', 'info', '--masque', '--noize', 'gfw', '--startup-secs', '90', '--validate-secs', '30'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const upAt = await waitFor(true, 180_000);
  const exitAfter = upAt ? await fetchExitIpThroughSocks(PORT) : null;

  const report = {
    generatedAt: new Date().toISOString(),
    tunnelPort: PORT,
    stoppedPid: PID,
    upBefore: before,
    exitBefore,
    confirmedDown: downAt !== null,
    downAfterMs: downAt === null ? null : downAt - killAt,
    confirmedUp: upAt !== null,
    reconnectMs: upAt === null ? null : upAt - spawnAt,
    totalOutageMs: upAt === null ? null : upAt - killAt,
    exitAfter,
    exitStable: exitBefore !== null && exitBefore === exitAfter,
    verdict:
      upAt === null
        ? 'FAIL — the tunnel did not come back within 180 s'
        : downAt === null
          ? 'PARTIAL — the tunnel came back, but the down state was never observed'
          : `PASS — down detected in ${downAt - killAt} ms, back in ${upAt - spawnAt} ms, exit ${exitAfter ?? 'unreadable'}`,
    notes: [
      'Recovery used the cached identity and gateway; a cold start (no cache) takes longer and is NOT measured here.',
      'The process was killed hard (SIGKILL equivalent), which is the harsher of the two failure modes.',
    ],
  };

  fs.writeFileSync('reports/accounting/RECONNECT_TEST_2026-11-03.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})();
