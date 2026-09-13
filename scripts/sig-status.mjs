#!/usr/bin/env node
/** sig-status.mjs — thin report on whether the release artifacts are signed. */
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const is = (p) => import('node:fs').then((fs) => fs.existsSync(p));
const st = (f) => {
  if (!f.startsWith('file')) return status(f);
  return require('node:fs').existsSync(f) ? status(f) : `${f}\nMISSING`;
};
function status(f) {

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const exe = join(root, '..', 'src-tauri', 'target', 'release', 'netpulse-desktop.exe');
const setup = join(root, '..', 'src-tauri', 'target', 'release', 'bundle', 'nsis', 'NetPulse_0.2.0_x64-setup.exe');

const status = (f) => {
  if (!existsSync(f)) return `${f}\n    MISSING`;
  try {
    const out = execSync(`powershell -NoProfile -Command "(Get-AuthenticodeSignature '${f.replace(/\\/g, '\\\\')}').Status"`, { encoding: 'utf8', timeout: 10_000 }).trim();
    return `${f}\n    Status: ${out}`;
  } catch (e) {
    return `${f}\n    ERROR: ${e.message.slice(0, 120)}`;
  }
};
console.log('=== current signature state ===\n' + status(exe) + '\n' + status(setup));
