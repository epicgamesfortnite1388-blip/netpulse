/**
 * useCloudSession — the React binding for the cloud session store.
 *
 * One tiny zustand store so every surface (welcome gate, Account page, nav
 * avatar) renders from the same state object instead of each poking
 * localStorage directly. Auth actions live here too, so the welcome page and
 * the sign-out buttons all share one code path.
 */

import { create } from 'zustand';

import { cloudAuth, CloudError } from './client';
import { currentSession } from './sessionStore';
import type { CloudSessionState, CloudUser } from './types';

interface CloudSessionStore {
  session: CloudSessionState | null;
  ready: boolean;
  /** Sign-in flows set this while the request is in flight. */
  busy: boolean;
  init: () => void;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  signOut: (opts?: { serverRevoke?: boolean }) => Promise<void>;
  refreshUser: (user: CloudUser) => void;
}

export const useCloudSession = create<CloudSessionStore>((set, get) => ({
  session: null,
  ready: false,
  busy: false,
  init: () => {
    set({ session: currentSession(), ready: true });
  },
  login: async (email, password) => {
    set({ busy: true });
    try {
      await cloudAuth.login(email, password);
      set({ session: currentSession() });
    } finally {
      set({ busy: false });
    }
  },
  register: async (email, password) => {
    set({ busy: true });
    try {
      await cloudAuth.register(email, password);
      set({ session: currentSession() });
    } finally {
      set({ busy: false });
    }
  },
  signOut: async () => {
    await cloudAuth.logout(); // clears local state; server revoke is best-effort
    set({ session: null });
  },
  refreshUser: (user) => {
    const s = get().session;
    if (s) set({ session: { ...s, user } });
  },
}));


export { CloudError };
