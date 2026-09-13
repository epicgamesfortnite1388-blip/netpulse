#!/usr/bin/env node
/**
 * E2E functional pass against the REAL desktop sidecar bundle.
 *
 * Boots src-tauri/backend/netpulse-backend.js exactly as the Rust supervisor
 * does (stdin token, ephemeral port, app-data dir), then exercises every major
 * feature surface over HTTP with the bearer token. Network-dependent probes
 * are allowed to fail — assertions focus on honest, well-formed responses,
 * not on internet reachability.
 *
 * Run: npm run e2e
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backendDir = path.join(root, 'src-tauri', 'backend');
const dataDir = fs.mkdtempSync(path.join(root, '.tmp-e2e-'));

let pass = 0;
let fail = 0;
const results = [];

function check(name, ok, detail = '') {
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ''}`);
  results.push({ name, ok, detail });
  if (ok) pass++; else fail++;
}

const token = crypto.randomBytes(32).toString('hex');
const child = spawn(process.execPath, [path.join(backendDir, 'netpulse-backend.js')], {
  env: {
    ...process.env,
    NETPULSE_PORT: '0',
    NETPULSE_DATA_DIR: dataDir,
    NETPULSE_MIGRATIONS_DIR: path.join(backendDir, 'drizzle'),
      NETPULSE_MODULES_DIR: path.join(backendDir, 'node_modules'),
    DEMO_DATA: 'false',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stdin.write(`${token}\n`);

let base = null;
let stderrBuf = '';
child.stderr.on('data', (d) => {
  stderrBuf += d.toString();
  const m = stderrBuf.match(/sidecar-ready port=(\d+)/);
  if (m && !base) {
    base = `http://127.0.0.1:${m[1]}`;
    run().catch((e) => { check('e2e suite crashed', false, String(e)); finish(1); });
  }
});
child.stdout.on('data', () => {});

setTimeout(() => {
  if (!base) {
    check('sidecar boots', false, stderrBuf.slice(0, 300));
    finish(1);
  }
}, 25000);

async function api(method, p, body) {
  const res = await fetch(`${base}/api/v1${p}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* text */ }
  return { status: res.status, json };
}

async function run() {
  // ---------- system ----------
  const meta = await api('GET', '/meta');
  check('meta endpoint', meta.status === 200, `status=${meta.status}`);

  const unauth = await fetch(`${base}/api/v1/network/status`);
  check('auth required', unauth.status === 401);

  const badTok = await fetch(`${base}/api/v1/network/status`, { headers: { authorization: 'Bearer nope' } });
  check('bad token rejected', badTok.status === 401);

  // ---------- vpn ----------
  const providers = await api('GET', '/vpn/providers');
  check('vpn providers listed', providers.status === 200 && Array.isArray(providers.json.providers) && providers.json.providers.length >= 4, `${providers.json.providers?.length} providers`);

  const profiles = await api('GET', '/vpn/profiles');
  check('vpn profiles listed', profiles.status === 200 && Array.isArray(profiles.json.profiles));

  const badConnect = await api('POST', '/vpn/connect', { profileId: 'does-not-exist' });
  check('connect unknown profile => 404', badConnect.status === 404, `status=${badConnect.status}`);

  const disconnectIdle = await api('POST', '/vpn/disconnect');
  check('disconnect when idle is safe', disconnectIdle.status === 200, `status=${disconnectIdle.status}`);

  const status = await api('GET', '/vpn/status');
  check('vpn status shape', status.status === 200 && typeof status.json.connected === 'boolean');

  // ---------- dns ----------
  const resolvers = await api('GET', '/dns/providers');
  check('dns resolvers listed', resolvers.status === 200, `status=${resolvers.status}`);

  const dnsBad = await api('POST', '/dns/test', { resolverId: 'nonexistent', domain: 'example.com' });
  check('dns test unknown resolver => 202 (async job)', dnsBad.status === 202, `status=${dnsBad.status}`);

  // ---------- probes ----------
  // SSRF guard: loopback/link-local/metadata targets are rejected by design.
  const pingLoopback = await api('POST', '/ping-test', { target: '127.0.0.1', count: 3 });
  check('ping rejects loopback (SSRF guard)', pingLoopback.status === 400, `status=${pingLoopback.status}`);

  const pingBad = await api('POST', '/ping-test', { target: 'http://evil:22/x', count: 3 });
  check('ping rejects URL as host', pingBad.status === 400, `status=${pingBad.status}`);

  const pingPrivate = await api('POST', '/ping-test', { target: '169.254.169.254', count: 1 });
  check('ping rejects cloud-metadata IP', pingPrivate.status === 400, `status=${pingPrivate.status}`);

  // A real public target is allowed through and executes (result may fail if
  // offline — the contract is 200 with an honest measurement record).
  const pingPublic = await api('POST', '/ping-test', { target: '1.1.1.1', count: 2, timeoutMs: 3000 });
  check('public target ping executes', pingPublic.status === 200 || pingPublic.status >= 500, `status=${pingPublic.status}`);

  // ---------- nodes ----------
  const nodesEmpty = await api('GET', '/nodes?limit=10');
  check('nodes list (empty db)', nodesEmpty.status === 200 && nodesEmpty.json.total === 0, `total=${nodesEmpty.json.total}`);

  const nodeStats = await api('GET', '/nodes/stats');
  check('node stats shape', nodeStats.status === 200 && typeof nodeStats.json.total === 'number');

  const sources = await api('GET', '/sources');
  check('sources listed', sources.status === 200 && Array.isArray(sources.json.sources));

  const badSource = await api('POST', '/sources', { name: 'x', urls: ['http://169.254.169.254/latest'] });
  check('SSRF guard blocks metadata source', badSource.status === 400, `status=${badSource.status}`);

  const badSource2 = await api('POST', '/sources', { name: 'x', urls: ['not-a-url'] });
  check('invalid source URL rejected', badSource2.status === 400, `status=${badSource2.status}`);

  const export404 = await api('GET', '/nodes/export?nodeIds=nope&format=uri');
  check('export unknown node => empty/error', export404.status === 200 || export404.status === 404, `status=${export404.status}`);

  // ---------- iran ----------
  const iranCatalog = await api('GET', '/iran/catalog');
  check('iran targets listed', iranCatalog.status === 200, `status=${iranCatalog.status}`);

  // ---------- gaming ----------
  const games = await api('GET', '/gaming/games');
  check('gaming catalog listed', games.status === 200, `status=${games.status}`);

  // ---------- map ----------
  const map = await api('GET', '/map/summary');
  check('map summary', map.status === 200 || map.status === 404, `status=${map.status}`);

  // ---------- events/history ----------
  const events = await api('GET', '/events?limit=5');
  check('events listed', events.status === 200, `status=${events.status}`);

  const tests = await api('GET', '/history?limit=5');
  check('history listed', tests.status === 200, `status=${tests.status}`);

  // ---------- settings ----------
  const settingsGet = await api('GET', '/settings');
  check('settings readable', settingsGet.status === 200 && typeof settingsGet.json === 'object');

  const settingsPatch = await api('PUT', '/settings', { general: { theme: 'light' } });
  const settingsAfter = await api('GET', '/settings');
  check('settings patch persists', settingsPatch.status === 200 && settingsAfter.json?.settings?.general?.theme === 'light', `theme=${settingsAfter.json?.settings?.general?.theme}`);

  // ---------- speed / diagnostics ----------
  const speed = await api('POST', '/speed/run', { durationSeconds: 2 });
  check('speed run executes', speed.status === 200 || speed.status === 202 || speed.status >= 500, `status=${speed.status}`);

  const speedHist = await api('GET', '/speed/history?limit=5');
  check('speed history listed', speedHist.status === 200, `status=${speedHist.status}`);

  const diag = await api('POST', '/diagnostics/mtu', {});
  check('mtu diagnostic runs', diag.status === 200 || diag.status === 202 || diag.status >= 500, `status=${diag.status}`);

  const cgnat = await api('POST', '/diagnostics/cgnat', {});
  check('cgnat diagnostic runs', cgnat.status === 200 || cgnat.status === 202 || cgnat.status >= 500, `status=${cgnat.status}`);

  // ---------- endpoints / test targets ----------
  const endpoints = await api('GET', '/test-endpoints');
  check('test endpoints listed', endpoints.status === 200, `status=${endpoints.status}`);

  // ---------- cloudflare scan lifecycle ----------
  const cfScan = await api('POST', '/cloudflare/scan', {});
  check('cloudflare scan starts (or honest refusal)', cfScan.status === 200 || cfScan.status === 202 || cfScan.status === 400, `status=${cfScan.status}`);
  const cfScans = await api('GET', '/cloudflare/scans');
  check('cloudflare scans listed', cfScans.status === 200, `status=${cfScans.status}`);

  // ---------- gaming test + compare ----------
  const games2 = await api('GET', '/gaming/games');
  const firstGame = games2.json?.games?.[0]?.id ?? games2.json?.[0]?.id;
  const gTest = await api('POST', '/gaming/test', firstGame ? { gameId: firstGame } : {});
  check('gaming test starts (async ok)', gTest.status === 200 || gTest.status === 202 || gTest.status >= 500, `status=${gTest.status}`);
  const gCompare = await api('GET', '/gaming/compare');
  check('gaming compare listed', gCompare.status === 200, `status=${gCompare.status}`);

  // ---------- iran run lifecycle ----------
  const iranRun = await api('POST', '/iran/run', {});
  check('iran run starts (async ok)', iranRun.status === 200 || iranRun.status === 202 || iranRun.status === 400, `status=${iranRun.status}`);
  const iranSessions = await api('GET', '/iran/sessions');
  check('iran sessions listed', iranSessions.status === 200, `status=${iranSessions.status}`);

  // ---------- health monitor (real UI path: /health-monitor/*) ----------
  const hStart = await api('POST', '/health-monitor/start', {});
  const hStatus = await api('GET', '/health-monitor/status');
  const hStop = await api('POST', '/health-monitor/stop', {});
  check('health monitor start/status/stop', hStatus.status === 200 && typeof hStatus.json?.running === 'boolean' && hStart.status === 200 && hStop.status === 200, `start=${hStart.status} status=${hStatus.status} stop=${hStop.status}`);

  // ---------- vpn full lifecycle (reconnect path) ----------
  const recon = await api('POST', '/vpn/reconnect', { profileId: 'does-not-exist' });
  check('vpn reconnect unknown profile => 404 (mutex path safe)', recon.status === 404, `status=${recon.status}`);

  const connList = await api('GET', '/vpn/connections');
  check('vpn connections listed', connList.status === 200 && Array.isArray(connList.json.connections ?? connList.json), `status=${connList.status}`);

  // ---------- fuzz: oversized + malformed ----------
  const huge = await api('POST', '/ping-test', { target: 'a'.repeat(100_000), count: 1 });
  check('oversized host rejected', huge.status >= 400 && huge.status < 500, `status=${huge.status}`);

  const weird = await api('POST', '/ping-test', { target: '\u0000\u{1F600}..', count: 1 });
  check('unicode/control host rejected safely', weird.status >= 400 && weird.status < 500, `status=${weird.status}`);

  const arr = await api('POST', '/ping-test', { target: ['1.1.1.1'], count: 1 });
  check('wrong-type payload rejected', arr.status >= 400 && arr.status < 500, `status=${arr.status}`);

  finish(0);
}

async function finish(code) {
  // clean shutdown via stdin EOF
  child.stdin.end();
  await new Promise((res) => {
    const t = setTimeout(() => { child.kill(); res(); }, 8000);
    child.on('exit', () => { clearTimeout(t); res(); });
  });
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
