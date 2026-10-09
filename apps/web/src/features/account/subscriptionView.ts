/**
 * Subscription view model — what the account actually holds, turned into
 * something a person can read at a glance.
 *
 * The shape comes from the worker, not from taste. `GET /api/v1/subscriptions`
 * and `GET /api/v1/subscriptions/:id` return the SAME ten safe-model fields
 * (cloud/worker/src/netpulse-integration.ts `listEntitlements`, and the route
 * in cloud/worker/src/index.ts):
 *
 *   id, plan, status, started_at, expiration_time, auto_renew,
 *   total_gb, used_gb, ip_limit, config_updated_at
 *
 * So the display is built from the list alone. `:id` returns no field the list
 * lacks, and fetching it per card would be N extra round trips for no new
 * information — a slower screen built out of the one thing the screen does
 * not need.
 *
 * Everything here is pure so the wording and the arithmetic can be pinned by
 * unit tests instead of by looking at a rendered card.
 */

import type { NetpulseSubscription } from '@/lib/cloud/client';

export type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent';

/** Badges use these names; the ones we assign are `ok`/`warn`/`danger`. */
export type StatusTone = Extract<Tone, 'neutral' | 'ok' | 'warn' | 'danger' | 'accent'>;

/**
 * `expiration_time` and `config_updated_at` are opaque strings the bot wrote.
 * Parse defensively: a date we cannot read must read as "unknown", never as
 * the browser's "Invalid Date". A bare number is accepted as an epoch, because
 * the column is TEXT and a numeric timestamp is a shape a bot realistically
 * writes into it.
 */
export function parseTimestamp(value: string | null | undefined): Date | null {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    const ms = n > 1e11 ? n : n * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface ExpiryView {
  /** Human sentence, always safe to render. */
  text: string;
  tone: StatusTone;
  /** True when there is genuinely no end date (null), not when we failed to read one. */
  openEnded: boolean;
}

/** Days before expiry that counts as "soon". Mirrors what users expect to be warned about. */
export const EXPIRY_SOON_DAYS = 7;

export function describeExpiry(expirationTime: string | null | undefined, now: Date = new Date()): ExpiryView {
  if (expirationTime == null || String(expirationTime).trim() === '') {
    return { text: 'No end date', tone: 'neutral', openEnded: true };
  }
  const at = parseTimestamp(expirationTime);
  if (!at) return { text: 'End date unavailable', tone: 'neutral', openEnded: false };

  const ms = at.getTime() - now.getTime();
  const days = Math.ceil(ms / 86_400_000);
  const when = at.toLocaleDateString();

  if (ms <= 0) return { text: `Expired ${days === 0 ? 'today' : `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`} (${when})`, tone: 'danger', openEnded: false };
  if (days <= EXPIRY_SOON_DAYS) {
    return { text: days === 1 ? `Ends tomorrow (${when})` : `Ends in ${days} days (${when})`, tone: 'warn', openEnded: false };
  }
  return { text: `Ends in ${days} days (${when})`, tone: 'ok', openEnded: false };
}

export interface TrafficView {
  /** Null when the plan states no cap, so nothing renders a misleading bar. */
  pct: number | null;
  text: string;
  tone: StatusTone;
  barTone: StatusTone;
}

/**
 * Traffic allowance and usage.
 *
 * `total_gb` of 0 (or absent) is treated as "no stated cap", NOT as "0% used":
 * rendering a full-width bar for an uncapped plan would be a worse lie than
 * showing the bytes used and nothing else.
 */
export function describeTraffic(totalGb: number | null | undefined, usedGb: number | null | undefined): TrafficView {
  const used = Number.isFinite(usedGb) ? Number(usedGb) : 0;
  const total = Number.isFinite(totalGb) ? Number(totalGb) : 0;
  const usedText = `${used.toFixed(2)} GB used`;

  if (total <= 0) return { pct: null, text: usedText, tone: 'neutral', barTone: 'neutral' };

  const pct = Math.max(0, Math.min(100, (used / total) * 100));
  const left = Math.max(0, total - used);
  const text = `${used.toFixed(2)} of ${total.toFixed(total % 1 === 0 ? 0 : 2)} GB — ${left.toFixed(left % 1 === 0 ? 0 : 2)} GB left`;
  const tone: StatusTone = pct >= 100 ? 'danger' : pct >= 85 ? 'warn' : 'ok';
  return { pct, text, tone, barTone: tone };
}

/**
 * Map the bot's status word to a tone. The contract does not publish a closed
 * enum, so this keys off substrings and falls back to `neutral` with the raw
 * word shown — an unrecognised status is displayed, never hidden or guessed.
 */
export function describeStatus(status: string | null | undefined): { label: string; tone: StatusTone } {
  const raw = (status ?? '').trim();
  if (!raw) return { label: 'Unknown', tone: 'neutral' };
  const s = raw.toLowerCase();
  const label = raw.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

  if (/(revoked|refunded|cancel|failed|inactive)/.test(s)) return { label, tone: 'danger' };
  if (/expired/.test(s)) return { label, tone: 'danger' };
  if (/(paused|pause|suspend)/.test(s)) return { label, tone: 'warn' };
  if (/(trial)/.test(s)) return { label, tone: 'accent' };
  if (/(pending|unpaid)/.test(s)) return { label, tone: 'warn' };
  if (/(active|active_?renewing|enabled)/.test(s)) return { label, tone: 'ok' };
  return { label, tone: 'neutral' };
}

/** "Runs until it ends" vs a fixed end — `auto_renew` is the plan's own flag. */
export function describeRenewal(autoRenew: boolean | null | undefined): string {
  return autoRenew === true ? 'Renews automatically' : autoRenew === false ? 'Does not renew' : 'Renewal not stated';
}

/** How many devices the plan allows; null means the plan states no limit. */
export function describeDeviceLimit(ipLimit: number | null | undefined): string | null {
  if (ipLimit == null) return null;
  const n = Number(ipLimit);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n === 1) return '1 device';
  return `${n} devices`;
}

/** When the bot last regenerated the config behind this subscription. */
export function describeConfigAge(configUpdatedAt: string | null | undefined, now: Date = new Date()): string | null {
  const at = parseTimestamp(configUpdatedAt);
  if (!at) return null;
  const ms = now.getTime() - at.getTime();
  if (!Number.isFinite(ms)) return null;
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'Config updated just now';
  if (mins < 60) return `Config updated ${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Config updated ${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days <= 60) return `Config updated ${days} day${days === 1 ? '' : 's'} ago`;
  return `Config updated ${at.toLocaleDateString()}`;
}

/** Grouped facts, so the card renders a definition list and nothing else. */
export function subscriptionFacts(s: NetpulseSubscription, now: Date = new Date()): Array<{ label: string; value: string }> {
  const facts: Array<{ label: string; value: string }> = [
    { label: 'Allowance', value: describeTraffic(s.total_gb, s.used_gb).text },
    { label: 'Renews', value: describeRenewal(s.auto_renew) },
  ];
  const devices = describeDeviceLimit(s.ip_limit);
  if (devices) facts.push({ label: 'Devices', value: devices });
  const age = describeConfigAge(s.config_updated_at, now);
  if (age) facts.push({ label: 'Config', value: age });
  const started = parseTimestamp(s.started_at);
  if (started) facts.push({ label: 'Started', value: started.toLocaleDateString() });
  return facts;
}