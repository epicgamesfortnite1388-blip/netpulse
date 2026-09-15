/**
 * Windows system-proxy handoff (HKCU Internet Settings).
 *
 * Sets/clears the per-user WinINET proxy that most Windows apps honor:
 *   ProxyEnable = 0/1, ProxyServer = "127.0.0.1:port"
 * Read-modify-write of ONLY these two values — never touches other keys.
 * Refreshes WinINET so running apps pick the change up without logoff.
 * On non-Windows platforms the set operation reports unsupported honestly
 * (macOS/Linux need networksetup/gsettings which are out of scope here) and
 * reads report the env-var fallback.
 */
import { spawn } from 'node:child_process';

const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

function regQuery(value: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    const child = spawn('reg', ['query', REG_KEY, '/v', value], { windowsHide: true, shell: false });
    let out = '';
    child.stdout?.on('data', (c: Buffer) => { out += c.toString(); });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) return resolve(null);
      const m = out.match(new RegExp(`^\\s*${value}\\s+REG_(DWORD|SZ)\\s+(.*)$`, 'mi'));
      resolve(m ? (m[2] ?? '').trim() : null);
    });
  });
}

function regPut(value: string, type: 'REG_DWORD' | 'REG_SZ', data: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(false);
    const child = spawn('reg', ['add', REG_KEY, '/v', value, '/t', type, '/d', data, '/f'], { windowsHide: true, shell: false });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/** Nudge WinINET (InternetSetOption via a tiny inline PowerShell call) so
 *  running apps notice the proxy change. Best-effort — never throws. */
function refreshWinInet(): void {
  if (process.platform !== 'win32') return;
  const script = `
$sig = '[DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);'
$t = Add-Type -MemberDefinition $sig -Name WI -Namespace NP -PassThru
$INTERNET_OPTION_SETTINGS_CHANGED = 39
$INTERNET_OPTION_REFRESH = 37
[void]$t::InternetSetOption([IntPtr]::Zero, $INTERNET_OPTION_SETTINGS_CHANGED, [IntPtr]::Zero, 0)
[void]$t::InternetSetOption([IntPtr]::Zero, $INTERNET_OPTION_REFRESH, [IntPtr]::Zero, 0)
`;
  try {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, shell: false, stdio: 'ignore' });
    child.once('error', () => { /* best effort */ });
  } catch { /* best effort */ }
}

export async function getSystemProxy(): Promise<{ proxy: string | null }> {
  if (process.platform !== 'win32') {
    // POSIX fallback: honor env vars, as most CLIs do.
    const p = process.env['HTTPS_PROXY'] ?? process.env['https_proxy'] ?? process.env['HTTP_PROXY'] ?? process.env['http_proxy'] ?? null;
    return { proxy: p };
  }
  const enable = await regQuery('ProxyEnable');
  const server = await regQuery('ProxyServer');
  return { proxy: enable === '0x1' && server ? server : null };
}

export async function setSystemProxy(proxyOrNull: string | null): Promise<{ ok: boolean; error?: string }> {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'system proxy handoff is Windows-only (env vars untouched)' };
  }
  const enableOk = await regPut('ProxyEnable', 'REG_DWORD', proxyOrNull ? '1' : '0');
  if (!enableOk) return { ok: false, error: 'registry write failed (ProxyEnable)' };
  if (proxyOrNull) {
    const serverOk = await regPut('ProxyServer', 'REG_SZ', proxyOrNull);
    if (!serverOk) {
      // Leave ProxyEnable=1 without a server → broken state; revert.
      await regPut('ProxyEnable', 'REG_DWORD', '0');
      return { ok: false, error: 'registry write failed (ProxyServer)' };
    }
  }
  refreshWinInet();
  return { ok: true };
}
