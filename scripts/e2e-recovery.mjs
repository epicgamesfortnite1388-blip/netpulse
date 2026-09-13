#!/usr/bin/env node
/**
 * Crash recovery + restart persistence test.
 *
 * Phase 1: boot sidecar, record settings change + seed a stale "connected" VPN row.
 * Phase 2: SIGKILL the process (simulated crash).
 * Phase 3: restart; assert the stale VPN row is reset to interrupted, the
 *          recovery event is recorded, and the settings change survived.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backendDir = path.join(root, 'src-tauri', 'backend');
const dataDir = fs.mkdtempSync(path.join(root, '.tmp-recovery-'));
const token = crypto.randomBytes(32).toString('hex');
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};

function boot() {
  const child = spawn(process.execPath, [path.join(backendDir, 'netpulse-backend.js')], {
    env: {
      ...process.env,
      NETPULSE_PORT: '0',
      NETPULSE_DATA_DIR: dataDir,
      NETPULSE_MIGRATIONS_DIR: path.join(backendDir, 'drizzle'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.write(`${token}\n`);
  return new Promise((resolve) => {
    let buf = '';
    child.stderr.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/sidecar-ready port=(\d+)/);
      if (m) resolve({ child, port: Number(m[1]) });
    });
    setTimeout(() => resolve({ child, port: null }), 20000);
  });
}

async function api(port, method, p, body) {
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

// ---------- phase 1: create state ----------
const first = await boot();
if (!first.port) {
  check('first boot', false);
  process.exit(1);
}
const { child: c1, port: p1 } = first;
check('first boot', true, `port=${p1}`);

// persist a marker setting (theme is a simple observable field)
const setRes = await api(p1, 'PUT', '/settings', { general: { theme: 'light', language: 'en', units: 'metric', notifications: false } });
check('settings patch accepted', setRes.status === 200, `status=${setRes.status}`);

// Seed a stale "connected" VPN row directly into SQLite — simulates a crash
// while a tunnel was supposedly active (the app never got to mark it down).
const Database = require(path.join(backendDir, 'node_modules', 'better-sqlite3'));
{
  const db = new Database(path.join(dataDir, 'netpulse.db'));
  db.prepare(
    `INSERT INTO vpn_connections (id, provider_id, protocol, status, connected_at)
     VALUES ('crash-test-row', 'wireguard', 'wireguard', 'connected', ?)`,
  ).run(Date.now());
  db.close();
  check('stale VPN row seeded', true);
}

// ---------- phase 2: crash ----------
c1.kill('SIGKILL');
await new Promise((res) => c1.on('exit', res));
check('SIGKILL delivered', true);

// ---------- phase 3: restart and verify ----------
const second = await boot();
if (!second.port) {
  check('restart boot', false);
  process.exit(1);
}
const { child: c2, port: p2 } = second;
check('restart boot after crash', true, `port=${p2}`);

// database intact — history/events readable
const events = await api(p2, 'GET', '/events?limit=50');
check('db readable after crash', events.status === 200, `status=${events.status}`);
const msgs = (events.json?.events ?? []).map((e) => String(e.message ?? ''));
const staleReset = msgs.some((m) => m.includes('stale tunnel record'));
const unclean = msgs.some((m) => m.toLowerCase().includes('unclean shutdown'));
check('stale VPN row reset to interrupted', staleReset, staleReset ? 'event found' : `events: ${msgs.slice(0, 3).join(' | ')}`);
check('crash recovery event recorded', unclean, unclean ? 'found' : 'missing');

// the stale row must now be marked error/interrupted, not connected
{
  const db = new Database(path.join(dataDir, 'netpulse.db'));
  const row = db.prepare("SELECT status FROM vpn_connections WHERE id = 'crash-test-row'").get();
  db.close();
  check('seeded row status repaired', row?.status === 'error', `status=${row?.status}`);
}

// settings survived
const settings = await api(p2, 'GET', '/settings');
const theme = settings.json?.settings?.general?.theme;
check('settings persisted across restart', theme === 'light', `theme=${JSON.stringify(theme)}`);

await stop(c2);
fs.rmSync(dataDir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
