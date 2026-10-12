/**
 * useCloudSession — the React binding for the cloud session.
 *
 * The session object itself is NOT held here. It lives in exactly one place,
 * `useSessionStore` (sessionStore.ts), and every writer — sign-in, the token
 * refresh inside a request, a finished sync, sign-out — publishes into that
 * store. Components that need the session select it from there:
 *
 *     const session = useSessionStore((s) => s.session);
 *
 * This store owns only what is genuinely its own: whether the first storage
 * read has happened, the sign-in form's busy flag, and the vault key status.
 * Holding a second copy of the session here is what made the two drift — the
 * account page rendered a snapshot taken at mount while the sync engine
 * stamped `lastSyncAt` elsewhere, and papering over that needed a
 * `refreshSession()` the sync path had to remember to call.
 */

import { create } from 'zustand';

import { cloudAuth, CloudError } from './client';
import { initSession } from './sessionStore';
import { primeSecureStore } from './secureStore';
import { ensureVaultKeyForAccount, loadVaultKey, type VaultKeyState } from './vaultKey';

interface CloudSessionStore {
  /** The first read of persisted session state has happened. */
  ready: boolean;
  /** Sign-in flows set this while the request is in flight. */
  busy: boolean;
  /** E2E backup key availability on this device (drives the Account UI). */
  vault: VaultKeyState;
  init: () => Promise<void>;
  /** `timeoutMs` lets a retry wait longer than the first, fast attempt. */
  login: (email: string, password: string, timeoutMs?: number) => Promise<void>;
  register: (email: string, password: string, timeoutMs?: number) => Promise<void>;
  signOut: (opts?: { serverRevoke?: boolean }) => Promise<void>;
  refreshVault: () => Promise<void>;
  unlockVault: (password: string) => Promise<void>;
}

export const useCloudSession = create<CloudSessionStore>((set, get) => ({
  ready: false,
  busy: false,
  vault: 'signed-out',
  init: async () => {
    // Decrypt persisted values (DPAPI on desktop) BEFORE the session
    // store hydrates — initSession reads through the secure store,
    // which serves decrypted values from its memory map.
    await primeSecureStore();
    // Publishing the session is initSession's job; this store only has to say
    // that reading is done, which is what un-gates the Account page.
    initSession();
    set({ ready: true });
    void get().refreshVault();
  },
  login: async (email, password, timeoutMs) => {
    set({ busy: true });
    try {
      await cloudAuth.login(email, password, timeoutMs);
      // Derive the E2E backup key while the password is still in hand; a
      // failure here must never block login — the vault stays locked with
      // an honest status and can be unlocked later.
      set({ vault: await ensureVaultKeyForAccount(password) });
    } finally {
      set({ busy: false });
    }
  },
  register: async (email, password, timeoutMs) => {
    set({ busy: true });
    try {
      await cloudAuth.register(email, password, timeoutMs);
      set({ vault: await ensureVaultKeyForAccount(password) });
    } finally {
      set({ busy: false });
    }
  },
  signOut: async () => {
    // `cloudAuth.logout` calls `clearSession`, which empties `useSessionStore`
    // — the sign-out gate follows from that one write. Nothing to set here.
    await cloudAuth.logout(); // clears local state; server revoke is best-effort
  },
  refreshVault: async () => {
    const { state } = await loadVaultKey();
    set({ vault: state });
  },
  unlockVault: async (password) => {
    set({ vault: await ensureVaultKeyForAccount(password) });
  },
}));


export { CloudError };