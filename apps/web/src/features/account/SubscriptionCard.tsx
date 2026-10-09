/**
 * SubscriptionCard — one subscription, rendered from what the account holds.
 *
 * Replaces the four-line text dump (`plan` / `Status:` / `Expires:` /
 * `Traffic: x / y GB`) with the things a subscriber actually asks: what plan
 * this is, is it live, when does it end, and how much of the allowance is
 * gone.
 *
 * Every value here comes from the worker's safe model
 * (cloud/worker/src/netpulse-integration.ts `listEntitlements`) and is shaped
 * by ./subscriptionView, which owns the wording and the arithmetic. This file
 * only decides layout, so the rules stay unit-testable without a DOM.
 */

import { Badge } from '@/components/ui/Badge';
import {
  describeExpiry,
  describeStatus,
  describeTraffic,
  subscriptionFacts,
} from './subscriptionView';

import type { NetpulseSubscription } from '@/lib/cloud/client';

/** Bar colours keyed to the meter tones, so the meter and its label agree. */
const BAR_TONE: Record<string, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  danger: 'bg-danger',
  neutral: 'bg-muted',
  accent: 'bg-accent',
};

export function SubscriptionCard({ sub, now = new Date() }: { sub: NetpulseSubscription; now?: Date }) {
  const status = describeStatus(sub.status);
  const expiry = describeExpiry(sub.expiration_time, now);
  const traffic = describeTraffic(sub.total_gb, sub.used_gb);
  const facts = subscriptionFacts(sub, now);

  return (
    <div className="rounded-lg border border-line p-3" data-testid={`subscription-${sub.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">{sub.plan || 'Unnamed plan'}</p>
        <div className="flex items-center gap-2">
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
      </div>

      <p className={`mt-1 text-sm ${expiry.tone === 'danger' ? 'text-danger' : expiry.tone === 'warn' ? 'text-warn' : 'text-muted'}`}>
        {expiry.text}
      </p>

      <div className="mt-2">
        <div className="mb-1 flex items-center justify-between text-xs text-muted">
          <span>{traffic.text}</span>
          {traffic.pct !== null && <span className="metric-num">{Math.round(traffic.pct)}%</span>}
        </div>
        {/* No bar at all when the plan states no cap — a 0%-wide bar would
            read as "you have used nothing" on an uncapped plan. */}
        {traffic.pct !== null && (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
            <div
              className={`h-full rounded-full ${BAR_TONE[traffic.barTone] ?? BAR_TONE.neutral} transition-all`}
              style={{ width: `${traffic.pct}%` }}
              role="progressbar"
              aria-valuenow={Math.round(traffic.pct)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${sub.plan || 'Plan'} traffic used`}
            />
          </div>
        )}
      </div>

      <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-0.5 text-xs text-muted">
        {facts.map((f) => (
          <div key={f.label} className="contents">
            <dt>{f.label}</dt>
            <dd>{f.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}