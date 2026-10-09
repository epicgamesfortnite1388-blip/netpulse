import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SubscriptionCard } from '@/features/account/SubscriptionCard';
import {
  EXPIRY_SOON_DAYS,
  describeConfigAge,
  describeDeviceLimit,
  describeExpiry,
  describeRenewal,
  describeStatus,
  describeTraffic,
  parseTimestamp,
} from '@/features/account/subscriptionView';

import type { NetpulseSubscription } from '@/lib/cloud/client';

/**
 * The card is built from the worker's safe model
 * (cloud/worker/src/netpulse-integration.ts `listEntitlements`), so these
 * fixtures are that shape exactly — no field invented, none missing.
 */
const sub = (over: Partial<NetpulseSubscription> = {}): NetpulseSubscription => ({
  id: '42',
  plan: 'pro-monthly',
  status: 'active',
  started_at: '2026-09-01T00:00:00Z',
  expiration_time: '2026-12-01T00:00:00Z',
  auto_renew: true,
  total_gb: 100,
  used_gb: 42.5,
  ip_limit: 3,
  config_updated_at: '2026-10-01T00:00:00Z',
  ...over,
});

const NOW = new Date('2026-10-05T12:00:00Z');
const iso = (d: Date) => d.toISOString();

describe('timestamps the bot wrote as opaque strings', () => {
  it('reads an ISO string', () => {
    expect(parseTimestamp('2026-10-01T00:00:00Z')?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('reads a numeric epoch, in seconds or milliseconds', () => {
    expect(parseTimestamp('1767225600')?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(parseTimestamp('1767225600000')?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns null rather than an Invalid Date', () => {
    // The old card did `new Date(x).toLocaleDateString()` and rendered the
    // browser's "Invalid Date" straight into the page.
    for (const bad of ['not-a-date', '', '   ', 'TBD', 'null']) {
      expect(parseTimestamp(bad)).toBeNull();
    }
    expect(parseTimestamp(null)).toBeNull();
    expect(parseTimestamp(undefined)).toBeNull();
  });
});

describe('expiry', () => {
  it('says so plainly when the plan has no end date', () => {
    const v = describeExpiry(null, NOW);
    expect(v.openEnded).toBe(true);
    expect(v.text).toBe('No end date');
  });

  it('admits when the date cannot be read instead of showing Invalid Date', () => {
    expect(describeExpiry('whenever', NOW).text).toBe('End date unavailable');
    expect(describeExpiry('whenever', NOW).openEnded).toBe(false);
  });

  it('counts down and warns as the end approaches', () => {
    const soon = describeExpiry(iso(new Date(NOW.getTime() + 3 * 86_400_000)), NOW);
    expect(soon.tone).toBe('warn');
    expect(soon.text).toContain('Ends in 3 days');

    const tomorrow = describeExpiry(iso(new Date(NOW.getTime() + 86_400_000)), NOW);
    expect(tomorrow.text).toBe(`Ends tomorrow (${new Date(NOW.getTime() + 86_400_000).toLocaleDateString()})`);

    const later = describeExpiry(iso(new Date(NOW.getTime() + 30 * 86_400_000)), NOW);
    expect(later.tone).toBe('ok');
    expect(later.text).toContain('Ends in 30 days');
  });

  it('flags an elapsed end date in the past tense', () => {
    const v = describeExpiry(iso(new Date(NOW.getTime() - 2 * 86_400_000)), NOW);
    expect(v.tone).toBe('danger');
    expect(v.text).toContain('Expired 2 days ago');
  });

  it('warns only inside the soon window', () => {
    const justOutside = describeExpiry(iso(new Date(NOW.getTime() + (EXPIRY_SOON_DAYS + 1) * 86_400_000)), NOW);
    expect(justOutside.tone).toBe('ok');
  });
});

describe('traffic allowance and usage', () => {
  it('reports used and remaining against the stated cap', () => {
    const v = describeTraffic(100, 42.5);
    expect(v.pct).toBeCloseTo(42.5);
    expect(v.text).toBe('42.50 of 100 GB — 57.50 GB left');
    expect(v.tone).toBe('ok');
  });

  it('draws NO bar for a plan that states no cap', () => {
    // total_gb 0 must not become a 0%-wide bar: that reads as "nothing used".
    for (const total of [0, null, undefined, -5]) {
      const v = describeTraffic(total as number | null, 12.5);
      expect(v.pct).toBeNull();
      expect(v.text).toBe('12.50 GB used');
    }
  });

  it('clamps at 100 and escalates the tone as the allowance runs out', () => {
    expect(describeTraffic(100, 150).pct).toBe(100);
    expect(describeTraffic(100, 150).tone).toBe('danger');
    expect(describeTraffic(100, 90).tone).toBe('warn');
    expect(describeTraffic(100, 10).tone).toBe('ok');
  });

  it('never shows negative remaining allowance', () => {
    expect(describeTraffic(100, 120).text).toContain('0 GB left');
  });
});

describe('status, renewal and device limit', () => {
  it('tones the statuses the bot emits', () => {
    expect(describeStatus('active').tone).toBe('ok');
    expect(describeStatus('paused').tone).toBe('warn');
    expect(describeStatus('expired').tone).toBe('danger');
    expect(describeStatus('revoked').tone).toBe('danger');
    expect(describeStatus('refunded').tone).toBe('danger');
  });

  it('shows an unrecognised status verbatim instead of guessing', () => {
    const v = describeStatus('grace_period');
    expect(v.tone).toBe('neutral');
    expect(v.label).toBe('Grace period');
    expect(describeStatus('').label).toBe('Unknown');
    expect(describeStatus(null).label).toBe('Unknown');
  });

  it('states renewal and device limits only when the plan does', () => {
    expect(describeRenewal(true)).toBe('Renews automatically');
    expect(describeRenewal(false)).toBe('Does not renew');
    expect(describeRenewal(null)).toBe('Renewal not stated');
    expect(describeDeviceLimit(null)).toBeNull();
    expect(describeDeviceLimit(1)).toBe('1 device');
    expect(describeDeviceLimit(5)).toBe('5 devices');
  });

  it('describes config age from the bot timestamp', () => {
    expect(describeConfigAge(iso(new Date(NOW.getTime() - 30_000)), NOW)).toBe('Config updated just now');
    expect(describeConfigAge(iso(new Date(NOW.getTime() - 5 * 60_000)), NOW)).toBe('Config updated 5 min ago');
    expect(describeConfigAge(iso(new Date(NOW.getTime() - 3 * 3_600_000)), NOW)).toBe('Config updated 3 hours ago');
    expect(describeConfigAge('rubbish', NOW)).toBeNull();
    expect(describeConfigAge(null, NOW)).toBeNull();
  });
});

describe('the card the user actually reads', () => {
  const render = (s: NetpulseSubscription, now = NOW) => renderToStaticMarkup(<SubscriptionCard sub={s} now={now} />);

  it('shows plan, status, when it ends and how much is gone', () => {
    const html = render(sub({ expiration_time: iso(new Date(NOW.getTime() + 3 * 86_400_000)) }));
    expect(html).toContain('pro-monthly');
    expect(html).toContain('Active');
    expect(html).toContain('Ends in 3 days');
    expect(html).toContain('42.50 of 100 GB');
    expect(html).toContain('43%'); // rounded usage
    expect(html).toContain('Renews automatically');
    expect(html).toContain('3 devices');
  });

  it('never renders Invalid Date or NaN, whatever the bot sent', () => {
    const html = render(sub({ expiration_time: 'whenever', started_at: 'TBD', config_updated_at: null }));
    expect(html).not.toContain('Invalid Date');
    expect(html).not.toContain('NaN');
    expect(html).toContain('End date unavailable');
  });

  it('omits the meter entirely when the plan states no cap', () => {
    const html = render(sub({ total_gb: 0, used_gb: 12.5 }));
    expect(html).not.toContain('progressbar');
    expect(html).toContain('12.50 GB used');
  });

  it('carries an accessible progress value', () => {
    const html = render(sub());
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="43"');
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="100"');
  });

  it('still renders a card whose plan name the bot left empty', () => {
    const html = render(sub({ plan: '' }));
    expect(html).toContain('Unnamed plan');
  });
});