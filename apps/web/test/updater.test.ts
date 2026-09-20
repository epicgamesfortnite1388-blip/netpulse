import { afterEach, describe, expect, it } from 'vitest';

import { checkForUpdate, statusLine, updateNotice, updaterAvailable } from '../src/lib/updater';

import type { CheckResult } from '../src/lib/updater';

/**
 * Honesty contract for the in-app update surface:
 *   - silence is the healthy default (no "you are up to date" noise)
 *   - a failed check never reads as up to date
 *   - web mode (no desktop bridge) renders nothing, not an error
 *   - the version shown comes from the feed, never from the running app
 */
describe('updateNotice', () => {
  it('stays silent when no check has completed yet', () => {
    expect(updateNotice(null, false)).toBeNull();
  });

  it('stays silent when the feed answers up-to-date', () => {
    const r: CheckResult = { kind: 'up-to-date' };
    expect(updateNotice(r, false)).toBeNull();
  });

  it('names the feed version when an update is available', () => {
    const r: CheckResult = {
      kind: 'available',
      update: { version: '0.4.0', currentVersion: '0.3.0', body: 'notes', date: null },
    };
    expect(updateNotice(r, false)).toBe('NetPulse 0.4.0 is available');
  });

  it('reports a failed check with its real reason, never as up-to-date', () => {
    const r: CheckResult = { kind: 'unavailable', reason: 'error sending request' };
    const notice = updateNotice(r, false);
    expect(notice).toBe('Update check failed: error sending request');
    expect(notice).not.toMatch(/up.to.date|current/i);
  });

  it('stays silent in web mode where no updater can exist', () => {
    const r: CheckResult = { kind: 'unavailable', reason: 'no-updater' };
    expect(updateNotice(r, false)).toBeNull();
  });

  it('a dismissed banner stays dismissed for every kind', () => {
    const kinds: CheckResult[] = [
      { kind: 'up-to-date' },
      { kind: 'available', update: { version: '9.9.9', currentVersion: '0.3.0', body: null, date: null } },
      { kind: 'unavailable', reason: 'timeout' },
    ];
    for (const r of kinds) expect(updateNotice(r, true)).toBeNull();
  });
});

/**
 * Manual-check wording (Settings card) — unlike the banner, the checker
 * ANSWERS the user's click in every case: "latest version" on up-to-date,
 * the real reason on failure. Silence is wrong after an explicit check.
 */
describe('statusLine (manual check)', () => {
  it('confirms up-to-date after an explicit check (never silent)', () => {
    expect(statusLine({ kind: 'up-to-date' })).toBe('You are on the latest version.');
  });

  it('names the feed version when available', () => {
    const r: CheckResult = {
      kind: 'available',
      update: { version: '0.4.0', currentVersion: '0.3.0', body: 'notes', date: null },
    };
    expect(statusLine(r)).toBe('NetPulse 0.4.0 is available');
  });

  it('reports the real failure reason, never as up-to-date', () => {
    const r: CheckResult = { kind: 'unavailable', reason: 'error sending request' };
    expect(statusLine(r)).toBe('Update check failed: error sending request');
  });

  it('says nothing only when there is no updater (web mode)', () => {
    expect(statusLine({ kind: 'unavailable', reason: 'no-updater' })).toBeNull();
  });

  it('says nothing before any check has run', () => {
    expect(statusLine(null)).toBeNull();
  });
});

/**
 * Bridge contract: without the desktop shell the plugin is simply absent —
 * available() is false and a check degrades to a null-state reason the UI
 * stays silent on, rather than throwing or fabricating an up-to-date.
 */
describe('checkForUpdate without the desktop bridge', () => {
  const w = window as unknown as { __TAURI__?: unknown };

  afterEach(() => {
    delete w.__TAURI__;
  });

  it('reports the updater as unavailable', () => {
    delete w.__TAURI__;
    expect(updaterAvailable()).toBe(false);
  });

  it('a check answers no-updater instead of throwing', async () => {
    delete w.__TAURI__;
    await expect(checkForUpdate()).resolves.toEqual({ kind: 'unavailable', reason: 'no-updater' });
  });

  it('a plugin-level check failure surfaces the real error text', async () => {
    w.__TAURI__ = {
      updater: {
        check: () => Promise.reject(new Error('endpoint unreachable')),
      },
    };
    const r = await checkForUpdate();
    expect(r).toEqual({ kind: 'unavailable', reason: 'endpoint unreachable' });
    // ...and the notice must not read like success.
    expect(updateNotice(r, false)).toMatch(/Update check failed/);
  });
});
