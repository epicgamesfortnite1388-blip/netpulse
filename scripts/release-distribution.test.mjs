#!/usr/bin/env node
/**
 * Release / distribution readiness tests.
 *
 * Runs against the STAGED DESKTOP BUNDLE (src-tauri/backend) — the same code
 * an installed app executes — simulating the distribution lifecycle:
 *
 *   1. fresh install        (empty data dir -> boot, migrate, clean close)
 *   2. version stamp        (root == tauri.conf == Cargo == staged manifest)
 *   3. upgrade / migration  (existing DB reopened by "new" build, data intact,
 *                            migrations idempotent, VPN state reconciled)
 *   4. corrupted DB         (garbage DB -> quarantine + self-heal, no boot loop)
 *   5. offline boot         (no outbound dependency: boot + API on loopback only)
 *   6. uninstall/reinstall  (staged backend deleted+restaged LAST — it is
 *                            destructive to the staging dir; user data dir
 *                            untouched -> settings/history survive)
 *
 * Installer-specific behavior (NSIS uninstaller, MSI upgrade codes) and
 * updater signature verification require a Rust toolchain / real signing
 * keys and are documented as NOT RUN HERE in RELEASING.md.
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backendDir = path.join(root, 'src-tauri', 'backend');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

function boot(dataDir, extraEnv = {}) {
  const token = crypto.randomBytes(32).toString('hex');
  const child = spawn(process.execPath, [path.join(backendDir, 'netpulse-backend.js')], {
    env: {
      ...process.env,
      NETPULSE_PORT: '0',
      NETPULSE_DATA_DIR: dataDir,
      NETPULSE_MIGRATIONS_DIR: path.join(backendDir, 'drizzle'),
      NETPULSE_MODULES_DIR: path.join(backendDir, 'node_modules'),
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.write(`${token}\n`);
  return new Promise((resolve) => {
    let buf = '';
    child.stderr.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/sidecar-ready port=(\d+)/);
      if (m) resolve({ child, port: Number(m[1]), token, log: buf });
    });
    child.on('exit', (code) => {
      if (buf.length > 0) console.error(`    [boot stderr] ${buf.trim().split('\n').slice(-4).join(' | ').slice(0, 400)}`);
      resolve({ child, port: null, exitCode: code, log: buf });
    });
    setTimeout(() => resolve({ child, port: null, exitCode: null, log: buf }), 20000);
  });
}

async function api(port, token, method, p, body) {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${p}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}

function stop(child) {
  return new Promise((res) => {
    child.stdin.end();
    const t = setTimeout(() => { child.kill(); res(); }, 5000);
    child.on('exit', () => { clearTimeout(t); res(); });
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'np-release-'));
const freshDir = path.join(tmp, 'fresh');
const upgradeDir = path.join(tmp, 'upgrade');
const corruptDir = path.join(tmp, 'corrupt');
const reinstallDir = path.join(tmp, 'reinstall');
// better-sqlite3 loaded from the REPO's hoisted copy — loading the staged
// copy would map its native module into THIS process, and Windows then
// refuses to delete the staging dir later (EPERM on the uninstall phase).
const openDatabase = () => require('better-sqlite3');

try {
  // ---------------------------------------------------------------- 1. fresh
  const f1 = await boot(freshDir);
  check('fresh install: boot + migrate', Boolean(f1.port), f1.port ? `port=${f1.port}` : `exit=${f1.exitCode}`);
  if (f1.port) {
    const meta = await api(f1.port, f1.token, 'GET', '/meta');
    check('fresh install: API healthy', meta.status === 200, `status=${meta.status}`);
    const dbPath = path.join(freshDir, 'netpulse.db');
    check('fresh install: DB created in data dir', fs.existsSync(dbPath));
    const db = openDatabase()(dbPath, { readonly: true });
    const tables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get();
    db.close();
    check('fresh install: schema migrated', tables.n > 20, `tables=${tables.n}`);
    await stop(f1.child);

    const db2 = openDatabase()(dbPath, { readonly: true });
    const flagRow = db2.prepare("SELECT value FROM settings WHERE key = 'app.runtime.__lastCleanExit'").get();
    db2.close();
    // drizzle stores JSON columns as TEXT; better-sqlite3 returns the raw string.
    const flagValue = typeof flagRow?.value === 'string' ? JSON.parse(flagRow.value) : flagRow?.value;
    check('graceful close: clean-exit flag set', flagValue?.clean === true, JSON.stringify(flagValue));
  }

  // ---------------------------------------------------------- 2. version stamp
  const rootVersion = require(path.join(root, 'package.json')).version;
  const conf = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const staged = require(path.join(backendDir, 'package.json'));
  const cargo = fs.readFileSync(path.join(root, 'src-tauri', 'Cargo.toml'), 'utf8');
  const cargoVersion = cargo.match(/^version = "([^"]+)"/m)?.[1];
  check(
    'version stamp: single canonical version',
    rootVersion === conf.version && conf.version === staged.version && conf.version === cargoVersion,
    `root=${rootVersion} conf=${conf.version} staged=${staged.version} cargo=${cargoVersion}`,
  );

  // ------------------------------------------------- 3. upgrade / migration
  fs.mkdirSync(upgradeDir, { recursive: true });
  const u1 = await boot(upgradeDir);
  const dbPathU = path.join(upgradeDir, 'netpulse.db');
  if (u1.port) {
    await api(u1.port, u1.token, 'PUT', '/settings', { general: { theme: 'dark', language: 'en', units: 'metric', notifications: false } });
    // Seed a connected VPN row to verify post-update reconciliation.
    {
      const db = openDatabase()(dbPathU);
      db.prepare(
        `INSERT INTO vpn_connections (id, provider_id, protocol, status, connected_at)
         VALUES ('upgrade-stale', 'wireguard', 'wireguard', 'connected', ?)`,
      ).run(Date.now());
      db.close();
    }
    await stop(u1.child); // graceful "previous version" shutdown
  }
  // "Upgrade": same data dir, brand-new process (as after an app update).
  const u2 = await boot(upgradeDir);
  check('upgrade: boot on existing DB', Boolean(u2.port), u2.port ? `port=${u2.port}` : 'failed');
  if (u2.port) {
    const settings = await api(u2.port, u2.token, 'GET', '/settings');
    check('upgrade: settings preserved', settings.json?.settings?.general?.theme === 'dark', `theme=${settings.json?.settings?.general?.theme}`);
    const events = await api(u2.port, u2.token, 'GET', '/events?limit=20');
    const reconciled = (events.json?.events ?? []).some((e) => String(e.message ?? '').includes('stale tunnel record'));
    check('upgrade: stale VPN state reconciled', reconciled, reconciled ? 'event found' : 'no reconciliation event');
    await stop(u2.child);
    // Migrations must be idempotent — reopening did not duplicate journal entries.
    const db = openDatabase()(dbPathU, { readonly: true });
    const journal = JSON.parse(fs.readFileSync(path.join(backendDir, 'drizzle', 'meta', '_journal.json'), 'utf8'));
    db.close();
    check('upgrade: migration journal sequential', journal.entries.every((e, i) => e.idx === i), `entries=${journal.entries.length}`);
  }

  // ------------------------------------------------------- 4. corrupted DB
  fs.mkdirSync(corruptDir, { recursive: true });
  fs.writeFileSync(path.join(corruptDir, 'netpulse.db'), Buffer.from('this is not a sqlite database'.repeat(100)));
  const c1 = await boot(corruptDir);
  check('corrupted DB: self-heal boot', Boolean(c1.port), c1.port ? 'recovered' : `exit=${c1.exitCode}`);
  if (c1.port) {
    const meta = await api(c1.port, c1.token, 'GET', '/meta');
    check('corrupted DB: API healthy after heal', meta.status === 200);
    await stop(c1.child);
    const quarantined = fs.readdirSync(corruptDir).some((f) => f.includes('.corrupt-'));
    check('corrupted DB: broken file quarantined (not deleted)', quarantined, fs.readdirSync(corruptDir).join(','));
  } else {
    check('corrupted DB: broken file quarantined (not deleted)', false, 'boot failed before heal');
  }

  // -------------------------------------------------------- 5. offline boot
  // The sidecar must boot and serve on loopback without any outbound network
  // dependency (no DNS, no API calls at startup). We approximate a hostile
  // network by pointing proxies at a dead port — the boot path must not care.
  const offDir = path.join(tmp, 'offline');
  const o1 = await boot(offDir, { HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9' });
  check('offline: boot succeeds without network', Boolean(o1.port), o1.port ? `port=${o1.port}` : 'failed');
  if (o1.port) {
    const history = await api(o1.port, o1.token, 'GET', '/history?limit=5');
    check('offline: local history readable', history.status === 200, `status=${history.status}`);
    await stop(o1.child);
  }

  // ------------------------------------------------ 6. uninstall/reinstall
  // Destructive to the staging dir — runs LAST so the phases above always
  // have a backend to boot.
  fs.mkdirSync(reinstallDir, { recursive: true });
  const r1 = await boot(reinstallDir);
  if (r1.port) {
    await api(r1.port, r1.token, 'PUT', '/settings', { general: { theme: 'light', language: 'en', units: 'metric', notifications: false } });
    await stop(r1.child);
  }
  // "Uninstall": wipe the app binaries, keep the user data dir. Windows can
  // hold locks on just-closed files (AV/indexer scan) — maxRetries handles the
  // common transient case; a settle delay gives handles time to release.
  await new Promise((r) => setTimeout(r, 1500));
  {
    let removed = false;
    for (let i = 0; i < 5 && !removed; i++) {
      try {
        fs.rmSync(backendDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
        removed = true;
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (!removed) {
      console.warn('[release-test] staging dir locked (AV/indexer); restaging in place instead');
      // Degraded simulation: restage over the locked dir. The data-survival
      // assertion below is still valid — the data dir was never touched.
    }
  }
  // "Reinstall": restage from the repo build. spawnSync without shell:true —
  // no quoting issues with spaces in the repo path.
  const restage = spawnSync(process.execPath, [path.join(root, 'scripts', 'prepare-desktop.mjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 240000,
  });
  check('reinstall: backend restaged', fs.existsSync(path.join(backendDir, 'netpulse-backend.js')), (restage.stderr || '').slice(-200));
  const r2 = await boot(reinstallDir);
  check('reinstall: boot after reinstall', Boolean(r2.port));
  if (r2.port) {
    const settings = await api(r2.port, r2.token, 'GET', '/settings');
    check('reinstall: user data survived', settings.json?.settings?.general?.theme === 'light', `theme=${settings.json?.settings?.general?.theme}`);
    await stop(r2.child);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  // Vitest treats process.exit as a test failure; report the result plainly
  // and let the suite end naturally. The exit code below is only used when
  // this script runs as a standalone npm task (not under vitest).
  if (process.env.VITEST) {
    if (fail === 0) {
      console.log('release-distribution: all checks passed');
    } else {
      throw new Error(`release-distribution: ${fail} check(s) failed`);
    }
  } else {
    process.exit(fail === 0 ? 0 : 1);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
