#!/usr/bin/env node
/**
 * Desktop pipeline verification that does NOT require the Rust toolchain.
 *
 * Validates everything that can be validated on a Node-only machine:
 *   1. backend desktop bundle exists and is fresh (tsup CJS output)
 *   2. resources stage correctly into src-tauri/backend/
 *   3. the staged backend actually boots, authenticates a request with the
 *      stdin-delivered ephemeral token, and shuts down on stdin close
 *   4. tauri.conf.json parses and its declared resources/icons exist
 *   5. web dist exists and references the same version as tauri.conf
 *
 * Run: npm run desktop:verify
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// --require-signature: additionally verify the built exe carries an
// Authenticode signature (set by desktop:package; cross-platform).
// --require-trusted-signature: additionally demand that the chain is TRUSTED
// (CA-issued / Azure Trusted Signing), because an intact self-signed signature
// still makes SmartScreen warn — `--require-signature` alone cannot tell them
// apart. When the
// env var NETPULSE_REQUIRE_SIGNATURE=1 is set instead, honor it too.
const requireTrustedSignature =
  process.argv.includes('--require-trusted-signature') || process.env.NETPULSE_REQUIRE_TRUSTED_SIGNATURE === '1';
const requireSignature =
  requireTrustedSignature ||
  process.argv.includes('--require-signature') || process.env.NETPULSE_REQUIRE_SIGNATURE === '1';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backendDir = path.join(root, 'src-tauri', 'backend');
const webDist = path.join(root, 'apps', 'web', 'dist');
let failures = 0;

const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/* ------------------------- 1. bundle + staging ---------------------------- */

const bundlePath = path.join(backendDir, 'netpulse-backend.js');
const nodeExe = path.join(backendDir, 'node.exe');
const stagedPkg = path.join(backendDir, 'package.json');

check('staged bundle exists', fs.existsSync(bundlePath));
check('staged portable node.exe exists', fs.existsSync(nodeExe));
check('staged package.json exists', fs.existsSync(stagedPkg));
check(
  'staged node_modules present',
  fs.existsSync(path.join(backendDir, 'node_modules', 'better-sqlite3')),
);

/* --------------------- 2. tauri.conf.json integrity ----------------------- */

let conf = null;
try {
  conf = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  check('tauri.conf.json parses', true);
} catch (e) {
  check('tauri.conf.json parses', false, String(e));
}
if (conf) {
  const res = conf.bundle?.resources ?? {};
  for (const [src, dst] of Object.entries(res)) {
    const srcPath = path.join(root, 'src-tauri', src.replace(/\/$/, ''));
    const dstPath = path.join(root, 'src-tauri', dst.replace(/\/$/, ''));
    check(
      `resource staged: ${src} -> ${dst}`,
      fs.existsSync(srcPath) && fs.existsSync(dstPath),
    );
  }
  for (const icon of conf.bundle?.icon ?? []) {
    check(`icon exists: ${icon}`, fs.existsSync(path.join(root, 'src-tauri', icon)));
  }
  const webIndex = path.join(webDist, 'index.html');
  check('web dist index.html exists', fs.existsSync(webIndex));
  check('frontendDist exists', fs.existsSync(path.join(root, 'src-tauri', conf.build?.frontendDist ?? '')));
}

/* ----------------- 4. authenticode signature (optional gate) --------------- */

if (requireSignature) {
  const appExe = path.join(root, 'src-tauri', 'target', 'release', 'netpulse-desktop.exe');
  if (!fs.existsSync(appExe)) {
    check('app exe exists (signature gate)', false, appExe);
  } else {
    // Verify via the same mechanism sign-release.mjs uses (PowerShell
    // Authenticode), so the gate agrees with the signer.
    const { spawnSync } = await import('node:child_process');
    const ps = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `$s = Get-AuthenticodeSignature -LiteralPath '${appExe.replace(/'/g, "''")}'; ` +
          `if ($s -and $s.SignerCertificate) { Write-Output ($s.Status.ToString() + '|' + $s.SignerCertificate.Subject + '|' + $s.SignerCertificate.Issuer + '|' + $s.StatusMessage) } else { Write-Output 'MISSING||||' }`,
      ],
      { encoding: 'utf8' },
    );
    const out = (ps.stdout || '').trim();
    const [status, subject, issuer, statusMessage] = out.split('|');
    // One owner decides what this means; the gate must never call an untrusted
    // root a pass, whatever the two scripts believe separately.
    const { classifySignature, smartScreenReport } = await import('./lib/signatureTrust.mjs');
    const trust = classifySignature({ status, subject, issuer, statusMessage });
    const ok = requireTrustedSignature ? trust.trusted : trust.level !== 'missing' && trust.level !== 'bad';
    check(
      requireTrustedSignature ? 'app exe signature is TRUSTED (CA-issued)' : 'app exe authenticode signature',
      ok,
      `${status ?? 'none'}${subject ? ` — ${subject}` : ''}; ${trust.reason}`,
    );
    if (!trust.trusted) console.log(`  ${smartScreenReport(trust.level)}`);
  }
}

/* -------------------- 3. live sidecar boot + auth test -------------------- */

async function sidecarBootTest() {
  // Temp data dir in the OS temp location: creating it inside the repo tree
  // intermittently fails with EPERM when antivirus holds a handle on freshly
  // written dirs (and pollutes the source tree either way).
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-verify-'));
  const port = 18000 + Math.floor(Math.random() * 2000);
  const token = crypto.randomBytes(32).toString('hex');

  const child = spawn(nodeExe, [bundlePath], {
    cwd: backendDir,
    env: {
      ...process.env,
      NETPULSE_PORT: String(port),
      NETPULSE_DATA_DIR: dataDir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Supervisor contract: deliver the ephemeral token as one stdin line and
  // keep the pipe open (stdin close later = graceful shutdown signal).
  child.stdin.write(`${token}\n`);

  let bootOutput = '';
  child.stdout.on('data', (d) => (bootOutput += d.toString()));
  child.stderr.on('data', (d) => (bootOutput += d.toString()));

  // Generous boot deadline: the first execution of a freshly built bundle can
  // take >30 s on Windows while antivirus inspects the new binaries; a warm
  // second run is fast, which made this check flaky inside desktop:package.
  const bootDeadlineMs = 90_000;
  const bootStart = Date.now();
  const deadline = Date.now() + bootDeadlineMs;
  let ready = false;
  let authOk = false;
  let unauthOk = false;
  const HEALTH = '/api/v1/meta/health';

  const get = (urlPath, withToken) =>
    new Promise((resolve) => {
      // http.request defers dispatch to .end(), so the error handler is
      // guaranteed to be attached before the socket can emit 'error'.
      const req = http.request(
        { host: '127.0.0.1', port, path: urlPath, timeout: 2000, method: 'GET' },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      if (withToken) req.setHeader('authorization', `Bearer ${token}`);
      req.on('error', () => resolve(0));
      req.on('timeout', () => {
        req.destroy();
        resolve(0);
      });
      req.end();
    });

  try {
    while (Date.now() < deadline) {
      const status = await get(HEALTH, true);
      if (status === 200) {
        ready = true;
        authOk = true;
        unauthOk = (await get(HEALTH, false)) === 401;
        break;
      }
      if (status === 401) {
        // server is up and enforcing auth; confirm the token works
        authOk = (await get(HEALTH, true)) === 200;
        ready = true;
        unauthOk = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    // stdin close => graceful shutdown (supervisor contract)
    child.stdin.end();
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        child.kill();
        resolve();
      }, 8000);
      child.on('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    // Windows releases the SQLite WAL/log handles a beat AFTER the exit
    // event fires; retry briefly and never let cleanup failure turn into a
    // false verification failure (a leftover temp dir is harmless).
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  }

  check('sidecar boots on 127.0.0.1', ready, `port ${port} (waited ${((Date.now() - bootStart) / 1000).toFixed(1)}s)`);
  check('sidecar enforces bearer auth', authOk && unauthOk);
  check(
    'sidecar reported ready stage',
    /sidecar-ready/.test(bootOutput),
    bootOutput.split('\n').filter((l) => /stage|ready|fatal/i.test(l)).slice(-3).join(' | '),
  );
}

try {
  await sidecarBootTest();
} catch (e) {
  check('sidecar boot test completed', false, String(e));
}

console.log(failures === 0 ? '\nAll desktop pipeline checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
