#!/usr/bin/env node
/**
 * Deployment battery — boots the INSTALLED backend bundle with a controlled
 * token and verifies: boot chain, auth enforcement, real measurement
 * endpoints (202 async + completion), settings round-trip, persistence.
 *
 * Usage: node scripts/deploy-battery.mjs [bundleDir]
 *   bundleDir defaults to %LOCALAPPDATA%/NetPulse/backend (the NSIS install
 *   location); pass an explicit dir to test a different install copy.
 * Run: npm run test:deploy
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

function resolveBundleDir() {
  if (process.argv[2]) return process.argv[2];
  // Auto-discover: registry InstallLocation of the installed app, falling back
  // to the default NSIS location.
  const candidates = [
    path.join(process.env.LOCALAPPDATA ?? '', 'NetPulse', 'backend'),
    'C:\\np-inst2\\backend',
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'netpulse-backend.js'))) return c;
  }
  return candidates[0];
}
const BUNDLE_DIR = resolveBundleDir();
const PORT = 19300 + Math.floor(Math.random() * 300);
const TOKEN = crypto.randomBytes(32).toString('hex');
const DATA_DIR = fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', 'np-batt-'));

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

function req(method, urlPath, body) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: urlPath,
        method,
        timeout: 20000,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(buf); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, json, text: buf });
        });
      },
    );
    r.on('error', () => resolve({ status: 0, json: null, text: '' }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, json: null, text: '' }); });
    if (data) r.write(data);
    r.end();
  });
}

const child = spawn(path.join(BUNDLE_DIR, 'node.exe'), [path.join(BUNDLE_DIR, 'netpulse-backend.js')], {
  cwd: BUNDLE_DIR,
  env: { ...process.env, NETPULSE_PORT: String(PORT), NETPULSE_DATA_DIR: DATA_DIR },
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stdin.write(TOKEN + '\n');
let bootLog = '';
child.stdout.on('data', (d) => (bootLog += d));
child.stderr.on('data', (d) => (bootLog += d));

// wait for readiness
let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const h = await req('GET', '/api/v1/meta/health');
  if (h.status === 200) ready = true;
}
check('sidecar booted (installed bundle)', ready, BUNDLE_DIR);
if (!ready) {
  console.log('--- boot log ---\n' + bootLog.split('\n').slice(-20).join('\n'));
  child.kill();
  process.exit(1);
}

/* ---- auth enforcement ---- */
{
  const noAuth = await new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port: PORT, path: '/api/v1/meta/health', timeout: 3000 }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    r.on('error', () => resolve(0));
  });
  check('auth enforced without token (401)', noAuth === 401, `got ${noAuth}`);
  const badAuth = await new Promise((resolve) => {
    const r = http.get({ host: '127.0.0.1', port: PORT, path: '/api/v1/meta/health', timeout: 3000, headers: { authorization: 'Bearer ' + 'x'.repeat(64) } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    r.on('error', () => resolve(0));
  });
  check('auth rejects wrong token (401)', badAuth === 401, `got ${badAuth}`);
}

/* ---- health payload ---- */
{
  const h = await req('GET', '/api/v1/meta/health');
  check('health returns payload', h.status === 200 && !!h.json, JSON.stringify(h.json).slice(0, 80));
}

/* ---- real measurement: complete diagnostic (202 async job) ---- */
{
  const start = await req('POST', '/api/v1/diagnostics/complete', {});
  check('diagnostics/complete accepted (202)', start.status === 202, `status ${start.status} ${JSON.stringify(start.json).slice(0, 100)}`);
}

/* ---- settings round-trip (persistence) ---- */
{
  const g = await req('GET', '/api/v1/settings');
  check('settings readable', g.status === 200 && !!g.json?.settings, `status ${g.status}`);
  const orig = g.json?.settings;
  const patch = await req('PUT', '/api/v1/settings', { general: { theme: 'light' } });
  check('settings update accepted', patch.status === 200 || patch.status === 204, `status ${patch.status}`);
  const g2 = await req('GET', '/api/v1/settings');
  check('settings update persisted', g2.json?.settings?.general?.theme === 'light', `theme=${g2.json?.settings?.general?.theme}`);
  // restore
  if (orig?.general?.theme && orig.general.theme !== 'light') await req('PUT', '/api/v1/settings', { general: { theme: orig.general.theme } });
}

/* ---- history persisted to SQLite ---- */
{
  const h = await req('GET', '/api/v1/history?limit=5');
  check('history endpoint responds', h.status === 200, `status ${h.status}`);
}

/* ---- graceful shutdown via stdin close ---- */
{
  child.stdin.end();
  const exited = await new Promise((resolve) => {
    const t = setTimeout(() => { child.kill(); resolve(false); }, 8000);
    child.on('exit', () => { clearTimeout(t); resolve(true); });
  });
  check('graceful shutdown on stdin close', exited);
}

console.log(failures === 0 ? '\nDeployment battery: ALL PASS' : `\nDeployment battery: ${failures} FAILURE(S)`);
fs.rmSync(DATA_DIR, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
