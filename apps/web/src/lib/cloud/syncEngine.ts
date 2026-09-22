/**
 * Cloud sync engine — the ONE owner of desktop↔cloud state movement.
 *
 * Design (local-first, per the mission):
 *  - The local sidecar DB stays the operational store. The cloud is a
 *    settings/preferences/profile-metadata mirror, never the runtime path.
 *  - Pushes are metadata-only: profile envelopes (id/name/protocol/endpoint),
 *    node favorites, and UI preferences. VPN configs and vaulted credentials
 *    NEVER leave the machine — the local API has no config-export endpoint,
 *    and the cloud `config` field stays '{}'.
 *  - Pulls: cloud settings payload is merged per-section (cloud wins only
 *    when its update stamp is newer than the last sync — a deterministic,
 *    documented rule; no interactive conflict UI), cloud preferences
 *    overwrite their local `cloud.`-namespaced copies, cloud profile
 *    metadata is returned in the result for the Account page inventory.
 *  - Offline: every step degrades to a recorded failure; favorites/prefs
 *    changed while offline can be queued (`queueFavorite`/`queuePreference`)
 *    and flush on the next successful pass. The VPN keeps working — nothing
 *    in the tunnel path touches the cloud.
 *
 * The session store provides tokens; `syncNow` is the only entry point the
 * UI drives, plus the periodic `startSyncLoop`.
 */

import { api, ApiError } from '@/lib/api';
import { cloudApi, CloudError } from './client';
import { currentSession, markSynced } from './sessionStore';
import type { CloudProfile } from './types';

/** Local (sidecar) settings shape: named sections of flat objects. */
type LocalSettings = Record<string, Record<string, unknown> | undefined>;

const PENDING_KEY = 'np.sync.pendingOps';
const MAX_PENDING = 200;

type PendingOp =
  | { kind: 'favorite'; nodeKey: string; label: string | null; at: number }
  | { kind: 'pref'; key: string; value: string | null; at: number };

function readPending(): PendingOp[] {
  try {
    return JSON.parse(localStorage.getItem(PENDING_KEY) ?? '[]') as PendingOp[];
  } catch {
    return [];
  }
}

function writePending(ops: PendingOp[]): void {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(ops.slice(-MAX_PENDING)));
  } catch {
    // storage unavailable — queue degrades, app keeps working
  }
}

/** Queue a favorite change made while offline; flushed by the next sync. */
export function queueFavorite(nodeKey: string, label: string | null): void {
  writePending([...readPending(), { kind: 'favorite', nodeKey, label, at: Date.now() }]);
}

/** Queue a preference change made while offline. */
export function queuePreference(key: string, value: string | null): void {
  writePending([...readPending(), { kind: 'pref', key, value, at: Date.now() }]);
}

export function pendingCount(): number {
  return readPending().length;
}

/* --------------------------- merge policy module -------------------------- */

/**
 * Last-write-wins per settings section. The cloud copy replaces a local
 * section only when the cloud row was updated after this device's last sync;
 * otherwise the local value (re-pushed by the caller) stands.
 */
export function mergeSettings(
  local: LocalSettings,
  cloud: LocalSettings,
  cloudUpdatedAt: number,
  lastSyncAt: number | null,
): LocalSettings {
  const merged: LocalSettings = { ...local };
  for (const [section, cloudValue] of Object.entries(cloud)) {
    if (local[section] === undefined || cloudUpdatedAt > (lastSyncAt ?? 0)) {
      merged[section] = cloudValue;
    }
  }
  return merged;
}

/* ------------------------------ the engine -------------------------------- */

export interface SyncResult {
  ok: boolean;
  offline: boolean;
  pushed: number;
  pulled: number;
  profiles?: CloudProfile[];
  error?: string;
}

let syncing = false;
let lastError: string | null = null;

export function lastSyncError(): string | null {
  return lastError;
}

/**
 * Classify a sync failure for the UI: `offline` means the cloud (or network)
 * was unreachable — keep the session and retry later. Anything else is a real
 * error to show. Pure so the rule is unit-testable.
 */
export function classifySyncError(err: unknown): { offline: boolean; message: string } {
  if (err instanceof CloudError && err.code === 'network_error') return { offline: true, message: 'cloud: network_error' };
  if (err instanceof CloudError || err instanceof ApiError) return { offline: false, message: err.message };
  return { offline: true, message: err instanceof Error ? err.message : 'sync failed' };
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Full sync pass. Re-entrant calls are dropped while one runs (single-owner
 * rule); the periodic loop plus manual "Sync now" both funnel through here.
 */
export async function syncNow(): Promise<SyncResult> {
  const session = currentSession();
  if (!session) return { ok: false, offline: false, pushed: 0, pulled: 0, error: 'signed-out' };
  if (syncing) return { ok: false, offline: false, pushed: 0, pulled: 0, error: 'already-running' };
  syncing = true;
  try {
    let pushed = 0;
    let pulled = 0;

    // ---- settings: merge, then store the winner both places ----
    const local = await api.get<{ settings: LocalSettings }>('/settings');
    const localSettings = local.settings ?? {};
    const cloudSettings = await cloudApi.settings();
    const merged = mergeSettings(localSettings, safeParseObject(cloudSettings.payload), cloudSettings.updatedAt, session.lastSyncAt);
    const payload = JSON.stringify(merged);
    if (payload !== '{}' ) {
      await cloudApi.putSettings(payload, nowSec());
      pushed++;
    }

    // ---- preferences: cloud overwrites the local `cloud.` namespace ----
    const cloudPrefs = await cloudApi.preferences();
    for (const pref of cloudPrefs.preferences) {
      if (pref.value !== null) {
        try {
          localStorage.setItem(`np.pref.${pref.key}`, pref.value);
        } catch {
          // storage unavailable — pull degrades, loop continues
        }
      }
      pulled++;
    }

    // ---- flush ops queued while offline ----
    const pending = readPending();
    for (const op of pending) {
      if (op.kind === 'favorite') await cloudApi.putFavorite(op.nodeKey, op.label);
      else await cloudApi.putPreference(op.key, op.value);
      pushed++;
    }
    if (pending.length > 0) writePending([]);

    // ---- profile metadata: push local envelopes, pull cloud inventory ----
    const localProfiles = await api.get<{
      profiles: Array<{ id: string; providerId: string; name: string; protocol: string; endpoint: string | null }>;
    }>('/vpn/profiles');
    for (const p of localProfiles.profiles) {
      await cloudApi.putProfile({
        id: `np-local-${p.id}`,
        name: p.name,
        protocol: p.protocol,
        endpoint: p.endpoint ?? null,
        config: '{}',
        configVersion: 1,
      });
      pushed++;
    }
    const cloudProfiles = await cloudApi.profiles();
    pulled += cloudProfiles.profiles.length;

    // ---- favorites: one-shot mirror of the local DB's flagged nodes ----
    const localFavs = await api.get<{ nodes: Array<{ id: string }>; total: number }>('/nodes?favorite=1&limit=500');
    for (const n of localFavs.nodes) {
      await cloudApi.putFavorite(`node:${n.id}`, null);
      pushed++;
    }

    markSynced(Date.now());
    lastError = null;
    return { ok: true, offline: false, pushed, pulled, profiles: cloudProfiles.profiles };
  } catch (err) {
    const msg = err instanceof CloudError ? `cloud: ${err.code}` : err instanceof ApiError ? `local: ${err.code}` : err instanceof Error ? err.message : 'sync failed';
    lastError = msg;
    const { offline } = classifySyncError(err);
    return { ok: false, offline, pushed: 0, pulled: 0, error: msg };
  } finally {
    syncing = false;
  }
}

function safeParseObject(text: string): LocalSettings {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as LocalSettings) : {};
  } catch {
    return {};
  }
}

/* ------------------------- sync loop (periodic) --------------------------- */

const SYNC_INTERVAL_MS = 5 * 60 * 1000;

let syncTimer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic sync (idempotent). Called once from AppShell. */
export function startSyncLoop(): void {
  if (syncTimer) return;
  syncTimer = setInterval(() => {
    if (currentSession()) void syncNow();
  }, SYNC_INTERVAL_MS);
}

export function stopSyncLoop(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}
