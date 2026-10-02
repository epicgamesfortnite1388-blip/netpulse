import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { AlertTriangle, CheckCircle2, Info, Play, RefreshCw, Route as RouteIcon, ShieldCheck, XCircle } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { DisclosureScope, DisclosureToolbar } from '@/components/ui/Disclosure';
import { Field, Input, Select } from '@/components/ui/Field';
import { Metric } from '@/components/ui/Metric';
import { PageHeader } from '@/components/ui/PageHeader';
import { Progress } from '@/components/ui/Progress';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { TabPanel, Tabs } from '@/components/ui/Tabs';
import { api } from '@/lib/api';
import { fmtDateTime, fmtMs, fmtPct } from '@/lib/format';
import { useBackgroundTest } from '@/lib/useBackgroundTest';

import type { IpFamily, RouteAnalysis, RouteCompareResult, TraceResult, VpnRouteCompareResult, VpnRouteCompareSide } from '@netpulse/shared';

interface RouteTestResponse {
  testId: string;
  trace: TraceResult;
  analysis: RouteAnalysis;
  lossPctAtDestination: number | null;
}

interface RouteCompareResponse {
  testId: string;
  target: string;
  routes: { family: IpFamily; trace: TraceResult; analysis: RouteAnalysis }[];
  winner: IpFamily | null;
  reason: string | null;
}

function SeverityIcon({ severity }: { severity: string }) {
  if (severity === 'error') return <XCircle size={15} className="mt-0.5 shrink-0 text-danger" />;
  if (severity === 'warn') return <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn" />;
  return <Info size={15} className="mt-0.5 shrink-0 text-accent" />;
}

function HopRow({ hop, isLast }: { hop: TraceResult['hops'][number]; isLast: boolean }) {
  const unresponsive = hop.latencyMs == null;
  return (
    <li className="relative flex gap-3.5 pb-5">
      {/* timeline rail */}
      <div className="flex flex-col items-center">
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-micro font-semibold font-mono ${
            unresponsive
              ? 'border-line-strong bg-surface-2 text-faint'
              : 'border-accent/40 bg-accent-soft text-accent-strong'
          }`}
        >
          {String(hop.hop).padStart(2, '0')}
        </span>
        {!isLast && <span className="mt-1 w-px flex-1 bg-line" />}
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className={`font-mono text-mini ${hop.ip ? 'text-text' : 'text-faint'}`}>
            {hop.ip ?? 'no response'}
          </span>
          {hop.hostname && <span className="truncate text-xs text-muted">{hop.hostname}</span>}
          <span className={`ml-auto font-mono text-mini ${unresponsive ? 'text-faint' : 'text-text'}`}>
            {fmtMs(hop.latencyMs)}
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-micro text-faint">
          {hop.org && <span className="truncate">{hop.org}</span>}
          {hop.asn != null && <span className="font-mono">AS{hop.asn}</span>}
          {hop.country && <span>{hop.country}</span>}
          {(hop.packetLoss ?? 0) > 0 && <span className="text-warn">{fmtPct(hop.packetLoss)} probes timed out</span>}
          {unresponsive && <span>ICMP filtered or deprioritized — not proof of loss</span>}
        </div>
      </div>
    </li>
  );
}

export default function RoutesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  // Only the two query params the page actually deep-links on; anything else
  // (or an unknown value) falls back to the first tab rather than guessing.
  const [tab, setTab] = useState(() => {
    const t = searchParams.get('tab');
    return t === 'vpn-compare' || t === 'compare' ? t : 'trace';
  });
  const [target, setTarget] = useState('1.1.1.1');
  const [family, setFamily] = useState<'auto' | '4' | '6'>('auto');

  const [traceId, setTraceId] = useState<string | null>(null);
  const trace = useBackgroundTest<RouteTestResponse>(traceId);
  const result = trace.result;
  const running = trace.running;
  const error = trace.error;
  const progress = trace.pct != null ? { pct: trace.pct, message: trace.message ?? '' } : null;

  const [compareId, setCompareId] = useState<string | null>(null);
  const compare = useBackgroundTest<RouteCompareResponse>(compareId);
  const compareRunning = compare.running;
  const compareError = compare.error;

  const compareResult = useMemo<RouteCompareResult | null>(() => {
    const res = compare.result;
    if (res == null) return null;
    const sides = res.routes.map((r) => ({
      label: `IPv${r.family}`,
      target: r.trace.target,
      resolvedIp: r.trace.resolvedIp,
      family: r.family as IpFamily | null,
      score: r.analysis.score,
      labelQuality: r.analysis.label,
      totalHops: r.trace.totalHops,
      totalLatencyMs: r.trace.totalLatencyMs,
      packetLossPct: null,
      trace: r.trace,
    }));
    const explanation =
      res.reason ??
      (res.winner ? `IPv${res.winner} provides the better measured route.` : 'No clear winner between the available protocols.');
    return {
      sides,
      preferredIndex: res.winner ? sides.findIndex((s) => s.family === res.winner) : null,
      explanation,
    };
  }, [compare.result]);

  const runTrace = useCallback(async () => {
    setTraceId(null);
    try {
      const body: Record<string, unknown> = { target: target.trim() };
      if (family !== 'auto') body.family = Number(family);
      const res = await api.post<{ testId: string }>('/route-test', body);
      setTraceId(res.testId);
    } catch {
      setTraceId(null);
    }
  }, [target, family]);

  const runCompare = useCallback(async () => {
    setCompareId(null);
    try {
      const res = await api.post<{ testId: string }>('/route-compare', { target: target.trim() });
      setCompareId(res.testId);
    } catch {
      setCompareId(null);
    }
  }, [target]);

  // ---- Direct vs VPN (from stored traces) ----
  const [vpnTarget, setVpnTarget] = useState('');
  const [vpnResult, setVpnResult] = useState<VpnRouteCompareResult | null>(null);
  const [vpnLoading, setVpnLoading] = useState(false);
  const [vpnError, setVpnError] = useState<string | null>(null);

  const loadVpnCompare = useCallback(async (t: string) => {
    if (!t.trim()) return;
    setVpnLoading(true);
    setVpnError(null);
    try {
      const res = await api.get<VpnRouteCompareResult>(`/route-compare/vpn?target=${encodeURIComponent(t.trim())}`);
      setVpnResult(res);
    } catch (e) {
      setVpnError(e instanceof Error ? e.message : String(e));
      setVpnResult(null);
    } finally {
      setVpnLoading(false);
    }
  }, []);

  // Pull a default target from the newest stored trace so the tab is never empty.
  useEffect(() => {
    // Deep link from Node detail: /routes?tab=vpn-compare&target=<host>
    const deepTarget = searchParams.get('target');
    const deepTab = searchParams.get('tab');
    if (deepTab === 'vpn-compare') {
      if (deepTarget) setVpnTarget(deepTarget);
      void loadVpnCompare(deepTarget ?? vpnTarget);
      setSearchParams({}, { replace: true });
      return;
    }
    let cancelled = false;
    api
      .get<{ routes: { target: string }[] }>('/route-compare/vpn/history?limit=30')
      .then((r) => {
        if (!cancelled && !vpnTarget && r.routes[0]?.target) setVpnTarget(r.routes[0].target);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <DisclosureScope name="routes">
      <PageHeader
        title="Route checker"
        description="Traceroute with per-hop ASN enrichment, honest loss analysis and route scoring."
      />
      <DisclosureToolbar className="-mt-3 mb-2" />

      <Tabs
        value={tab}
        onValueChange={setTab}
        items={[
          { value: 'trace', label: 'Trace' },
          { value: 'compare', label: 'IPv4 vs IPv6' },
          { value: 'vpn-compare', label: 'Direct vs VPN' },
        ]}
      >
        <TabPanel value="trace">
          <Card className="mb-5">
            <CardBody className="flex flex-wrap items-end gap-3">
              <div className="min-w-56 flex-1">
                <Field label="Target" hint="Domain, hostname or IP address">
                  <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="example.com" disabled={running} />
                </Field>
              </div>
              <div className="w-32">
                <Field label="Protocol">
                  <Select value={family} onChange={(e) => setFamily(e.target.value as 'auto' | '4' | '6')} disabled={running}>
                    <option value="auto">Auto</option>
                    <option value="4">IPv4</option>
                    <option value="6">IPv6</option>
                  </Select>
                </Field>
              </div>
              <Button variant="primary" onClick={runTrace} loading={running} className="h-9">
                <Play size={14} />
                Trace route
              </Button>
            </CardBody>
          </Card>

          {running && progress && (
            <Card className="mb-5">
              <CardBody>
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span className="text-muted">{progress.message || 'Tracing…'}</span>
                  <span className="font-mono text-faint">{progress.pct}%</span>
                </div>
                <Progress value={progress.pct} />
              </CardBody>
            </Card>
          )}

          {error != null && (
            <div className="mb-5">
              <ErrorState error={error} retry={runTrace} />
            </div>
          )}

          {result == null && !running && error == null && (
            <EmptyState
              icon={<RouteIcon size={20} />}
              title="Awaiting first trace"
              message="Run a traceroute to see the hop-by-hop path, latency and honest loss analysis. Hop-level timeouts are reported separately from real end-to-end loss."
            />
          )}

          {result && (
            <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
              <Card fold={{ id: 'route-hops', pinned: true }}>
                <CardHeader
                  title={`Route to ${result.trace.target}`}
                  subtitle={`${result.trace.totalHops} hops · ${fmtMs(result.trace.totalLatencyMs)} end-to-end${result.lossPctAtDestination != null ? ` · ${fmtPct(result.lossPctAtDestination)} loss at destination` : ''}`}
                  icon={<RouteIcon size={15} />}
                  actions={
                    <Badge tone={result.analysis.score != null && result.analysis.score >= 70 ? 'ok' : result.analysis.score != null && result.analysis.score >= 50 ? 'warn' : 'danger'}>
                      {result.analysis.label ?? 'no score'} {result.analysis.score != null ? `· ${result.analysis.score}/100` : ''}
                    </Badge>
                  }
                />
                <CardBody>
                  <ul className="list-none">
                    {result.trace.hops.map((hop, i) => (
                      <HopRow key={`${hop.hop}-${i}`} hop={hop} isLast={i === result.trace.hops.length - 1} />
                    ))}
                  </ul>
                </CardBody>
              </Card>

              <div className="space-y-5">
                <Card
                  fold={{
                    id: 'analysis',
                    defaultOpen: false,
                    summary:
                      result.analysis.findings.length === 0
                        ? 'no anomalies detected on this route'
                        : `${result.analysis.findings.length} finding${result.analysis.findings.length === 1 ? '' : 's'} from this run`,
                  }}
                >
                  <CardHeader title="Analysis" subtitle="Derived from this run's measurements" />
                  <CardBody className="space-y-3">
                    {result.analysis.findings.length === 0 && <p className="text-sm text-muted">No anomalies detected on this route.</p>}
                    {result.analysis.findings.map((f, i) => (
                      <div key={i} className="flex gap-2.5 text-mini leading-relaxed text-muted">
                        <SeverityIcon severity={f.severity} />
                        <span>{f.message}</span>
                      </div>
                    ))}
                  </CardBody>
                </Card>

                <Card
                  fold={{
                    id: 'summary',
                    defaultOpen: false,
                    summary: `${result.trace.totalHops} hops · ${fmtMs(result.trace.totalLatencyMs)} end-to-end`,
                  }}
                >
                  <CardHeader title="Summary" />
                  <CardBody className="grid grid-cols-2 gap-4">
                    <Metric label="Hops" value={result.trace.totalHops} />
                    <Metric label="E2E latency" value={result.trace.totalLatencyMs} unit="ms" />
                    <Metric label="Dest. loss" value={result.lossPctAtDestination} unit="pct" />
                    <Metric label="Probe time" value={result.trace.durationMs != null ? Math.round(result.trace.durationMs / 100) / 10 : null} unit="raw" hint="Wall-clock duration of the traceroute run (seconds)" />
                  </CardBody>
                </Card>
              </div>
            </div>
          )}
        </TabPanel>

        <TabPanel value="compare">
          <Card className="mb-5">
            <CardBody className="flex flex-wrap items-end gap-3">
              <div className="min-w-56 flex-1">
                <Field label="Target" hint="Both protocols are traced from the same host">
                  <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="example.com" disabled={compareRunning} />
                </Field>
              </div>
              <Button variant="primary" onClick={runCompare} loading={compareRunning} className="h-9">
                <Play size={14} />
                Compare IPv4 / IPv6
              </Button>
            </CardBody>
          </Card>

          {compareError != null && (
            <div className="mb-5">
              <ErrorState error={compareError} retry={runCompare} />
            </div>
          )}

          {compareResult == null && !compareRunning && compareError == null && (
            <EmptyState
              icon={<CheckCircle2 size={20} />}
              title="No comparison yet"
              message="Runs a traceroute over IPv4 and IPv6 and recommends the better path only when the score difference is statistically meaningful."
            />
          )}

          {compareResult && (
            <div>
              <Card className="mb-5">
                <CardBody className="flex items-start gap-2.5 text-mini leading-relaxed text-muted">
                  <Info size={15} className="mt-0.5 shrink-0 text-accent" />
                  <span>{compareResult.explanation}</span>
                </CardBody>
              </Card>
              <div className="grid gap-5 md:grid-cols-2">
                {compareResult.sides.map((side, i) => (
                  <Card
                    key={side.label}
                    className={compareResult.preferredIndex === i ? 'border-accent/50' : ''}
                    fold={{
                      id: `compare-${side.family ?? side.label}`,
                      // Open: these two cards are the comparison's result; a
                      // folded default would hide the numbers being compared.
                      defaultOpen: true,
                      summary: `${side.score != null ? `score ${side.score}/100` : 'no score'} · ${side.totalHops} hops · ${fmtMs(side.totalLatencyMs)}`,
                    }}
                  >
                    <CardHeader
                      title={side.label}
                      actions={
                        compareResult.preferredIndex === i ? (
                          <Badge tone="ok">Recommended</Badge>
                        ) : (
                          <Badge>{side.labelQuality ?? '—'}</Badge>
                        )
                      }
                    />
                    <CardBody className="grid grid-cols-3 gap-4">
                      <Metric label="Score" value={side.score} status={side.score != null && side.score >= 70 ? 'good' : 'idle'} />
                      <Metric label="Hops" value={side.totalHops} />
                      <Metric label="Latency" value={side.totalLatencyMs} unit="ms" />
                    </CardBody>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </TabPanel>

        <TabPanel value="vpn-compare">
          <Card className="mb-5">
            <CardBody className="flex flex-wrap items-end gap-3">
              <div className="min-w-56 flex-1">
                <Field
                  label="Target"
                  hint="Pairs the newest VPN trace with the newest direct trace to this same target from history"
                >
                  <Input
                    value={vpnTarget}
                    onChange={(e) => setVpnTarget(e.target.value)}
                    placeholder="example.com or 1.1.1.1"
                    disabled={vpnLoading}
                  />
                </Field>
              </div>
              <Button variant="primary" onClick={() => void loadVpnCompare(vpnTarget)} loading={vpnLoading} className="h-9">
                <RefreshCw size={14} />
                Compare from history
              </Button>
            </CardBody>
          </Card>

          {vpnError != null && (
            <div className="mb-5">
              <ErrorState error={vpnError} retry={() => void loadVpnCompare(vpnTarget)} />
            </div>
          )}

          {vpnResult == null && !vpnLoading && vpnError == null && (
            <EmptyState
              icon={<ShieldCheck size={20} />}
              title="No comparison loaded"
              message="Enter a target you have traced before — the view pairs real stored traceroutes taken while the VPN was up with ones taken while direct. Run a trace disconnected, connect, trace again, and the deltas appear here."
            />
          )}

          {vpnResult && <VpnCompareView result={vpnResult} />}
        </TabPanel>
      </Tabs>
    </DisclosureScope>
  );
}

function vpnTagLabel(side: VpnRouteCompareSide | null): string {
  if (!side) return '—';
  if (!side.vpn.connected) return 'Direct';
  return `VPN (${side.vpn.providerId ?? 'tunnel'})`;
}

function VpnCompareView({ result }: { result: VpnRouteCompareResult }) {
  const complete = result.status === 'complete';
  const sides: { key: 'direct' | 'vpn'; side: VpnRouteCompareSide | null; title: string }[] = [
    { key: 'direct', side: result.direct, title: 'Direct route' },
    { key: 'vpn', side: result.vpn, title: 'VPN route' },
  ];

  return (
    <div>
      {result.note && (
        <Card className="mb-5">
          <CardBody className="flex items-start gap-2.5 text-mini leading-relaxed text-muted">
            <Info size={15} className="mt-0.5 shrink-0 text-accent" />
            <span>{result.note}</span>
          </CardBody>
        </Card>
      )}

      {result.deltas && (
        <Card className="mb-5" fold={{ id: 'vpn-deltas', pinned: true }}>
          <CardHeader
            title="Measured deltas (VPN − direct)"
            actions={
              result.deltas.preferred ? (
                <Badge tone="ok">{result.deltas.preferred === 'vpn' ? 'VPN route preferred' : 'Direct route preferred'}</Badge>
              ) : (
                <Badge>No significant difference</Badge>
              )
            }
          />
          <CardBody>
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <Metric
                label="Latency"
                value={result.deltas.latencyDeltaMs}
                unit="ms"
                hint="End-to-end latency difference (positive = VPN slower)"
              />
              <Metric label="Hops" value={result.deltas.hopsDelta} hint="Hop-count difference (positive = VPN longer path)" />
              <Metric
                label="Dest. loss"
                value={result.deltas.lossDeltaPct}
                unit="pct"
                hint="Destination packet-loss difference in percentage points"
              />
              <Metric label="Score" value={result.deltas.scoreDelta} hint="Route-score difference (positive = VPN better)" />
            </div>
            {result.deltas.reason && <p className="mt-3 text-mini text-muted">{result.deltas.reason}</p>}
          </CardBody>
        </Card>
      )}

      <div className="grid gap-5 md:grid-cols-2">
        {sides.map(({ key, side, title }) =>
          side == null ? (
            <Card key={key}>
              <CardHeader title={title} actions={<Badge tone="warn">Missing</Badge>} />
              <CardBody>
                <EmptyState
                  icon={<AlertTriangle size={18} />}
                  title="No stored trace"
                  message={
                    key === 'vpn'
                      ? 'No trace to this target was recorded while the VPN was connected.'
                      : 'No direct trace to this target was recorded.'
                  }
                />
              </CardBody>
            </Card>
          ) : (
            <Card
              key={key}
              className={complete && result.deltas?.preferred === key ? 'border-accent/50' : ''}
              fold={{
                id: `vpn-side-${key}`,
                defaultOpen: true,
                summary: `${side.trace.totalHops} hops · ${fmtMs(side.trace.totalLatencyMs)} · ${vpnTagLabel(side)}`,
              }}
            >
              <CardHeader
                title={title}
                subtitle={`Traced ${fmtDateTime(side.startedAt)} · ${side.trace.totalHops} hops`}
                actions={
                  <Badge tone={side.vpn.connected ? 'ok' : undefined}>
                    {vpnTagLabel(side)}
                    {side.vpn.connected && side.vpn.verifiedPublicIp ? ` · exit ${side.vpn.verifiedPublicIp}` : ''}
                  </Badge>
                }
              />
              <CardBody className="grid grid-cols-3 gap-4">
                <Metric label="Score" value={side.analysis.score} status={side.analysis.score != null && side.analysis.score >= 70 ? 'good' : 'idle'} />
                <Metric label="E2E latency" value={side.trace.totalLatencyMs} unit="ms" />
                <Metric label="Dest. loss" value={side.lossPctAtDestination} unit="pct" />
              </CardBody>
            </Card>
          ),
        )}
      </div>
    </div>
  );
}
