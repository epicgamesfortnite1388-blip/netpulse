import fs from 'node:fs';
import path from 'node:path';

import { runCommand } from './exec';

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
    out.singbox = await where('sing-box');
    return out;
  }

  const which = async (bin: string): Promise<boolean> =>
    runCommand('which', [bin], { timeoutMs: 5_000 }).then((r) => r.code === 0).catch(() => false);
  return {
    wireguard: (await which('wg')) && (await which('wg-quick')),
    openvpn: await which('openvpn'),
    singbox: await which('sing-box'),
  };
}
