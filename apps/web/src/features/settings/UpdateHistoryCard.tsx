import { useCallback, useEffect, useRef, useState } from 'react';

import { CheckCircle2, History, Info, RefreshCw, Trash2, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { fetchUpdateHistory, updateHistoryRefetchDue } from '@/lib/updater';

import type { UpdateEventTone, UpdateHistoryEntry } from '@netpulse/shared';

import { updateEventLine, updateEventTone, updateHistorySummary } from '@netpulse/shared';

const TONE_ICON: Record<UpdateEventTone, typeof CheckCircle2> = {
  ok: CheckCircle2,
  info: Info,
  error: TriangleAlert,
};

const TONE_CLASS: Record<UpdateEventTone, string> = {
  ok: 'text-ok',
  info: 'text-accent-strong',
  error: 'text-danger',
};

/**
 * Update history — the readable diary of what the updater did, when, and why.
 *
 * Data comes from the sidecar's event log via `fetchUpdateHistory`; every line
 * is worded by the shared policy (`updateEventLine`) so this card, the fold
 * summary, and the dashboard warning tell the same story. A failed check or
 * install shows the REAL reason the updater produced — never dressed up as a
 * success and never blank.
 *
 * Deep link: /settings?tab=platform&card=update-history (used by the dashboard
 * warning) opens the fold and scrolls the card into view. Opening goes through
 * `defaultOpen`, so the Disclosure store's rules stay the owner: a user who
 * explicitly folded the card keeps that choice; everyone else gets it open.
 *
 * Visibility refetch: rows recorded while the card was off-screen — the
 * launch poll, a background check, another device's install reconciled on
 * boot — appear the moment the card's body re-enters the viewport, without a
 * manual Refresh. The observer attaches INSIDE CardBody, so a folded card
 * observes nothing (no body is rendered) and costs zero. A 30 s staleness
 * floor (`updateHistoryRefetchDue`) keeps scroll-past from hammering the
 * sidecar.
 */
export function UpdateHistoryCard() {
  // Latched once at mount: did this mount arrive via the deep link? A stored
  // fold choice still wins over it (Disclosure policy), and the param is
  // consumed after mount so tab-switch remounts never re-fire it.
  const [deepLinked] = useState(
    () => new URLSearchParams(window.location.search).get('card') === 'update-history',
  );
  const [events, setEvents] = useState<UpdateHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(false);
  // Two-step clear: first click arms, second click deletes. Arming is session
  // state, not storage — a stuck armed button after a tab switch is worse than
  // clicking Confirm again.
  const [armed, setArmed] = useState(false);
  const [clearing, setClearing] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    void fetchUpdateHistory()
      .then((rows) => {
        setEvents(rows);
        setError(null);
      })
      .catch(() => setError('History is unavailable right now.'))
      .finally(() => setLoading(false));
  }, []);

  // When the last load STARTED — the staleness clock for the visibility
  // refetch. Initialized to 0 (never loaded = always due).
  const lastLoadStartRef = useRef(0);
  const wrappedLoad = useCallback(() => {
    lastLoadStartRef.current = Date.now();
    load();
  }, [load]);

  useEffect(() => {
    load();
    lastLoadStartRef.current = Date.now();
  }, [load, reloadKey]);

  // Deep link: scroll to the card, then drop the `card` param from the URL
  // (replaceState, no re-render) so remounting on tab switches never re-scrolls.
  useEffect(() => {
    if (!deepLinked) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('card');
    window.history.replaceState(null, '', url);
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [deepLinked]);

  // Visibility refetch: when the card's body re-enters the viewport after
  // the staleness floor, reload so off-screen recordings (launch poll,
  // background checks) appear without a manual Refresh. The observer lives in
  // a child rendered INSIDE CardBody, so it mounts/unmounts with the body —
  // a folded card observes nothing, and a re-opened fold gets a fresh
  // observer without any lifecycle bookkeeping here.
  const onBodyVisible = useCallback(() => {
    if (!updateHistoryRefetchDue(lastLoadStartRef.current, Date.now())) return;
    wrappedLoad();
  }, [wrappedLoad]);

  const clearHistory = useCallback(async () => {
    setClearing(true);
    try {
      await api.delete<{ ok: boolean; removed: number }>('/update-history');
      setEvents([]);
      setError(null);
      setArmed(false);
    } catch {
      setError('Could not clear history.');
    } finally {
      setClearing(false);
    }
  }, []);

  // null = not loaded yet; [] = loaded and genuinely empty.
  const summary = events === null ? 'loading…' : updateHistorySummary(events);

  return (
    <div ref={cardRef} className="scroll-mt-24">
      <Card fold={{ id: 'update-history', defaultOpen: deepLinked, summary }}>
        <CardHeader
          title="Update history"
          subtitle="Checks, downloads and installs recorded by the updater"
          actions={
            events !== null && events.length > 0 && error === null ? (
              armed ? (
                <span className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="danger"
                    loading={clearing}
                    title="Removes every recorded update event — this cannot be undone"
                    onClick={() => void clearHistory()}
                  >
                    <Trash2 size={12} /> Confirm clear
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setArmed(false)}>
                    Cancel
                  </Button>
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setArmed(true)}
                  aria-label="Clear update history"
                  title="Remove every recorded update event — asks to confirm first"
                >
                  <Trash2 size={12} /> Clear
                </Button>
              )
            ) : null
          }
        />
        <CardBody className="max-w-xl space-y-3">
          <VisibilityRefetch onVisible={onBodyVisible} />
          {error !== null ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted">{error}</span>
              <Button size="sm" variant="secondary" loading={loading} onClick={() => setReloadKey((k) => k + 1)}>
                <RefreshCw size={12} /> Retry
              </Button>
            </div>
          ) : events === null ? (
            <p className="text-xs text-faint">Loading history…</p>
          ) : events.length === 0 ? (
            <p className="text-xs text-faint">
              No update activity recorded yet. The first check — automatic after launch or manual below — will appear here.
            </p>
          ) : (
            <>
              <ul className="space-y-2">
                {events.map((e) => {
                  const Icon = TONE_ICON[updateEventTone(e)];
                  return (
                    <li key={e.id} className="flex items-start gap-2.5">
                      <Icon size={13} className={`mt-0.5 shrink-0 ${TONE_CLASS[updateEventTone(e)]}`} />
                      <div className="min-w-0">
                        <div className="text-xs leading-snug text-text">{updateEventLine(e)}</div>
                        <div className="text-[10px] text-faint">{timeAgo(e.at)}</div>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <div className="flex justify-end">
                <Button size="sm" variant="secondary" loading={loading} onClick={() => setReloadKey((k) => k + 1)}>
                  <History size={12} /> Refresh
                </Button>
              </div>
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

/**
 * Renders nothing. Watches the element it is mounted in and fires `onVisible`
 * every time that element enters the viewport (the fold body unmounts this
 * component when the card is folded, so a folded card observes nothing). The
 * throttle/staleness decision belongs to the caller (`onBodyVisible` applies
 * the shared refetch-due policy).
 */
function VisibilityRefetch({ onVisible }: { onVisible: () => void }) {
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onVisible();
      },
      { threshold: 0.1 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [onVisible]);

  return <span ref={ref} aria-hidden className="hidden" />;
}

