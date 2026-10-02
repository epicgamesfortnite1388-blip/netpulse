import { describe, expect, it } from 'vitest';

import {
  EVENT_WINDOW_MS,
  deriveAttentionItems,
  resolveImportTarget,
} from '../src/features/dashboard/needsAttention';

import type { VpnSelfTestResult } from '@shared/models/settings';
import type { EventRecord } from '@shared/models/common';

const NOW = 1_757_000_000_000;

/** The dev database's real broken-key-material sentence, verbatim. */
const BROKEN =
  '6 of 7 stored profiles have missing or unreadable key material — they will fail on connect. Re-import them.';

function selfTest(over: Partial<VpnSelfTestResult> = {}): VpnSelfTestResult {
  return {
    state: 'ok',
    detail: '7 profile(s) key material OK · 7/7 endpoints reachable',
    engines: { wireguard: true, openvpn: false, singbox: true },
    profilesChecked: 7,
    endpointsReachable: 7,
    checkedAt: NOW - 60_000,
    tookMs: 120,
    ...over,
  };
}

function event(over: Partial<EventRecord> = {}): EventRecord {
  return {
    id: 1,
    ts: NOW - 60_000,
    level: 'warn',
    category: 'vpn',
    message: 'Kill switch engaged (core exited (code 1)) — traffic is blocked',
    ...over,
  };
}

/** The dev database's real shape: six sing-box profiles and one Aether. */
const MIXED = ['singbox', 'singbox', 'singbox', 'singbox', 'singbox', 'singbox', 'aether'];
/** A machine whose stored profiles all belong to one engine. */
const SINGBOX = ['singbox', 'singbox', 'singbox'];

describe('resolveImportTarget', () => {
  it('points at the engine that owns every stored profile', () => {
    expect(resolveImportTarget(['wireguard', 'wireguard'])).toEqual({
      surface: 'wireguard',
      providerId: 'wireguard',
    });
    expect(resolveImportTarget(['singbox', 'singbox', 'aether'])).toBeNull();
  });

  it('ignores custom profiles, which have no surface', () => {
    expect(resolveImportTarget(['custom', 'openvpn'])).toEqual({
      surface: 'openvpn',
      providerId: 'openvpn',
    });
  });

  it('refuses to guess when nothing is stored', () => {
    expect(resolveImportTarget([])).toBeNull();
  });
});

describe('deriveAttentionItems — the self-test is the diagnosis', () => {
  it('raises a danger item with the backend sentence verbatim when key material is broken', () => {
    const items = deriveAttentionItems({
      selftest: selfTest({ state: 'error', detail: BROKEN, profilesChecked: 1 }),
      events: [],
      profileProviders: SINGBOX,
      now: NOW,
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.detail).toBe(BROKEN);
    expect(items[0]!.tone).toBe('danger');
    expect(items[0]!.canRecheck).toBe(true);
  });

  it('routes to the owning engine and its import panel', () => {
    const [item] = deriveAttentionItems({
      selftest: selfTest({ state: 'error', detail: BROKEN, profilesChecked: 1 }),
      events: [],
      profileProviders: SINGBOX,
      now: NOW,
    });
    expect(item!.action).toMatchObject({
      kind: 'route',
      to: '/vpn',
      surface: 'sing-box',
      providerId: 'singbox',
    });
  });

  /**
   * The dev database's real shape is six sing-box profiles plus one Aether, and
   * the self-test reports only a COUNT — never which profiles failed. Guessing
   * the majority engine would send the user to a panel that may hold none of
   * the broken ones, so the strip falls back to the overview.
   */
  it('refuses to name an engine when the profiles span several', () => {
    const [item] = deriveAttentionItems({
      selftest: selfTest({ state: 'error', detail: BROKEN, profilesChecked: 1 }),
      events: [],
      profileProviders: MIXED,
      now: NOW,
    });
    expect(item!.action.surface).toBeUndefined();
    expect(item!.action.label).toBe('Open VPN');
  });

  it('routes to the overview when the profiles span several engines', () => {
    const [item] = deriveAttentionItems({
      selftest: selfTest({ state: 'error', detail: BROKEN, profilesChecked: 1 }),
      events: [],
      profileProviders: ['wireguard', 'openvpn'],
      now: NOW,
    });
    expect(item!.action.surface).toBeUndefined();
    expect(item!.action.label).toBe('Open VPN');
  });

  it('says nothing when the self-test passed', () => {
    expect(
      deriveAttentionItems({ selftest: selfTest(), events: [], profileProviders: SINGBOX, now: NOW }),
    ).toEqual([]);
  });

  it('says nothing when the self-test has never run', () => {
    expect(
      deriveAttentionItems({ selftest: null, events: [], profileProviders: SINGBOX, now: NOW }),
    ).toEqual([]);
  });
});

describe('deriveAttentionItems — only breakage is attention', () => {
  it('raises a missing engine only when profiles exist that need it', () => {
    const [item] = deriveAttentionItems({
      selftest: selfTest({
        state: 'unavailable',
        detail: 'No VPN engine installed — tunnel features unavailable. Install WireGuard to enable them.',
        profilesChecked: 0,
      }),
      events: [],
      profileProviders: ['wireguard'],
      now: NOW,
    });
    expect(item!.tone).toBe('warn');
    expect(item!.action).toEqual({ kind: 'route', label: 'Install an engine', to: '/engines' });
  });

  it('stays silent on "not set up yet" — an unused feature is not a fault', () => {
    expect(
      deriveAttentionItems({
        selftest: selfTest({
          state: 'unavailable',
          detail: 'Engine installed (wireguard), but no VPN profiles imported yet.',
          profilesChecked: 0,
        }),
        events: [],
        profileProviders: [],
        now: NOW,
      }),
    ).toEqual([]);
  });
});

describe('deriveAttentionItems — the log is the echo, not the diagnosis', () => {
  it('drops the self-test log lines so one fault is never shown twice', () => {
    const items = deriveAttentionItems({
      selftest: selfTest({ state: 'error', detail: BROKEN, profilesChecked: 1 }),
      events: [
        event({ id: 91, message: `VPN self-test error: ${BROKEN} (manual)` }),
        event({ id: 92, message: `Scheduled VPN self-test failed: ${BROKEN}` }),
      ],
      profileProviders: SINGBOX,
      now: NOW,
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.source).toBe('vpn-selftest');
  });

  it('collapses a repeated fault into one item that counts its repeats', () => {
    const items = deriveAttentionItems({
      selftest: null,
      events: [
        event({ id: 1, ts: NOW - 3_000, message: 'Kill switch engaged — traffic is blocked' }),
        event({ id: 2, ts: NOW - 200_000, message: 'Kill switch engaged — traffic is blocked' }),
        event({ id: 3, ts: NOW - 400_000, message: 'Kill switch engaged — traffic is blocked' }),
      ],
      profileProviders: [],
      now: NOW,
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.repeats).toBe(3);
    expect(items[0]!.id).toBe('event:1');
  });

  it('does not mistake two different faults for one repeated fault', () => {
    const items = deriveAttentionItems({
      selftest: null,
      events: [
        event({ id: 7, message: 'Recovered from unclean shutdown — 1 stale tunnel record(s) reset.' }),
        event({ id: 8, message: 'Recovered from unclean shutdown — 2 stale tunnel record(s) reset.' }),
      ],
      profileProviders: [],
      now: NOW,
    });
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.repeats === undefined)).toBe(true);
  });

  it('ignores info events', () => {
    expect(
      deriveAttentionItems({
        selftest: null,
        events: [event({ level: 'info', message: 'VPN self-test passed: all OK' })],
        profileProviders: [],
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('drops history that is no longer recent', () => {
    expect(
      deriveAttentionItems({
        selftest: null,
        events: [event({ ts: NOW - EVENT_WINDOW_MS - 1 })],
        profileProviders: [],
        now: NOW,
      }),
    ).toEqual([]);
  });

  it('never offers a VPN re-check for a fault it cannot re-check', () => {
    const [item] = deriveAttentionItems({
      selftest: null,
      events: [event({ message: 'Connection lost: TCP probe to 1.1.1.1:443 failed' })],
      profileProviders: [],
      now: NOW,
    });
    expect(item!.canRecheck).toBe(false);
    expect(item!.action).toEqual({ kind: 'route', label: 'Open events', to: '/events' });
  });

  it('caps how many log items reach the strip', () => {
    const items = deriveAttentionItems({
      selftest: null,
      events: [
        event({ id: 1, ts: NOW - 1_000, message: 'a' }),
        event({ id: 2, ts: NOW - 2_000, message: 'b' }),
        event({ id: 3, ts: NOW - 3_000, message: 'c' }),
      ],
      profileProviders: [],
      now: NOW,
      maxEventItems: 2,
    });
    expect(items.map((i) => i.detail)).toEqual(['a', 'b']);
  });
});

describe('deriveAttentionItems — a verdict does not survive a restart', () => {
  /**
   * `VpnSelfTestService.last` is an in-memory field, so a launched app answers
   * `/vpn/selftest` with `last: null` while the stored profiles are exactly as
   * broken as at shutdown. The event log is the only persisted trace.
   */
  it('offers the last recorded fault as evidence, and asks for a fresh verdict', () => {
    const items = deriveAttentionItems({
      selftest: null,
      events: [event({ id: 500, level: 'warn', ts: NOW - 8 * 24 * 3600_000, message: `VPN self-test error: ${BROKEN} (scheduled)` })],
      profileProviders: MIXED,
      now: NOW,
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.source).toBe('vpn-selftest-recorded');
    expect(items[0]!.tone).toBe('danger');
    // The scheduler bookkeeping is trimmed; the finding is the backend's own.
    expect(items[0]!.detail).toBe(BROKEN);
    expect(items[0]!.action).toEqual({ kind: 'rerun', label: 'Re-check now' });
  });

  it('stays silent when the last recorded verdict was a healthy one', () => {
    const items = deriveAttentionItems({
      selftest: null,
      events: [
        event({ id: 501, level: 'info', message: 'VPN self-test passed: 7 profile(s) key material OK (scheduled)' }),
      ],
      profileProviders: MIXED,
      now: NOW,
    });
    expect(items).toEqual([]);
  });

  it('stays silent when nothing has ever been recorded', () => {
    expect(
      deriveAttentionItems({ selftest: null, events: [], profileProviders: MIXED, now: NOW }),
    ).toEqual([]);
  });

  it('keeps the same identity for the same recorded fault across a restart', () => {
    const log = [event({ id: 600, level: 'warn', message: `VPN self-test error: ${BROKEN} (manual)` })];
    const a = deriveAttentionItems({ selftest: null, events: log, profileProviders: MIXED, now: NOW });
    const b = deriveAttentionItems({ selftest: null, events: log, profileProviders: MIXED, now: NOW + 5000 });
    expect(a[0]!.id).toBe(b[0]!.id);
  });

  it('prefers the live verdict over the recorded one', () => {
    const items = deriveAttentionItems({
      selftest: selfTest({ state: 'error', detail: BROKEN, profilesChecked: 1 }),
      events: [event({ id: 700, level: 'warn', message: `VPN self-test error: ${BROKEN} (scheduled)` })],
      profileProviders: MIXED,
      now: NOW,
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.source).toBe('vpn-selftest');
  });
});

describe('deriveAttentionItems — dismissals are bound to the diagnosis', () => {
  it('gives a worse fault a new identity, so dismissing the old one cannot mask it', () => {
    const worse = deriveAttentionItems({
      selftest: selfTest({
        state: 'error',
        detail: '7 of 7 stored profiles have missing or unreadable key material — they will fail on connect. Re-import them.',
        profilesChecked: 0,
      }),
      events: [],
      profileProviders: SINGBOX,
      now: NOW,
    });
    const [a] = deriveAttentionItems({
      selftest: selfTest({ state: 'error', detail: BROKEN, profilesChecked: 1 }),
      events: [],
      profileProviders: SINGBOX,
      now: NOW,
    });
    expect(worse[0]!.id).not.toBe(a!.id);
  });

  it('gives an identical repeat fault the same identity', () => {
    const once = deriveAttentionItems({
      selftest: selfTest({ state: 'error', detail: BROKEN, profilesChecked: 1 }),
      events: [],
      profileProviders: SINGBOX,
      now: NOW,
    });
    const again = deriveAttentionItems({
      selftest: selfTest({ state: 'error', detail: BROKEN, profilesChecked: 1 }),
      events: [],
      profileProviders: SINGBOX,
      now: NOW + 60_000,
    });
    expect(again[0]!.id).toBe(once[0]!.id);
  });
});