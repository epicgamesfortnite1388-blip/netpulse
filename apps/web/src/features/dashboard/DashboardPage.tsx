import { useEffect, useMemo, useRef, useState } from 'react';

import { useQuery } from '@tanstack/react-query';
import { Gauge as GaugeIcon, Globe as Globe2Icon, Network, Play, Sparkles, Activity, TriangleAlert, Route as RouteIcon, Shield as ShieldIcon, Flag as FlagIcon } from 'lucide-react';
import { Link, useNavigate } from 'react-router';

import { BrandMark } from '@/components/BrandMark';
import { Gauge } from '@/components/charts/Gauge';
import { LatencyChart } from '@/components/charts/LatencyChart';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { DetailGate, DetailLevelControl, DetailLevelProvider } from '@/components/ui/DetailLevel';
import { DisclosureScope, DisclosureToolbar } from '@/components/ui/Disclosure';
import { Metric } from '@/components/ui/Metric';
import { PageHeader } from '@/components/ui/PageHeader';
import { Progress } from '@/components/ui/Progress';
import { ErrorState, LoadingState } from '@/components/ui/States';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { fetchLastCheckFailure } from '@/lib/updater';
import { ConnectionCard, HealthBreakdown } from './ConnectionCard';
import { ConnectionHero } from '@/features/connection/ConnectionHero';
import { useConnection } from '@/features/connection/connectionState';
import { deriveInsights, InsightsCard } from './InsightsCard';
import { NeedsAttentionCard } from './NeedsAttentionCard';
import { IranConnectivityWidget } from '@/features/iran/IranConnectivityWidget';
import { LiveMapWidget } from '@/features/map/LiveMapWidget';

import { updateEventLine } from '@netpulse/shared';

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
  { to: '/speed-test', label: 'Speed test', icon: <Activity size={14} /> },
  { to: '/dns', label: 'DNS test', icon: <Network size={14} /> },
  { to: '/routes', label: 'Route test', icon: <RouteIcon size={14} /> },
  { to: '/iran', label: 'Iran test', icon: <FlagIcon size={14} /> },
  { to: '/optimizer', label: 'Optimize', icon: <GaugeIcon size={14} /> },
  { to: '/vpn', label: 'Connect VPN', icon: <ShieldIcon size={14} /> },
];

/**
 * One supporting number in the command band.
 *
 * The unit only renders when there is a value. Printing "— ms" states a unit
 * for a measurement that does not exist, and at 12px the em dash plus "ms"
 * reads as the word "as" — which is how the band came to say "DNS —as".
 * All four numbers share one size: the band's hierarchy is the verdict word,
 * and four metrics at four different sizes made it read as a dashboard widget
 * rather than an instrument readout.
 */
function HeroMetric({
  label,
  value,
  unit,
  tone = 'text-text',
}: {
  label: string;
  value: number | string | null | undefined;
  unit?: string;
  tone?: string;
}) {
  const present = value != null && value !== '';
  return (
    <div>
      <div className="text-micro uppercase tracking-[0.16em] text-faint">{label}</div>
      <div className={`metric-num mt-1 text-xl font-medium leading-none ${present ? tone : 'text-faint'}`}>
        {present ? value : '—'}
        {present && unit && <span className="ml-1 text-micro font-normal text-faint">{unit}</span>}
      </div>
    </div>
  );
}

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

  // Proactive updater surfacing: if the last check failed, say so here and
  // link to the history card — a silent updater that never checks is exactly
  // how an app ends up months out of date. Null renders nothing (healthy case;
  // also web mode, where no updater exists to fail).
  const lastCheckFailQuery = useQuery({
    queryKey: ['update-history', 'last-failure'],
    queryFn: () => fetchLastCheckFailure(),
    staleTime: 60_000,
  });
  const lastCheckFail = lastCheckFailQuery.data ?? null;

  const navigate = useNavigate();
  // F-05: the redesigned connection console is now the primary surface on the
  // dashboard. It reads the same backend carriers as the legacy ConnectionCard
  // through useConnection(); no connection state is computed in the UI.
  const connection = useConnection();

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

  /*
   * The hero band's live verdict.
   *
   * The word comes from the backend's own label, and the colour from the same
   * score bands the backend uses to produce it (>=85 Excellent, >=70 Good,
   * >=50 Fair, else Poor). This band previously ran a second, different scale
   * (>=80 Nominal, >=50 Degraded) and printed the backend label beside it as a
   * hint — so a score of 75 read "Degraded Good", two verdicts at once, and the
   * gauge below it said "Good" while the band said "Degraded". One scale now,
   * defined where the score is computed; the hint is evidence, not a verdict.
   */
  const health = statusQuery.data?.health ?? null;
  const healthScore = health?.score ?? null;
  const measuredCount = health?.components?.filter((c) => c.measured).length ?? 0;
  const totalCount = health?.components?.length ?? 0;
  const bandWord =
    healthScore == null
      ? null
      : healthScore >= 85
        ? 'Excellent'
        : healthScore >= 70
          ? 'Good'
          : healthScore >= 50
            ? 'Fair'
            : 'Poor';
  const bandTone =
    healthScore == null ? 'text-muted' : healthScore >= 70 ? 'text-ok' : healthScore >= 50 ? 'text-warn' : 'text-danger';

  const heroStatus = statusQuery.isLoading
    ? { word: 'Measuring', hint: 'Sampling the connection…', tone: 'text-muted' }
    : statusQuery.isError
      ? { word: 'Offline', hint: 'Backend unreachable', tone: 'text-danger' }
      : healthScore == null
        ? { word: 'Awaiting data', hint: 'Run a quick test to measure', tone: 'text-muted' }
        : {
            word: health?.label ?? bandWord ?? 'Measured',
            hint: totalCount > 0 ? `Based on ${measuredCount} of ${totalCount} components` : 'Measured just now',
            tone: bandTone,
          };

  return (
    <DisclosureScope name="dashboard">
      <DetailLevelProvider scope="dashboard" defaultLevel={2}>
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

      <div className="-mt-3 mb-2 flex flex-wrap items-center justify-between gap-3">
        <DetailLevelControl />
        <DisclosureToolbar />
      </div>

      {/* Command-center hero: the live verdict of the connection, at a glance.
          Values are the same ones the cards below render, so it can never
          disagree with them; the tone is the shared semantic colour. */}
      <div className="np-panel relative mb-6 overflow-hidden">
        <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-px hairline-brand" />
        <div className="flex flex-col gap-6 p-5 sm:p-7 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-4">
            <BrandMark size={46} />
            <div className="min-w-0">
              <div className="text-micro font-semibold uppercase tracking-[0.2em] text-faint">Network command</div>
              <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className={`text-2xl font-semibold tracking-tight ${heroStatus.tone}`}>{heroStatus.word}</span>
                <span className="text-mini text-muted">{heroStatus.hint}</span>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-x-7 gap-y-4">
            <HeroMetric label="Health" value={healthScore} tone={bandTone} />
            <HeroMetric label="Ping" value={lastPing?.avg ?? statusQuery.data?.latencyTcpMs ?? null} unit="ms" />
            <HeroMetric label="DNS" value={bestDnsMs} unit="ms" />
            <HeroMetric label="Download" value={lastDownload} unit="Mbps" />
          </div>
        </div>
      </div>

      {/* First thing on the page: what the machine already knows is broken.
          Renders nothing at all when nothing needs attention. */}
      <NeedsAttentionCard />

      {lastCheckFail !== null && (
        <div className="mb-5 flex items-center justify-between gap-3 rounded-xl border border-warn/30 bg-warn/10 px-4 py-2.5">
          <span className="flex min-w-0 items-center gap-2 text-xs leading-snug text-warn">
            <TriangleAlert size={13} className="shrink-0" />
            {/* Wording comes from the shared policy — the same line the history
                card renders, so both surfaces cannot disagree. */}
            <span className="truncate">{updateEventLine(lastCheckFail)}</span>
          </span>
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0"
            onClick={() => navigate('/settings?tab=platform&card=update-history')}
          >
            View history
          </Button>
        </div>
      )}

      {statusQuery.isError && <ErrorState error={statusQuery.error} retry={() => void statusQuery.refetch()} />}
      {statusQuery.isLoading && <LoadingState label="Measuring your connection" />}

      {statusQuery.data?.health && statusQuery.data.health.score != null ? (
        <div className="stagger space-y-6">
          {/* Row 1 — the two answers to "is my connection healthy, and is the
              tunnel sound?". They sit in their own row so the gauge card is
              only as tall as the console it stands beside; previously it was
              stretched to the height of a three-item column and carried ~400px
              of empty space under the dial. */}
          {/* Level 1 — the verdict and the immediate action. Essential content is
              never gated away: this row answers "is my connection healthy, and
              what do I do about it?" with no further clicks. */}
          <DetailGate required={1}>
            <div className="stagger grid gap-5 lg:grid-cols-3">
              <Card className="flex flex-col lg:col-span-1">
                <CardHeader title="Network health" icon={<GaugeIcon size={15} />} />
                <CardBody className="flex flex-1 flex-col">
                  <div className="flex flex-1 items-center justify-center">
                    <Gauge value={statusQuery.data.health.score} label={statusQuery.data.health.label ?? 'awaiting data'} size={190} />
                  </div>
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

              <div className="lg:col-span-2">
                <ConnectionHero state={connection} />
              </div>
            </div>
          </DetailGate>

          {/* Level 2 — the evidence that makes the verdict believable: network
              facts beside the six readings they came from. */}
          <DetailGate required={2}>
            <div className="stagger grid gap-5 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <ConnectionCard status={statusQuery.data} />
              </div>
              <Card className="lg:col-span-1">
                <CardHeader title="Measurements" subtitle="Last recorded run of each test" />
                <CardBody>
                  <div className="grid grid-cols-2 gap-x-5 gap-y-4">
                    <Metric label="Ping" value={lastPing?.avg ?? statusQuery.data.latencyTcpMs} unit="ms" status={pingStatus} hint={lastPing ? `ICMP avg to ${lastPing.target}` : 'Live TCP connect time to 1.1.1.1:443'} />
                    <Metric label="Jitter" value={lastPing?.jitterMs ?? null} unit="ms" status={jitterStatus} hint="Mean variation between successive replies (last ping run)" />
                    <Metric label="Packet loss" value={lastPing?.lossPct ?? null} unit="pct" status={lossStatus} hint="From the last ping run" />
                    <Metric label="Download" value={lastDownload} unit="mbps" status={lastDownload == null ? 'idle' : 'good'} hint={lastSpeed ? `Last speed test (${timeAgo(lastSpeed.startedAt)})` : 'Run a speed test to populate'} />
                    <Metric label="Upload" value={lastUpload} unit="mbps" status={lastUpload == null ? 'idle' : 'good'} hint="From the last speed test" />
                    <Metric label="DNS" value={bestDnsMs} unit="ms" status={bestDnsMs == null ? 'idle' : bestDnsMs <= 30 ? 'good' : bestDnsMs <= 80 ? 'warn' : 'bad'} hint={lastDns ? `Best resolver latency (last DNS test)` : 'Run a DNS test to populate'} />
                  </div>
                </CardBody>
              </Card>
            </div>
          </DetailGate>

          {/* Level 2 — what the score is made of, beside the diagnostics a
              reader is most likely to reach for next. */}
          <DetailGate required={2}>
            <div className="stagger grid gap-5 lg:grid-cols-3">
              <HealthBreakdown status={statusQuery.data} />
              <div className="lg:col-span-2">
                <Card fold={{ id: 'quick-actions', defaultOpen: false, summary: `${QUICK_ACTIONS.length} diagnostics, one click each` }}>
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
              </div>
            </div>
          </DetailGate>

          {/* Level 3 — the widgets that cost the most to run. Gating them here is
              also why the dashboard no longer mounts a map on load. */}
          <DetailGate required={3}>
            <IranConnectivityWidget />
          </DetailGate>

          <DetailGate required={3}>
            <LiveMapWidget />
          </DetailGate>

          <DetailGate required={3}>
            <div className="stagger grid gap-5 lg:grid-cols-3">
              <Card className="lg:col-span-2" fold={{ id: 'live-latency' }}>
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
            </div>
          </DetailGate>

          {/* Level 4 — raw provenance. This is what "why did that happen?" needs,
              and it is not what a first-time reader is looking for. */}
          <DetailGate required={4}>
            <Card fold={{ id: 'recent-activity', defaultOpen: false, summary: `${(eventsQuery.data?.events ?? []).length} recent events` }}>
              <CardHeader
                title="Recent activity"
                actions={
                  <Link to="/events" className="text-xs text-accent hover:underline">
                    View all
                  </Link>
                }
              />
              <CardBody className="space-y-2">
                {(eventsQuery.data?.events ?? []).length === 0 && (
                  <p className="py-4 text-center text-sm text-faint">No events recorded yet.</p>
                )}
                {(eventsQuery.data?.events ?? []).map((e) => (
                  <div key={e.id} className="flex items-center justify-between gap-3 text-mini">
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
          </DetailGate>
        </div>
      ) : (
        <Card>
          <CardHeader title="Health data" subtitle="No measurements yet" />
          <CardBody className="flex items-center justify-center py-12">
            <div className="text-center">
              <GaugeIcon size={32} className="mx-auto mb-3 text-faint" />
              <p className="text-sm text-muted">Health data not available yet.</p>
              <p className="mt-1 text-xs text-faint">Run a quick ping test or wait for the next status refresh.</p>
            </div>
          </CardBody>
        </Card>
      )
    }
      </DetailLevelProvider>
    </DisclosureScope>
  );
}
