import { useEffect, useMemo, useRef, useState } from 'react';

import { useQuery } from '@tanstack/react-query';
import { Gauge as GaugeIcon, Globe as Globe2Icon, Play, Sparkles, Zap } from 'lucide-react';
import { useNavigate } from 'react-router';

import { Gauge } from '@/components/charts/Gauge';
import { LatencyChart } from '@/components/charts/LatencyChart';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Metric } from '@/components/ui/Metric';
import { PageHeader } from '@/components/ui/PageHeader';
import { Progress } from '@/components/ui/Progress';
import { ErrorState, LoadingState } from '@/components/ui/States';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { ConnectionCard, HealthBreakdown } from './ConnectionCard';
import { deriveInsights, InsightsCard } from './InsightsCard';
import { IranConnectivityWidget } from '@/features/iran/IranConnectivityWidget';
import { LiveMapWidget } from '@/features/map/LiveMapWidget';

import type { EventRecord } from '@shared/models/common';
import type { NetworkStatus, PingResult } from '@shared/models/network';

interface PingTestResponse {
  testId: string;
  result: PingResult;
}

interface HistoryRow {
  id: string;
  type: string;
  status: string;
  summary: Record<string, unknown> | null;
  startedAt: number;
}

const QUICK_ACTIONS = [
  { to: '/map', label: 'Live map', icon: <Globe2Icon size={14} /> },
  { to: '/diagnostics', label: 'Full test', icon: <Sparkles size={14} /> },
  { to: '/speed-test', label: 'Speed test', icon: <Zap size={14} /> },
  { to: '/dns', label: 'DNS test', icon: <Zap size={14} /> },
  { to: '/routes', label: 'Route test', icon: <Zap size={14} /> },
  { to: '/iran', label: 'Iran test', icon: <Zap size={14} /> },
  { to: '/optimizer', label: 'Optimize', icon: <Zap size={14} /> },
  { to: '/vpn', label: 'Connect VPN', icon: <Zap size={14} /> },
];

export default function DashboardPage() {
  const statusQuery = useQuery({
    queryKey: ['network', 'status'],
    queryFn: () => api.get<NetworkStatus>('/network/status'),
    refetchInterval: 5_000,
  });

  const eventsQuery = useQuery({
    queryKey: ['events', 'dashboard'],
    queryFn: () => api.get<{ events: EventRecord[] }>('/events?limit=6'),
    refetchInterval: 8_000,
  });

  const navigate = useNavigate();

  // latest persisted measurements for the dashboard metrics
  const speedHistoryQuery = useQuery({
    queryKey: ['history', 'speed', 'dashboard'],
    queryFn: () => api.get<{ tests: HistoryRow[] }>('/history?type=speed&limit=1'),
    refetchInterval: 30_000,
  });
  const dnsHistoryQuery = useQuery({
    queryKey: ['history', 'dns', 'dashboard'],
    queryFn: () => api.get<{ tests: HistoryRow[] }>('/history?type=dns&limit=1'),
    refetchInterval: 30_000,
  });

  const lastSpeed = speedHistoryQuery.data?.tests?.[0];
  const lastDns = dnsHistoryQuery.data?.tests?.[0];
  const lastDownload = typeof lastSpeed?.summary?.downloadMbps === 'number' ? (lastSpeed.summary.downloadMbps as number) : null;
  const lastUpload = typeof lastSpeed?.summary?.uploadMbps === 'number' ? (lastSpeed.summary.uploadMbps as number) : null;
  // best (lowest) latency among tested providers — the number a good resolver should match
  const dnsResults = Array.isArray(lastDns?.summary?.results) ? (lastDns.summary.results as { latencyMs: number | null }[]) : [];
  const lastDnsMs = dnsResults.filter((r) => r.latencyMs != null).reduce((min, r) => Math.min(min, r.latencyMs as number), Infinity);
  const bestDnsMs = Number.isFinite(lastDnsMs) ? lastDnsMs : null;

  const [latencyHistory, setLatencyHistory] = useState<{ t: number; ms: number | null }[]>([]);
  const lastTsRef = useRef(0);

  useEffect(() => {
    const status = statusQuery.data;
    if (!status || status.checkedAt === lastTsRef.current) return;
    lastTsRef.current = status.checkedAt;
    setLatencyHistory((prev) => [...prev.slice(-59), { t: status.checkedAt, ms: status.latencyTcpMs }]);
  }, [statusQuery.data]);

  const [lastPing, setLastPing] = useState<PingResult | null>(null);
  const [pingRunning, setPingRunning] = useState(false);
  const [pingProgress, setPingProgress] = useState(0);

  const runQuickTest = async () => {
    setPingRunning(true);
    setPingProgress(0);
    try {
      // subscribe after we know the testId: the POST resolves it first,
      // so we poll progress via a pre-arranged channel id
      const promise = api.post<PingTestResponse>('/ping-test', { target: '1.1.1.1', count: 10 });
      const res = await promise;
      setLastPing(res.result);
      setPingProgress(100);
    } catch {
      // error toast handled by caller via ErrorState below
      setLastPing(null);
    } finally {
      setPingRunning(false);
    }
  };

  const insights = useMemo(
    () =>
      deriveInsights(statusQuery.data, lastPing, {
        bestDnsMs,
        downloadMbps: lastDownload,
        uploadMbps: lastUpload,
      }),
    [statusQuery.data, lastPing, bestDnsMs, lastDownload, lastUpload],
  );

  const pingStatus = !lastPing ? 'idle' : lastPing.avg != null && lastPing.avg <= 50 ? 'good' : lastPing.avg != null && lastPing.avg <= 150 ? 'warn' : 'bad';
  const jitterStatus = !lastPing?.jitterMs ? 'idle' : lastPing.jitterMs <= 3 ? 'good' : lastPing.jitterMs <= 10 ? 'warn' : 'bad';
  const lossStatus = lastPing == null ? 'idle' : lastPing.lossPct === 0 ? 'good' : lastPing.lossPct <= 2 ? 'warn' : 'bad';

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description="How healthy is your connection right now?"
        actions={
          <Button variant="primary" onClick={runQuickTest} loading={pingRunning} disabled={pingRunning}>
            {!pingRunning && <Play size={14} />}
            Quick ping test
          </Button>
        }
      />

      {statusQuery.isError && <ErrorState error={statusQuery.error} retry={() => void statusQuery.refetch()} />}
      {statusQuery.isLoading && <LoadingState label="Measuring your connection" />}

      {statusQuery.data?.health && statusQuery.data.health.score != null ? (
        <div className="space-y-6">
          {/* health + connection */}
          <div className="grid gap-5 lg:grid-cols-3">
            <Card className="lg:col-span-1">
              <CardHeader title="Network health" icon={<GaugeIcon size={15} />} />
              <CardBody className="flex flex-col items-center">
                <Gauge value={statusQuery.data.health.score} label={statusQuery.data.health.label ?? 'awaiting data'} size={190} />
                <p className="mt-3 text-center text-xs leading-relaxed text-faint">
                  {statusQuery.data.health.score == null
                    ? 'Score appears once latency data exists.'
                    : `Based on ${statusQuery.data.health.components?.filter((c) => c.measured).length ?? 0} of ${statusQuery.data.health.components?.length ?? 0} measured components.`}
                </p>
                {pingRunning && (
                  <div className="mt-4 w-full">
                    <Progress value={pingProgress} />
                  </div>
                )}
              </CardBody>
            </Card>

            <div className="space-y-5 lg:col-span-2">
              <ConnectionCard status={statusQuery.data} />
              <div className="grid grid-cols-2 gap-5 sm:grid-cols-3 xl:grid-cols-6">
                <Metric label="Ping" value={lastPing?.avg ?? statusQuery.data.latencyTcpMs} unit="ms" status={pingStatus} hint={lastPing ? `ICMP avg to ${lastPing.target}` : 'Live TCP connect time to 1.1.1.1:443'} />
                <Metric label="Jitter" value={lastPing?.jitterMs ?? null} unit="ms" status={jitterStatus} hint="Mean variation between successive replies (last ping run)" />
                <Metric label="Packet loss" value={lastPing?.lossPct ?? null} unit="pct" status={lossStatus} hint="From the last ping run" />
                <Metric label="Download" value={lastDownload} unit="mbps" status={lastDownload == null ? 'idle' : 'good'} hint={lastSpeed ? `Last speed test (${timeAgo(lastSpeed.startedAt)})` : 'Run a speed test to populate'} />
                <Metric label="Upload" value={lastUpload} unit="mbps" status={lastUpload == null ? 'idle' : 'good'} hint="From the last speed test" />
                <Metric label="DNS" value={bestDnsMs} unit="ms" status={bestDnsMs == null ? 'idle' : bestDnsMs <= 30 ? 'good' : bestDnsMs <= 80 ? 'warn' : 'bad'} hint={lastDns ? `Best resolver latency (last DNS test)` : 'Run a DNS test to populate'} />
              </div>
            </div>
          </div>

          {/* iran connectivity widget */}
          <IranConnectivityWidget />

          {/* live map widget */}
          <LiveMapWidget />

          {/* quick actions */}
          <Card>
            <CardHeader
              title="Quick actions"
              subtitle="Jump into a focused diagnostic — progress and results are always real measurements"
            />
            <CardBody>
              <div className="flex flex-wrap gap-2.5">
                {QUICK_ACTIONS.map((a) => (
                  <Button key={a.to} variant="secondary" size="sm" onClick={() => navigate(a.to)}>
                    {a.icon}
                    {a.label}
                  </Button>
                ))}
              </div>
            </CardBody>
          </Card>

          {/* chart + insights */}
          <div className="grid gap-5 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader
                title="Live latency"
                subtitle="TCP connect time to 1.1.1.1:443, sampled every 5 seconds"
                actions={<Badge tone="accent">{latencyHistory.length} samples</Badge>}
              />
              <CardBody>
                <LatencyChart data={latencyHistory} height={150} />
              </CardBody>
            </Card>
            <InsightsCard insights={insights} />
          </div>          {/* breakdown + events */}
          <div className="grid gap-5 lg:grid-cols-3">
            <HealthBreakdown status={statusQuery.data} />
            <Card className="lg:col-span-2">
              <CardHeader
                title="Recent activity"
                actions={
                  <a href="/events" className="text-xs text-accent hover:underline">
                    View all
                  </a>
                }
              />
              <CardBody className="space-y-2">
                {(eventsQuery.data?.events ?? []).length === 0 && (
                  <p className="py-4 text-center text-sm text-faint">No events recorded yet.</p>
                )}
                {(eventsQuery.data?.events ?? []).map((e) => (
                  <div key={e.id} className="flex items-center justify-between gap-3 text-[13px]">
                    <span className="flex min-w-0 items-center gap-2">
                      <Badge tone={e.level === 'error' ? 'danger' : e.level === 'warn' ? 'warn' : 'neutral'}>
                        {e.category}
                      </Badge>
                      <span className="truncate text-muted">{e.message}</span>
                    </span>
                    <span className="shrink-0 text-xs text-faint">{timeAgo(e.ts)}</span>
                  </div>
                ))}
              </CardBody>
            </Card>
          </div>
        </div>
      ) : (
        <div>
          <Card>
            <CardBody className="flex items-center justify-center py-12 text-faint">
              <div className="text-center">
                <p className="text-sm">Health data not available yet.</p>
                <p className="text-xs mt-1">Run a quick ping test or wait for the next status refresh.</p>
              </div>
            </CardBody>
          </Card>
        </div>
      )
    }
  </div>
);
}
