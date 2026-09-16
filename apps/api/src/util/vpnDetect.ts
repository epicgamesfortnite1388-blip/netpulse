import fs from 'node:fs';
import path from 'node:path';

import { runCommand } from './exec';

import { coresDir, ENGINE_RELEASES } from '../services/engineManager';

/**
 * Where the app's own engine installer would have put sing-box, if installed.
 * The cores drop-in dir is part of this app, so a binary there counts — a
 * provider that says "not installed" while the app manages the binary itself
 * is a lie the Engines card would show.
 */
export function managedSingBoxPath(): string | null {
  // ENGINE_RELEASES.binaryName is already platform-correct ('sing-box.exe' on
  // Windows) — appending a suffix here would look for sing-box.exe.exe.
  const name = ENGINE_RELEASES['sing-box']?.binaryName
    ?? (process.platform === 'win32' ? 'sing-box.exe' : 'sing-box');
  const managed = path.join(coresDir(), name);
  return fs.existsSync(managed) ? managed : null;
}

/**
 * Launch target for the sing-box VPN provider: the managed binary when the app
 * installed it, else the bare name (PATH lookup), else null. Returning the real
 * path matters — spawning `'sing-box'` by name cannot see the cores dir.
 */
export async function findSingBoxLaunch(): Promise<string | null> {
  const managed = managedSingBoxPath();
  if (managed) return managed;
  const where = process.platform === 'win32' ? 'where' : 'which';
  const onPath = await runCommand(where, ['sing-box'], { timeoutMs: 5_000 }).then((r) => r.code === 0).catch(() => false);
  return onPath ? 'sing-box' : null;
}
/**
 * Best-effort detection of locally installed VPN engines. Uses `where`
 * (Windows) / `which` (Unix) — never executes the binaries.
 */
export async function detectVpnBinaries(): Promise<Record<string, boolean>> {
  if (process.platform === 'win32') {
    const out: Record<string, boolean> = { wireguard: false, openvpn: false, singbox: false };
    const candidates = [
      path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'WireGuard', 'wireguard.exe'),
      path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'WireGuard', 'wireguard.exe'),
    ];
    out.wireguard = candidates.some((p) => fs.existsSync(p));
    const where = async (bin: string): Promise<boolean> =>
      runCommand('where', [bin], { timeoutMs: 5_000 }).then((r) => r.code === 0).catch(() => false);
    out.openvpn = await where('openvpn');
    out.singbox = (await findSingBoxLaunch()) !== null;
    return out;
  }

  const which = async (bin: string): Promise<boolean> =>
    runCommand('which', [bin], { timeoutMs: 5_000 }).then((r) => r.code === 0).catch(() => false);
  return {
    wireguard: (await which('wg')) && (await which('wg-quick')),
    openvpn: await which('openvpn'),
    singbox: (await findSingBoxLaunch()) !== null,
  };
}
