#!/usr/bin/env node
/**
 * Cross-platform desktop release pipeline (the executable behind `desktop:package`).
 *
 * Chain:
 *   1. desktop:build          (version + backend bundle + tauri build)
 *   2. desktop:verify         (staging, tauri.conf, live sidecar boot + auth)
 *   3. package-signed         (sign exe, rebuild NSIS with signed exe, sign installer)
 *   4. desktop:verify --require-signature
 *   5. release:feed           (updater artifact + minisign signature + latest.json)
 *   6. post-install bootstrap (NSIS first-launch markers)
 *   7. test:signing           ("signed ≠ trusted" contract for the signer/gate)
 *   8. test:release           (distribution lifecycle tests)
 *   9. test:feed              (minisign/feed contract)
 *
 * Step 5 must follow step 3: the updater artifact has to be built from the
 * REBUILT installer, or an update would replace the signed exe with the
 * pre-signature one.
 *
 * Replaces the previous POSIX-only `ENV=x cmd` chain which broke under
 * cmd.exe ("NETPULSE_REQUIRE_SIGNATURE is not recognized").
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const steps = [
  { name: 'desktop:build', cmd: [npm, ['run', 'desktop:build']] },
  { name: 'desktop:verify', cmd: [npm, ['run', 'desktop:verify', '--silent']] },
  {
    name: 'package-signed',
    cmd: [process.execPath, [path.join(root, 'scripts', 'package-signed.mjs')]],
  },
  {
    // AFTER package-signed: the gate verifies the FINAL signed exe
    // (tauri build patches the exe after beforeBuildCommand, so signing must
    // happen post-bundle — running the gate earlier always failed MISSING).
    name: 'desktop:verify --require-signature',
    cmd: [process.execPath, [path.join(root, 'scripts', 'verify-desktop-pipeline.mjs'), '--require-signature']],
  },
  {
    // AFTER package-signed: the updater artifact must wrap the FINAL installer
    // (the one embedding the signed exe), and its minisign signature is checked
    // against the pubkey the app itself will verify with. --optional keeps a
    // key-less dev build working; NETPULSE_REQUIRE_UPDATER_FEED=1 makes a
    // release fail instead.
    name: 'release:feed',
    cmd: [process.execPath, [path.join(root, 'scripts', 'update-feed.mjs'), '--optional']],
  },
  {
    name: 'post-install-bootstrap',
    cmd: [
      process.execPath,
      [path.join(root, 'scripts', 'post-install-bootstrap.mjs')],
    ],
    env: {
      TAURI_TARGET_DIR: path.join(root, 'src-tauri', 'target', 'release'),
      NP_DATA_DIR: path.join(process.env.LOCALAPPDATA ?? '', 'NetPulse'),
      NP_BUNDLE_DIR: path.join(root, 'src-tauri', 'target', 'release'),
      NP_CERT_STATUS: 'signed',
    },
  },
  { name: 'test:signing', cmd: [process.execPath, [path.join(root, 'scripts', 'signature-trust.test.mjs')]] },
  { name: 'test:release', cmd: [process.execPath, [path.join(root, 'scripts', 'release-distribution.test.mjs')]] },
  { name: 'test:feed', cmd: [process.execPath, [path.join(root, 'scripts', 'update-feed.test.mjs')]] },
];

for (const step of steps) {
  console.log(`\n=== ${step.name} ===`);
  const r = spawnSync(step.cmd[0], step.cmd[1], {
    stdio: 'inherit',
    cwd: root,
    // Windows: npm.cmd is a batch file — spawn requires a shell (Node rejects
    // direct .cmd/.bat execution since the CVE-2024-27980 fix).
    shell: process.platform === 'win32' && step.cmd[0] === npm,
    env: { ...process.env, ...(step.env ?? {}) },
  });
  if (r.error) {
    console.error(`\nFAILED to spawn "${step.name}": ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`\nFAILED at step "${step.name}" (exit ${r.status ?? r.signal}).`);
    process.exit(r.status ?? 1);
  }
}

console.log('\ndesktop:package completed successfully.');
