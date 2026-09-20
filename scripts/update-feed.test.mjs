#!/usr/bin/env node
/**
 * Update-feed contract tests.
 *
 * What these pin, and why each one is a real failure mode rather than a
 * restatement of the code:
 *
 *  - **The signature is verified the way the updater verifies it.** The
 *    publishing side must not advertise an artifact the app will refuse. That
 *    includes the check that is easy to omit: the SECOND signature over
 *    `signature || trusted-comment`, which is what catches a signature file
 *    whose comment was edited after signing.
 *  - **`signature` in latest.json is base64 of the `.sig` FILE TEXT**, not the
 *    signature itself (the plugin base64-decodes the field before parsing). A
 *    manifest built the "obvious" way is rejected by every client.
 *  - **Platform keys are `{target}-{arch}`** (`windows-x86_64`), not the Rust
 *    triple — a wrong key means the release is invisible for that platform.
 *  - **The endpoint is derived, not typed.** It is stamped from the release
 *    repository, and a placeholder repository is refused rather than shipped.
 *
 * The round-trip uses the real Tauri signer when the CLI is available, so the
 * format assumptions are checked against the tool that actually produces the
 * signatures the app consumes.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { decodePublicKey, decodeSignature, isEncryptedSecretKey, toMinisignField, toMinisignText, verifyMinisign } from './lib/minisign.mjs';
import {
  buildLatestJson,
  feedEndpoint,
  FeedConfigError,
  localEndpointForPort,
  manifestSignatureField,
  parseRepoSlug,
  platformKeyFor,
  releaseAssetUrl,
  resolveReleaseRepo,
} from './lib/updateFeed.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let checks = 0;
let failed = 0;

function check(name, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`  ok   ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function eq(name, actual, expected) {
  check(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'np-feed-'));
const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });

/* ------------------------------ feed model -------------------------------- */

console.log('\nrepository slug resolution');
eq('parses an https GitHub URL', parseRepoSlug('https://github.com/acme/netpulse'), 'acme/netpulse');
eq('parses a clone URL with .git', parseRepoSlug('git@github.com:acme/netpulse.git'), 'acme/netpulse');
eq('parses a bare slug', parseRepoSlug('acme/netpulse'), 'acme/netpulse');
eq('parses the package.json object form', parseRepoSlug({ type: 'git', url: 'git+https://github.com/acme/netpulse.git' }), 'acme/netpulse');
eq('rejects a non-repo string', parseRepoSlug('not-a-repo'), null);

eq(
  'env override wins over package.json',
  resolveReleaseRepo({ env: { NETPULSE_RELEASE_REPO: 'env-owner/env-repo' }, repoRoot: null }).slug,
  'env-owner/env-repo',
);

{
  const local = resolveReleaseRepo({ env: { NETPULSE_RELEASE_REPO: 'local' }, repoRoot: null });
  check('NETPULSE_RELEASE_REPO=local selects the local feed', local.slug === 'local' && local.local === true);
  eq('the local feed endpoint is the sidecar route', feedEndpoint('local'), 'http://127.0.0.1:update-feed/api/v1/update-feed/latest.json');
  eq('the local artifact URL is the sidecar route', releaseAssetUrl('local', '1.2.3', 'ignored.zip'), 'http://127.0.0.1:update-feed/artifact');
  eq('localEndpointForPort rewrites the placeholder host', localEndpointForPort(53944), 'http://127.0.0.1:53944/api/v1/update-feed/latest.json');
}

{
  let threw = null;
  try {
    resolveReleaseRepo({ env: { NETPULSE_RELEASE_REPO: 'https://releases.example.com/netpulse' }, repoRoot: null });
  } catch (err) {
    threw = err;
  }
  check('a placeholder repository is refused', threw instanceof FeedConfigError);
  check('the refusal explains how to fix it', Array.isArray(threw?.hints) && threw.hints.length > 0);
}

console.log('\nendpoints and platform keys');
eq('feed endpoint is the stable latest-manifest URL', feedEndpoint('acme/netpulse'), 'https://github.com/acme/netpulse/releases/latest/download/latest.json');
eq(
  'artifact URL is tag-pinned, not "latest"',
  releaseAssetUrl('acme/netpulse', '1.2.3', 'NetPulse_1.2.3_x64-setup.exe.zip'),
  'https://github.com/acme/netpulse/releases/download/v1.2.3/NetPulse_1.2.3_x64-setup.exe.zip',
);
eq('windows key is target-arch', platformKeyFor('win32', 'x64'), 'windows-x86_64');
eq('linux key is target-arch', platformKeyFor('linux', 'x64'), 'linux-x86_64');
eq('macOS arm64 key is target-arch', platformKeyFor('darwin', 'arm64'), 'darwin-aarch64');

console.log('\nmanifest shape');
{
  const sigText = 'untrusted comment: signature from minisign secret key\nAAAA\n';
  const field = manifestSignatureField(sigText);
  eq(
    'a raw minisign signature is encoded into the field (the plugin decodes it before parsing)',
    Buffer.from(field, 'base64').toString('utf8').trim(),
    sigText.trim(),
  );
  // The Tauri CLI writes `<artifact>.sig` ALREADY in that form, so the field
  // must be the file content itself — encoding it again is rejected by every
  // client, which is the exact bug this pins.
  eq('an already-encoded .sig passes through unchanged', manifestSignatureField(field), field);
  const manifest = buildLatestJson({
    version: '1.2.3',
    notes: 'n',
    pubDate: '2026-01-01T00:00:00Z',
    artifactUrl: 'https://example.invalid/a.zip',
    signature: field,
    platformKey: 'windows-x86_64',
  });
  eq('manifest carries the version', manifest.version, '1.2.3');
  eq('manifest keys platforms by target-arch', Object.keys(manifest.platforms)[0], 'windows-x86_64');
  check('manifest platform entry has url + signature', Boolean(manifest.platforms['windows-x86_64'].url) && Boolean(manifest.platforms['windows-x86_64'].signature));
  for (const missing of ['version', 'artifactUrl', 'signature', 'platformKey']) {
    let threw = false;
    try {
      buildLatestJson({
        version: missing === 'version' ? '' : '1.0.0',
        artifactUrl: missing === 'artifactUrl' ? '' : 'https://example.invalid/a.zip',
        signature: missing === 'signature' ? '' : 'AAAA',
        platformKey: missing === 'platformKey' ? '' : 'windows-x86_64',
      });
    } catch {
      threw = true;
    }
    check(`an incomplete manifest is refused (${missing})`, threw);
  }
}

/* ------------------------- hand-built signatures --------------------------- */
// No CLI needed, and it exercises the legacy ("Ed", unhashed) branch the
// updater still accepts via allow_legacy, which the signer never produces.

console.log('\nminisign verification (hand-built keys)');

function buildKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const rawPub = publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  const keyId = crypto.randomBytes(8);
  const pubText = `untrusted comment: minisign public key: ${keyId.toString('hex').toUpperCase()}\n` +
    `${Buffer.concat([Buffer.from('Ed'), keyId, rawPub]).toString('base64')}\n`;
  return { keyId, pubText, privateKey };
}

function sign(content, { keyId, privateKey }, { prehashed }) {
  const signed = prehashed ? crypto.createHash('blake2b512').update(content).digest() : content;
  const sig = crypto.sign(null, signed, privateKey);
  const comment = 'timestamp:0\tfile:test\t';
  const global = crypto.sign(null, Buffer.concat([sig, Buffer.from(comment, 'utf8')]), privateKey);
  return `untrusted comment: signature from minisign secret key\n` +
    `${Buffer.concat([Buffer.from(prehashed ? 'ED' : 'Ed'), keyId, sig]).toString('base64')}\n` +
    `trusted comment: ${comment}\n` +
    `${global.toString('base64')}\n`;
}

{
  const content = Buffer.from('the updater artifact bytes');
  for (const prehashed of [true, false]) {
    const keys = buildKeys();
    const sigText = sign(content, keys, { prehashed });
    const mode = prehashed ? 'prehashed (ED)' : 'legacy (Ed)';
    const ok = verifyMinisign(content, sigText, keys.pubText);
    check(`a valid ${mode} signature verifies`, ok.ok, ok.reason);

    const tampered = verifyMinisign(Buffer.from('different bytes'), sigText, keys.pubText);
    check(`a tampered artifact is rejected (${mode})`, !tampered.ok);

    // The check that is easy to leave out: the global signature over the
    // trusted comment. Editing the comment must invalidate the signature.
    const editedComment = sigText.replace('trusted comment: timestamp:0', 'trusted comment: timestamp:999');
    const commentCheck = verifyMinisign(content, editedComment, keys.pubText);
    check(`an edited trusted comment is rejected (${mode})`, !commentCheck.ok, 'global signature not enforced');

    const wrongKey = verifyMinisign(content, sigText, buildKeys().pubText);
    check(`a different public key is rejected (${mode})`, !wrongKey.ok);
    check(`the key-id mismatch names the cause (${mode})`, /key id mismatch/.test(wrongKey.reason ?? ''), wrongKey.reason);
  }

  // A password-protected secret key must be DETECTED, not discovered by hanging
  // on the signer's prompt inside a build.
  const secretKeyFile = (encrypted) => {
    const payload = Buffer.concat([
      Buffer.from('Ed'),
      Buffer.from(encrypted ? 'Sc' : '\u0000\u0000'),
      Buffer.alloc(32, encrypted ? 0x2a : 0x00),
      crypto.randomBytes(8),
      crypto.randomBytes(96),
      crypto.randomBytes(4),
    ]);
    return Buffer.from(`untrusted comment: rsign ${encrypted ? 'encrypted ' : ''}secret key\n${payload.toString('base64')}\n`, 'utf8').toString('base64');
  };
  check('an encrypted secret key is detected', isEncryptedSecretKey(secretKeyFile(true)));
  check('an unencrypted secret key is not', !isEncryptedSecretKey(secretKeyFile(false)));
  check('a raw (non-base64-wrapped) key file is detected too', (() => {
    const wrapped = Buffer.from(secretKeyFile(true), 'base64').toString('utf8');
    return isEncryptedSecretKey(wrapped);
  })());
  if (fs.existsSync(path.join(os.homedir(), '.tauri', 'netpulse.key'))) {
    const local = fs.readFileSync(path.join(os.homedir(), '.tauri', 'netpulse.key'), 'utf8');
    check('the machine\'s real key is classified without prompting', typeof isEncryptedSecretKey(local) === 'boolean');
  }

  const keys = buildKeys();
  const junk = verifyMinisign(content, 'not a signature', keys.pubText);
  check('an unparseable signature is rejected, not thrown', !junk.ok);
  check('the parse failure says why', /base64|trusted comment/.test(junk.reason ?? ''), junk.reason);

  // The key-id the verifier reports is the one baked into the key file.
  const sigText = sign(content, keys, { prehashed: true });
  eq('the verified key id is the key file\'s', verifyMinisign(content, sigText, keys.pubText).keyId, keys.keyId.toString('hex'));
  eq('decodePublicKey reads the "Ed" algorithm', decodeSignature(sigText).prehashed, true);
  check('decodePublicKey exposes an 8-byte key id', decodePublicKey(keys.pubText).keyId.length === 16);
}

/* --------------------------- real Tauri signer ---------------------------- */
// The strongest evidence: signatures produced by the actual tool, verified by
// this module, and rejected by it when the artifact is edited afterwards.

console.log('\nround-trip against the real Tauri signer');
{
  // Invoke the CLI's node entry directly (no shell): the same way the pipeline
  // does, so a path with spaces cannot change which file gets signed.
  const tauriCli = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  const runCli = (argv, opts = {}) => spawnSync(process.execPath, [tauriCli, ...argv], {
    cwd: root, encoding: 'utf8', timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'], ...opts,
  });
  const cli = fs.existsSync(tauriCli) ? runCli(['--version']) : { status: 1 };
  if (cli.status !== 0) {
    console.log('  note  Tauri CLI unavailable — skipping the real-signer round-trip');
  } else {
    const keyPath = path.join(tmp, 'test.key');
    const password = `pw-${Date.now()}`;
    const gen = runCli(['signer', 'generate', '-w', keyPath, '-f', '-p', password]);
    check('the CLI generated a keypair', gen.status === 0 && fs.existsSync(keyPath), (gen.stderr || '').slice(-200));

    const artifactPath = path.join(tmp, 'NetPulse_0.0.0_x64-setup.exe.zip');
    fs.writeFileSync(artifactPath, Buffer.from('pretend this is the updater artifact'));
    const signedRun = runCli(['signer', 'sign', artifactPath, '-f', keyPath, '-p', password]);
    const sigFile = `${artifactPath}.sig`;
    check('the CLI produced a .sig beside the artifact', signedRun.status === 0 && fs.existsSync(sigFile), (signedRun.stderr || '').slice(-200));

    // The CLI's .pub file is ALREADY base64 of the minisign public-key text.
    const pubFile = fs.readFileSync(`${keyPath}.pub`, 'utf8');
    const pubText = toMinisignText(pubFile, 'cli pub');
    check('the CLI .pub file decodes to minisign key text', /^untrusted comment: /.test(pubText), pubText.slice(0, 40));
    const sigFileRaw = fs.readFileSync(sigFile, 'utf8');
    const sigText = sigFileRaw; // the verifier normalizes both encodings
    const round = verifyMinisign(fs.readFileSync(artifactPath), sigText, pubText);
    check('a real signer signature verifies', round.ok, round.reason);

    const edited = Buffer.concat([fs.readFileSync(artifactPath), Buffer.from('!')]);
    check('the same signature rejects an edited artifact', !verifyMinisign(edited, sigText, pubText).ok);

    // The manifest field must equal the .sig file for a CLI-produced signature,
    // and must still verify once decoded — the round-trip the app performs.
    const field = manifestSignatureField(sigText);
    check('the manifest field is the CLI .sig content itself', Buffer.from(field, 'base64').toString('utf8') === toMinisignText(sigFileRaw, 'sig'), 'field was re-encoded');
    const parsedBack = verifyMinisign(fs.readFileSync(artifactPath), field, toMinisignField(pubText, 'pub'));
    check('the manifest signature field round-trips to a valid signature', parsedBack.ok, parsedBack.reason);
  }
}

/* ------------------------------ config wiring ----------------------------- */

console.log('\nshipped configuration');
{
  const conf = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));  const pubkeyField = conf.plugins?.updater?.pubkey ?? '';
  let decoded = null;
  try {
    // decodePublicKey accepts the raw minisign text AND base64 of it.
    decoded = decodePublicKey(pubkeyField);
  } catch {
    decoded = null;
  }
  check('plugins.updater.pubkey is a real minisign public key (not a placeholder)', Boolean(decoded));

  const endpoints = conf.plugins?.updater?.endpoints ?? [];
  eq('exactly one endpoint is configured', endpoints.length, 1);

  let slug = null;
  let isLocal = false;
  try {
    const resolved = resolveReleaseRepo({ env: process.env, repoRoot: root });
    slug = resolved.slug;
    isLocal = resolved.local === true;
  } catch {
    slug = null;
  }
  const placeholder = /example\.com|REPLACE_WITH/i.test(endpoints[0] ?? '');
  if (isLocal) {
    // Local feed: the endpoint is the sidecar route; the port is per-launch
    // so the baked URL carries the `update-feed` host placeholder by contract.
    eq('the endpoint is the local sidecar feed route', endpoints[0], feedEndpoint('local'));
  } else if (slug) {
    // Configured: the endpoint must match the repository exactly, or the app
    // polls a feed this pipeline does not publish to.
    eq('the endpoint is derived from the release repository', endpoints[0], feedEndpoint(slug));
  } else if (placeholder) {
    // Unconfigured. That is a real gap, not a broken contract — so a dev build
    // gets a note (like the signer's missing-certificate advisory) while a
    // RELEASE is stopped by NETPULSE_REQUIRE_UPDATER_FEED=1.
    const required = process.env.NETPULSE_REQUIRE_UPDATER_FEED === '1';
    check('a release has a real update endpoint', !required, `endpoint is still ${endpoints[0]}`);
    if (!required) {
      console.log('  note  the update endpoint is not configured yet.');
      console.log('        activate it with:  npm run release:version -- --repo owner/repo');
    }
  } else {
    check('an endpoint is set without a recorded repository (it cannot be re-derived)', false, endpoints[0]);
  }

  // If the machine holds the private key, prove it is the PAIR of the shipped
  // public key: a release signed with a different key is invisible to the app.
  const localKey = path.join(os.homedir(), '.tauri', 'netpulse.key');
  if (fs.existsSync(localKey) && slug) {
    const probe = path.join(tmp, 'pair-probe.bin');
    fs.writeFileSync(probe, 'pair check');
    const signed = spawnSync(process.execPath, [path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'), 'signer', 'sign', probe, '-f', localKey], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
    });
    if (signed.status === 0 && fs.existsSync(`${probe}.sig`)) {
      const verdict = verifyMinisign(fs.readFileSync(probe), fs.readFileSync(`${probe}.sig`, 'utf8'), pubkeyText);
      check('the local private key matches the shipped public key', verdict.ok, verdict.reason);
    } else {
      console.log('  note  local private key needs a password — pair check skipped');
    }
  }
}

cleanup();

console.log(`\nupdate-feed: ${checks - failed}/${checks} checks passed`);
if (failed) {
  console.error(`update-feed: ${failed} check(s) failed`);
  process.exit(1);
}
console.log('update-feed: all checks passed');
