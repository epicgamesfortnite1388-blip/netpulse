/**
 * Secure storage bridge — localStorage values, DPAPI-protected
 * on desktop, plaintext on web.
 *
 * The cloud session store must keep the refresh token (30 days)
 * and the derived vault key across restarts for "open the app,
 * still logged in" to work. In the packaged app those values
 * used to sit in localStorage in the clear, readable by any
 * process running as this user. On desktop this module stores
 * them as `dpapi1:<base64>` blobs produced by the Rust
 * `secret_protect` command (CryptProtectData — bound to this
 * user AND this machine), so a stolen profile directory, an
 * off-machine backup, or another user's process cannot decrypt
 * them. In web mode there is no IPC and nothing changes.
 *
 * The store's public API stays synchronous: values live in a
 * memory map that `primeSecureStore()` fills asynchronously at
 * startup (before the session store hydrates). Writes go to the
 * memory map immediately and to storage via fire-and-forget IPC.
 * On desktop a protection failure NEVER falls back to plaintext: the
 * value stays in memory for this session only and the failure is
 * reported once, so a DPAPI hiccup cannot silently strip the
 * user+machine binding from a refresh token or vault key. Web mode
 * has no IPC and keeps its historical plaintext behavior.
 *
 * Legacy plaintext values written by older versions are read as
 * plaintext at prime time and re-encrypted on the next write —
 * migration happens by use, not by a data migration step.
 */
import { hasTauriIpc, tauriInvoke } from '../transport';

/** Marker prefix for DPAPI-protected values in localStorage. */
const MARKER = 'dpapi1:';

/** Only keys under this namespace are ever protected. */
const NAMESPACE = 'np.cloud.';

/** Decrypted values, keyed exactly as they appear in storage. */
const memory = new Map<string, string>();

let primed = false;
let priming: Promise<void> | null = null;

function safeRead(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeWrite(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private-browsing/quota failures degrade to memory-only.
  }
}

function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/**
 * Load and decrypt every namespaced value from storage. Runs
 * once, before the session store hydrates, so the synchronous
 * getters below see decrypted values. Idempotent and safe to
 * call concurrently; failures degrade per-key (an undecryptable
 * blob is dropped rather than failing the app — the user simply
 * re-authenticates).
 */
export async function primeSecureStore(): Promise<void> {
  if (primed) return;
  if (priming) return priming;
  priming = doPrime().finally(() => {
    primed = true;
  });
  return priming;
}

async function doPrime(): Promise<void> {
  // No IPC (web mode): keep the historical plaintext behavior.
  if (!hasTauriIpc()) return;

  const entries: Array<[string, string]> = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(NAMESPACE)) {
        const raw = localStorage.getItem(key);
        if (raw !== null) entries.push([key, raw]);
      }
    }
  } catch {
    return; // storage unavailable — memory-only session
  }

  await Promise.all(
    entries.map(async ([key, raw]) => {
      if (raw.startsWith(MARKER)) {
        try {
          const plain = await tauriInvoke<string>('secret_unprotect', {
            protected: raw.slice(MARKER.length),
          });
          if (typeof plain === 'string') memory.set(key, plain);
        } catch {
          // Corrupted or foreign blob: drop it. The session (or
          // vault key) is re-created rather than the app failing.
          safeRemove(key);
        }
      } else {
        // Legacy plaintext value — re-encrypted on the next write.
        memory.set(key, raw);
      }
    }),
  );
}

/**
 * Read a value. Desktop: from the decrypted memory map (empty
 * until priming completes — startup primes before first read).
 * Web: straight from localStorage, unchanged.
 */
export function secureGet(key: string): string | null {
  if (memory.has(key)) return memory.get(key) ?? null;
  if (!isDesktop()) return safeRead(key);
  return null;
}

/** Warn once per key when desktop protection fails; never log the value. */
const protectionWarnings = new Set<string>();
function reportProtectionFailure(key: string): void {
  if (protectionWarnings.has(key)) return;
  protectionWarnings.add(key);
  console.warn(`[secureStore] secret_protect failed for ${key}; value is memory-only for this session.`);
}

/**
 * Write a value: memory map immediately, storage protected via
 * DPAPI on desktop (fire-and-forget), plaintext on web.
 */
export function secureSet(key: string, value: string): void {
  memory.set(key, value);
  const pending = tauriInvoke<string>('secret_protect', { plain: value });
  if (!pending) {
    // Web mode (no IPC): historical plaintext behavior.
    safeWrite(key, value);
    return;
  }
  void pending
    .then((blob) => {
      if (typeof blob === 'string') safeWrite(key, MARKER + blob);
    })
    .catch(() => {
      // Fail closed (DD-011): the in-memory copy keeps the current session
      // usable, but a secret is never persisted in the clear. Only delete a
      // stored value that is ACTUALLY plaintext — a transient IPC failure
      // must not destroy a still-valid dpapi1: blob written earlier (Kim P2).
      const stored = safeRead(key);
      if (stored !== null && !stored.startsWith(MARKER)) safeRemove(key);
      reportProtectionFailure(key);
    });
}

/** Remove a value from both the memory map and storage. */
export function secureRemove(key: string): void {
  memory.delete(key);
  safeRemove(key);
}

/** True when Tauri IPC is reachable (the packaged desktop app). */
function isDesktop(): boolean {
  return hasTauriIpc();
}
