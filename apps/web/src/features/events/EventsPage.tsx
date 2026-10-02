import { useQuery } from '@tanstack/react-query';
import { Radio } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Field';
import { LoadingState, ErrorState } from '@/components/ui/States';
import { api } from '@/lib/api';
import { usePersistentState } from '@/lib/usePersistentState';
import { fmtClock, timeAgo } from '@/lib/format';

import type { EventCategory, EventLevel } from '@shared/models/common';

const LEVELS: { value: string; label: string }[] = [
  { value: '', label: 'All levels' },
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warning' },
  { value: 'error', label: 'Error' },
];

const CATEGORIES: { value: string; label: string }[] = [
  { value: '', label: 'All categories' },
  { value: 'network', label: 'Network' },
  { value: 'vpn', label: 'VPN' },
  { value: 'dns', label: 'DNS' },
  { value: 'routing', label: 'Routing' },
  { value: 'system', label: 'System' },
];

export default function EventsPage() {
  const [level, setLevel] = usePersistentState<string>('events.level', '');
  const [category, setCategory] = usePersistentState<string>('events.category', '');

  const params = new URLSearchParams({ limit: '200' });
  if (level) params.set('level', level);
  if (category) params.set('category', category);

  const query = useQuery({
    queryKey: ['events', level, category],
    queryFn: () => api.get<{ events: { id: number; ts: number; level: EventLevel; category: EventCategory; message: string }[] }>(`/events?${params}`),
    refetchInterval: 5_000,
  });

  return (
    <div>
      <PageHeader
        title="Events"
        description="Technical event log — every diagnostic action, state change and warning, in order."
      />

      <div className="mb-4 flex flex-wrap gap-3">
        <div className="w-44">
          <Select value={level} onChange={(e) => setLevel(e.target.value)} aria-label="Filter events by level">
            {LEVELS.map((l) => (
              <option key={l.value} value={l.value}>{l.label}</option>
            ))}
          </Select>
        </div>
        <div className="w-52">
          <Select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Filter events by category">
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </Select>
        </div>
      </div>

      {query.isError && <ErrorState error={query.error} retry={() => void query.refetch()} />}
      {query.isLoading && <LoadingState label="Loading events" />}

      {query.data && (
        <Card>
          <CardHeader
            title={`${query.data.events.length} events`}
            subtitle="Newest first — refreshes automatically"
            icon={<Radio size={15} />}
          />
          <CardBody className="space-y-1">
            {query.data.events.length === 0 && (
              <p className="py-8 text-center text-sm text-faint">No events match the current filters.</p>
            )}
            {query.data.events.map((e) => (
              <div
                key={e.id}
                className="flex items-start justify-between gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-surface-2"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <span className="metric-num shrink-0 pt-0.5 text-xs text-faint">{fmtClock(e.ts)}</span>
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Badge tone={e.level === 'error' ? 'danger' : e.level === 'warn' ? 'warn' : 'neutral'}>
                      {e.level}
                    </Badge>
                    <Badge tone="accent">{e.category}</Badge>
                    <span className="text-mini text-text">{e.message}</span>
                  </div>
                </div>
                <span className="shrink-0 text-xs text-faint">{timeAgo(e.ts)}</span>
              </div>
            ))}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
