import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, History as HistoryIcon } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/States';
import { StatusDot } from '@/components/ui/StatusDot';
import { api } from '@/lib/api';
import { usePersistentId, usePersistentState } from '@/lib/usePersistentState';
import { fmtDateTime } from '@/lib/format';

import type { TestStatus, TestType } from '@shared/models/common';

interface TestRow {
  id: string;
  type: TestType;
  status: TestStatus;
  params: Record<string, unknown> | null;
  summary: Record<string, unknown> | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

interface TestDetail extends TestRow {
  /** Full result payload persisted with the record (same object as WS test:done). */
  result: Record<string, unknown> | null;
}

const RANGES = [
  { value: '1h', label: '1 hour', ms: 3600_000 },
  { value: '24h', label: '24 hours', ms: 24 * 3600_000 },
  { value: '7d', label: '7 days', ms: 7 * 24 * 3600_000 },
  { value: '30d', label: '30 days', ms: 30 * 24 * 3600_000 },
];

const TYPES = [
  { value: '', label: 'All' },
  { value: 'ping', label: 'Ping' },
  { value: 'speed', label: 'Speed' },
  { value: 'dns', label: 'DNS' },
  { value: 'route', label: 'Route' },
];

function summarize(row: TestRow): { label: string; value: string }[] {
  const s = (row.summary ?? {}) as Record<string, number | string | null>;
  switch (row.type) {
    case 'ping':
      return [
        { label: 'Avg', value: s.avg != null ? `${Number(s.avg).toFixed(1)} ms` : '—' },
        { label: 'Loss', value: s.lossPct != null ? `${s.lossPct}%` : '—' },
        { label: 'Target', value: String(s.target ?? '—') },
      ];
    case 'speed':
      return [
        { label: 'Down', value: s.downloadMbps != null ? `${Number(s.downloadMbps).toFixed(1)} Mbps` : '—' },
        { label: 'Up', value: s.uploadMbps != null ? `${Number(s.uploadMbps).toFixed(1)} Mbps` : '—' },
        { label: 'Ping', value: s.pingAvg != null ? `${Number(s.pingAvg).toFixed(1)} ms` : '—' },
      ];
    case 'dns':
      return [{ label: 'Providers', value: String(s.providers ?? '—') }];
    case 'route':
      return [
        { label: 'Hops', value: s.hops != null ? String(s.hops) : '—' },
        { label: 'Latency', value: s.totalLatencyMs != null ? `${Number(s.totalLatencyMs).toFixed(1)} ms` : '—' },
        { label: 'Score', value: s.score != null ? String(s.score) : '—' },
      ];
    default:
      return [];
  }
}

function TestDetailView({ test }: { test: TestDetail }) {
  const payload = test.result ?? (test.summary as Record<string, unknown> | null);
  return (
    <div className="space-y-3 py-3">
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-faint">
        <span>Status <span className="text-muted">{test.status}</span></span>
        <span>Started <span className="text-muted">{fmtDateTime(test.startedAt)}</span></span>
        {test.finishedAt != null && <span>Finished <span className="text-muted">{fmtDateTime(test.finishedAt)}</span></span>}
        {test.error && <span className="text-danger">Error: {test.error}</span>}
      </div>
      {test.params && (
        <div className="text-xs text-faint">
          Params <span className="text-muted">{JSON.stringify(test.params)}</span>
        </div>
      )}
      <pre className="max-h-80 overflow-auto rounded-lg border border-line bg-surface-2 p-3 text-micro leading-relaxed text-muted">
        {JSON.stringify(payload ?? {}, null, 2)}
      </pre>
    </div>
  );
}

export default function HistoryPage() {
  const [range, setRange] = usePersistentState<string>('history.range', '24h');
  const [type, setType] = usePersistentState<string>('history.type', '');
  const [selectedId, setSelectedId] = usePersistentId('history.selectedId');

  const rangeMs = RANGES.find((r) => r.value === range)?.ms ?? 24 * 3600_000;

  const params = new URLSearchParams({ limit: '200' });
  if (type) params.set('type', type);

  const query = useQuery({
    queryKey: ['history', type],
    queryFn: () => api.get<{ tests: TestRow[] }>(`/history?${params}`),
    refetchInterval: 15_000,
  });

  // Full payload comes from the detail endpoint — the record stores the complete
  // result, so a reload renders full detail without any WS delivery.
  const detailQuery = useQuery({
    queryKey: ['history', 'detail', selectedId],
    queryFn: () => api.get<{ test: TestDetail | null }>(`/history/${encodeURIComponent(selectedId ?? '')}`),
    enabled: selectedId != null,
  });

  const tests = (query.data?.tests ?? []).filter((t) => Date.now() - t.startedAt <= rangeMs);
  const detail = selectedId != null ? detailQuery.data?.test ?? null : null;

  return (
    <div>
      <PageHeader title="History" description="Every test you run is recorded here with its measured summary." />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {RANGES.map((r) => (
          <button
            key={r.value}
            onClick={() => setRange(r.value)}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              range === r.value
                ? 'border-accent/40 bg-accent-soft text-accent-strong'
                : 'border-line bg-surface text-muted hover:text-text'
            }`}
          >
            {r.label}
          </button>
        ))}
        <div className="mx-2 h-5 w-px bg-line" />
        {TYPES.map((t) => (
          <button
            key={t.value}
            onClick={() => setType(t.value)}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
              type === t.value
                ? 'border-accent/40 bg-accent-soft text-accent-strong'
                : 'border-line bg-surface text-muted hover:text-text'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {query.isError && <ErrorState error={query.error} retry={() => void query.refetch()} />}
      {query.isLoading && <LoadingState label="Loading history" />}

      {query.data && tests.length === 0 && (
        <EmptyState
          icon={<HistoryIcon size={20} />}
          title="No tests in this range"
          message="Run a quick ping test from the dashboard — results appear here automatically."
        />
      )}

      {query.data && tests.length > 0 && (
        <Card>
          <CardHeader title={`${tests.length} tests`} icon={<HistoryIcon size={15} />} />
          <CardBody className="space-y-1">
            {tests.map((t) => {
              const metrics = summarize(t);
              const open = selectedId === t.id;
              return (
                <div key={t.id}>
                  <button
                    onClick={() => setSelectedId(open ? null : t.id)}
                    className="flex w-full flex-wrap items-center justify-between gap-3 rounded-lg px-2 py-2.5 text-left transition-colors hover:bg-surface-2"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      {open ? <ChevronDown size={14} className="shrink-0 text-faint" /> : <ChevronRight size={14} className="shrink-0 text-faint" />}
                      <StatusDot tone={t.status === 'done' ? 'ok' : t.status === 'error' ? 'danger' : 'warn'} />
                      <Badge tone="accent">{t.type}</Badge>
                      <span className="text-mini text-muted">{fmtDateTime(t.startedAt)}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-4">
                      {metrics.map((m) => (
                        <span key={m.label} className="text-xs text-faint">
                          {m.label} <span className="metric-num ml-1 text-mini text-text">{m.value}</span>
                        </span>
                      ))}
                      {t.error && <span className="text-xs text-danger">{t.error}</span>}
                    </div>
                  </button>
                  {open && (
                    <div className="ml-2 border-l border-line pl-4">
                      {detailQuery.isFetching && <p className="py-2 text-xs text-faint">Loading detail…</p>}
                      {detail && <TestDetailView test={detail} />}
                    </div>
                  )}
                </div>
              );
            })}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
