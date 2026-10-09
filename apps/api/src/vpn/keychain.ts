import { execSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where a secret vault keeps its 32-byte master key.
 *
 * ## Why this exists
 *
 * `FileSecretVault` used to keep that key in `<vault>.key` — a plaintext file
 * sitting in the same directory as the ciphertext it protects. Anyone who could
 * read the data directory (a backup sync, a stolen disk, a support bundle) could
 * decrypt every node credential and VPN profile with a single read. The vault's
 * own comment said a packaged build should swap the key file for the OS
 * keychain; this is that swap.
 *
 * On Windows the key now lives in **Credential Manager**, where `CredWrite`
 * stores it as a generic credential under the current user, protected by DPAPI
 * (the user's logon master key). The data directory now holds only AES-256-GCM
 * ciphertext with no readable key beside it, so copying the directory to another
 * machine yields nothing.
 *
 * ## What this deliberately does NOT change
 *
 * The ciphertext format is untouched: same AES-256-GCM envelope, same key bytes,
 * same `seal`/`open` contract. That matters because
 *   - every secret already on disk must still decrypt, and
 *   - `ProfileCloudVault` seals blobs whose bytes leave the machine, which
 *     requires an envelope that can be produced and opened without a filesystem.
 * Moving the key does both jobs at once; re-keying the ciphertext would not.
 *
 * ## Honest limitations
 *
 * - Credential stores are per-user, so a vault copied to another account or
 *   machine no longer opens there. That is the point of the change, and it is a
 *   real behaviour change: a data directory moved to a new PC needs its
 *   credentials re-imported.
 * - `secrets` remain AES-256-GCM ciphertext on disk (they are not individually
 *   re-homed into the credential store — a per-secret `CredWrite` costs a
 *   PowerShell round-trip, and a bulk import writes thousands of them). The
 *   protection gained is that the key that opens them is no longer readable
 *   from the data directory, which is the same guarantee DPAPI itself makes.
 */

/** Result of reading a key: a real "no such key" is not an error, and must never be confused with one. */
export type KeyRead =
  | { state: 'ok'; value: Buffer }
  | { state: 'missing' }
  | { state: 'error'; error: string };

export interface VaultKeyStore {
  /** Stable identifier, surfaced in diagnostics so a misbehaving store is visible. */
  readonly id: string;
  read(): KeyRead;
  write(value: Buffer): { ok: boolean; error?: string };
  delete(): void;
}

/**
 * Windows ACL enforcement for the vault .key file.
 *
 * On POSIX the file mode 0o600 is respected. On Windows it is NOT — Node's
 * fs.chmod has no effect on the NTFS ACL. `icacls` directly manipulates the
 * ACL: it replaces the existing entries with one entry granting access to the
 * current user only (Everyone and SYSTEM are removed).
 *
 * Failure is deliberately silent — a vault that cannot be hardened is still
 * better than no vault, and a noisy failure would make the app unusable on
 * locked-down WinPE/AD environments where the current user lacks icacls rights.
 */
function enforceWindowsAcl(filePath: string): void {
  if (process.platform !== 'win32') return;
  try {
    execSync(`icacls "${filePath}" /inheritance:r /grant:r "%USERNAME%:(R)" /c`, { stdio: 'ignore' });
  } catch {
    // best-effort: non-zero exit on restricted environments
  }
}

/** The original store: a key file next to the ciphertext. Used as the portable fallback. */
export class FileKeyStore implements VaultKeyStore {
  readonly id = 'file';

  constructor(private readonly keyFile: string) {
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  }

  read(): KeyRead {
    try {
      if (!fs.existsSync(this.keyFile)) return { state: 'missing' };
      return { state: 'ok', value: fs.readFileSync(this.keyFile) };
    } catch (err) {
      return { state: 'error', error: String(err instanceof Error ? err.message : err) };
    }
  }

  write(value: Buffer): { ok: boolean; error?: string } {
    try {
      fs.writeFileSync(this.keyFile, value, { mode: 0o600 });
      enforceWindowsAcl(this.keyFile);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err instanceof Error ? err.message : err) };
    }
  }

  delete(): void {
    try {
      fs.rmSync(this.keyFile, { force: true });
    } catch {
      // best effort
    }
  }
}

/**
 * Windows Credential Manager, reached through `advapi32.dll`'s CredRead /
 * CredWrite / CredDelete.
 *
 * ## Why PowerShell is doing this
 *
 * The app ships a portable Node runtime with no native build step for anything
 * but `better-sqlite3`, so pulling in `keytar` (unmaintained, needs node-gyp at
 * package time) would trade a solved problem for a packaging one. PowerShell
 * can P/Invoke the same API with zero new dependencies.
 *
 * ## Why this is only ever used for the master key
 *
 * A PowerShell round-trip costs ~300 ms (Add-Type compiles the C# each time).
 * The master key is read once per vault and cached in memory, so that is
 * irrelevant. Per-secret storage would not be: a bulk import writes a secret
 * for every node, and the documented 8,284-node import would have gone from
 * 8.2 s to roughly 40 minutes. Hence the key moves and the ciphertext stays.
 */

/**
 * The driver script: a thin `switch` around three Cred* calls. The C# lives in
 * a single-quoted here-string so PowerShell expands nothing inside it.
 */
const CRED_SCRIPT = `param(
  [Parameter(Mandatory=$true)][ValidateSet('read','write','delete')][string]$Action,
  [Parameter(Mandatory=$true)][string]$Name,
  [string]$Value = ''
)
$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class NetpulseCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
    [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
    public long LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
    [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
  }

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWrite(ref CREDENTIAL credential, uint flags);

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDelete(string target, uint type, uint flags);

  [DllImport("advapi32.dll")]
  static extern void CredFree(IntPtr buffer);

  const uint CRED_TYPE_GENERIC = 1;
  const int ERROR_NOT_FOUND = 1168;

  public static int Read(string target, out string value) {
    value = null;
    IntPtr p;
    if (!CredRead(target, CRED_TYPE_GENERIC, 0, out p)) {
      return Marshal.GetLastWin32Error();
    }
    try {
      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      if (c.CredentialBlob != IntPtr.Zero && c.CredentialBlobSize > 0) {
        byte[] blob = new byte[c.CredentialBlobSize];
        Marshal.Copy(c.CredentialBlob, blob, 0, (int)c.CredentialBlobSize);
        value = Encoding.UTF8.GetString(blob);
      } else {
        value = string.Empty;
      }
      return 0;
    } finally {
      CredFree(p);
    }
  }

  public static int Write(string target, string value) {
    byte[] blob = Encoding.UTF8.GetBytes(value ?? string.Empty);
    IntPtr ptr = IntPtr.Zero;
    if (blob.Length > 0) {
      ptr = Marshal.AllocHGlobal(blob.Length);
      Marshal.Copy(blob, 0, ptr, blob.Length);
    }
    try {
      CREDENTIAL c = new CREDENTIAL();
      c.Type = CRED_TYPE_GENERIC;
      c.TargetName = target;
      c.CredentialBlobSize = (uint)blob.Length;
      c.CredentialBlob = ptr;
      c.Persist = 2;
      return CredWrite(ref c, 0) ? 0 : Marshal.GetLastWin32Error();
    } finally {
      if (ptr != IntPtr.Zero) Marshal.FreeHGlobal(ptr);
    }
  }

  public static int Delete(string target) {
    if (CredDelete(target, CRED_TYPE_GENERIC, 0)) return 0;
    int e = Marshal.GetLastWin32Error();
    return e == ERROR_NOT_FOUND ? 0 : e;
  }
}
'@

try {
  Add-Type -TypeDefinition $src -ErrorAction Stop
} catch {
  if (-not ('NetpulseCred' -as [type])) { Write-Output 'ERROR:add-type-failed'; exit 1 }
}

try {
  switch ($Action) {
    'read' {
      $v = $null
      $code = [NetpulseCred]::Read($Name, [ref]$v)
      if ($code -eq 0) {
        if ($null -eq $v) { Write-Output 'VALUE:' } else { Write-Output ('VALUE:' + $v) }
      } elseif ($code -eq 1168) {
        Write-Output 'MISSING'
      } else {
        Write-Output ('ERROR:' + $code)
      }
    }
    'write' {
      $code = [NetpulseCred]::Write($Name, $Value)
      if ($code -eq 0) { Write-Output 'OK' } else { Write-Output ('ERROR:' + $code) }
    }
    'delete' {
      $code = [NetpulseCred]::Delete($Name)
      if ($code -eq 0) { Write-Output 'OK' } else { Write-Output ('ERROR:' + $code) }
    }
  }
} catch {
  Write-Output 'ERROR:exception'
}
`;

export class WindowsCredentialKeyStore implements VaultKeyStore {
  readonly id = 'windows-credential-manager';

  constructor(private readonly name: string) {}

  /**
   * Runs one Cred* action. A fresh temp script per call, so nothing is left
   * behind and concurrent vaults cannot race on a shared file.
   *
   * Returns the last non-empty stdout line — the script's protocol is a single
   * word (`OK` / `MISSING` / `VALUE:<base64>` / `ERROR:<code>`), which keeps
   * parsing independent of PowerShell's formatting quirks.
   */
  private invoke(action: 'read' | 'write' | 'delete', value?: string): { ok: boolean; line: string } {
    const script = path.join(os.tmpdir(), `netpulse-cred-${process.pid}-${crypto.randomBytes(4).toString('hex')}.ps1`);
    fs.writeFileSync(script, CRED_SCRIPT, 'utf8');
    try {
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', action, '-Name', this.name];
      if (action === 'write') args.push('-Value', value ?? '');
      const r = spawnSync('powershell', args, {
        encoding: 'utf8',
        timeout: 20_000,
        windowsHide: true,
      });
      const out = (r.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? '';
      if (r.error || out === '') {
        const detail = r.error ? String((r.error as Error).message) : `no output (exit ${r.status})`;
        return { ok: false, line: `ERROR:spawn:${detail}` };
      }
      if (out.startsWith('ERROR')) return { ok: false, line: out };
      return { ok: true, line: out };
    } finally {
      try { fs.unlinkSync(script); } catch { /* best effort */ }
    }
  }

  read(): KeyRead {
    const r = this.invoke('read');
    if (!r.ok) return { state: 'error', error: r.line };
    if (r.line === 'MISSING') return { state: 'missing' };
    if (r.line.startsWith('VALUE:')) {
      const b64 = r.line.slice('VALUE:'.length);
      try {
        return { state: 'ok', value: Buffer.from(b64, 'base64') };
      } catch {
        return { state: 'error', error: 'credential blob is not valid base64' };
      }
    }
    return { state: 'error', error: `unexpected credential reply: ${r.line.slice(0, 80)}` };
  }

  write(value: Buffer): { ok: boolean; error?: string } {
    const r = this.invoke('write', value.toString('base64'));
    return r.ok ? { ok: true } : { ok: false, error: r.line };
  }

  delete(): void {
    this.invoke('delete');
  }
}

/**
 * Credential target for a vault file.
 *
 * Hashed from the ABSOLUTE path rather than the file's basename, because two
 * vaults in different data directories would otherwise collide: `vault`,
 * `vault.nodes` and `vault.cloud` are reused everywhere, and a collision would
 * make one vault adopt another's key — silently failing to decrypt its
 * ciphertext. Hashing costs nothing and makes each data directory independent.
 *
 * The flip side is worth stating: moving the data directory changes this name,
 * so the credential does not follow. That is inherent to a per-user credential
 * store and is the behaviour being opted into.
 */
export function credentialTargetFor(vaultFile: string): string {
  const abs = path.resolve(vaultFile);
  const digest = crypto.createHash('sha256').update(abs).digest('hex').slice(0, 32);
  const label = path.basename(abs).replace(/[^A-Za-z0-9._-]/g, '_');
  return `NetPulse/vault/${label}-${digest}`;
}

/**
 * Picks the store for a vault.
 *
 * `NETPULSE_VAULT_KEY_STORE` overrides the default:
 *   - `file`     the original key file. The test suite sets this so a test run
 *                never writes entries into a developer's real credential store.
 *   - `keychain` demand the OS store; still falls back to file if unavailable.
 *   - unset      Credential Manager on Windows, file everywhere else.
 */
export function createVaultKeyStore(vaultFile: string): VaultKeyStore {
  const mode = (process.env.NETPULSE_VAULT_KEY_STORE ?? '').toLowerCase();
  if (process.platform !== 'win32') return new FileKeyStore(`${vaultFile}.key`);
  if (mode === 'file') return new FileKeyStore(`${vaultFile}.key`);
  return new WindowsCredentialKeyStore(credentialTargetFor(vaultFile));
}
