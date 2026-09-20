#!/usr/bin/env node
/**
 * Update-feed stage — turns the FINAL signed installer into the artifacts a
 * GitHub Release must carry:
 *
 *   NetPulse_<version>_x64-setup.exe.zip       the updater artifact
 *   NetPulse_<version>_x64-setup.exe.zip.sig   its minisign signature
 *   latest.json                                the manifest the app fetches
 *
 * Why this stage exists instead of `createUpdaterArtifacts: true`:
 * `tauri build` would produce the updater zip from the installer it just
 * bundled — but `package-signed` REBUILDS that installer so it embeds the
 * post-bundle-patched, Authenticode-signed exe. A zip made by `tauri build`
 * therefore contains the pre-signature installer, and an update installed from
 * it would silently replace a signed exe with an unsigned one. Zipping the
 * final installer here is the only way the update path keeps the signature.
 *
 * Verification before publishing (all of it hard-fail):
 *   - the artifact zip exists and CONTAINS the installer (the updater looks for
 *     a top-level .exe/.msi inside the archive),
 *   - its minisign signature verifies against the pubkey baked into
 *     tauri.conf.json — the same check the app performs before running it,
 *   - the signature's key id matches that pubkey,
 *   - with NETPULSE_REQUIRE_TRUSTED_SIGNATURE=1, the installer's Authenticode
 *     chain is verified by the existing signer (one owner for that verdict).
 *
 * The network is never touched: this writes files for a human/CI to attach to a
 * release. Nothing is uploaded, so no credential is needed here.
 *
 * Env:
 *   TAURI_SIGNING_PRIVATE_KEY[_PATH] + _PASSWORD   minisign private key
 *   NETPULSE_RELEASE_REPO                          owner/repo (else package.json)
 *   NETPULSE_FEED_OUT                              output dir (default: bundle/updater)
 *
 * Usage: node scripts/update-feed.mjs [--check] [--optional]
 *   --check     verify the artifact and its signature, write nothing
 *   --optional  no signing key = skip with an advisory (dev builds); a key that
 *               IS present but produces an invalid signature always fails, and
 *               a release build sets NETPULSE_REQUIRE_UPDATER_FEED=1 to make a
 *               missing key fatal — the same --optional/require split the
 *               Authenticode signer uses.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { installerFileName } from './lib/installerName.mjs';
import { isEncryptedSecretKey, toMinisignText, verifyMinisign } from './lib/minisign.mjs';
import { inspectZip, writeZipSingleStored } from './lib/zipWrite.mjs';
import {
  buildLatestJson,
  feedEndpoint,
  FeedConfigError,
  manifestSignatureField,
  parseRepoSlug,
  platformKeyFor,
  releaseAssetUrl,
  resolveReleaseRepo,
} from './lib/updateFeed.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');
const optional = process.argv.includes('--optional') && process.env.NETPULSE_REQUIRE_UPDATER_FEED !== '1';
const die = (m) => {
  console.error(m);
  process.exit(1);
};
const step = (m) => console.log(`\n== ${m} ==`);

/* ------------------------------- inputs ---------------------------------- */

const confPath = path.join(root, 'src-tauri', 'tauri.conf.json');
const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
const version = conf.version;
if (!version) die('update-feed: tauri.conf.json has no version');

const pubkeyField = conf.plugins?.updater?.pubkey;
if (!pubkeyField || /REPLACE_WITH/i.test(pubkeyField)) {
  die('update-feed: tauri.conf.json plugins.updater.pubkey is not a real minisign public key.\n' +
    'Generate one with `npx tauri signer generate -w <file>` and put the PUBLIC key here (RELEASING.md §5).');
}
// The conf carries base64 of the minisign public-key text (the plugin decodes
// it before parsing, so verification here normalizes the same way).
const publicKeyText = toMinisignText(pubkeyField, 'plugins.updater.pubkey');

let slug;
try {
  slug = resolveReleaseRepo({ env: process.env, repoRoot: root });
} catch (err) {
  if (!(err instanceof FeedConfigError)) throw err;
  const message = `update-feed: ${err.message}\n${err.hints.map((h) => `  ${h}`).join('\n')}`;
  // A dev build with no repository configured must still package; a release
  // build sets NETPULSE_REQUIRE_UPDATER_FEED=1 and stops here instead.
  if (optional) {
    console.log(message);
    console.log('update-feed: skipping the feed (no release repository configured).');
    process.exit(0);
  }
  die(`${message}\nA release build cannot ship an update feed without one. See RELEASING.md §5.`);
}
console.log(`update-feed: version ${version}, feed ${slug.local ? 'LOCAL (sidecar-served)' : `repo ${slug.slug}`} (${slug.source})`);

const installer = path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis', installerFileName(root));
if (!fs.existsSync(installer)) {
  die(`update-feed: signed installer not found: ${installer}\nBuild it first: npm run desktop:package`);
}

const outDir = process.env.NETPULSE_FEED_OUT ?? path.join(root, 'src-tauri', 'target', 'release', 'bundle', 'updater');
const artifactName = `${installerFileName(root)}.zip`;
const artifact = path.join(outDir, artifactName);
const sigPath = `${artifact}.sig`;

/* --------------------- 1. the updater artifact (a zip) -------------------- */

if (!checkOnly) {
  fs.mkdirSync(outDir, { recursive: true });
  step(`pack the installer into ${artifactName}`);
  // The updater unpacks the archive and runs the first .exe it finds at the top
  // level, so the entry name must be the installer itself (not a folder).
  // STORED (method 0) is mandatory, not a size choice: the updater's zip crate is
  // built with no decompression feature, so a deflate entry is rejected live as
  // "Compression method not supported" (see scripts/lib/zipWrite.mjs).
  const packedSize = writeZipSingleStored(artifact, installerFileName(root), fs.readFileSync(installer), fs.statSync(installer).mtime);
  console.log(`packed: ${installerFileName(root)} (${fs.statSync(installer).size} B -> ${packedSize} B archive)`);
}

if (!fs.existsSync(artifact)) die(`update-feed: updater artifact missing: ${artifact}`);

/* ------------------- 2. the signed-artifact check(s) ---------------------- */

step('verify the artifact the feed will advertise');
{
  // (a) the archive carries the installer, at the top level (the updater's
  // extract_zip scans the extraction dir for the first .exe).
  const ps = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `$zip = [System.IO.Compression.ZipFile]::OpenRead(${JSON.stringify(artifact.replace(/\\/g, '/'))})`,
    '$names = $zip.Entries | Where-Object { $_.Name -ne "" } | ForEach-Object { $_.FullName }',
    '$zip.Dispose()',
    'Write-Output ($names -join "`n")',
  ].join('\n');
  const tmp = path.join(os.tmpdir(), `np-zipcheck-${Date.now()}.ps1`);
  fs.writeFileSync(tmp, ps, 'utf8');
  const listed = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], { encoding: 'utf8', timeout: 120_000 });
  fs.rmSync(tmp, { force: true });
  if (listed.status !== 0) die('update-feed: could not read the artifact archive');
  const entries = (listed.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const expected = installerFileName(root);
  if (!entries.includes(expected)) {
    die(`update-feed: artifact does not contain ${expected} (found: ${entries.join(', ') || 'nothing'})\n` +
      'An update would install nothing — refusing to publish a manifest for it.');
  }
  console.log(`artifact contains: ${expected}`);

  // (a2) The method must be STORED. The updater's zip crate is compiled with no
  // decompression feature and rejects a deflate entry at extract time, so a
  // compression-method regression here would only surface on a user's machine
  // mid-update. Fail the pipeline instead.
  const zip = inspectZip(artifact);
  if (zip.entries !== 1 || zip.method !== 0 || zip.centralMethod !== 0) {
    die(`update-feed: artifact must be a single STORED (method 0) entry, got ${zip.entries} entr${zip.entries === 1 ? 'y' : 'ies'} method ${zip.centralMethod}.\n` +
      'The updater cannot read any other method — the archive would be rejected mid-update.');
  }
  if (zip.localSize !== zip.localCompressed || zip.centralSize !== zip.localSize) {
    die('update-feed: artifact header sizes disagree; a truncated archive is not publishable.');
  }
  console.log(`artifact: STORED entry "${zip.name}", ${zip.localSize} B`);

  // (b) the installer's own Authenticode verdict, using the existing owner
  // rather than a second reading of Windows' signature fields.
  if (process.env.NETPULSE_REQUIRE_TRUSTED_SIGNATURE === '1') {
    const v = spawnSync(process.execPath, [path.join(root, 'scripts', 'sign-release.mjs'), '--verify-only', '--require-trusted', installer], { encoding: 'utf8', stdio: 'inherit' });
    if (v.status !== 0) die('update-feed: the installer is not trust-signed; a release cannot ship it as an update.');
  } else {
    console.log('installer Authenticode: not re-checked here (set NETPULSE_REQUIRE_TRUSTED_SIGNATURE=1 for a release)');
  }
}

if (!checkOnly) {
  step('sign the artifact (minisign)');
  // The key is always handed over as a FILE, never as an argument: a command
  // line is readable by every process on the machine, and a CI secret does not
  // belong there. Key content from the environment is staged to a private temp
  // file that is removed again below.
  let keyPath = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH
    ?? (process.env.TAURI_SIGNING_PRIVATE_KEY && fs.existsSync(process.env.TAURI_SIGNING_PRIVATE_KEY) ? process.env.TAURI_SIGNING_PRIVATE_KEY : null)
    ?? path.join(os.homedir(), '.tauri', 'netpulse.key');
  let stagedKey = null;
  const keyContent = process.env.TAURI_SIGNING_PRIVATE_KEY && !fs.existsSync(process.env.TAURI_SIGNING_PRIVATE_KEY)
    ? process.env.TAURI_SIGNING_PRIVATE_KEY
    : null;
  if (keyContent) {
    stagedKey = path.join(os.tmpdir(), `np-mskey-${Date.now()}`);
    fs.writeFileSync(stagedKey, keyContent, { mode: 0o600 });
    keyPath = stagedKey;
  }
  // An encrypted key whose password is UNKNOWN makes the signer PROMPT, and a
  // prompt in a pipeline hangs instead of failing. Ask the file, and stop early
  // — but only when no password was supplied at all: an EMPTY password is a
  // real choice (the key was created with one) and works via `-p ''`.
  const passwordDefined = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD !== undefined;
  if (!keyContent && fs.existsSync(keyPath) && !passwordDefined) {
    if (isEncryptedSecretKey(fs.readFileSync(keyPath, 'utf8'))) {
      const message = `update-feed: ${keyPath} is password-protected but TAURI_SIGNING_PRIVATE_KEY_PASSWORD is not set.\n` +
        'The signer would prompt and block the pipeline, so this stops here. If the key uses an EMPTY password, set the variable to empty.';
      if (optional) { console.log(message); console.log('update-feed: skipping the feed (advisory only).'); process.exit(0); }
      die(message);
    }
  }

  if (!keyContent && !fs.existsSync(keyPath)) {
    const message = 'update-feed: no minisign private key. Expected TAURI_SIGNING_PRIVATE_KEY(_PATH) or ' + keyPath + '.\n' +
      'Without it the feed would advertise an unsigned update, which the app refuses.';
    if (optional) {
      console.log(message);
      console.log('update-feed: skipping the feed (advisory only — this build cannot ship updates).');
      process.exit(0);
    }
    die(`${message}\nThis is a release build, so it stops here. See RELEASING.md §5.`);
  }
  fs.rmSync(sigPath, { force: true });
  // Key CONTENT from the environment is staged to a private temp file (never a
  // command line) and removed again right after signing.
  const dropStagedKey = () => { if (stagedKey) fs.rmSync(stagedKey, { force: true }); };
  // The CLI is invoked through its node entry point, NOT through `npx` + a
  // shell: a shell re-splits the command line (so a checkout under a path with
  // spaces signs the wrong file, or nothing), and Node deprecated passing args
  // with `shell: true` for exactly that reason.
  const cli = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  if (!fs.existsSync(cli)) {
    die(`update-feed: Tauri CLI not found at ${cli}. Run \`npm install\` first.`);
  }
  const args = [cli, 'signer', 'sign', artifact, '-f', keyPath];
  // An empty password is a real choice (the key was created with one) — pass
  // it through whenever the variable is defined at all.
  if (passwordDefined) args.push('-p', process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '');
  // stdin is ignored and a timeout is enforced so that any unexpected prompt
  // fails the step instead of hanging until CI or a human notices.
  const signed = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 300_000,
  });
  dropStagedKey();
  if (signed.status !== 0) {
    die(`update-feed: signing failed (status ${signed.status ?? signed.signal}${signed.error ? `: ${signed.error.message}` : ''})`);
  }
  if (!fs.existsSync(sigPath)) die(`update-feed: signer produced no ${sigPath}`);
}

if (!fs.existsSync(sigPath)) {
  die(`update-feed: no signature at ${sigPath}. Run without --check once the key is available.`);
}

step('verify the minisign signature against the app\'s configured public key');
const sigText = fs.readFileSync(sigPath, 'utf8');
const verdict = verifyMinisign(fs.readFileSync(artifact), sigText, publicKeyText);
if (!verdict.ok) {
  die(`update-feed: SIGNATURE INVALID — the app would reject this update.\n  ${verdict.reason}`);
}
console.log(`signature OK (key ${verdict.keyId}, ${verdict.prewashed ? 'prehashed' : 'legacy'} mode)`);

/* -------------------------- 3. the manifest ------------------------------ */

step('write latest.json');
const notesPath = path.join(root, 'docs', `RELEASE_NOTES_v${version}.md`);
let notes = fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf8').slice(0, 20_000) : '';
if (!notes) console.log(`note: no docs/RELEASE_NOTES_v${version}.md — shipping empty release notes`);
// The repository came from the environment, not the repo's package.json: the
// download URLs name a place nobody has published to yet. Say so IN the
// manifest, so an unpublished feed can never be mistaken for a live one.
if (slug.source === 'NETPULSE_RELEASE_REPO') {
  const pkgRepo = parseRepoSlug(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).repository);
  if (!pkgRepo) {
    notes = `[PUBLISHED NOWHERE YET — this manifest is a build artifact, not a live feed. Re-run release:feed after 'npm run release:version -- --repo owner/repo' to point the URLs at the real release.]\n\n${notes}`;
    console.log('note: repository is env-only — the manifest notes carry an unpublished-feed warning');
  }
}
const manifest = buildLatestJson({
  version,
  notes,
  artifactUrl: releaseAssetUrl(slug.slug, version, artifactName),
  signature: manifestSignatureField(sigText),
  platformKey: platformKeyFor('win32', 'x64'),
});
const manifestPath = path.join(outDir, 'latest.json');
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`\nupdate feed ready in ${outDir}`);
console.log(`  manifest : latest.json  (version ${manifest.version})`);
console.log(`  artifact : ${artifactName}`);
console.log(`  signature: ${artifactName}.sig`);
console.log(`  endpoint : ${feedEndpoint(slug.slug)}`);
if (slug.local) {
  console.log('\nLocal feed: publish = put latest.json + the zip + the .sig into the app release dir');
  console.log('(NETPULSE_RELEASE_DIR). The sidecar serves them at /api/v1/update-feed/ on loopback.');
} else {
  console.log('\nAttach all three to the GitHub release tag ' + `v${version}` + '. The endpoint above is what the app polls;');
  console.log('it resolves to the newest release, so the manifest must carry the highest version.');
}
