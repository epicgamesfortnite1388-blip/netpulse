import { useEffect, useRef, useState } from 'react';

import { useQuery } from '@tanstack/react-query';
import { Activity, History as HistoryIcon, Play } from 'lucide-react';

import { LatencyChart } from '@/components/charts/LatencyChart';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { DisclosureScope, DisclosureToolbar } from '@/components/ui/Disclosure';
import { Metric } from '@/components/ui/Metric';
import { PageHeader } from '@/components/ui/PageHeader';
import { Progress } from '@/components/ui/Progress';
import { ErrorState, LoadingState } from '@/components/ui/States';
import { api } from '@/lib/api';
import { usePersistentId } from '@/lib/usePersistentState';
import { useBackgroundTest } from '@/lib/useBackgroundTest';
import { subscribeTest } from '@/lib/ws';
import { timeAgo } from '@/lib/format';

import type { SpeedTestResult, ThroughputSample } from '@shared/models/speed';

interface TestRow {
  id: string;
  summary: Record<string, unknown> | null;
  startedAt: number;
  finishedAt: number | null;
}

interface HistoryResponse {
  tests: TestRow[];
}

/** test:progress frames for speed carry an extra `mbps` field from the provider sampler */
type WsProgressWithMbps = { mbps?: number };

export default function SpeedTestPage() {
  const historyQuery = useQuery({
    queryKey: ['speed', 'history'],
    queryFn: () => api.get<HistoryResponse>('/speed/history?limit=25'),
  });

  // testId persists across tab switches — a ~30s speed test keeps its live
  // progress when the user browses other pages and re-attaches on return.
  const [testId, setTestId] = usePersistentId('speed.testId');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const state = useBackgroundTest<SpeedTestResult>(testId);
  const result = state.result;

  // live throughput samples stream in via test:progress extras ({ mbps })
  const [live, setLive] = useState<{ t: number; ms: number }[]>([]);
  const unsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (testId == null) return;
    const unsubscribe = subscribeTest(testId, (msg) => {
      const mbps = (msg as WsProgressWithMbps).mbps;
      if (msg.type === 'test:progress' && typeof mbps === 'number') {
        setLive((prev) => [...prev.slice(-119), { t: Date.now(), ms: mbps }]);
      }
    });
    unsubRef.current = unsubscribe;
    return () => {
      unsubscribe();
      unsubRef.current = null;
    };
  }, [testId]);

  const runTest = async () => {
    if (state.running) return;
    setSubmitError(null);
    setLive([]);
    try {
      const res = await api.post<{ testId: string }>('/speed/run', { durationMs: 8_000 });
      setTestId(res.testId);
      void historyQuery.refetch();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Speed test failed to start');
    }
  };

  const error = submitError ?? state.error;
  const liveNow = live.length > 0 ? live[live.length - 1]?.ms ?? null : null;

  const samples = result
    ? [
        ...result.downloadSamples.map((s: ThroughputSample) => ({ t: s.t, ms: s.mbps })),
        ...result.uploadSamples.map((s: ThroughputSample) => ({ t: s.t, ms: s.mbps })),
      ]
    : [];

  return (
    <DisclosureScope name="speed-test">
      <PageHeader
        title="Speed test"
        description="Real throughput measurement — streaming downloads and uploads against Cloudflare speed endpoints. No simulated numbers."
        actions={
          <Button variant="primary" onClick={() => void runTest()} loading={state.running} disabled={state.running}>
            <Play size={14} />
            {state.running ? 'Measuring…' : 'Run speed test'}
          </Button>
        }
      />

      <DisclosureToolbar className="-mt-3 mb-2" />

      {error && <ErrorState error={new Error(error)} retry={() => void runTest()} />}

      {state.running && (
        <Card className="mb-5">
          <CardBody className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted">{state.message ?? 'measuring'}</span>
              <span className="font-mono text-faint">{state.pct ?? 0}%</span>
            </div>
            <Progress value={state.pct ?? 0} />
            <p className="text-xs text-faint">Download and upload are measured sequentially. Keep heavy transfers paused for an accurate reading.</p>
          </CardBody>
        </Card>
      )}

      {state.running && live.length > 0 && (
        <Card className="mb-5" fold={{ id: 'live-throughput', summary: `${live.length} sample${live.length === 1 ? '' : 's'} so far` }}>
          <CardHeader
            title="Live throughput"
            subtitle="Samples stream in as bytes arrive — nothing is interpolated"
            actions={<Badge tone="accent">{liveNow != null ? `${liveNow.toFixed(1)} Mbps` : '…'}</Badge>}
          />
          <CardBody>
            <LatencyChart data={live} height={160} />
          </CardBody>
        </Card>
      )}

      {result && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 xl:grid-cols-6">
            <Metric label="Download" value={result.downloadMbps} unit="mbps" status={result.downloadMbps == null ? 'idle' : result.downloadMbps >= 100 ? 'good' : result.downloadMbps >= 25 ? 'warn' : 'bad'} />
            <Metric label="Upload" value={result.uploadMbps} unit="mbps" status={result.uploadMbps == null ? 'idle' : result.uploadMbps >= 50 ? 'good' : result.uploadMbps >= 10 ? 'warn' : 'bad'} />
            <Metric label="Ping avg" value={result.pingAvg} unit="ms" status={result.pingAvg == null ? 'idle' : result.pingAvg <= 30 ? 'good' : result.pingAvg <= 80 ? 'warn' : 'bad'} />
            <Metric label="Ping median" value={result.pingMedian} unit="ms" />
            <Metric label="Jitter" value={result.jitterMs} unit="ms" status={result.jitterMs == null ? 'idle' : result.jitterMs <= 3 ? 'good' : result.jitterMs <= 10 ? 'warn' : 'bad'} />
            <Metric label="Packet loss" value={result.packetLoss} unit="pct" status={result.packetLoss == null ? 'idle' : result.packetLoss === 0 ? 'good' : result.packetLoss <= 2 ? 'warn' : 'bad'} />
          </div>

          <Card
            fold={{
              id: 'throughput-samples',
              defaultOpen: false,
              summary: `${result.downloadSamples.length} download + ${result.uploadSamples.length} upload samples`,
            }}
          >
            <CardHeader
              title="Throughput samples"
              subtitle={`${result.downloadSamples.length} download + ${result.uploadSamples.length} upload samples · server: ${result.server}`}
              actions={<Badge tone="accent">{(result.durationMs / 1000).toFixed(0)}s window</Badge>}
            />
            <CardBody>
              {samples.length > 0 ? (
                <LatencyChart data={samples} height={180} />
              ) : (
                <p className="py-6 text-center text-sm text-faint">No throughput samples were collected — the measurement may have been blocked by this environment.</p>
              )}
              {result.error && <p className="mt-3 text-xs text-warn">{result.error}</p>}
            </CardBody>
          </Card>
        </div>
      )}

      {!result && !state.running && !error && (
        <Card className="mb-5">
          <CardBody>
            <p className="py-4 text-center text-sm text-faint">
              Measures real download and upload throughput over ~16 seconds plus TCP-connect latency statistics. Values appear only from actual socket traffic.
            </p>
          </CardBody>
        </Card>
      )}

      <Card
        fold={{
          id: 'speed-history',
          defaultOpen: false,
          summary: historyQuery.data ? `${historyQuery.data.tests.length} test${historyQuery.data.tests.length === 1 ? '' : 's'} recorded` : 'loading history',
        }}
      >
        <CardHeader title="History" icon={<HistoryIcon size={15} />} actions={<Badge tone="neutral">{historyQuery.data?.tests.length ?? 0}</Badge>} />
        <CardBody>
          {historyQuery.isLoading && <LoadingState label="Loading history" />}
          {historyQuery.data && historyQuery.data.tests.length === 0 && (
            <p className="py-6 text-center text-sm text-faint">No speed tests recorded yet — run your first measurement above.</p>
          )}
          {historyQuery.data && historyQuery.data.tests.length > 0 && (
            <div className="space-y-1.5">
              {historyQuery.data.tests.slice(0, 12).map((test) => {
                const summary = (test.summary ?? {}) as Partial<SpeedTestResult>;
                return (
                  <div key={test.id} className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-mini hover:bg-surface-2">
                    <span className="font-mono text-muted">
                      ↓ {fmt(summary.downloadMbps)} · ↑ {fmt(summary.uploadMbps)} · {fmt(summary.pingAvg)} ms
                    </span>
                    <span className="text-xs text-faint">{timeAgo(test.finishedAt ?? test.startedAt)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </CardBody>
      </Card>

      <p className="mt-4 flex items-center gap-2 text-xs text-faint">
        <Activity size={12} />
        Throughput numbers derive from bytes actually received/sent over the measurement window.
      </p>
    </DisclosureScope>
  );
}

function fmt(v: number | null | undefined): string {
  return v == null ? '—' : v.toFixed(1);
}
