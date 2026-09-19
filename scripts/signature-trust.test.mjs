#!/usr/bin/env node
/**
 * Code-signing honesty tests.
 *
 * The rule these pin: **"signed" is not "trusted"**. A release whose signature
 * chain ends in a root Windows does not know is cryptographically intact and
 * still makes SmartScreen warn on every machine, so the signer, the release gate
 * and the report must all classify it the same way — and a build cannot claim to
 * be signed-and-safe when it is only signed.
 *
 * Also covered: identity resolution distinguishes NOTHING CONFIGURED (a machine
 * with no cert may still build unsigned) from CONFIGURED BUT UNUSABLE (a broken
 * Azure profile or a locked PFX must never read as "no identity — ship it
 * unsigned"), and the Azure metadata/argv the token-free route depends on.
 *
 * Runs everywhere: pure classification plus filesystem-shaped resolution, with
 * no certificate, no signtool and no network required.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { classifySignature, parseVerifyLine, smartScreenReport, TRUST_LEVELS } from './lib/signatureTrust.mjs';
import { azureSignArgs, resolveSigningIdentity, SigningIdentityError } from './lib/signingIdentity.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const signer = path.join(root, 'scripts', 'sign-release.mjs');

let checks = 0;
let failed = 0;

function check(name, ok, detail = '') {
  checks += 1;
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const eq = (name, actual, expected) => check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'np-signing-test-'));
const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
const emptyRoot = path.join(tmp, 'no-certs-here');
fs.mkdirSync(emptyRoot, { recursive: true });

/* ------------------------- what a signature means ------------------------- */

console.log('\n== signature trust classification ==');

const caSigned = {
  status: 'Valid',
  subject: 'CN=NetPulse Ltd, O=NetPulse Ltd, C=GB',
  issuer: 'CN=DigiCert Trusted G4 Code Signing RSA4096 SHA384 2021 CA1, O=DigiCert, C=US',
  statusMessage: 'Signature verified.',
};
eq('CA-signed chain is trusted', classifySignature(caSigned).level, 'trusted');
eq('CA-signed chain does not warn SmartScreen', classifySignature(caSigned).smartScreen, 'ok');
check('CA-signed reason names the issuer', classifySignature(caSigned).reason.includes('DigiCert'));

// Windows PowerShell 5.1 reports CRYPT_E_UNTRUSTEDROOT as UnknownError; the
// signer-is-its-own-issuer shape is what actually identifies it.
const selfSigned = {
  status: 'UnknownError',
  subject: 'CN=NetPulse Development, O=NetPulse',
  issuer: 'CN=NetPulse Development, O=NetPulse',
  statusMessage: 'A certificate chain processed, but terminated in a root certificate which is not trusted by the trust provider.',
};
eq('self-signed chain is classified selfsigned', classifySignature(selfSigned).level, 'selfsigned');
eq('self-signed chain is not trusted', classifySignature(selfSigned).trusted, false);
eq('self-signed chain warns SmartScreen', classifySignature(selfSigned).smartScreen, 'warns');
eq(
  'self-signed detection ignores case and spacing',
  classifySignature({ ...selfSigned, issuer: 'cn=netpulse development,  o=netpulse' }).level,
  'selfsigned',
);

const privateCa = {
  status: 'UnknownError',
  subject: 'CN=NetPulse Release, O=NetPulse',
  issuer: 'CN=Internal Issuing CA, O=NetPulse',
  statusMessage: 'A certificate chain processed, but terminated in a root certificate which is not trusted by the trust provider.',
};
eq('CA-signed but unknown root is untrusted-root', classifySignature(privateCa).level, 'untrusted-root');
eq('untrusted-root warns SmartScreen', classifySignature(privateCa).smartScreen, 'warns');

const tampered = {
  status: 'HashMismatch',
  subject: 'CN=NetPulse Ltd',
  issuer: 'CN=DigiCert Trusted G4 CA1, O=DigiCert',
  statusMessage: 'The contents of the file do not match the hash in the signature.',
};
eq('tampered file is bad', classifySignature(tampered).level, 'bad');

eq('unsigned file is missing', classifySignature({ status: 'NotSigned', subject: '', issuer: '' }).level, 'missing');
eq('no observation at all is missing', classifySignature(null).level, 'missing');
eq('signature with no signer cert is missing', classifySignature({ status: 'UnknownError', subject: '' }).level, 'missing');
// Windows is the authority on `Valid`; anything it could NOT verify must not be
// rescued into trust by our own string inspection.
check(
  'an unverifiable signer with no issuer is never called trusted',
  classifySignature({ status: 'UnknownError', subject: 'CN=X', issuer: '' }).trusted === false,
);
check(
  'a Valid status with no issuer detail stays trusted (the OS verified the chain)',
  classifySignature({ status: 'Valid', subject: 'CN=X', issuer: '' }).level === 'trusted',
);

for (const level of TRUST_LEVELS) {
  const line = smartScreenReport(level);
  check(`smartScreenReport(${level}) states a SmartScreen outcome`, /SmartScreen: (WILL warn|the publisher chain is trusted)/.test(line));
}
check(
  'the self-signed report names the real remedy',
  /CA-issued or Azure Trusted Signing/.test(smartScreenReport('selfsigned')),
);

console.log('\n== the signer output contract the gate parses ==');
const parsed = parseVerifyLine('verify: NetPulse_0.2.2_x64-setup.exe status=UnknownError class=selfsigned ts=ok');
eq('parses the artifact name', parsed?.file, 'NetPulse_0.2.2_x64-setup.exe');
eq('parses the Windows status', parsed?.status, 'UnknownError');
eq('parses the trust class', parsed?.level, 'selfsigned');
eq('ignores non-verify lines', parseVerifyLine('sign-release: identity route pfx'), null);

/* ---------------------------- identity resolution ------------------------- */

console.log('\n== signing identity resolution ==');

const noIdentity = resolveSigningIdentity({ env: {}, repoRoot: emptyRoot });
eq('nothing configured resolves to route null', noIdentity.route, null);

const thumb = resolveSigningIdentity({ env: { NETPULSE_SIGN_THUMBPRINT: 'ABCDEF' }, repoRoot: emptyRoot });
eq('thumbprint selects the store route', thumb.route, 'store-thumbprint');

const dlib = path.join(tmp, 'Azure.CodeSigning.Dlib.dll');
fs.writeFileSync(dlib, 'not a real dll');
const signtool = path.join(tmp, 'signtool.exe');
fs.writeFileSync(signtool, 'not a real exe');

let threw = null;
try {
  resolveSigningIdentity({ env: { NETPULSE_SIGN_AZURE_DLIB: dlib, NETPULSE_SIGNTOOL: signtool }, repoRoot: emptyRoot, log: () => {} });
} catch (err) {
  threw = err;
}
check('an Azure route without its four values is refused', threw instanceof SigningIdentityError);
check('the refusal names the endpoint variable', (threw?.hints ?? []).some((h) => h.includes('NETPULSE_SIGN_AZURE_ENDPOINT')));

threw = null;
try {
  resolveSigningIdentity({ env: { NETPULSE_SIGN_AZURE_DLIB: path.join(tmp, 'absent.dll'), NETPULSE_SIGNTOOL: signtool }, repoRoot: emptyRoot });
} catch (err) {
  threw = err;
}
eq('a missing dlib is a hard error', threw?.code, 2);

const azureEnv = {
  NETPULSE_SIGN_AZURE_DLIB: dlib,
  NETPULSE_SIGNTOOL: signtool,
  NETPULSE_SIGN_AZURE_ENDPOINT: 'https://eus.codesigning.azure.net/',
  NETPULSE_SIGN_AZURE_ACCOUNT: 'netpulse-signing',
  NETPULSE_SIGN_AZURE_PROFILE: 'netpulse-release',
  NETPULSE_SIGN_AZURE_CERTIFICATE: 'netpulse',
};
const azure = resolveSigningIdentity({ env: azureEnv, repoRoot: emptyRoot, log: () => {} });
eq('a complete Azure profile selects the token-free route', azure.route, 'azure-trusted-signing');
check('generated metadata exists at the resolved path', fs.existsSync(azure.env.NETPULSE_SIGN_AZURE_METADATA));
const metadata = JSON.parse(fs.readFileSync(azure.env.NETPULSE_SIGN_AZURE_METADATA, 'utf8'));
eq('metadata carries the Trusted Signing endpoint', metadata.Endpoint, azureEnv.NETPULSE_SIGN_AZURE_ENDPOINT);
eq('metadata carries the account', metadata.CodeSigningAccountName, azureEnv.NETPULSE_SIGN_AZURE_ACCOUNT);
eq('metadata carries the certificate profile', metadata.CertificateProfileName, azureEnv.NETPULSE_SIGN_AZURE_PROFILE);
const argv = azureSignArgs('C:\\build\\setup.exe', azure.env);
check('signtool argv uses the dlib', argv.includes(dlib));
check('signtool argv passes the metadata file', argv.includes(azure.env.NETPULSE_SIGN_AZURE_METADATA));
check('signtool argv stamps an RFC3161 timestamp', argv.includes('/tr') && argv.includes('/td') && argv.includes('SHA256'));
eq('signtool argv ends with the artifact', argv[argv.length - 1], 'C:\\build\\setup.exe');

const pfxDir = path.join(tmp, 'with-pfx');
fs.mkdirSync(path.join(pfxDir, 'certs'), { recursive: true });
const pfxPath = path.join(pfxDir, 'certs', 'netpulse-release.pfx');
fs.writeFileSync(pfxPath, 'not a real pfx');

threw = null;
try {
  resolveSigningIdentity({
    env: { NETPULSE_SIGN_PW_FILE: path.join(tmp, 'no-such-pw-file') },
    repoRoot: pfxDir,
    log: () => {},
  });
} catch (err) {
  threw = err;
}
check('a PFX with no password is a hard error, not "no identity"', threw instanceof SigningIdentityError);

const pwFile = path.join(tmp, 'pw');
fs.writeFileSync(pwFile, 'hunter2\n');
const pfx = resolveSigningIdentity({ env: { NETPULSE_SIGN_PW_FILE: pwFile }, repoRoot: pfxDir, log: () => {} });
eq('a PFX with a password file selects the pfx route', pfx.route, 'pfx');
eq('the password is read and trimmed', pfx.env.NETPULSE_SIGN_PFX_PASSWORD, 'hunter2');
eq('the resolved PFX path is absolute', pfx.env.NETPULSE_SIGN_PFX, pfxPath);

/* ------------------------- the signer's own behavior ---------------------- */

console.log('\n== signer CLI behavior (spawned for real) ==');

const dummy = path.join(tmp, 'artifact.exe');
fs.writeFileSync(dummy, 'not really a binary');
const runSigner = (args, env = {}) =>
  spawnSync(process.execPath, [signer, ...args, dummy], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    cwd: root,
  });

// --optional exists so machines without a cert can still build. It must not
// swallow a BROKEN profile: that would ship an unsigned release that believes
// it was signed.
const broken = runSigner(['--optional', '--verify-only'], {
  NETPULSE_SIGN_AZURE_DLIB: path.join(tmp, 'absent.dll'),
  NETPULSE_SIGN_THUMBPRINT: '',
  NETPULSE_SIGN_PFX: '',
});
eq('--optional still refuses a broken Azure profile', broken.status, 2);
check('the refusal explains what is missing', /Azure Trusted Signing|dlib/.test(broken.stderr));

// The enforcement rule: a release build fails unless the chain is trusted, and
// the verdict must come from the classifier — never a second opinion.
if (process.platform === 'win32' && fs.existsSync(dummy)) {
  const verify = runSigner(['--verify-only'], {});
  const line = verify.stdout.split('\n').find((l) => l.startsWith('verify: '));
  const trust = parseVerifyLine(line ?? '');
  check('the signer reports a trust class for a real file', trust !== null, verify.stdout.trim().split('\n').pop());
  if (trust) {
    const strict = runSigner(['--verify-only', '--require-trusted'], {});
    const shouldFail = trust.level !== 'trusted';
    eq(
      `--require-trusted ${shouldFail ? 'rejects' : 'accepts'} a ${trust.level} signature`,
      strict.status === 0,
      !shouldFail,
    );
    if (shouldFail) check('the strict failure states the SmartScreen consequence', /SmartScreen/.test(strict.stderr));
  }
} else {
  console.log('  note  signature inspection skipped (Windows-only)');
}

cleanup();

console.log(`\nsignature-trust: ${checks - failed}/${checks} checks passed`);
if (failed) {
  console.error(`signature-trust: ${failed} check(s) failed`);
  process.exit(1);
}
console.log('signature-trust: all checks passed');
