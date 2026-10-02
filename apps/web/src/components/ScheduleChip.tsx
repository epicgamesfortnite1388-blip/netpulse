import { CalendarClock, Loader2 } from 'lucide-react';

import type { ScheduledRunStatus } from '@shared/models/settings';

import { useScheduleStatus } from '@/lib/useScheduleStatus';

/**
 * Compact "auto-benchmark" indicator for feature pages. Renders nothing when
 * the schedule is disabled; otherwise shows the interval and when the next run
 * happens (updating every minute via the live schedule feed).
 */
export function ScheduleChip({ kind }: { kind: 'dns' | 'gaming' | 'vpn' }) {
  const { data } = useScheduleStatus();
  const st = (data?.status ?? {})[kind] as ScheduledRunStatus | undefined;
  if (!st?.enabled) return null;

  const next = st.nextRunAt != null ? relativeTime(st.nextRunAt) : null;
  return (
    <span
      title={st.running ? 'A scheduled run is in progress' : `Next run in ${next ?? '…'}`}
      className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent/10 px-2.5 py-1 text-micro font-medium uppercase tracking-wide text-accent"
    >
      {st.running ? <Loader2 size={11} className="animate-spin" /> : <CalendarClock size={11} />}
      auto {st.intervalMin}m{st.running ? ' · running' : next ? ` · next ${next}` : ''}
    </span>
  );
}

function relativeTime(ts: number): string {
  const diff = Math.max(0, Math.round((ts - Date.now()) / 1000));
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.round(diff / 60)}m`;
  if (diff < 86_400) return `${Math.round(diff / 3600)}h`;
  return `${Math.round(diff / 86_400)}d`;
}