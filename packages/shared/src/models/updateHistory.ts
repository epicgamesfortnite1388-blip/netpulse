/**
 * Update history — the contract for what the updater did, when, and why.
 *
 * The desktop UI records every feed check and install attempt (including the
 * real failure reason) to the sidecar, which stores it in the existing
 * append-only `node_events` log (kind `update-feed:history`) — the same
 * bounded event log the VPN history uses. Rows are read back here, newest
 * first.
 *
 * The wording helpers are pure display policy: one owner so the fold summary,
 * the history rows, and any future surface cannot drift into different
 * accounts of the same outcome. The rule is the one this codebase already
 * uses for node tests: a failure is reported with the REAL reason the updater
 * produced, never dressed up as success and never blank.
 */

/** One recorded update check or install attempt. */
export interface UpdateHistoryEntry {
  id: number;
  kind: 'check' | 'install';
  /** check: what the feed said. install: how far it got. */
  outcome: 'up-to-date' | 'available' | 'failed' | 'started' | 'completed';
  /** Version the app was running when the event happened. */
  fromVersion: string | null;
  /** Version seen on the feed (available/started/completed). */
  toVersion: string | null;
  /** The real error text on a failed check or install; null otherwise. */
  reason: string | null;
  /** Epoch ms. */
  at: number;
}

/** What the UI posts to record one event (server assigns id + at). */
export interface RecordUpdateEventInput {
  kind: UpdateHistoryEntry['kind'];
  outcome: UpdateHistoryEntry['outcome'];
  fromVersion?: string | null;
  toVersion?: string | null;
  reason?: string | null;
}

/** The event-log kind update history lives under (see vpnHistory precedent). */
export const UPDATE_HISTORY_KIND = 'update-feed:history';

/** How much history is returned / kept — bounded like every event kind. */
export const MAX_UPDATE_HISTORY = 100;

/**
 * One honest line per row: what happened, in the past tense, with the real
 * version or reason. A failed check never reads as success; a failed install
 * carries the actual error text.
 */
export function updateEventLine(e: UpdateHistoryEntry): string {
  switch (e.outcome) {
    case 'up-to-date':
      return 'Checked for updates — running the latest version.';
    case 'available':
      return `Update available: NetPulse ${e.toVersion ?? 'unknown version'}.`;
    case 'started':
      return `Downloading and installing NetPulse ${e.toVersion ?? 'the update'}…`;
    case 'completed':
      return `Updated to NetPulse ${e.toVersion ?? 'the new version'}.`;
    case 'failed':
      if (e.kind === 'install') {
        return `Install failed: ${e.reason ?? 'the updater reported an error without a reason'}`;
      }
      return `Update check failed: ${e.reason ?? 'the updater reported an error without a reason'}`;
  }
}

/** Compact icon-ish tone for a row, so failures stand out without color-only cues. */
export type UpdateEventTone = 'ok' | 'info' | 'error';

export function updateEventTone(e: UpdateHistoryEntry): UpdateEventTone {
  if (e.outcome === 'failed') return 'error';
  if (e.outcome === 'available' || e.outcome === 'started') return 'info';
  return 'ok';
}

/**
 * The folded header's summary: true counts, or the honest empty state. Never
 * claims history exists when nothing was recorded yet.
 */
export function updateHistorySummary(entries: UpdateHistoryEntry[]): string {
  if (entries.length === 0) return 'no update activity recorded yet';
  const failed = entries.filter((e) => e.outcome === 'failed').length;
  const updated = entries.filter((e) => e.outcome === 'completed').length;
  const parts: string[] = [`${entries.length} recorded event${entries.length === 1 ? '' : 's'}`];
  if (updated > 0) parts.push(`${updated} installed`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(' · ');
}

/**
 * Proactive surfacing: the NEWEST check event decides the dashboard warning.
 * A failed check surfaces; a newer check that succeeded (including the
 * 'available' outcome that always precedes an install) means the failure is
 * already stale, so the app stays silent. Returns the failed ENTRY (not
 * pre-worded text) so every surface renders it through `updateEventLine` and
 * the warning can never drift from the history card's account of the same
 * event. Null renders nothing, which is the common case. Install events and
 * failed INSTALLS stay out of scope here: they are visible on the history
 * card and never block the running app the way a dead check silently does.
 */
export function lastFailedCheck(entries: UpdateHistoryEntry[]): UpdateHistoryEntry | null {
  const last = entries.find((e) => e.kind === 'check');
  if (!last || last.outcome !== 'failed') return null;
  return last;
}
