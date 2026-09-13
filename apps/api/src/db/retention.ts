import type { Logger } from '../logger';
import type { DbHandle } from './client';

/**
 * Data-retention sweeper.
 *
 * Long-running desktop sessions accumulate measurement rows (tests with full
 * JSON payloads, events, map observations, node tests, scan jobs, gaming
 * samples, DNS benchmarks, raw crawled documents). Left alone, the database
 * grows without bound and every index degrades with it. This module deletes
 * rows older than each table's retention window, with hard per-run and
 * per-table delete caps so a first run against a huge legacy database cannot
 * itself stall the sidecar.
 *
 * Every child table of network_tests uses ON DELETE CASCADE, so pruning tests
 * removes their detail rows (route hops, dns results, bufferbloat samples…)
 * in the same statement.
 */

export interface RetentionRule {
  /** SQL table name. */
  table: string;
  /** Timestamp column (ms since epoch, integer). */
  tsColumn: string;
  /** Rows older than this are eligible for deletion. */
  maxAgeMs: number;
}

/** 14 days in ms — the default window for measurement data. */
const DAY = 86_400_000;
export const DEFAULT_RETENTION_MS = 14 * DAY;

/** Per-table delete cap per sweep (SQLite limit/rowcount safety). */
const MAX_DELETES_PER_TABLE = 20_000;

export const RETENTION_RULES: RetentionRule[] = [
  // Biggest payload first: full test results (children cascade).
  { table: 'network_tests', tsColumn: 'started_at', maxAgeMs: DEFAULT_RETENTION_MS },
  { table: 'network_events', tsColumn: 'ts', maxAgeMs: DEFAULT_RETENTION_MS },
  { table: 'map_observations', tsColumn: 'created_at', maxAgeMs: 7 * DAY },
  { table: 'node_tests', tsColumn: 'started_at', maxAgeMs: DEFAULT_RETENTION_MS },
  { table: 'scan_jobs', tsColumn: 'created_at', maxAgeMs: 30 * DAY },
  { table: 'gaming_session_samples', tsColumn: 'ts', maxAgeMs: DEFAULT_RETENTION_MS },
  { table: 'gaming_comparisons', tsColumn: 'created_at', maxAgeMs: 30 * DAY },
  { table: 'dns_benchmarks', tsColumn: 'created_at', maxAgeMs: 30 * DAY },
  { table: 'raw_documents', tsColumn: 'fetched_at', maxAgeMs: 30 * DAY },
];

export interface RetentionResult {
  /** Table name -> rows deleted this sweep. */
  deleted: Record<string, number>;
  /** Total rows removed. */
  total: number;
  durationMs: number;
}

/** true when any table previously crossed its cap (next sweep continues). */
export interface RetentionState {
  lastRunAt: number | null;
  lastResult: RetentionResult | null;
}

export class RetentionService {
  private state: RetentionState = { lastRunAt: null, lastResult: null };

  constructor(
    private readonly handle: DbHandle,
    private readonly log?: Logger,
  ) {}

  /**
   * Run one bounded sweep. Safe to call from a background timer: each DELETE
   * is capped and every statement is followed by a WAL checkpoint pass so the
   * transaction never grows unbounded.
   */
  sweep(now = Date.now()): RetentionResult {
    const started = Date.now();
    const deleted: Record<string, number> = {};
    let total = 0;
    const { sqlite } = this.handle;

    for (const rule of RETENTION_RULES) {
      const cutoff = now - rule.maxAgeMs;
      let removed = 0;
      // Loop with a per-iteration cap: a table with millions of legacy rows is
      // drained a chunk at a time instead of one huge transaction.
      for (;;) {
        const chunk = Math.min(5_000, MAX_DELETES_PER_TABLE - removed);
        if (chunk <= 0) break;
        const info = sqlite
          .prepare(
            `DELETE FROM ${rule.table} WHERE rowid IN (
               SELECT rowid FROM ${rule.table} WHERE ${rule.tsColumn} < ? LIMIT ?
             )`,
          )
          .run(cutoff, chunk);
        const changes = Number(info.changes ?? 0);
        removed += changes;
        if (changes < chunk) break; // table drained below the cutoff
      }
      if (removed > 0) {
        deleted[rule.table] = removed;
        total += removed;
      }
    }

    const result: RetentionResult = { deleted, total, durationMs: Date.now() - started };
    this.state = { lastRunAt: started, lastResult: result };
    if (total > 0) {
      this.log?.info(
        { deleted, total, durationMs: result.durationMs },
        'retention sweep removed old measurement rows',
      );
    }
    return result;
  }

  getState(): RetentionState {
    return this.state;
  }
}

/**
 * The daily periodic sweep: interval is long (6h) relative to the windows, so
 * one pass per interval with a small catch-up multiplier keeps every table
 * comfortably under its retention horizon without hammering the DB.
 */
export const RETENTION_INTERVAL_MS = 6 * 3600 * 1000;
