import fs from 'node:fs';
import path from 'node:path';

/**
 * Canonical NSIS installer filename, derived from src-tauri/tauri.conf.json —
 * the same version Tauri itself bakes into the bundle name. Hardcoding the
 * name in signing scripts caused version-skewed artifacts (a 0.2.2 build
 * shipping its signed installer as NetPulse_0.2.0_x64-setup.exe).
 */
export function installerFileName(repoRoot) {
  const confPath = path.join(repoRoot, 'src-tauri', 'tauri.conf.json');
  const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
  if (!conf.version) throw new Error(`installerFileName: no "version" in ${confPath}`);
  return `NetPulse_${conf.version}_x64-setup.exe`;
}
