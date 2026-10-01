import { describe, expect, it } from 'vitest';

import { updateHistoryRefetchDue } from '../src/lib/updater';

import {
  lastFailedCheck,
  updateEventLine,
  updateEventTone,
  updateHistorySummary,
  type UpdateHistoryEntry,
} from '@netpulse/shared';

/**
 * The wording contract: a check that failed must never read as success, an
 * install failure carries the real reason, and the fold summary states true
 * counts or the honest empty state.
 */

const entry = (over: Partial<UpdateHistoryEntry> & Pick<UpdateHistoryEntry, 'kind' | 'outcome'>): UpdateHistoryEntry => ({
  id: 1,
  fromVersion: null,
  toVersion: null,
  reason: null,
  at: 1_700_000_000_000,
  ...over,
});

describe('updateEventLine', () => {
  it('a successful check reads as up to date', () => {
    const line = updateEventLine(entry({ kind: 'check', outcome: 'up-to-date' }));
    expect(line).toMatch(/latest version/i);
    expect(line).not.toMatch(/fail/i);
  });

  it('an available check names the real version', () => {
    expect(updateEventLine(entry({ kind: 'check', outcome: 'available', toVersion: '1.2.0' }))).toContain('1.2.0');
  });

  it('a failed check carries the real reason, never blank', () => {
    expect(updateEventLine(entry({ kind: 'check', outcome: 'failed', reason: 'fetch failed: ECONNREFUSED' })))
      .toBe('Update check failed: fetch failed: ECONNREFUSED');
  });

  it('a failed install is distinct from a failed check and names its reason', () => {
    expect(updateEventLine(entry({ kind: 'install', outcome: 'failed', reason: 'update aborted: node.exe is still locked' })))
      .toBe('Install failed: update aborted: node.exe is still locked');
  });

  it('a missing reason is stated honestly, not left blank', () => {
    const line = updateEventLine(entry({ kind: 'check', outcome: 'failed', reason: null }));
    expect(line).toMatch(/without a reason/);
  });

  it('completed names the version it landed on', () => {
    expect(updateEventLine(entry({ kind: 'install', outcome: 'completed', toVersion: '1.2.0' }))).toContain('1.2.0');
  });

  it('started reads as in-progress', () => {
    expect(updateEventLine(entry({ kind: 'install', outcome: 'started', toVersion: '1.2.0' }))).toMatch(/installing/i);
  });
});

describe('updateEventTone', () => {
  it('marks failures as errors and completed as ok', () => {
    expect(updateEventTone(entry({ kind: 'check', outcome: 'failed' }))).toBe('error');
    expect(updateEventTone(entry({ kind: 'install', outcome: 'completed' }))).toBe('ok');
    expect(updateEventTone(entry({ kind: 'check', outcome: 'available' }))).toBe('info');
  });
});

describe('updateHistorySummary', () => {
  it('states the honest empty state', () => {
    expect(updateHistorySummary([])).toMatch(/no update activity/i);
  });

  it('reports true counts including failures', () => {
    const rows = [
      entry({ id: 1, kind: 'check', outcome: 'up-to-date' }),
      entry({ id: 2, kind: 'install', outcome: 'started', toVersion: '1.2.0' }),
      entry({ id: 3, kind: 'install', outcome: 'completed', toVersion: '1.2.0' }),
      entry({ id: 4, kind: 'check', outcome: 'failed', reason: 'x' }),
    ];
    const summary = updateHistorySummary(rows);
    expect(summary).toContain('4 recorded events');
    expect(summary).toContain('1 installed');
    expect(summary).toContain('1 failed');
  });
});

describe('updateHistoryRefetchDue (visibility refetch policy)', () => {
  it('is due when the card has never loaded', () => {
    expect(updateHistoryRefetchDue(0, 1_000_000)).toBe(true);
  });

  it('is due once the staleness floor has passed', () => {
    expect(updateHistoryRefetchDue(1_000_000, 1_000_000 + 30_000)).toBe(true);
    expect(updateHistoryRefetchDue(1_000_000, 1_000_000 + 60_000)).toBe(true);
  });

  it('is not due right after a load (scroll-past stays cheap)', () => {
    expect(updateHistoryRefetchDue(1_000_000, 1_000_000 + 5_000)).toBe(false);
    expect(updateHistoryRefetchDue(1_000_000, 1_000_000 + 29_999)).toBe(false);
  });

  it('a clock skew into the future is never due', () => {
    expect(updateHistoryRefetchDue(1_000_000, 1_000_000 - 500_000)).toBe(false);
  });

  it('a custom floor is honored (tighter or looser)', () => {
    expect(updateHistoryRefetchDue(1_000_000, 1_000_000 + 2_000, 2_000)).toBe(true);
    expect(updateHistoryRefetchDue(1_000_000, 1_000_000 + 10_000, 60_000)).toBe(false);
  });
});

describe('lastFailedCheck (dashboard warning policy)', () => {
  it('surfaces the failed check when it is the newest check', () => {
    const rows = [
      entry({ id: 2, kind: 'check', outcome: 'failed', reason: 'fetch failed: ECONNREFUSED' }),
      entry({ id: 1, kind: 'check', outcome: 'up-to-date' }),
    ];
    const failed = lastFailedCheck(rows);
    expect(failed).not.toBeNull();
    expect(failed?.reason).toBe('fetch failed: ECONNREFUSED');
  });

  it('stays silent when the newest check succeeded', () => {
    const rows = [
      entry({ id: 2, kind: 'check', outcome: 'up-to-date' }),
      entry({ id: 1, kind: 'check', outcome: 'failed', reason: 'old failure' }),
    ];
    expect(lastFailedCheck(rows)).toBeNull();
  });

  it('stays silent when an update is available (a failed check is stale then)', () => {
    const rows = [
      entry({ id: 2, kind: 'check', outcome: 'available', toVersion: '1.2.0' }),
      entry({ id: 1, kind: 'check', outcome: 'failed', reason: 'old failure' }),
    ];
    expect(lastFailedCheck(rows)).toBeNull();
  });

  it('stays silent with no history at all', () => {
    expect(lastFailedCheck([])).toBeNull();
  });

  it('install events neither mask a failed check nor trigger the warning', () => {
    // A failed check followed only by install rows: the warning still fires,
    // because no NEWER CHECK ever succeeded.
    const rows = [
      entry({ id: 3, kind: 'install', outcome: 'completed', toVersion: '1.2.0' }),
      entry({ id: 2, kind: 'install', outcome: 'started', toVersion: '1.2.0' }),
      entry({ id: 1, kind: 'check', outcome: 'failed', reason: 'feed unreachable' }),
    ];
    const failed = lastFailedCheck(rows);
    expect(failed).not.toBeNull();
    expect(failed?.reason).toBe('feed unreachable');

    // And a failed install with a healthy check never warns here — install
    // failures belong to the history card, not the dashboard.
    expect(
      lastFailedCheck([
        entry({ id: 2, kind: 'install', outcome: 'failed', reason: 'locked file' }),
        entry({ id: 1, kind: 'check', outcome: 'up-to-date' }),
      ]),
    ).toBeNull();
  });

  it('the warning renders through the same wording as the history card', () => {
    const failed = lastFailedCheck([
      entry({ id: 1, kind: 'check', outcome: 'failed', reason: 'error sending request' }),
    ]);
    expect(failed).not.toBeNull();
    expect(updateEventLine(failed!)).toBe('Update check failed: error sending request');
  });
});
