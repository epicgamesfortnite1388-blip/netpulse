import { useMemo } from 'react';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, TriangleAlert, X } from 'lucide-react';
import { useNavigate } from 'react-router';

import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { useToast } from '@/components/Toaster';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { usePersistentState, writePersistedState } from '@/lib/usePersistentState';
import { useVpnProfiles } from '@/features/vpn/useVpnData';
import { VPN_SELFTEST_KEY, useVpnSelfTest } from '@/lib/useVpnSelfTest';
import { deriveAttentionItems } from './needsAttention';

import type { EventRecord } from '@shared/models/common';
import type { AttentionItem } from './needsAttention';

/** Bounded so a long session cannot grow the sessionStorage entry without limit. */
const MAX_REMEMBERED_DISMISSALS = 100;

const SOURCE_LABEL: Record<AttentionItem['source'], string> = {
  'vpn-selftest': 'VPN self-test, this session',
  'vpn-selftest-recorded': 'Last recorded VPN check — this app has no current verdict',
  event: 'Event log',
};

/**
 * The failures this app knows about, said out loud.
 *
 * The trust failure this replaces is specific: the backend computes a precise
 * diagnosis — which stored profiles cannot decrypt, which engine is missing —
 * and then keeps it in the event log, where it surfaces only if a user already
 * suspects a problem and goes looking. Everything shown here comes from a
 * payload the app already fetched; no wording is invented and nothing is claimed
 * the backend did not report. The rules are in ./needsAttention.ts.
 */
export function NeedsAttentionCard() {
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();

  const selfTest = useVpnSelfTest();
  const profiles = useVpnProfiles();

  // Level-filtered rather than a page of the newest events: the newest-N slice
  // is swamped by info traffic (404 info rows vs 167 warnings in the dev DB),
  // so an unfiltered fetch would push the last recorded VPN verdict out of the
  // window and the strip would go quiet again after a busy morning. The level
  // filter also means the recency window in the derivation is all that decides
  // what is recent.
  const warnEvents = useQuery({
    queryKey: ['events', 'dashboard', 'attention', 'warn'],
    queryFn: () => api.get<{ events: EventRecord[] }>('/events?level=warn&limit=100'),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
  const errorEvents = useQuery({
    queryKey: ['events', 'dashboard', 'attention', 'error'],
    queryFn: () => api.get<{ events: EventRecord[] }>('/events?level=error&limit=100'),
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
  const events = useMemo(
    () => [...(warnEvents.data?.events ?? []), ...(errorEvents.data?.events ?? [])],
    [warnEvents.data?.events, errorEvents.data?.events],
  );

  const [dismissed, setDismissed] = usePersistentState<string[]>('dashboard.needsAttention.dismissed', []);

  const items = useMemo(
    () =>
      deriveAttentionItems({
        selftest: selfTest.data?.last ?? null,
        events,
        profileProviders: (profiles.data?.profiles ?? []).map((p) => p.providerId),
        now: Date.now(),
      }),
    [selfTest.data?.last, events, profiles.data?.profiles],
  );

  const visible = items.filter((i) => !dismissed.includes(i.id));
  const hidden = items.length - visible.length;

  const dismiss = (id: string) =>
    setDismissed((prev) => [...prev.filter((x) => x !== id), id].slice(-MAX_REMEMBERED_DISMISSALS));

  const rerun = useMutation({
    mutationFn: () => api.post('/vpn/selftest/run'),
    onSuccess: () => {
      // The run rewrites the diagnosis, so every dismissal bound to the old
      // sentence is dropped rather than left to mask the new verdict.
      void qc.invalidateQueries({ queryKey: VPN_SELFTEST_KEY });
      void qc.invalidateQueries({ queryKey: ['events'] });
    },
    onError: (err) => toast('error', 'Self-test could not run', err instanceof Error ? err.message : undefined),
  });

  const act = (item: AttentionItem) => {
    if (item.action.kind === 'rerun') {
      rerun.mutate();
      return;
    }
    // VpnPage reads its open engine tab from persisted state at mount, so this
    // has to be written before the route changes — that is what makes the click
    // land on the import box of the engine that actually owns the fault.
    if (item.action.surface) writePersistedState('vpn.surface', item.action.surface);
    if (item.action.providerId) writePersistedState(`vpn.import.${item.action.providerId}`, true);
    navigate(item.action.to);
  };

  // Nothing wrong is the good state: an all-clear strip on every launch is
  // noise, and noise is what this feature exists to remove.
  if (items.length === 0) return null;

  return (
    <Card
      className="mb-5"
      fold={{ id: 'needs-attention', summary: `${visible.length} needing action · ${hidden} dismissed` }}
    >
      <CardHeader
        title="Needs attention"
        icon={<TriangleAlert size={15} />}
        subtitle="Diagnoses this machine has already computed — each one is a problem that is still true right now"
      />
      <CardBody>
        {visible.length === 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted">
              {items.length} {items.length === 1 ? 'problem is' : 'problems are'} on record and you have dismissed{' '}
              {items.length === 1 ? 'it' : 'them'}. Nothing is hidden — the app is not failing anything new.
            </p>
            <Button variant="secondary" size="sm" onClick={() => setDismissed([])}>
              Show again
            </Button>
          </div>
        ) : (
          <ul className="space-y-2.5">
            {visible.map((item) => (
              <li
                key={item.id}
                className={`rounded-lg border px-3.5 py-3 ${
                  item.tone === 'danger' ? 'border-danger/30 bg-danger/10' : 'border-warn/30 bg-warn/10'
                }`}
              >
                <div className="flex items-start gap-2.5">
                  {item.tone === 'danger' ? (
                    <TriangleAlert size={15} className="mt-0.5 shrink-0 text-danger" />
                  ) : (
                    <TriangleAlert size={15} className="mt-0.5 shrink-0 text-warn" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p
                      className={`text-sm font-medium leading-relaxed ${
                        item.tone === 'danger' ? 'text-danger' : 'text-warn'
                      }`}
                    >
                      {/* Verbatim backend sentence, including the remedy it states. */}
                      {item.detail}
                    </p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 text-micro text-muted">
                      <span className="font-medium">{SOURCE_LABEL[item.source]}</span>
                      <span aria-hidden>·</span>
                      <span>seen {timeAgo(item.ts)}</span>
                      {item.repeats != null && (
                        <>
                          <span aria-hidden>·</span>
                          <span>recorded {item.repeats}×</span>
                        </>
                      )}
                    </p>
                    <div className="mt-2.5 flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => act(item)}
                        loading={item.action.kind === 'rerun' && rerun.isPending}
                        disabled={item.action.kind === 'rerun' && rerun.isPending}
                      >
                        {item.action.kind === 'rerun' && !rerun.isPending && <RefreshCw size={12} />}
                        {item.action.label}
                      </Button>
                      {item.canRecheck && item.action.kind !== 'rerun' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => rerun.mutate()}
                          loading={rerun.isPending}
                          disabled={rerun.isPending}
                        >
                          {!rerun.isPending && <RefreshCw size={12} />}
                          Re-check
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => dismiss(item.id)}
                        aria-label={`Dismiss: ${item.detail.slice(0, 80)}`}
                      >
                        <X size={12} />
                        Dismiss
                      </Button>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}