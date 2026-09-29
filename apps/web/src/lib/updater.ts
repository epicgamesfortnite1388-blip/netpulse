/**
 * Updater bridge — the UI's single seam to tauri-plugin-updater.
 *
 * The plugin is invoked through the `withGlobalTauri` bundle (`window.__TAURI__.updater`),
 * which the plugin injects when present — no npm dependency needed, matching how
 * transport.ts reaches the core APIs. Every call is null-safe: in web mode (or a
 * shell without the plugin) there is simply no updater, and callers get `null`
 * states they can render honestly.
 *
 * Contract (from tauri-plugin-updater 2.11 source, commands.rs):
 *   check()            -> Update | null   (Update = rid + currentVersion + version + date + body)
 *   downloadAndInstall -> Started{contentLength} / Progress{chunkLength} / Finished events
 *   restart_after_install: true          -> the app relaunches itself after install
 */

export interface UpdateInfo {
  /** Version found on the feed (semver string). */
  version: string;
  /** Version currently running. */
  currentVersion: string;
  /** Release notes body from latest.json (markdown/plain text), if any. */
  body: string | null;
  /** RFC3339 publish date from the manifest, if any. */
  date: string | null;
}

export interface DownloadProgress {
  /** Total bytes when the feed declares them; null when it does not. */
  contentLength: number | null;
  /** Received so far. */
  received: number;
  /** true on the terminal Finished event. */
  done: boolean;
}

interface PluginUpdate {
  rid: number;
  available: boolean;
  currentVersion: string;
  version: string;
  date: string | null;
  body: string | null;
  downloadAndInstall(
    onEvent?: (ev: unknown) => void,
    opts?: { restartAfterInstall?: boolean; timeout?: number },
  ): Promise<void>;
  close(): Promise<void>;
}

interface UpdaterPlugin {
  check(opts?: { timeout?: number }): Promise<PluginUpdate | null>;
}

interface UpdaterGlobals {
  __TAURI__?: { updater?: UpdaterPlugin; core?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> } };
}

function plugin(): UpdaterPlugin | null {
  const w = window as unknown as UpdaterGlobals;
  return w.__TAURI__?.updater ?? null;
}

/** The shell's proxy-safe commands (see src-tauri/src/updater_feed.rs): the
 *  local feed lives on the sidecar's loopback port, which a system proxy
 *  would otherwise swallow. Present only in builds that ship the fix. */
function feedInvoke(): ((cmd: string, args?: unknown) => Promise<unknown>) | null {
  const w = window as unknown as UpdaterGlobals;
  return w.__TAURI__?.core?.invoke ?? null;
}

/** True only when the real desktop updater plugin is reachable. */
export function updaterAvailable(): boolean {
  return plugin() !== null;
}

import { api } from '@/lib/api';

import type { RecordUpdateEventInput, UpdateHistoryEntry } from '@netpulse/shared';

/**
 * Update-history recorder. Fire-and-forget: history must never break the
 * update flow it records (web mode / offline / sidecar down all swallow).
 * Every check and install from every surface passes through this module, so
 * this is the one place recording can live.
 */
function recordUpdateEvent(input: RecordUpdateEventInput): void {
  void api.post('/update-history', input).catch(() => {
    /* best-effort by design */
  });
}

/** Newest-first update history (empty on any failure — never a fake row). */
export async function fetchUpdateHistory(limit = 100): Promise<UpdateHistoryEntry[]> {
  try {
    const out = await api.get<{ events: UpdateHistoryEntry[] }>(`/update-history?limit=${limit}`);
    return Array.isArray(out?.events) ? out.events : [];
  } catch {
    return [];
  }
}

/**
 * Boot reconciliation: if the previous session died mid-install (the normal
 * successful path — the shell exits while the NSIS installer runs), close the
 * loop by recording 'completed' once the new version is actually running.
 * Only fires when the newest event is that unmatched 'started' for exactly
 * this version, so repeated boots and already-closed installs never double.
 */
export async function reconcileInstallCompletion(currentVersion: string): Promise<void> {
  try {
    const events = await fetchUpdateHistory(1);
    const last = events[0];
    if (last?.kind === 'install' && last.outcome === 'started' && last.toVersion === currentVersion) {
      recordUpdateEvent({ kind: 'install', outcome: 'completed', fromVersion: last.fromVersion, toVersion: currentVersion });
    }
  } catch {
    /* best-effort by design */
  }
}
/**
 * Poll the feed once. Returns:
 *   - { kind: 'up-to-date' } — feed answered, no newer version
 *   - { kind: 'available', update } — a real update with notes
 *   - { kind: 'unavailable', reason } — no desktop bridge, or the check failed
 *     (offline, feed unset/placeholder, feed unreachable). The reason string is
 *     the plugin's own error text, never invented here.
 */
export type CheckResult =
  | { kind: 'up-to-date' }
  | { kind: 'available'; update: UpdateInfo }
  | { kind: 'unavailable'; reason: string };

export async function checkForUpdate(): Promise<CheckResult> {
  const p = plugin();
  if (!p) return { kind: 'unavailable', reason: 'no-updater' }; // web mode: nothing happened, nothing recorded
  try {
    // The shell's feed_check bypasses the system proxy for loopback feeds
    // (the plugin's own check cannot). Falls back to the plugin command when
    // the running shell predates it.
    const invoke = feedInvoke();
    if (invoke) {
      const feed = (await invoke('feed_check')) as {
        available: boolean; version: string; currentVersion: string; body?: string | null;
      } | null;
      if (!feed) {
        recordUpdateEvent({ kind: 'check', outcome: 'failed', reason: 'feed_check returned nothing' });
        return { kind: 'unavailable', reason: 'feed_check returned nothing' };
      }
      if (!feed.available) {
        recordUpdateEvent({ kind: 'check', outcome: 'up-to-date', fromVersion: feed.currentVersion });
        return { kind: 'up-to-date' };
      }
      recordUpdateEvent({ kind: 'check', outcome: 'available', fromVersion: feed.currentVersion, toVersion: feed.version });
      return {
        kind: 'available',
        update: {
          version: feed.version,
          currentVersion: feed.currentVersion,
          body: feed.body ?? null,
          date: null,
        },
      };
    }
    // Bounded timeout: a feed that never answers must not hold the launch poll.
    const found = await p.check({ timeout: 15_000 });
    if (!found) {
      // Plugin path cannot report the current version here; null is the truth.
      recordUpdateEvent({ kind: 'check', outcome: 'up-to-date' });
      return { kind: 'up-to-date' };
    }
    recordUpdateEvent({ kind: 'check', outcome: 'available', fromVersion: found.currentVersion, toVersion: found.version });
    return {
      kind: 'available',
      update: {
        version: found.version,
        currentVersion: found.currentVersion,
        body: found.body ?? null,
        date: found.date ?? null,
      },
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    recordUpdateEvent({ kind: 'check', outcome: 'failed', reason });
    return { kind: 'unavailable', reason };
  }
}

/**
 * Download + install the update, then relaunch the app
 * (`restart_after_install: true` — the plugin runs the NSIS installer and
 * restarts). Reports progress as received bytes; `contentLength` may be null
 * when the feed does not declare it.
 */
export async function installUpdate(
  update: UpdateInfo,
  onProgress?: (p: DownloadProgress) => void,
): Promise<void> {
  const p = plugin();
  if (!p) throw new Error('no-updater');
  // Shell path: feed_install downloads (signature-verified in Rust), runs the
  // installer and restarts. Progress is coarse (no per-chunk events yet).
  const invoke = feedInvoke();
  if (invoke) {
    onProgress?.({ contentLength: null, received: 0, done: false });
    // 'started' is the last row this dying instance can write on success —
    // reconcileInstallCompletion() closes the loop after the new version boots.
    recordUpdateEvent({ kind: 'install', outcome: 'started', fromVersion: update.currentVersion, toVersion: update.version });
    try {
      await invoke('feed_install');
    } catch (err) {
      recordUpdateEvent({
        kind: 'install',
        outcome: 'failed',
        fromVersion: update.currentVersion,
        toVersion: update.version,
        reason: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    onProgress?.({ contentLength: null, received: 0, done: true });
    return;
  }
  // The Update object (with its resource id) only lives in the plugin's
  // resources table — re-check to fetch it fresh rather than caching an rid
  // across poll cycles (the feed may have changed between poll and click).
  const found = await p.check({ timeout: 15_000 });
  if (!found || found.version !== update.version) {
    throw new Error('update-changed');
  }
  let received = 0;
  let contentLength: number | null = null;
  await found.downloadAndInstall(
    (ev: unknown) => {
      const e = ev as { event: string; data: { contentLength?: unknown; chunkLength?: unknown } };
      if (e.event === 'started') {
        contentLength = typeof e.data.contentLength === 'number' ? e.data.contentLength : null;
        received = 0;
      } else if (e.event === 'progress') {
        received += typeof e.data.chunkLength === 'number' ? e.data.chunkLength : 0;
      } else if (e.event === 'finished') {
        onProgress?.({ contentLength, received, done: true });
        return;
      }
      onProgress?.({ contentLength, received, done: false });
    },
    { restartAfterInstall: true },
  );
}

/**
 * Pure policy: what the user is told about the update state.
 *
 * Kept beside the `CheckResult` union it switches on (it IS the wording of
 * that union), so the honest-wording rules are testable without a DOM and no
 * component can drift from the bridge's contract. Every branch states what
 * actually happened — a failed check never reads as "up to date", and an
 * unavailable updater in web mode says nothing at all (rendering an update
 * surface where none can exist would be noise).
 */
export function updateNotice(result: CheckResult | null, dismissed: boolean): string | null {
  if (result === null || dismissed) return null;
  switch (result.kind) {
    case 'available':
      return `NetPulse ${result.update.version} is available`;
    case 'up-to-date':
      return null; // healthy default: silence, not a nightly "you are current" banner
    case 'unavailable':
      // Web mode (no desktop bridge) can never update itself — not an error.
      return result.reason === 'no-updater' ? null : `Update check failed: ${result.reason}`;
  }
}

/** Small presentational helper shared by both surfaces: the honest status line
 * for a completed check when nothing is downloading. */
export function statusLine(result: CheckResult | null): string | null {
  if (result === null) return null;
  switch (result.kind) {
    case 'available':
      return `NetPulse ${result.update.version} is available`;
    case 'up-to-date':
      return 'You are on the latest version.';
    case 'unavailable':
      // Web mode (no desktop bridge) can never update itself — not an error.
      return result.reason === 'no-updater' ? null : `Update check failed: ${result.reason}`;
  }
}
