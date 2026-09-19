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
 * Env: same identity resolution as sign-release.mjs — see scripts/lib/signingIdentity.mjs
 * (thumbprint, Azure Trusted Signing, or PFX). TAURI_NSIS_DIR for the NSIS bin
 * dir, TAURI_TARGET_DIR for target/release.
 * Set NETPULSE_REQUIRE_TRUSTED_SIGNATURE=1 for a RELEASE: a chain Windows does
 * not trust still leaves SmartScreen warning, so the build fails instead.
 * Usage: node scripts/package-signed.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installerFileName } from './lib/installerName.mjs';
import { resolveSigningIdentity, SigningIdentityError, NO_IDENTITY_HINTS } from './lib/signingIdentity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targetDir = process.env.TAURI_TARGET_DIR ?? path.join(root, 'src-tauri', 'target', 'release');
const nsisBin = process.env.TAURI_NSIS_DIR ?? path.join(process.env.LOCALAPPDATA ?? '', 'tauri', 'NSIS', 'Bin');
const appExe = path.join(targetDir, 'netpulse-desktop.exe');
const nsisDir = path.join(targetDir, 'nsis', 'x64');
const nsi = path.join(nsisDir, 'installer.nsi');
const outInstaller = path.join(targetDir, 'bundle', 'nsis', installerFileName(root));

const step = (m) => console.log(`\n== ${m} ==`);
const die = (m) => { console.error(m); process.exit(1); };

for (const f of [appExe, nsi]) if (!fs.existsSync(f)) die(`package-signed: missing ${f}`);
if (process.platform !== 'win32') die('package-signed: Windows only');

// Resolve the signing identity ONCE (one owner: lib/signingIdentity.mjs) so both
// child signers — sign-release for the exe/installer, and sign-uninstall via
// NSIS `uninstfinalize` — see exactly the same resolved values. The Azure route
// is handed to makensis' environment too, because the uninstaller is generated
// during compilation and must be signed by the same profile.
let resolved;
try {
  resolved = resolveSigningIdentity({ env: process.env, repoRoot: root, log: (m) => console.log(m) });
} catch (err) {
  if (!(err instanceof SigningIdentityError)) throw err;
  die(`package-signed: ${err.message}\n${err.hints.join('\n')}`);
}
const childEnv = resolved.env;
if (!resolved.route) die(`package-signed: refusing to build a partially signed installer.\n${NO_IDENTITY_HINTS.join('\n')}`);
const trustedRequired = childEnv.NETPULSE_REQUIRE_TRUSTED_SIGNATURE === '1';
if (trustedRequired) console.log('package-signed: a TRUSTED (CA-issued) signature is required for this build');
// The signer owns classification and the SmartScreen verdict; this pipeline just
// asks it to enforce trust when the build is a release.
const signerFlags = trustedRequired ? ['--require-trusted'] : [];

step('sign app exe (post-bundle-patch)');
let r = spawnSync('node', [path.join(root, 'scripts', 'sign-release.mjs'), ...signerFlags, appExe], { encoding: 'utf8', stdio: 'inherit', env: childEnv });
if (r.status !== 0) die('package-signed: exe signing failed');

step('rebuild NSIS installer from generated script (embeds signed exe)');
// UNINSTALLERSIGNCOMMAND makes the Tauri NSIS template's `!uninstfinalize`
// sign the uninstaller as part of compilation — without it the installed
// uninstall.exe ships unsigned (it is generated during install, so a
// post-build pass cannot reach it). Tauri emits the define EMPTY in the
// generated script (a /D override would collide with "already defined"),
// so patch the define in place; the .nsi is regenerated on every build,
// making this idempotent per build.
const signHelper = path.join(root, 'scripts', 'sign-uninstall.ps1');
// NSIS contract (verified empirically against NSIS 3.11): `!uninstfinalize`
// does NOT append the uninstaller path — the command must carry a %1
// placeholder that NSIS substitutes with the generated uninstaller's temp
// path. In the .nsi define, quotes escape as $\" and % as $%. The command
// runs via cmd /c so the quoted path survives PowerShell's -File parsing.
const helperFwd = signHelper.replace(/\\/g, '/');
const uninstallerSignCmd =
  `cmd /c powershell.exe -NoProfile -ExecutionPolicy Bypass -File ${helperFwd} $\"%1$\"`;
const nsiSrc = fs.readFileSync(nsi, 'utf8');
// Match whatever value the define currently carries (empty from Tauri, or a
// previous run's injection) — the patch is idempotent per generated script.
const defineRe = /^!define UNINSTALLERSIGNCOMMAND ".*"$/m;
if (!defineRe.test(nsiSrc)) die('package-signed: unexpected installer.nsi (no UNINSTALLERSIGNCOMMAND define)');
// makensis !define value: embed quotes as $\" (NSIS string escape). Do NOT
// escape % — `$%` leaks a literal `$` before NSIS's %1 substitution (verified:
// PowerShell then sees drive `$C`), while bare %1 is what uninstfinalize
// replaces with the generated uninstaller's path.
const patchedCmd = uninstallerSignCmd.replace(/"/g, '$\\"');
fs.writeFileSync(nsi, nsiSrc.replace(defineRe, `!define UNINSTALLERSIGNCOMMAND "${patchedCmd}"`), 'utf8');
console.log('uninstaller signing: enabled (uninstfinalize via sign-uninstall.ps1)');
r = spawnSync(path.join(nsisBin, 'makensis.exe'), [nsi], { encoding: 'utf8', timeout: 300_000, env: childEnv });
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
r = spawnSync('node', [path.join(root, 'scripts', 'sign-release.mjs'), ...signerFlags, outInstaller], { encoding: 'utf8', stdio: 'inherit', env: childEnv });
if (r.status !== 0) die('package-signed: installer signing failed');

step('done');
console.log(`signed exe:       ${appExe}`);
console.log(`signed installer: ${outInstaller}`);
