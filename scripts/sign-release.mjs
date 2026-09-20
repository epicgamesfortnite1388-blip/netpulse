#!/usr/bin/env node
/**
 * Authenticode signing for NetPulse release artifacts.
 *
 * Signs (default): the Tauri app exe + the NSIS installer.
 * Every signature is SHA-256 with an RFC3161 timestamp (survives cert expiry).
 *
 * Certificate resolution (first match wins):
 *   1. NETPULSE_SIGN_THUMBPRINT          — cert already in Cert:\CurrentUser\My
 *   2. Azure Trusted Signing             — NETPULSE_SIGN_AZURE_DLIB (+
 *                                          NETPULSE_SIGN_AZURE_METADATA, or the
 *                                          endpoint/account/profile/certificate
 *                                          env vars to generate it). This is the
 *                                          route that needs no hardware token:
 *                                          since June 2023 a purchased OV/EV key
 *                                          must live in FIPS 140-2 L2 hardware.
 *   3. NETPULSE_SIGN_PFX + NETPULSE_SIGN_PFX_PASSWORD — any PFX (CA-issued or self-signed)
 *   4. certs/netpulse-release.pfx + password in %USERPROFILE%\.netpulse-signing-pw
 *                                          (local dev cert created by New-SelfSignedCertificate)
 *
 * Exit code 0 = all artifacts signed & digest-verified. Whether Windows will
 * TRUST the result is classified by ./lib/signatureTrust.mjs (the same owner the
 * release gate uses): a self-signed chain is cryptographically intact but still
 * makes SmartScreen warn, and this script says so instead of implying otherwise.
 *
 * Usage: node scripts/sign-release.mjs [--optional] [--verify-only] [--require-trusted] [file1 file2 ...]
 *
 *   --optional         no cert configured is not an error (dev/unsigned builds)
 *   --verify-only      report, never modify
 *   --require-trusted  a chain Windows does not trust is a FAILURE (release gate)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { installerFileName } from './lib/installerName.mjs';
import { resolveSigningIdentity, azureSignArgs, SigningIdentityError, NO_IDENTITY_HINTS } from './lib/signingIdentity.mjs';
import { classifySignature, smartScreenReport } from './lib/signatureTrust.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_FILES = [
  'src-tauri/target/release/netpulse-desktop.exe',
  `src-tauri/target/release/bundle/nsis/${installerFileName(repoRoot)}`,
];

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
let files = positional.length ? positional.map((f) => (path.isAbsolute(f) ? f : path.resolve(f))) : DEFAULT_FILES.map((f) => path.join(repoRoot, f));
// --optional: for Tauri beforeBundleCommand — machines without a signing cert
// must still be able to produce unsigned builds.
const optional = process.argv.includes('--optional');
// --verify-only: check existing signatures without modifying files (CI gates).
const verifyOnly = process.argv.includes('--verify-only');
// --require-trusted: a signature whose chain Windows does not trust (self-signed,
// unknown root) still leaves SmartScreen warning, so a RELEASE must fail here.
// Set by the packaging pipeline via NETPULSE_REQUIRE_TRUSTED_SIGNATURE=1.
const requireTrusted = process.argv.includes('--require-trusted') || process.env.NETPULSE_REQUIRE_TRUSTED_SIGNATURE === '1';

const missing = files.filter((f) => !fs.existsSync(f));
if (missing.length && !optional) {
  console.error('sign-release: artifact not found: ' + missing[0]);
  console.error('Build first: npm run desktop:build');
  process.exit(2);
}
// Under --optional, absent artifacts are simply not part of this run — they must
// not be carried into verification, which would report them as unsigned.
for (const f of missing) console.log('sign-release: skipping missing artifact (unsigned build): ' + f);
files = files.filter((f) => fs.existsSync(f));

/* --------------------------- identity resolution -------------------------- */

let route;
let env;
try {
  ({ route, env } = resolveSigningIdentity({ env: process.env, repoRoot, log: (m) => console.log(m) }));
} catch (err) {
  // A route that IS configured but unusable always fails, even under --optional:
  // a broken signing profile must never quietly produce an unsigned build.
  if (!(err instanceof SigningIdentityError)) throw err;
  console.error(`sign-release: ${err.message}`);
  for (const hint of err.hints) console.error(hint);
  process.exit(err.code);
}

if (!route) {
  if (optional) {
    console.log('sign-release: no signing identity — producing UNSIGNED build (advisory only)');
    console.log(`  ${smartScreenReport('missing')}`);
    process.exit(0);
  }
  console.error('sign-release: no signing identity available.');
  for (const hint of NO_IDENTITY_HINTS) console.error(hint);
  process.exit(2);
}

if (verifyOnly) {
  console.log('sign-release: --verify-only — verifying without modifying artifacts');
}

/* --------------------------------- signing -------------------------------- */

if (!verifyOnly) {
  if (route === 'azure-trusted-signing') {
    for (const f of files) {
      if (!fs.existsSync(f)) continue;
      const sign = spawnSync(env.NETPULSE_SIGNTOOL, azureSignArgs(f, env), { encoding: 'utf8', timeout: 300_000 });
      const out = `${sign.stdout ?? ''}${sign.stderr ?? ''}`.trim();
      console.log(`sign: ${path.basename(f)} -> ${sign.status === 0 ? 'submitted' : `FAILED (${sign.status})`}`);
      if (out) console.log(out.split('\n').slice(-6).join('\n'));
      if (sign.status !== 0) process.exit(1);
    }
  } else {
    // Store/PFX identities sign with the certificate; the private key never
    // leaves the store or the password-protected PFX.
    const psScript = `
$ErrorActionPreference = 'Stop'
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
  #
  # Timestamping is a third-party network call, and it fails transiently: a
  # release build was observed dying with "no timestamp" while the identical
  # call succeeded seconds later. Try the servers in order, then the pair once
  # more, and name the server that answered. A signature without a timestamp is
  # still not shippable, so every attempt failing stays a hard failure.
  $servers = @('http://timestamp.digicert.com', 'http://timestamp.sectigo.com')
  $sig = $null
  $used = $null
  foreach ($pass in 1, 2) {
    foreach ($server in $servers) {
      $sig = Set-AuthenticodeSignature -FilePath $f -Certificate $cert -IncludeChain signer \`
        -TimeStampServer $server -HashAlgorithm SHA256
      $stamped = Get-AuthenticodeSignature $f
      if ($stamped.TimeStamperCertificate) { $used = $server; break }
    }
    if ($used) { break }
  }
  $stampNote = 'NONE (every timestamp server failed)'
  if ($used) { $stampNote = $used }
  Write-Output ("sign: " + (Split-Path $f -Leaf) + " -> " + $sig.Status + " (timestamp: " + $stampNote + ")")
}
`;
    const tmp = path.join(os.tmpdir(), `np-sign-${Date.now()}.ps1`);
    fs.writeFileSync(tmp, psScript, 'utf8');
    env.NETPULSE_SIGN_FILES = files.join('|');
    const run = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], { env, encoding: 'utf8', timeout: 120_000 });
    fs.rmSync(tmp, { force: true });
    if (run.status !== 0) {
      console.error(run.stderr || run.stdout || 'signing failed');
      process.exit(1);
    }
    console.log(run.stdout.trim());
  }
}

/* -------------------------------- verifying ------------------------------- */
// The reader is deliberately dumb (raw fields only): classification has ONE
// owner, so the signer, the gate and the report can never disagree.
const verifyScript = `
$ErrorActionPreference = 'Stop'
$files = $env:NETPULSE_SIGN_FILES -split '\\|'
foreach ($f in $files) {
  if (-not (Test-Path $f)) { Write-Output ("verify-raw: " + $f + "|MISSING||||"); continue }
  $v = Get-AuthenticodeSignature -FilePath $f
  $subj = if ($v.SignerCertificate) { $v.SignerCertificate.Subject } else { '' }
  $iss = if ($v.SignerCertificate) { $v.SignerCertificate.Issuer } else { '' }
  $msg = if ($v.StatusMessage) { $v.StatusMessage } else { '' }
  $ts = if ($v.TimeStamperCertificate) { $v.TimeStamperCertificate.Subject } else { 'NONE' }
  Write-Output ("verify-raw: " + $f + "|" + $v.Status + "|" + $subj + "|" + $iss + "|" + $msg + "|" + $ts)
}
`;
const verifyTmp = path.join(os.tmpdir(), `np-verify-${Date.now()}.ps1`);
fs.writeFileSync(verifyTmp, verifyScript, 'utf8');
env.NETPULSE_SIGN_FILES = files.join('|');
const verified = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', verifyTmp], { env, encoding: 'utf8', timeout: 120_000 });
fs.rmSync(verifyTmp, { force: true });
if (verified.status !== 0) {
  console.error(verified.stderr || verified.stdout || 'verification failed');
  process.exit(1);
}

const failures = [];
let worst = 'trusted';
for (const line of `${verified.stdout ?? ''}`.split('\n')) {
  const raw = /^verify-raw: (.+?)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|(.*)$/.exec(line.trim());
  if (!raw) continue;
  const [, file, status, subject, issuer, statusMessage, ts] = raw;
  const trust = classifySignature({ status, subject, issuer, statusMessage });
  console.log(`verify: ${path.basename(file)} status=${status} class=${trust.level} ts=${ts === 'NONE' ? 'NONE' : 'ok'}`);
  if (trust.level === 'bad' || trust.level === 'missing') failures.push(`${path.basename(file)}: ${trust.reason}`);
  else if (!trust.trusted) worst = worst === 'trusted' ? trust.level : worst;
  if (ts === 'NONE') failures.push(`${path.basename(file)}: no timestamp — the signature dies with the certificate`);
}

if (failures.length) {
  console.error(`sign-release: FAILED verification — ${failures.join('; ')}`);
  process.exit(1);
}
if (requireTrusted && worst !== 'trusted') {
  console.error(`sign-release: FAILED (--require-trusted / NETPULSE_REQUIRE_TRUSTED_SIGNATURE=1) — ${smartScreenReport(worst)}`);
  console.error('A release build cannot ship warning SmartScreen on every machine. See RELEASING.md "Code signing".');
  process.exit(1);
}

console.log(smartScreenReport(worst));
console.log(
  worst === 'trusted'
    ? 'sign-release: OK (trusted chain)'
    : `sign-release: OK (${worst}: signature and timestamp intact, publisher chain NOT trusted by Windows)`,
);
