#!/usr/bin/env node
/**
 * Signed packaging pass — run AFTER `tauri build` (which patches the exe with
 * bundle type info after beforeBundleCommand, invalidating a pre-bundle
 * signature). This script:
 *
 *   1. signs the bundle-patched app exe
 *   2. rebuilds the NSIS installer from the generated installer.nsi so it
 *      embeds the SIGNED exe
 *   3. signs the installer itself
 *
 * Result: the installed exe keeps its signature end-to-end.
 *
 * Env: same identity resolution as sign-release.mjs (thumbprint or PFX),
 * TAURI_NSIS_DIR for the NSIS bin dir, TAURI_TARGET_DIR for target/release.
 * Usage: node scripts/package-signed.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetDir = process.env.TAURI_TARGET_DIR ?? path.join(root, 'src-tauri', 'target', 'release');
const nsisBin = process.env.TAURI_NSIS_DIR ?? path.join(process.env.LOCALAPPDATA ?? '', 'tauri', 'NSIS', 'Bin');
const appExe = path.join(targetDir, 'netpulse-desktop.exe');
const nsisDir = path.join(targetDir, 'nsis', 'x64');
const nsi = path.join(nsisDir, 'installer.nsi');
const outInstaller = path.join(targetDir, 'bundle', 'nsis', 'NetPulse_0.2.0_x64-setup.exe');

const step = (m) => console.log(`\n== ${m} ==`);
const die = (m) => { console.error(m); process.exit(1); };

for (const f of [appExe, nsi]) if (!fs.existsSync(f)) die(`package-signed: missing ${f}`);
if (process.platform !== 'win32') die('package-signed: Windows only');

step('sign app exe (post-bundle-patch)');
let r = spawnSync('node', [path.join(root, 'scripts', 'sign-release.mjs'), appExe], { encoding: 'utf8', stdio: 'inherit' });
if (r.status !== 0) die('package-signed: exe signing failed');

step('rebuild NSIS installer from generated script (embeds signed exe)');
r = spawnSync(path.join(nsisBin, 'makensis.exe'), [nsi], { encoding: 'utf8', timeout: 300_000 });
if (r.status !== 0) die(`package-signed: makensis failed\n${(r.stderr || r.stdout || '').slice(-800)}`);
const tail = (r.stdout || '').trim().split('\n').filter(Boolean).slice(-2).join(' | ');
console.log(`makensis: ${tail}`);
// makensis writes OutFile (nsis-output.exe) next to the .nsi — promote it to
// the canonical bundle path (the signed exe is INSIDE this fresh installer).
const rawInstaller = path.join(nsisDir, 'nsis-output.exe');
if (!fs.existsSync(rawInstaller)) die(`package-signed: makensis output missing: ${rawInstaller}`);
fs.mkdirSync(path.dirname(outInstaller), { recursive: true });
fs.copyFileSync(rawInstaller, outInstaller);
console.log(`promoted: ${rawInstaller} -> ${outInstaller}`);
if (!fs.existsSync(outInstaller)) die(`package-signed: installer not produced at ${outInstaller}`);

step('sign installer');
r = spawnSync('node', [path.join(root, 'scripts', 'sign-release.mjs'), outInstaller], { encoding: 'utf8', stdio: 'inherit' });
if (r.status !== 0) die('package-signed: installer signing failed');

step('done');
console.log(`signed exe:       ${appExe}`);
console.log(`signed installer: ${outInstaller}`);
