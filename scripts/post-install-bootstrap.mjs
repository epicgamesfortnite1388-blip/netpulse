#!/usr/bin/env node
/**
 * Post-install bootstrap (invoked by NSIS `Exec` after WriteUninstaller).
 *
 * Job: make the VERY FIRST launch as fast, durable and self-diagnosing as possible.
 *
 * What it does (idempotent, no-op when already healthy):
 *   1. Ensures the WebView2 bootstrapper package was staged next to the exe by
 *      the installer bundle phase. The app's `embedBootstrapper` mode ships that
 *      package; this is a belt-and-suspenders present check.
 *   2. Ensures the sidecar backend bundle is present next to the exe (the runtime
 *      the Tauri-managed node uses).
 *   3. Creates the user data directory so the app's first boot does not need to
 *      create it under time pressure.
 *   4. Touches a one-time first-launch probe file the app reads and clears on
 *      startup; this is what lets the app *say* what failed on first launch rather
 *      than failing silently.
 *
 * This is deliberately NOT an installer substitute: the NSIS installer already
 * places binaries, creates shortcuts, writes the uninstaller, and registers the
 * app in the user registry. This script is the last mile so the very first
 * double-click leaves nothing to chance.
 *
 * Env (mostly NSIS-expanded at install time):
 *   NP_DATA_DIR         -> <LocalAppData>/NetPulse
 *   NP_BUNDLE_DIR       -> directory containing the running exe / installer
 *   NP_CERT_STATUS      -> 'unsigned' | 'signed'  (so the app can tailor messages)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root   = path.resolve(__dirname, '..');
const dataDir = process.env.NP_DATA_DIR ?? path.join(process.env.LOCALAPPDATA ?? '', 'NetPulse');
const bundleDir = process.env.NP_BUNDLE_DIR ?? path.dirname(process.execPath);
const certStatus = (process.env.NP_CERT_STATUS ?? 'unknown').toLowerCase();

const log = (m) => {
  // NSIS shows stdout; we also drop a small marker that the app can read.
  try { fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true }); } catch {}
  fs.appendFileSync(path.join(dataDir, 'logs', 'post-install-bootstrap.log'), `[bootstrap] ${m}\n`);
  process.stdout.write(`[bootstrap] ${m}\n`);
};
const die = (m) => { log(`FATAL: ${m}`); process.exit(2); };

log(`starting — bundleDir=${bundleDir} dataDir=${dataDir}`);

// ---- 1. WebView2 bootstrapper presence (info only; the app handles the real check) ----
const dll = path.join(bundleDir, 'WebView2Loader.dll');
if (!fs.existsSync(dll)) {
  log(`warn: WebView2Loader.dll absent from bundle dir (app will diagnose at launch and, if needed, invoke the bootstrapper)`);
  // Do NOT fabricate one. Do NOT block. The app owns the real recovery path.
} else {
  log(`WebView2Loader.dll present (${fs.statSync(dll).size}B)`);
}

// ---- 2. Sidecar backend bundle presence (same) ----
const backendDir = path.join(bundleDir, 'backend');
if (!fs.existsSync(backendDir)) {
  log(`warn: backend bundle dir missing (${backendDir}); app will use its packaged runtime`);
} else {
  log(`backend bundle present (${fs.readdirSync(backendDir).length} entries)`);
}

// ---- 3. Data dir ----
try { fs.mkdirSync(dataDir, { recursive: true }); } catch (e) {
  die(`cannot create data dir ${dataDir}: ${e.message}`);
}
log(`data dir ready (${dataDir})`);

// ---- 4. First-launch probe file ----
// The app reads bootstrap-status.json on first boot, drives a first-launch screen,
// and clears it once the app has successfully started.
const bootstrapFile = path.join(dataDir, 'bootstrap-status.json');
const fresh = { ts: Date.now(), pending: true, certStatus };
try { fs.writeFileSync(bootstrapFile, JSON.stringify(fresh, null, 2), 'utf8'); log('wrote bootstrap-status.json (first-launch probe)'); }
catch (e) { die(`cannot write bootstrap-status.json: ${e.message}`); }

log('bootstrap complete — ready for first launch');
