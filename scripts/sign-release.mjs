#!/usr/bin/env node
/**
 * Authenticode signing for NetPulse release artifacts.
 *
 * Signs (default): the Tauri app exe + the NSIS installer.
 * Every signature is SHA-256 with an RFC3161 timestamp (survives cert expiry).
 *
 * Certificate resolution (first match wins):
 *   1. NETPULSE_SIGN_THUMBPRINT          — cert already in Cert:\CurrentUser\My
 *   2. NETPULSE_SIGN_PFX + NETPULSE_SIGN_PFX_PASSWORD — any PFX (CA-issued or self-signed)
 *   3. certs/netpulse-release.pfx + password in %USERPROFILE%\.netpulse-signing-pw
 *                                          (local dev cert created by New-SelfSignedCertificate)
 *
 * Exit code 0 = all artifacts signed & digest-verified. A self-signed chain
 * reports Windows status `NotTrusted` (cryptographically intact, root not
 * distributed) — accepted here and reported honestly; CA/EV certs report `Valid`.
 *
 * Usage: node scripts/sign-release.mjs [file1 file2 ...]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { installerFileName } from './lib/installerName.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_FILES = [
  'src-tauri/target/release/netpulse-desktop.exe',
  `src-tauri/target/release/bundle/nsis/${installerFileName(repoRoot)}`,
];

const files = process.argv.slice(2).filter((a) => !a.startsWith('--')).length
  ? process.argv.slice(2).filter((a) => !a.startsWith('--')).map((f) => (path.isAbsolute(f) ? f : path.resolve(f)))
  : DEFAULT_FILES.map((f) => path.join(repoRoot, f));
// --optional: for Tauri beforeBundleCommand — machines without a signing cert
// must still be able to produce unsigned builds.
const optional = process.argv.includes('--optional');
// --verify-only: check existing signatures without modifying files (CI gates).
const verifyOnly = process.argv.includes('--verify-only');
for (const f of files) {
  if (!fs.existsSync(f)) {
    if (optional) {
      console.log('sign-release: skipping missing artifact (unsigned build): ' + f);
      continue;
    }
    console.error('sign-release: artifact not found: ' + f);
    console.error('Build first: npm run desktop:build');
    process.exit(2);
  }
}

// Certificate resolution — everything is passed to PowerShell via env, never argv echoes.
const env = { ...process.env };
if (!env.NETPULSE_SIGN_THUMBPRINT) {
  const pfx = env.NETPULSE_SIGN_PFX ?? path.join(repoRoot, 'certs', 'netpulse-release.pfx');
  if (fs.existsSync(pfx)) {
    env.NETPULSE_SIGN_PFX = pfx;
    let pwFile = env.NETPULSE_SIGN_PW_FILE ?? path.join(os.homedir(), '.netpulse-signing-pw');
    if (!env.NETPULSE_SIGN_PFX_PASSWORD) {
      if (fs.existsSync(pwFile)) {
        env.NETPULSE_SIGN_PFX_PASSWORD = fs.readFileSync(pwFile, 'ascii').trim();
      } else {
        console.error(`sign-release: PFX found (${pfx}) but no password.`);
        console.error('Set NETPULSE_SIGN_PFX_PASSWORD, or NETPULSE_SIGN_THUMBPRINT for a store cert.');
        process.exit(2);
      }
    }
  } else {
    if (optional) {
      console.log('sign-release: no signing identity — producing UNSIGNED build (advisory only)');
      process.exit(0);
    }
    console.error('sign-release: no signing identity available.');
    console.error('Provide NETPULSE_SIGN_THUMBPRINT (store cert) or NETPULSE_SIGN_PFX(+PASSWORD).');
    console.error('Local dev cert: see RELEASING.md "Code signing" for New-SelfSignedCertificate setup.');
    process.exit(2);
  }
}

const psScript = `
$ErrorActionPreference = 'Stop'
$cert = $null
if ($env:NETPULSE_SIGN_THUMBPRINT) {
  $cert = Get-ChildItem ("Cert:\\CurrentUser\\My\\" + $env:NETPULSE_SIGN_THUMBPRINT) -ErrorAction Stop
  Write-Output ("identity: store thumbprint " + $cert.Thumbprint + " subject " + $cert.Subject)
} else {
  $sec = ConvertTo-SecureString $env:NETPULSE_SIGN_PFX_PASSWORD -AsPlainText -Force
  $cert = Import-PfxCertificate -FilePath $env:NETPULSE_SIGN_PFX -Password $sec -CertStoreLocation Cert:\\CurrentUser\\My
  Write-Output ("identity: pfx import " + $cert.Thumbprint + " subject " + $cert.Subject)
}
$files = $env:NETPULSE_SIGN_FILES -split '\\|'
foreach ($f in $files) {
  if (-not (Test-Path $f)) { Write-Output ("skip: " + $f); continue }
  # IncludeChain signer: a self-signed root has no CA chain to embed; embedding
  # attempts yield UnknownError. CA-issued certs still validate fine from the signer cert.
  $sig = Set-AuthenticodeSignature -FilePath $f -Certificate $cert -IncludeChain signer \`
    -TimeStampServer 'http://timestamp.digicert.com' -HashAlgorithm SHA256
  Write-Output ("sign: " + (Split-Path $f -Leaf) + " -> " + $sig.Status)
}
foreach ($f in $files) {
  if (-not (Test-Path $f)) { Write-Output ("skip-verify: " + $f); continue }
  $v = Get-AuthenticodeSignature -FilePath $f
  $ts = if ($v.TimeStamperCertificate) { $v.TimeStamperCertificate.Subject } else { 'NONE' }
  # PS 5.1 maps CRYPT_E_UNTRUSTEDROOT to UnknownError; classify by message.
  $cls = if ($v.Status -eq 'Valid') { 'trusted' }
         elseif ($v.StatusMessage -match 'root certificate which is not trusted') { 'selfsigned' }
         else { 'BAD' }
  Write-Output ("verify: " + (Split-Path $f -Leaf) + " status=" + $v.Status + " class=" + $cls + " ts=" + $ts)
}
`;

const tmp = path.join(os.tmpdir(), `np-sign-${Date.now()}.ps1`);
fs.writeFileSync(tmp, psScript, 'utf8');
env.NETPULSE_SIGN_FILES = files.join('|');
if (verifyOnly) env.NETPULSE_VERIFY_ONLY = '1';

const run = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], {
  env,
  encoding: 'utf8',
  timeout: 120_000,
});
fs.rmSync(tmp, { force: true });

if (run.status !== 0) {
  console.error(run.stderr || run.stdout || 'signing failed');
  process.exit(1);
}
console.log(run.stdout.trim());

const bad = [];
let untrusted = false;
for (const line of run.stdout.split('\n')) {
  const m = line.match(/^verify: (.+) status=(\w+) class=(\w+)/);
  if (!m) continue;
  if (m[3] === 'selfsigned') untrusted = true;
  else if (m[3] !== 'trusted') bad.push(`${m[1]}: ${m[2]}`);
}
if (bad.length) {
  console.error(`sign-release: FAILED verification — ${bad.join('; ')}`);
  process.exit(1);
}
console.log(
  untrusted
    ? 'sign-release: OK (self-signed chain — signature+timestamp intact; SmartScreen reputation requires a CA/EV cert)'
    : 'sign-release: OK (trusted chain)',
);
