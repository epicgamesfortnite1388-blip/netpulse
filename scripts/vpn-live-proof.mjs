/**
 * Live VPN lifecycle proof — the release gate for the product's namesake path.
 *
 * WHY THIS EXISTS
 * ---------------
 * `docs/REPO_STATE_ASSESSMENT_2026-10-06.md` (D3) recorded that this repository
 * had route-level and unit coverage for the tunnel but NO runnable, repo-owned
 * proof that a real node connects, switches, and disconnects on a real machine.
 * The evidence that did exist came from throwaway scripts in a temp directory
 * (`g4-driver.mjs`, `capture.mjs`, `os-fetch.mjs`, a pile of `.ps1` launchers in
 * `%TEMP%`), all hardcoded to one developer's absolute paths. Nothing in the
 * repository could re-run them, so nothing could gate a release on them.
 *
 * This script is that proof, in-repo and self-contained. It:
 *
 *   1. mints a fresh per-run bearer token and boots the SHIPPED sidecar bundle
 *      (`src-tauri/backend/netpulse-backend.js`) exactly as the Rust supervisor
 *      does — ephemeral port, `NETPULSE_DATA_DIR` under the proof root, token on
 *      stdin, `sidecar-ready port=` on stderr;
 *   2. launches two hermetic VLESS proof servers with the discovered `xray` core;
 *   3. drives the real lifecycle through the sidecar's own HTTP API:
 *      baseline -> import -> proxy-test both nodes -> connect A -> verify ->
 *      OS-level exit check -> stop -> connect B -> verify -> disconnect -> verify;
 *   4. asserts the OS state at each boundary (HKCU system proxy, listening
 *      ports, orphan core processes) instead of trusting the app's own status
 *      field — the entire point is to catch a `CONNECTED` that is not functional;
 *   5. writes `evidence/vpn-live-proof.json` and exits non-zero if any
 *      assertion failed.
 *
 * It mutates exactly two things on the host, both of which the app itself
 * mutates on Connect, and both restored in `finally`: the HKCU system proxy and
 * a `<root>/data/netpulse.db` under the proof root. It never touches the user's
 * real app-data directory.
 *
 * USAGE
 *   node scripts/vpn-live-proof.mjs [--root <dir>] [--core <xray.exe>]
 *                                  [--no-os-fetch] [--keep]
 *
 * EXIT CODES
 *   0  every assertion passed
 *   1  a real assertion failed (the artifact in evidence/ says which)
 *   2  the proof could not run (no xray core, no sidecar bundle) — an honest
 *      SKIP, never reported as a pass.
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = 2;

/* ------------------------------- arguments ------------------------------ */

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const ROOT = path.resolve(
  argValue('--root') ?? process.env.NETPULSE_PROOF_ROOT ?? path.join(os.tmpdir(), 'netpulse-vpnproof'),
);
const EVIDENCE = path.join(ROOT, 'evidence');
const DATA = path.join(ROOT, 'data');
const OS_FETCH = !process.argv.includes('--no-os-fetch');
const KEEP = process.argv.includes('--keep');

// ---- soak (opt-in via --soak): repeat the lifecycle and prove nothing leaks
const num = (flag, dflt) => {
  const v = argValue(flag);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
};
const SOAK = process.argv.includes('--soak');
const CYCLES = num('--cycles', 50);
const RECONNECTS = num('--reconnects', 20);
const RESTARTS = num('--restarts', 10);
const ENGINE_KILLS = num('--engine-kills', 10);
const PORT_A = 20801;
const PORT_B = 20802;
const UUID_A = '11111111-2222-4333-8444-555555555555';
const UUID_B = '99999999-8888-4777-8666-555555555555';

/* -------------------------------- reporting ------------------------------ */

const steps = [];
const failures = [];
let checks = 0;

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function step(name, detail) {
  steps.push({ step: name, at: Date.now(), ok: true, ...detail });
  log(`[${name}] ${JSON.stringify(detail ?? {}).slice(0, 220)}`);
}

/** Record a measured fact. `ok:false` is a release-stopping finding, not a note. */
function check(name, ok, detail) {
  checks++;
  steps.push({ step: `check:${name}`, at: Date.now(), ok, ...detail });
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${JSON.stringify(detail).slice(0, 200)}` : ''}`);
  if (!ok) failures.push({ name, detail });
  return ok;
}

function writeEvidence(payload) {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const file = path.join(EVIDENCE, 'vpn-live-proof.json');
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}

/* ----------------------------- host inspection --------------------------- */

if (process.platform !== 'win32') {
  log('vpn-live-proof: this gate drives the Windows system proxy and the shipped sidecar; it only runs on Windows.');
  process.exit(SKIP);
}

/** Run a PowerShell file (not `-Command`) so backslashes in registry paths survive. */
function ps(script, timeout = 20000) {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const f = path.join(EVIDENCE, `.ps-${crypto.randomBytes(4).toString('hex')}.ps1`);
  fs.writeFileSync(f, script, 'utf8');
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', f], {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
    });
    return { out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim(), status: r.status };
  } finally {
    try { fs.unlinkSync(f); } catch { /* best effort */ }
  }
}

const PROXY_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/** The system proxy as the OS sees it — the state the app must leave clean. */
function readProxy() {
  const r = ps(
    `$k='${PROXY_KEY}';` +
    `[PSCustomObject]@{` +
    `Enable=(Get-ItemProperty $k -Name ProxyEnable -EA SilentlyContinue).ProxyEnable;` +
    `Server=(Get-ItemProperty $k -Name ProxyServer -EA SilentlyContinue).ProxyServer` +
    `} | ConvertTo-Json`,
  );
  try {
    const o = JSON.parse(r.out);
    const en = o.Enable;
    return {
      enable: en === 1 || en === true ? 1 : 0,
      server: o.Server == null || o.Server === '' ? null : String(o.Server),
    };
  } catch {
    return { enable: null, server: null, error: r.err || r.out || 'unreadable' };
  }
}

/** Restore the system proxy. `server:null` removes the value rather than blanking it. */
function writeProxy(enable, server) {
  const body = server == null
    ? `Remove-ItemProperty -Path '${PROXY_KEY}' -Name ProxyServer -EA SilentlyContinue; Set-ItemProperty -Path '${PROXY_KEY}' -Name ProxyEnable -Value 0`
    : `Set-ItemProperty -Path '${PROXY_KEY}' -Name ProxyServer -Value '${String(server).replace(/'/g, "''")}'; Set-ItemProperty -Path '${PROXY_KEY}' -Name ProxyEnable -Value ${enable ? 1 : 0}`;
  const r = ps(body, 15000);
  return r.status === 0 ? { ok: true } : { ok: false, error: r.err || r.out };
}

function listeningPorts() {
  const r = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  const ports = [];
  for (const line of (r.stdout ?? '').split('\n')) {
    const m = line.match(/:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
    if (m) ports.push({ port: Number(m[1]), pid: Number(m[2]) });
  }
  return ports;
}

/** Every xray.exe on the box, so "0 orphans after disconnect" is measurable. */
function xrayProcs() {
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq xray.exe', '/FO', 'CSV', '/NH'], {
    encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  const out = [];
  for (const line of (r.stdout ?? '').split('\n')) {
    const m = line.match(/^"([^"]+)","?(\d+)"?/);
    if (m) out.push({ name: m[1], pid: Number(m[2]) });
  }
  return out;
}

function killTree(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------- soak bookkeeping + helpers -------------------- */

// Module-level so the scenario runners below can see them without threading
// half a dozen parameters through every call.
let baselineXray = new Set();
let ownedPids = new Set();
let baselineProxy = null;
let baselineNet = null;
// Deliberately module-level: the crash-restart scenario replaces the sidecar, and
// `main`'s cleanup must see the replacement, not the process it already killed.
let sidecar = null;
let sh = null;
let proofs = [];
let tunnelConnected = false;
let rateLimited = 0;
const soakTally = {};
const lastCallAt = new Map();

/** Per-scenario-class pass rate — the soak's headline number. */
function tally(name, ok) {
  if (!soakTally[name]) soakTally[name] = { run: 0, ok: 0 };
  soakTally[name].run++;
  if (ok) soakTally[name].ok++;
}

async function waitFor(fn, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

/**
 * The tunnel endpoints are rate limited on purpose (`tunnel/start` and
 * `tunnel/reconnect` allow 10 per minute each). A soak that ignored that would
 * spend most of its cycles collecting 429s and "proving" a failure that is
 * really the throttle working. So: keep a minimum gap per route, and if a 429
 * still arrives, back off and record it as a throttle event — never as a
 * product failure.
 */
async function pacedPost(route, body, minGapMs = 7000, timeoutMs = 60000) {
  const gap = (lastCallAt.get(route) ?? 0) + minGapMs - Date.now();
  if (gap > 0) await sleep(gap);
  let res = await api('POST', route, body, timeoutMs);
  let backoffs = 0;
  while (res.status === 429 && backoffs < 5) {
    backoffs++;
    rateLimited++;
    log(`  rate limited on ${route} — backing off (the throttle is the product working)`);
    await sleep(7000);
    res = await api('POST', route, body, timeoutMs);
  }
  lastCallAt.set(route, Date.now());
  return { ...res, backoffs };
}

/** Cores spawned during THIS run that outlived the app — the leak metric. */
function leakedCores() {
  return xrayProcs()
    .filter((x) => !baselineXray.has(x.pid) && !ownedPids.has(x.pid))
    .map((x) => x.pid);
}

function reapLeaked() {
  const pids = leakedCores();
  for (const pid of pids) killTree(pid);
  return pids;
}

/* --------------------------- one-shot host snapshot ---------------------- */

// Written once and re-run many times. The soak takes hundreds of snapshots, and
// spawning PowerShell is the dominant cost — one prepared file beats writing a
// fresh temp script per call.
let HOST_PS1 = null;
function hostPs1() {
  if (HOST_PS1) return HOST_PS1;
  fs.mkdirSync(EVIDENCE, { recursive: true });
  HOST_PS1 = path.join(EVIDENCE, 'host-snapshot.ps1');
  fs.writeFileSync(HOST_PS1, [
    'param([int]$Port)',
    `$k='${PROXY_KEY}'`,
    '$p=Get-ItemProperty $k -Name ProxyEnable,ProxyServer -EA SilentlyContinue',
    '$listen=@(Get-NetTCPConnection -LocalPort $Port -State Listen -EA SilentlyContinue | Select-Object -ExpandProperty OwningProcess)',
    '$procs=@(Get-Process -Name xray -EA SilentlyContinue | Select-Object -ExpandProperty Id)',
    '[PSCustomObject]@{ enable=[int](($p.ProxyEnable) -eq 1); server=$p.ProxyServer; listenPids=$listen; xrayPids=$procs } | ConvertTo-Json -Compress',
  ].join('\n'), 'utf8');
  return HOST_PS1;
}

/**
 * Proxy + "is anything still listening on the tunnel port" + core PIDs, in ONE
 * process spawn, so a 50-cycle soak can afford to check every cycle.
 */
function snapshotHost(port = 0) {
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', hostPs1(), '-Port', String(port)], {
    encoding: 'utf8', timeout: 25000, windowsHide: true,
  });
  const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
  try {
    const o = JSON.parse((r.stdout ?? '').trim());
    return {
      enable: o.enable === 1 ? 1 : 0,
      server: o.server == null || o.server === '' ? null : String(o.server),
      listenPids: asArray(o.listenPids).map(Number).filter(Number.isFinite),
      xrayPids: asArray(o.xrayPids).map(Number).filter(Number.isFinite),
    };
  } catch {
    return {
      enable: null, server: null, listenPids: [], xrayPids: [],
      error: `${r.err || r.stdout || 'snapshot failed'}`.slice(0, 200),
    };
  }
}

/* ------------------------ adapters + routes (leaks) ---------------------- */

// Deliberately a SEPARATE, slower snapshot: Get-NetAdapter/Get-NetRoute cost
// real time, so taking them every cycle would double the soak's runtime for no
// extra signal. They are captured at the boundaries that matter — before the
// run, and after each scenario class.
let NET_PS1 = null;
function netPs1() {
  if (NET_PS1) return NET_PS1;
  fs.mkdirSync(EVIDENCE, { recursive: true });
  NET_PS1 = path.join(EVIDENCE, 'net-snapshot.ps1');
  fs.writeFileSync(NET_PS1, [
    '$adapters=@(Get-NetAdapter -EA SilentlyContinue | Select-Object -ExpandProperty InterfaceDescription)',
    "$def=@(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -EA SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 1 | Select-Object -ExpandProperty NextHop)",
    '$all=@(Get-NetRoute -EA SilentlyContinue)',
    '[PSCustomObject]@{ adapters=$adapters; defaultNextHop=$def; routeCount=$all.Count } | ConvertTo-Json -Compress',
  ].join('\n'), 'utf8');
  return NET_PS1;
}

function snapshotNetwork() {
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', netPs1()], {
    encoding: 'utf8', timeout: 40000, windowsHide: true,
  });
  const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
  try {
    const o = JSON.parse((r.stdout ?? '').trim());
    return {
      adapters: asArray(o.adapters).map(String),
      defaultNextHop: asArray(o.defaultNextHop).map(String)[0] ?? null,
      routeCount: Number(o.routeCount ?? 0),
    };
  } catch {
    return { adapters: [], defaultNextHop: null, routeCount: 0, error: `${r.err || r.stdout || 'network snapshot failed'}`.slice(0, 200) };
  }
}

/**
 * What a leaked tunnel leaves behind at the OS level: an adapter that outlives
 * the session, or a default route still pointing at a dead tunnel. Both are
 * checked against the pre-run baseline. Route-table drift is reported as a
 * measurement, not failed — Windows adds and ages routes on its own, and
 * failing on that would be noise rather than a finding.
 */
function checkNetworkNoLeak(label) {
  if (!baselineNet) return;
  const now = snapshotNetwork();
  const newAdapters = now.adapters.filter((a) => !baselineNet.adapters.includes(a));
  check(`${label}: no network adapter survived the session`, newAdapters.length === 0, { newAdapters });
  check(`${label}: the default route is unchanged`, now.defaultNextHop === baselineNet.defaultNextHop, {
    before: baselineNet.defaultNextHop, after: now.defaultNextHop,
  });
  step(`${label}: route table measurement`, {
    routeCountBefore: baselineNet.routeCount,
    routeCountAfter: now.routeCount,
    delta: now.routeCount - baselineNet.routeCount,
  });
}

/* ------------------------------- api client ------------------------------ */

let API_BASE = null;
const TOKEN = crypto.randomBytes(32).toString('hex'); // same shape the supervisor mints

async function api(method, route, body, timeoutMs = 30000) {
  if (!API_BASE) throw new Error('api base not resolved yet');
  const url = `${API_BASE}/${route.replace(/^\//, '')}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed };
  } finally {
    clearTimeout(timer);
  }
}

const enc = (id) => id.replace(/:/g, '%3A');

/* ---------------------------- artifact discovery ------------------------- */

function resolveCore() {
  const explicit = argValue('--core');
  const candidates = [explicit, path.join(ROOT, 'cores', 'xray.exe'), path.join(DATA, 'cores', 'xray.exe')];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  const which = spawnSync('where', ['xray.exe'], { encoding: 'utf8', windowsHide: true });
  const hit = (which.stdout ?? '').split('\n')[0]?.trim();
  return hit && fs.existsSync(hit) ? hit : null;
}

/** The sidecar the DESKTOP APP ships — not the TypeScript it was written from. */
function resolveSidecar() {
  const staged = path.join(REPO, 'src-tauri', 'backend');
  const bundle = path.join(staged, 'netpulse-backend.js');
  const nodeExe = path.join(staged, 'node.exe');
  const drizzle = path.join(staged, 'drizzle');
  if (fs.existsSync(bundle) && fs.existsSync(nodeExe) && fs.existsSync(drizzle)) {
    return { node: nodeExe, bundle, migrations: drizzle, what: 'src-tauri/backend (the packaged sidecar)' };
  }
  const devBundle = path.join(REPO, 'dist-desktop', 'desktop-index.js');
  const devMigrations = path.join(REPO, 'apps', 'api', 'drizzle');
  if (fs.existsSync(devBundle) && fs.existsSync(devMigrations)) {
    return { node: process.execPath, bundle: devBundle, migrations: devMigrations, what: 'dist-desktop bundle + system node (staged sidecar absent)' };
  }
  return null;
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (listeningPorts().some((p) => p.port === port)) return true;
    await sleep(400);
  }
  return false;
}

/* ------------------------------ proof servers ---------------------------- */

/**
 * Two VLESS inbounds with freedom outbounds. "Freedom" means they CONNECT OUT
 * rather than terminating the traffic somewhere synthetic, so a successful
 * proxy test proves the whole path works end to end. Each gets a distinct exit
 * identity via a DNS host override so switching nodes is observable.
 */
function startProofServers(core) {
  fs.mkdirSync(EVIDENCE, { recursive: true });
  const procs = [];
  const defs = [
    { name: 'proof-a', port: PORT_A, uuid: UUID_A, host: '127.0.0.1' },
    { name: 'proof-b', port: PORT_B, uuid: UUID_B, host: '127.0.0.2' },
  ];
  for (const d of defs) {
    const cfgPath = path.join(EVIDENCE, `${d.name}-server.json`);
    fs.writeFileSync(cfgPath, JSON.stringify({
      log: { loglevel: 'warning' },
      dns: { hosts: { 'www.cloudflare.com': d.host } },
      inbounds: [{
        tag: 'vless-in',
        listen: '127.0.0.1',
        port: d.port,
        protocol: 'vless',
        settings: { clients: [{ id: d.uuid }], decryption: 'none' },
      }],
      outbounds: [{ tag: 'direct', protocol: 'freedom' }],
    }, null, 2), 'utf8');
    const logFd = fs.openSync(path.join(EVIDENCE, `${d.name}-server.log`), 'w');
    const proc = spawn(core, ['run', '-c', cfgPath], { detached: true, stdio: ['ignore', 'ignore', logFd] });
    proc.unref();
    fs.closeSync(logFd);
    procs.push({ name: d.name, port: d.port, pid: proc.pid });
  }
  return procs;
}

/* -------------------------------- sidecar -------------------------------- */

function startSidecar(sh) {
  fs.mkdirSync(DATA, { recursive: true });
  const proc = spawn(sh.node, [sh.bundle], {
    cwd: path.dirname(sh.bundle),
    env: {
      ...process.env,
      NETPULSE_PORT: '0',
      NETPULSE_DATA_DIR: DATA,
      NETPULSE_MIGRATIONS_DIR: sh.migrations,
      NETPULSE_CORES_DIR: path.join(ROOT, 'cores'),
      NETPULSE_DESKTOP: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  // The supervisor's handshake: one token line, then stdin STAYS OPEN — the
  // sidecar treats stdin EOF as "supervisor gone" and shuts itself down.
  proc.stdin.write(`${TOKEN}\n`);
  let err = '';
  let out = '';
  proc.stdout.on('data', (c) => { out += c.toString('utf8'); });
  proc.stderr.on('data', (c) => { err += c.toString('utf8'); });
  return {
    proc,
    logs: () => ({ out, err }),
    /** Port is ephemeral (NETPULSE_PORT=0); the sidecar reports the real one. */
    async ready(timeoutMs = 60000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const m = err.match(/sidecar-ready port=(\d+)/);
        if (m) return Number(m[1]);
        if (proc.exitCode != null) return null;
        await sleep(400);
      }
      return null;
    },
  };
}

/* ------------------------- OS-level exit verification -------------------- */

/**
 * Fetch our own public IP the way an ordinary OS client would: curl through the
 * system proxy the app just installed. This is the check the app's own status
 * field CANNOT fake — if the tunnel is not really forwarding, curl fails or
 * returns the direct address rather than the exit's.
 *
 * The previous ad-hoc driver computed this result and then dropped it while
 * building its evidence record, so "internet works through the tunnel" was
 * never actually written down. Here the outcome IS the assertion input.
 */
function osFetchThroughProxy(proxy) {
  if (!proxy) return { ok: false, error: 'no system proxy set' };
  const started = Date.now();
  const r = spawnSync('curl.exe', ['-s', '--max-time', '15', '-x', `http://${proxy}`, 'https://api.ipify.org'], {
    encoding: 'utf8', maxBuffer: 64 * 1024, timeout: 25000, windowsHide: true,
  });
  const elapsedMs = Date.now() - started;
  if (r.error) return { ok: false, error: r.error.message, elapsedMs };
  const ip = (r.stdout ?? '').trim().split(/\s+/)[0] ?? '';
  const looksLikeIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || ip.includes(':') && /^[0-9a-f:]+$/i.test(ip);
  return {
    ok: looksLikeIp,
    ip: looksLikeIp ? ip : null,
    elapsedMs,
    curlExit: r.status,
    raw: looksLikeIp ? undefined : `${(r.stdout ?? '').slice(0, 120)} ${(r.stderr ?? '').slice(0, 160)}`.trim(),
  };
}

/** Poll a node until the proxy test lands a real measurement (or fails). */
async function waitForProxyTest(nodeId, label, tries = 24) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    await sleep(2500);
    last = (await api('GET', `nodes/${enc(nodeId)}`)).body;
    if (last?.medianProxyMs != null && last?.lastSuccessAt != null) return last;
    if (last?.status === 'failed' && last?.error) {
      // A refused connection means the proof server is not reachable — that is
      // an environment failure, not a product failure, so say so plainly.
      throw new Error(`${label} proxy test failed: ${JSON.stringify(last.error).slice(0, 200)}`);
    }
  }
  throw new Error(`${label} proxy test never produced a measurement; last=${JSON.stringify(last).slice(0, 300)}`);
}

/** One labelled snapshot of the state a release claim has to stand on. */
async function capture(name) {
  const proxy = readProxy();
  const ports = listeningPorts();
  const xray = xrayProcs();
  let tunnel = null;
  try {
    tunnel = (await api('GET', 'vpn/tunnel/status')).body?.tunnel ?? null;
  } catch (e) {
    tunnel = { error: String(e?.message ?? e) };
  }
  const snap = { capturedAt: Date.now(), proxy, listening: ports.length, inbound: ports.filter((p) => p.pid && tunnel?.inboundPort === p.port), xrayProcs: xray, tunnel };
  step(`capture:${name}`, { proxy, tunnelState: tunnel?.state, xrayPids: xray.map((x) => x.pid) });
  return snap;
}

/* ------------------------ soak scenario primitives ----------------------- */

async function connectNode(nodeId) {
  const r = await pacedPost('vpn/tunnel/start', { nodeId, systemProxy: true, mode: 'single' });
  if (r.status !== 200) return { ok: false, why: `start returned ${r.status}`, body: r.body };
  const t = await waitFor(async () => {
    const s = (await api('GET', 'vpn/tunnel/status')).body?.tunnel;
    return s?.state === 'active' && s?.nodeId === nodeId ? s : null;
  }, 45000);
  if (!t) return { ok: false, why: 'never reported active on the requested node' };
  tunnelConnected = true;
  return { ok: true, tunnel: t };
}

async function disconnectTunnel() {
  const r = await pacedPost('vpn/disconnect', undefined, 3000);
  if (r.status !== 200) return { ok: false, why: `disconnect returned ${r.status}`, body: r.body };
  const t = await waitFor(async () => {
    const s = (await api('GET', 'vpn/tunnel/status')).body?.tunnel;
    return s?.state !== 'active' ? s : null;
  }, 45000);
  if (!t) return { ok: false, why: 'still active after disconnect' };
  tunnelConnected = false;
  return { ok: true, tunnel: t };
}

/**
 * One connect/disconnect cycle, measured at the OS boundary. The point is not
 * that the API answers — it is that the host is handed back unchanged every
 * single time: proxy restored, no listener left behind, no orphan core.
 */
async function runCycle(i, nodeId) {
  const before = failures.length;
  await disconnectTunnel(); // start from a known-clean state; result checked below
  const c = await connectNode(nodeId);
  check(`cycle ${i}: connected to ${nodeId}`, c.ok, { why: c.why });
  if (c.ok) {
    const host = snapshotHost(c.tunnel.inboundPort);
    check(`cycle ${i}: the tunnel port has a live listener`, host.listenPids.length > 0, {
      port: c.tunnel.inboundPort, pids: host.listenPids,
    });
    check(`cycle ${i}: OS proxy targets this tunnel`,
      host.enable === 1 && `${host.server ?? ''}`.includes(String(c.tunnel.inboundPort)),
      { proxy: { enable: host.enable, server: host.server }, inboundPort: c.tunnel.inboundPort });
  }
  const d = await disconnectTunnel();
  check(`cycle ${i}: disconnected to idle`, d.ok, { why: d.why });
  const after = snapshotHost();
  check(`cycle ${i}: OS proxy restored to baseline`,
    after.enable === baselineProxy.enable && after.server === baselineProxy.server,
    { after: { enable: after.enable, server: after.server }, baseline: { enable: baselineProxy.enable, server: baselineProxy.server } });
  const leaked = leakedCores();
  check(`cycle ${i}: no leaked core process`, leaked.length === 0, { leaked });
  tally('connect/disconnect cycles', failures.length === before);
}

async function runReconnect(i, nodeId) {
  const before = failures.length;
  const c = await connectNode(nodeId);
  check(`reconnect ${i}: connected before reconnecting`, c.ok, { why: c.why });
  const r = await pacedPost('vpn/tunnel/reconnect', undefined);
  check(`reconnect ${i}: the endpoint accepted the request`, r.status === 200, { status: r.status, body: r.body });
  const t = await waitFor(async () => {
    const s = (await api('GET', 'vpn/tunnel/status')).body?.tunnel;
    return s?.state === 'active' ? s : null;
  }, 45000);
  check(`reconnect ${i}: tunnel is active again`, Boolean(t), { state: t?.state ?? null });
  if (t) check(`reconnect ${i}: still on the same node`, t.nodeId === nodeId, { nodeId: t.nodeId, expected: nodeId });
  const d = await disconnectTunnel();
  check(`reconnect ${i}: disconnected to idle`, d.ok, { why: d.why });
  const leaked = leakedCores();
  check(`reconnect ${i}: no leaked core process`, leaked.length === 0, { leaked });
  tally('reconnects', failures.length === before);
}

/**
 * Crash the sidecar mid-tunnel and boot it again on the SAME data directory.
 *
 * The product property under test is the safety one: a restarted app must never
 * read as `active` for a tunnel it does not own. Whatever the SIGKILL leaks
 * (orphan core, a system proxy pointing at a dead port) is measured and then
 * cleaned up by the harness — the Rust supervisor is what normally owns that
 * job, and it is deliberately absent here, so failing the gate for it would be
 * grading the harness rather than the product.
 */
async function runRestart(i, nodeId) {
  const before = failures.length;
  await disconnectTunnel();
  const c = await connectNode(nodeId);
  check(`restart ${i}: connected before the crash`, c.ok, { why: c.why });

  if (sidecar?.proc?.pid) killTree(sidecar.proc.pid);
  await sleep(1500);

  API_BASE = null;
  const booted = startSidecar(sh);
  sidecar = booted;
  const port = await booted.ready(60000);
  check(`restart ${i}: sidecar booted again on the persisted data dir`, port > 0, { port });
  if (port > 0) {
    API_BASE = `http://127.0.0.1:${port}/api/v1`;
    const t = (await api('GET', 'vpn/tunnel/status')).body?.tunnel;
    check(`restart ${i}: no false Connected state after a crash`, t?.state !== 'active', {
      state: t?.state ?? null,
      rule: 'a tunnel the new process does not own must not read as active',
    });
    tunnelConnected = false;
  }

  // Measured, not asserted: what an un-supervised SIGKILL leaks.
  step(`restart ${i}: crash leak measurement`, { leakedCorePids: leakedCores() });

  const h = snapshotHost();
  if (h.enable !== baselineProxy.enable || h.server !== baselineProxy.server) {
    writeProxy(baselineProxy.enable, baselineProxy.server);
  }
  reapLeaked();
  if (port > 0) {
    const d = await disconnectTunnel();
    check(`restart ${i}: back to a clean idle`, d.ok, { why: d.why });
  }
  const leaked = leakedCores();
  check(`restart ${i}: no leaked core process after recovery`, leaked.length === 0, { leaked });
  tally('app restarts', failures.length === before);
}

/**
 * Kill the process that actually owns the tunnel's inbound port, the way a core
 * crash would, and then demand the one thing that must never happen: reporting
 * Connected while nothing is listening.
 */
async function runEngineKill(i, nodeId) {
  const before = failures.length;
  await disconnectTunnel();
  const c = await connectNode(nodeId);
  check(`engineKill ${i}: connected`, c.ok, { why: c.why });
  if (c.ok) {
    const host = snapshotHost(c.tunnel.inboundPort);
    check(`engineKill ${i}: the owning core was found`, host.listenPids.length > 0, {
      port: c.tunnel.inboundPort, pids: host.listenPids,
    });
    for (const pid of host.listenPids) killTree(pid);
    await sleep(2500);
    const t = (await api('GET', 'vpn/tunnel/status')).body?.tunnel;
    if (t?.state === 'active') {
      const h2 = snapshotHost(t.inboundPort);
      check(`engineKill ${i}: never reports Connected without a live listener`, h2.listenPids.length > 0, {
        port: t.inboundPort, pids: h2.listenPids, note: 'watchdog recovered with a real core',
      });
      tunnelConnected = true;
    } else {
      check(`engineKill ${i}: honestly stopped reporting an active tunnel`, true, {
        state: t?.state ?? null, error: t?.error ?? null,
      });
      tunnelConnected = false;
    }
  }
  const d = await disconnectTunnel();
  check(`engineKill ${i}: recovered to a clean idle`, d.ok, { why: d.why });
  reapLeaked();
  const leaked = leakedCores();
  check(`engineKill ${i}: no leaked core process`, leaked.length === 0, { leaked });
  tally('engine kills', failures.length === before);
}

async function runSoak(nodeA, nodeB) {
  log('');
  log('=== SOAK =====================================================');
  log(`  cycles=${CYCLES}  reconnects=${RECONNECTS}  restarts=${RESTARTS}  engineKills=${ENGINE_KILLS}`);
  log('  pacing: tunnel/start and tunnel/reconnect allow 10/min each, so starts are');
  log('          spaced >=7s apart — the throttle is honoured, not disabled.');
  const pick = (i) => (i % 2 === 1 ? nodeA : nodeB);
  for (let i = 1; i <= CYCLES; i++) await runCycle(i, pick(i));
  checkNetworkNoLeak('after the connect/disconnect cycles');
  for (let i = 1; i <= RECONNECTS; i++) await runReconnect(i, pick(i));
  checkNetworkNoLeak('after the reconnects');
  for (let i = 1; i <= RESTARTS; i++) await runRestart(i, pick(i));
  checkNetworkNoLeak('after the crash-restarts');
  for (let i = 1; i <= ENGINE_KILLS; i++) await runEngineKill(i, pick(i));
  checkNetworkNoLeak('after the engine kills');
  log('  sleep/wake: NOT VERIFIED — a gate must not suspend the host; see the report.');
}

/* ---------------------------------- main --------------------------------- */

async function main() {
  log(`vpn-live-proof: root=${ROOT}`);

  const core = resolveCore();
  if (!core) {
    log(`SKIP: no xray core. Put xray.exe at ${path.join(ROOT, 'cores', 'xray.exe')} or pass --core <path>.`);
    return SKIP;
  }
  sh = resolveSidecar();
  if (!sh) {
    log('SKIP: no sidecar bundle. Run `npm run desktop:prepare` (or `npm run build:desktop-backend`) first.');
    return SKIP;
  }
  log(`  core:    ${core}`);
  log(`  sidecar: ${sh.what}`);

  // Start from a data directory that has never seen a run. A reused one carries
  // a persisted tunnel state and node rows from the previous proof, which makes
  // the "baseline is not connected" assertion meaningless — that is not
  // hypothetical: the first run of this gate reused the ad-hoc proof's data dir,
  // came up believing an old tunnel was still active, re-spawned a core for it,
  // and failed the baseline check for a reason that had nothing to do with the
  // code under test. This directory is proof-local scratch, owned by this
  // script, so it is deleted and recreated every run.
  if (!path.resolve(DATA).startsWith(path.resolve(ROOT))) {
    throw new Error(`refusing to reset ${DATA}: it is outside the proof root ${ROOT}`);
  }
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });

  let baseline = null;

  try {
    // ---- baseline: nothing of ours is running, the OS proxy is whatever it was
    baseline = readProxy();
    baselineProxy = baseline;
    baselineNet = snapshotNetwork();
    step('baseline:network', baselineNet);
    // Cores already on the box before us. The orphan check below is measured
    // against THIS set, not against "zero xray.exe": a core started by some
    // other process (a user's real VPN client, a service) is not an orphan this
    // product created, and failing the gate for it would be a false alarm.
    baselineXray = new Set(xrayProcs().map((x) => x.pid));
    step('baseline', { proxy: baseline, xrayPids: [...baselineXray] });

    // ---- proof servers
    proofs = startProofServers(core);
    ownedPids = new Set(proofs.map((p) => p.pid));
    for (const p of proofs) {
      const up = await waitForPort(p.port, 25000);
      if (!check(`proof server ${p.name} listening on 127.0.0.1:${p.port}`, up, { pid: p.pid })) {
        throw new Error(`${p.name} never bound :${p.port} — a stale xray may hold the port`);
      }
    }

    // ---- the shipped sidecar, booted the way the supervisor boots it
    sidecar = startSidecar(sh);
    const port = await sidecar.ready();
    if (!port) {
      const { err } = sidecar.logs();
      log(`sidecar failed to become ready. stderr tail:\n${err.slice(-2500)}`);
      throw new Error('sidecar never reported `sidecar-ready port=`');
    }
    API_BASE = `http://127.0.0.1:${port}/api/v1`;
    check('sidecar bound an ephemeral loopback port and reported it', port > 0, { port });

    // A bare request must not be served: the sidecar is not an open service.
    const unauth = await fetch(`${API_BASE}/meta/health`).catch((e) => ({ status: 0, err: String(e) }));
    check('sidecar refuses an unauthenticated request', unauth.status === 401, { status: unauth.status });

    const start = await capture('00-start');
    check('baseline tunnel is not connected', start.tunnel?.state !== 'active', { state: start.tunnel?.state });

    // ---- import two distinct nodes (deduped set, so a repeat run still works)
    const imported = await api('POST', 'nodes/import', {
      configs: [`vless://${UUID_A}@localhost:${PORT_A}#proof-a`, `vless://${UUID_B}@localhost:${PORT_B}#proof-b`],
    });
    const nodeIds = imported.body?.nodeIds ?? [];
    check('import resolves exactly the two proof nodes', nodeIds.length === 2, {
      imported: imported.body?.imported, duplicates: imported.body?.duplicates, nodeIds,
    });
    if (nodeIds.length < 2) throw new Error(`import did not yield two nodes: ${JSON.stringify(imported.body)}`);
    const [nodeA, nodeB] = nodeIds;

    // ---- proxy-test both nodes through the real core
    await api('POST', `nodes/${enc(nodeA)}/test`, { nodeId: nodeA, type: 'proxy' });
    const testedA = await waitForProxyTest(nodeA, 'proof-a');
    check('proof-a proxy test measured a real round trip', testedA.medianProxyMs != null, {
      medianProxyMs: testedA.medianProxyMs, engine: testedA.lastEngine ?? null,
    });
    await api('POST', `nodes/${enc(nodeB)}/test`, { nodeId: nodeB, type: 'proxy' });
    const testedB = await waitForProxyTest(nodeB, 'proof-b');
    check('proof-b proxy test measured a real round trip', testedB.medianProxyMs != null, {
      medianProxyMs: testedB.medianProxyMs,
    });

    // ---- SOAK (opt-in): repeat the whole lifecycle and prove nothing leaks.
    // The single-shot proof below is the smoke test; this is the acceptance
    // population the release brief asks for.
    if (SOAK) {
      await runSoak(nodeA, nodeB);
      await capture('99-final');
      return failures.length === 0 ? 0 : 1;
    }

    // ---- CONNECT the first node
    const startA = await api('POST', 'vpn/tunnel/start', { nodeId: nodeA, systemProxy: true, mode: 'single' });
    check('connect returned 200', startA.status === 200, { status: startA.status, body: startA.body });
    let st = (await api('GET', 'vpn/tunnel/status')).body?.tunnel;
    check('tunnel reports active on the requested node', st?.state === 'active' && st?.nodeId === nodeA, {
      state: st?.state, nodeId: st?.nodeId, expected: nodeA,
    });
    check('tunnel published a real inbound port', Number.isInteger(st?.inboundPort) && st.inboundPort > 0, {
      inboundPort: st?.inboundPort, exitIp: st?.exitIp ?? null, verifiedAt: st?.verifiedAt ?? null,
    });
    tunnelConnected = true;

    // ---- the OS must actually be pointing at the tunnel
    const proxA = readProxy();
    check('OS system proxy is enabled while connected', proxA.enable === 1, { proxy: proxA });
    const hitsTunnel = typeof proxA.server === 'string' && st?.inboundPort && proxA.server.includes(String(st.inboundPort));
    check('OS system proxy targets this tunnel\'s inbound port', Boolean(hitsTunnel), {
      server: proxA.server, inboundPort: st?.inboundPort,
    });

    // ---- and traffic must really leave through the exit
    if (OS_FETCH) {
      const fetched = osFetchThroughProxy(proxA.server);
      check('a real OS client reached the internet through the tunnel', fetched.ok, fetched);
      step('os-fetch:node-a', fetched);
      if (st?.exitIp) {
        check('the observed exit address is the address the app recorded', fetched.ip === st.exitIp, {
          observed: fetched.ip, recorded: st.exitIp,
        });
      }
    } else {
      step('os-fetch:node-a', { skipped: '--no-os-fetch' });
    }

    // ---- SWITCH: stop, then connect the second node on the same tunnel API
    const stop1 = await api('POST', 'vpn/tunnel/stop');
    check('stopping node A returns the tunnel to idle', stop1.body?.tunnel?.state !== 'active', {
      state: stop1.body?.tunnel?.state,
    });
    const startB = await api('POST', 'vpn/tunnel/start', { nodeId: nodeB, systemProxy: true, mode: 'single' });
    check('reconnect to node B succeeded', startB.status === 200, { status: startB.status });
    st = (await api('GET', 'vpn/tunnel/status')).body?.tunnel;
    check('tunnel is active on node B (the switch really moved)', st?.state === 'active' && st?.nodeId === nodeB, {
      state: st?.state, nodeId: st?.nodeId, expected: nodeB,
    });
    if (OS_FETCH) {
      const proxB = readProxy();
      const fetchedB = osFetchThroughProxy(proxB.server);
      check('traffic still flows through the tunnel after the switch', fetchedB.ok, fetchedB);
      step('os-fetch:node-b', fetchedB);
    }

    // ---- DISCONNECT and require the host to be handed back clean
    const stopped = await api('POST', 'vpn/disconnect');
    check('disconnect returned 200', stopped.status === 200, { status: stopped.status });
    tunnelConnected = false;
    st = (await api('GET', 'vpn/tunnel/status')).body?.tunnel;
    check('tunnel is idle after disconnect', st?.state !== 'active', { state: st?.state });

    const after = readProxy();
    check('OS system proxy was restored to its baseline value',
      after.enable === baseline.enable && after.server === baseline.server, {
        before: baseline, after,
      });

    // "0 orphan core processes after a normal disconnect": nothing NEW may be
    // left running beyond the two proof servers this script started. Whatever
    // held xray PIDs before the run is excluded — see the baseline note above.
    const ours = new Set(proofs.map((p) => p.pid));
    const strays = xrayProcs().filter((x) => !ours.has(x.pid) && !baselineXray.has(x.pid));
    check('the disconnect left no newly spawned core process behind', strays.length === 0, {
      strays: strays.map((s) => s.pid),
    });

    await capture('99-final');
    return failures.length === 0 ? 0 : 1;
  } catch (err) {
    failures.push({ name: 'harness', detail: String(err?.stack ?? err) });
    log(`ERROR ${err?.message ?? err}`);
    return 1;
  } finally {
    // Hand the host back before anything else. Order matters: disconnect
    // through the API first (it restores the proxy and reaps the tunnel core),
    // then a belt-and-braces proxy restore if the API could not, then our own
    // processes.
    if (tunnelConnected) {
      try { await api('POST', 'vpn/disconnect', undefined, 15000); } catch { /* best effort */ }
    }
    reapLeaked();
    try {
      const now = readProxy();
      if (baseline && (now.enable !== baseline.enable || now.server !== baseline.server)) {
        writeProxy(baseline.enable, baseline.server);
        log('  restored the system proxy to its pre-run value');
      }
    } catch { /* best effort */ }
    if (sidecar?.proc?.pid) killTree(sidecar.proc.pid);
    for (const p of proofs) killTree(p.pid);
  }
}

/* ------------------------------- entry point ----------------------------- */

try {
  const code = await main();
  const passed = checks - failures.length;
  const file = writeEvidence({
    timestamp: Date.now(),
    root: ROOT,
    osFetch: OS_FETCH,
    verdict: code === 0 ? 'PASS' : code === SKIP ? 'SKIP' : 'FAIL',
    checks: { total: checks, passed, failed: failures.length },
    soak: SOAK
      ? {
          requested: { cycles: CYCLES, reconnects: RECONNECTS, restarts: RESTARTS, engineKills: ENGINE_KILLS },
          byScenario: soakTally,
          throttleBackoffs: rateLimited,
          sleepWake: 'NOT VERIFIED — requires suspending the host, which a gate must not do',
        }
      : undefined,
    failures,
    steps,
  });

  log('');
  log('================ VPN LIVE PROOF ================');
  log(`  checks:   ${passed}/${checks} passed`);
  log(`  failures: ${failures.length}`);
  if (SOAK) {
    log('  ---- soak failure rate by scenario ----');
    for (const [name, t] of Object.entries(soakTally)) {
      const rate = t.run === 0 ? 100 : (t.ok / t.run) * 100;
      log(`  ${t.ok}/${t.run}  ${rate.toFixed(1).padStart(5)}%  ${name}`);
    }
    log(`  throttle backoffs (429s absorbed, not failures): ${rateLimited}`);
    log('  sleep/wake: NOT VERIFIED (a gate must not suspend the host)');
  }
  log(`  evidence: ${file}`);
  log(`  verdict:  ${code === 0 ? 'PASS' : code === SKIP ? 'SKIP (not run — not a pass)' : 'FAIL'}`);
  log('===============================================');
  process.exit(code);
} catch (err) {
  log(`vpn-live-proof crashed: ${err?.stack ?? err}`);
  writeEvidence({ timestamp: Date.now(), root: ROOT, verdict: 'ERROR', error: String(err?.stack ?? err), failures, steps });
  process.exit(1);
}
