#!/usr/bin/env node
/**
 * Cross-platform desktop release pipeline (the executable behind `desktop:package`).
 *
 * Chain:
 *   1. desktop:build          (version + backend bundle + tauri build)
 *   2. desktop:verify         (staging, tauri.conf, live sidecar boot + auth)
 *   3. desktop:verify --require-signature
 *   4. package-signed         (sign exe, rebuild NSIS with signed exe, sign installer)
 *   5. post-install bootstrap (NSIS first-launch markers)
 *   6. test:signing           ("signed ≠ trusted" contract for the signer/gate)
 *   7. test:release           (distribution lifecycle tests)
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
