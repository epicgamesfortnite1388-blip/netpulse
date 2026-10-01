/**
 * Update history — persistence for what the updater did, when, and why.
 *
 * Storage reuses the existing append-only `node_events` log with a namespaced
 * kind (`update-feed:history`), exactly the pattern vpnHistory uses for
 * discovery/quick-connect runs: bounded storage, newest kept, no new table,
 * no migration. Every write is best-effort — history must never break the
 * update flow it is recording.
 */
import {
  MAX_UPDATE_HISTORY,
  UPDATE_HISTORY_KIND,
  type RecordUpdateEventInput,
  type UpdateHistoryEntry,
} from '@netpulse/shared';

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Minimal event-log seam; `NodeEventsRepository` satisfies it. */
export interface UpdateHistoryEventStore {
  insert(row: { kind: string; at: number; payload: Record<string, unknown> }): void;
  recent(kind: string, limit: number): Array<{ id: number; kind: string; at: number; payload: Record<string, unknown> }>;
  /** Deletes every row of one kind; returns how many were removed. */
  clearKind(kind: string): number;
}

const OUTCOMES: ReadonlySet<string> = new Set(['up-to-date', 'available', 'failed', 'started', 'completed']);

/** Defensive row parse: malformed payloads are dropped, never invented around. */
function toEntry(id: number, at: number, payload: Record<string, unknown>): UpdateHistoryEntry | null {
  const kind = payload['kind'];
  const outcome = payload['outcome'];
  if ((kind !== 'check' && kind !== 'install') || typeof outcome !== 'string' || !OUTCOMES.has(outcome)) {
    return null;
  }
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  const reason = str(payload['reason']);
  return {
    id,
    at,
    kind,
    outcome: outcome as UpdateHistoryEntry['outcome'],
    fromVersion: str(payload['fromVersion']),
    toVersion: str(payload['toVersion']),
    // Bound a hostile/oversized reason the same way the log bounds rows.
    reason: reason !== null && reason.length > 400 ? reason.slice(0, 400) : reason,
  };
}

export class UpdateFeedHistoryService {
  constructor(
    private readonly deps: {
      events: UpdateHistoryEventStore;
      log: { warn(msg: string): void };
    },
  ) {}

  /** Store one check/install event. Never throws into the caller's path. */
  record(input: RecordUpdateEventInput): void {
    try {
      if (!OUTCOMES.has(input.outcome)) return; // unknown outcome: refuse, don't guess
      const payload: Record<string, unknown> = {
        kind: input.kind,
        outcome: input.outcome,
        fromVersion: input.fromVersion ?? null,
        toVersion: input.toVersion ?? null,
        reason: input.reason ?? null,
      };
      this.deps.events.insert({ kind: UPDATE_HISTORY_KIND, at: Date.now(), payload });
    } catch (err) {
      this.deps.log.warn(`update history: event not recorded: ${message(err)}`);
    }
  }

  /** Newest-first history, malformed rows dropped, count bounded. */
  list(limit = MAX_UPDATE_HISTORY): UpdateHistoryEntry[] {
    try {
      return this.deps.events
        .recent(UPDATE_HISTORY_KIND, MAX_UPDATE_HISTORY)
        .map((e) => toEntry(Number(e.id), Number(e.at), e.payload))
        .filter((e): e is UpdateHistoryEntry => e !== null)
        .slice(0, Math.max(1, Math.min(limit, MAX_UPDATE_HISTORY)));
    } catch (err) {
      this.deps.log.warn(`update history: cannot read: ${message(err)}`);
      return [];
    }
  }

  /**
   * Wipe the diary. Deletes ONLY this feature's rows (`update-feed:history`) —
   * the shared event log carries other kinds' history (discovery runs, report
   * runs), which a clear must never touch. Returns the number removed so the
   * route can report exactly what happened.
   */
  clear(): number {
    try {
      return this.deps.events.clearKind(UPDATE_HISTORY_KIND);
    } catch (err) {
      this.deps.log.warn(`update history: cannot clear: ${message(err)}`);
      return 0;
    }
  }
}
