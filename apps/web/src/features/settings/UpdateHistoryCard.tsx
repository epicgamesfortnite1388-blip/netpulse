import { useCallback, useEffect, useState } from 'react';

import { CheckCircle2, History, Info, RefreshCw, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { timeAgo } from '@/lib/format';
import { fetchUpdateHistory } from '@/lib/updater';

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
 * summary, and any future surface tell the same story. A failed check or
 * install shows the REAL reason the updater produced — never dressed up as a
 * success and never blank.
 */
export function UpdateHistoryCard() {
  const [events, setEvents] = useState<UpdateHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(false);

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

  useEffect(() => {
    load();
  }, [load, reloadKey]);

  // null = not loaded yet; [] = loaded and genuinely empty.
  const summary = events === null ? 'loading…' : updateHistorySummary(events);

  return (
    <Card fold={{ id: 'update-history', defaultOpen: false, summary }}>
      <CardHeader
        title="Update history"
        subtitle="Checks, downloads and installs recorded by the updater"
      />
      <CardBody className="max-w-xl space-y-3">
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
  );
}
