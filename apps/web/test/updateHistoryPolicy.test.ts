import { describe, expect, it } from 'vitest';

import {
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
