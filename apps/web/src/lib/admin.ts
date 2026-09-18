import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api';
import { isDesktop, tauriInvoke } from '@/lib/transport';

import type { AdminStatus, DesktopAdminRights } from '@netpulse/shared';

/**
 * Administrator rights, as the UI consumes them.
 *
 * Two independent observations, deliberately kept apart:
 *
 *   - `useAdminStatus()` asks the BACKEND, which runs the cores. Its answer is
 *     what decides whether a TUN adapter or a WireGuard service install can
 *     work, because it is the process that would attempt them.
 *   - `useDesktopAdminRights()` asks the TAURI SHELL about its own process over
 *     typed IPC. Only it can raise a UAC prompt, so only it can say whether a
 *     one-click relaunch is possible.
 *
 * Both are real OS checks (`net session`). Nothing here infers a privilege from
 * a setting, and nothing renders a capability the observed state does not
 * support.
 */

export function useAdminStatus() {
  return useQuery({
    queryKey: ['vpn', 'admin'],
    queryFn: () => api.get<{ admin: AdminStatus }>('/vpn/admin'),
    // The answer changes only when the process restarts, so this is a slow poll
    // — it exists so a relaunch/elevation elsewhere in the app is picked up
    // without a manual refresh.
    refetchInterval: 30_000,
  });
}

/** The shell's own elevation state (desktop only; never invented in web mode). */
export function useDesktopAdminRights() {
  return useQuery({
    queryKey: ['desktop', 'admin'],
    queryFn: async (): Promise<DesktopAdminRights | null> => {
      const invoke = tauriInvoke<DesktopAdminRights>;
      if (!invoke) return null;
      try {
        return await invoke('admin_status');
      } catch {
        return null;
      }
    },
    enabled: isDesktop(),
    staleTime: 30_000,
  });
}

/**
 * Re-probe privileges after an elevated relaunch or a Settings change, so the
 * UI does not keep showing a cached "no admin".
 */
export function useRecheckAdmin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ admin: AdminStatus }>('/vpn/admin/recheck'),
    onSuccess: (data) => {
      qc.setQueryData(['vpn', 'admin'], data);
      void qc.invalidateQueries({ queryKey: ['desktop', 'admin'] });
    },
  });
}

export interface RelaunchOutcome {
  /** True once the helper is armed and the app has been asked to quit. */
  armed: boolean;
  /** What to tell the user, in the words of whatever actually happened. */
  message: string;
}

/**
 * One-click elevated relaunch.
 *
 * SINGLE CALL: the Rust command arms the detached helper (which waits for this
 * process to exit, then raises the one UAC prompt) and quits the app itself.
 * The quit is part of the command — offering it as a second step was the bug:
 * a caller that armed without quitting left an invisible helper waiting on a
 * process that never exited, and a UAC prompt that led nowhere.
 *
 * The quit tears the tunnel down through the normal exit path, so no system
 * proxy or route is left pointing at a core that is about to die.
 */
export function useElevatedRelaunch() {
  return useMutation({
    mutationFn: async (): Promise<RelaunchOutcome> => {
      if (!isDesktop()) {
        return {
          armed: false,
          message: 'Elevation is only available in the desktop app — this is the browser build, so there is no process to relaunch.',
        };
      }
      const invoke = tauriInvoke<boolean>;
      try {
        // The command returns `true` AFTER arming the helper; the process then
        // exits on its own, so this promise may never resolve on the wire —
        // treat a transport error after the call as the expected shutdown.
        await invoke('relaunch_as_admin');
      } catch (err) {
        return { armed: false, message: err instanceof Error ? err.message : String(err) };
      }
      return { armed: true, message: 'The app is restarting with administrator rights — approve the Windows prompt.' };
    },
  });
}
