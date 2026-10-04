import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';

import {
  Activity,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  Flag,
  Info,
  Loader2,
  Network,
  RefreshCw,
  Route as RouteIcon,
  Server,
  Shield,
  ShieldCheck,
  ShieldX,
  Star,
  Wifi,
} from 'lucide-react';

import { ENGINE_LABELS, EngineBadge } from '@/components/EngineBadge';
import { healthMetricItems, nodeRates } from './nodeHealthDisplay';
import { Gauge } from '@/components/charts/Gauge';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/States';
import { DisclosureScope, DisclosureToolbar } from '@/components/ui/Disclosure';
import { DataList, DataRow, EngineGlyph, EngineHero, MetricStrip, Notice, Panel, Section } from '@/components/ui/Surface';
import { TabPanel, Tabs } from '@/components/ui/Tabs';
import { useToast } from '@/components/Toaster';
import { NodesNav } from '@/features/nodes/NodesChrome';
import { NodeEngineActions } from '@/features/nodes/NodeEngineActions';
import { testMessage } from '@/features/nodes/nodeActionPolicy';
import { useNodeActions } from '@/features/nodes/useNodeActions';
import { ApiError, api } from '@/lib/api';
import { diagnoseFailure } from '@/lib/failureIntelligence';
import { fmtDateTime, fmtMs, fmtPct } from '@/lib/format';
import { GEO_STATUS_COPY, geoReasonOf } from '@/lib/geoStatus';
import { usePersistentState } from '@/lib/usePersistentState';

import type { ExportFormat } from '@/features/nodes/nodeActionPolicy';
import type { NodeTestResult, NodeTestType, PublicNode } from '@netpulse/shared';
import type { ReactNode } from 'react';

type NodeWebDTO = PublicNode;

/** Aggregated health record returned by GET /nodes/:id/health */
import type { NodeHealthSummary } from './nodeHealthDisplay';

const PROTOCOL_LABELS: Record<string, string> = {
  vless: 'VLESS',
  vmess: 'VMess',
  trojan: 'Trojan',
  shadowsocks: 'Shadowsocks',
  shadowsocksr: 'ShadowsocksR',
  hysteria2: 'Hysteria2',
  tuic: 'TUIC',
  wireguard: 'WireGuard',
  unknown: 'Unknown',
};

const TRANSPORT_LABELS: Record<string, string> = {
  tcp: 'TCP',
  ws: 'WebSocket',
  grpc: 'gRPC',
  http: 'HTTP',
  quic: 'QUIC',
  udp: 'UDP',
  reality: 'Reality',
  none: 'None',
  unknown: 'Unknown',
};

/**
 * One measured field. Flat by design — a hairline under the value instead of a
 * bordered tile, so a dense panel of facts stays readable instead of becoming a
 * grid of boxes.
 */
function DetailItem({ label, value, mono = false }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0 border-b border-line py-1.5 last:border-b-0">
      <dt className="text-micro font-semibold uppercase tracking-[0.14em] text-faint">{label}</dt>
      <dd className={`mt-0.5 break-words text-sm text-text ${mono ? 'metric-num text-xs' : ''}`}>{value}</dd>
    </div>
  );
}

function DetailGrid({ children, cols = 2 }: { children: ReactNode; cols?: 2 | 3 }) {
  // Three across only from xl: at 1024px the third column left ~92px and the
  // uppercase labels ("ORGANIZATION") overflowed it.
  return (
    <dl className={`grid grid-cols-1 gap-x-6 ${cols === 3 ? 'sm:grid-cols-2 xl:grid-cols-3' : 'sm:grid-cols-2'}`}>
      {children}
    </dl>
  );
}

/**
 * Explains WHY a node shows Unknown (anycast / edge fabric / failed lookup)
 * instead of a location, so the empty field reads as honesty, not missing data.
 * Copy lives in lib/geoStatus.ts — shared with explorer rows and the map panel.
 */
function GeoStatusNote({ node, onRecheck, checking }: { node: NodeWebDTO; onRecheck: () => void; checking: boolean }) {
  const reason = geoReasonOf(node.geoStatusReason, node.lat != null);
  if (reason === 'known') return null; // a location exists — nothing to explain
  const x = GEO_STATUS_COPY[reason];
  return (
    <Notice tone="info" icon={<Info size={14} />} className="mb-3">
      <p className="font-medium text-text">{x.title}</p>
      <p className="mt-0.5">{x.detail}</p>
      {reason !== 'anycast' && reason !== 'edge_fabric' && (
        <Button variant="ghost" size="sm" className="mt-2" onClick={onRecheck} loading={checking}>
          <RefreshCw size={12} />
          Re-check location
        </Button>
      )}
    </Notice>
  );
}

function statusTone(status: string): 'ok' | 'danger' | 'warn' {
  return status === 'healthy' ? 'ok' : status === 'failed' ? 'danger' : 'warn';
}

/** Real numbers only: the gauge plots the stored node score, nothing synthetic. */
function HeroVitals({ node, engine, lastTestedAt }: { node: NodeWebDTO; engine: string | null; lastTestedAt: number | null }) {
  const StatusIcon = node.status === 'healthy' ? ShieldCheck : node.status === 'failed' ? ShieldX : Shield;
  const tone = statusTone(node.status);
  return (
    <Panel tone="quiet" className="flex flex-col items-center gap-3 py-4">
      <Gauge value={node.score} label="node score" size={156} />
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        <Badge tone={tone}>
          <StatusIcon size={12} />
          <span className="capitalize">{node.status}</span>
        </Badge>
        <Badge tone="neutral">
          <span className="capitalize">{node.confidence}</span> confidence
        </Badge>
      </div>
      <dl className="w-full space-y-1.5 border-t border-line pt-2.5">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-micro font-semibold uppercase tracking-[0.14em] text-faint">Runtime</dt>
          <dd className="text-xs text-text">
            {engine ? (
              <EngineBadge engine={engine} title={`Last probe was executed by ${ENGINE_LABELS[engine as keyof typeof ENGINE_LABELS] ?? engine}`} />
            ) : (
              <span className="text-faint">not probed</span>
            )}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-micro font-semibold uppercase tracking-[0.14em] text-faint">Last tested</dt>
          <dd className="metric-num text-xs text-muted">{lastTestedAt != null ? fmtDateTime(lastTestedAt) : <span className="text-faint">never</span>}</dd>
        </div>
      </dl>
    </Panel>
  );
}

export default function NodeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const toast = useToast();

  const [loading, setLoading] = useState(true);
  const [loadingError, setLoadingError] = useState<unknown>(null);
  const [node, setNode] = useState<NodeWebDTO | null>(null);
  const [tests, setTests] = useState<NodeTestResult[]>([]);
  const [health, setHealth] = useState<NodeHealthSummary | null>(null);
  // In-flight test descriptor persists across tab switches: node tests run
  // server-side for many seconds, and the POST promise dies with the page —
  // but the result record does not. On remount we re-attach by polling the
  // node's history for the record this descriptor describes.
  const [pendingTest, setPendingTest] = usePersistentState<{ type: string; startedAt: number } | null>('nodes.pendingTest', null);
  const [testResult, setTestResult] = useState<NodeTestResult | null>(null);

  const loadNode = useCallback(async () => {
    if (!id) return;
    try {
      setLoading(true);
      const [nodeRes, testsRes, healthRes] = await Promise.all([
        api.get<NodeWebDTO>(`/nodes/${id}`),
        api.get<{ tests: NodeTestResult[] }>(`/nodes/${id}/history?limit=50`).then((r) => ({ tests: r.tests || [] })),
        api.get<NodeHealthSummary>(`/nodes/${id}/health`),
      ]);
      setNode(nodeRes);
      setTests(testsRes.tests || []);
      setHealth(healthRes);
    } catch (err) {
      setLoadingError(err);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { void loadNode(); }, [loadNode]);

  // Per-node actions (test, geo re-check, favorite, copy link, export) come from
  // one hook shared with the explorer: it owns the request, the in-flight state
  // and the wording for every outcome, so this page and a list row cannot report
  // the same refusal differently. This page only decides what changed state it
  // must re-read — a returned node row, or a full reload when the server did not
  // return one.
  const actions = useNodeActions<NodeWebDTO>({
    onChanged: (changed) => {
      if (changed) setNode(changed);
      else void loadNode();
    },
    onTestStarted: ({ type, startedAt }) => setPendingTest({ type, startedAt }),
  });

  const runTest = useCallback(
    async (type: NodeTestType) => {
      if (!id) return;
      const startedAt = Date.now();
      const outcome = await actions.test(id, type);
      setPendingTest(null);
      if (outcome.status === 'done') setTestResult(outcome.value);
      else if (outcome.status === 'failed') {
        // Keep the failure in the result box as well as the toast: the box is
        // where the user looks after the toast is gone.
        setTestResult({
          nodeId: id,
          type,
          status: 'failed',
          startedAt,
          finishedAt: Date.now(),
          latencyMs: null,
          totalMs: null,
          error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
          tlsVersion: null,
          authorized: null,
          httpStatus: null,
          responseSize: null,
          family: null,
          probedIp: null,
          testEndpoint: null,
          engine: null,
        });
      }
    },
    [actions, id, setPendingTest],
  );

  // Which quick-test is running (spinner + disabled state on the buttons).
  const testing = pendingTest?.type ?? null;

  // Re-attach after a tab switch: if a test was started here and the page
  // unmounted mid-flight, poll history for its record instead of silently
  // dropping the user's request.
  useEffect(() => {
    if (!pendingTest || !id) return;
    let cancelled = false;
    const deadline = pendingTest.startedAt + 120_000;
    const poll = setInterval(() => {
      void api
        .get<{ tests: NodeTestResult[] }>(`/nodes/${id}/history?limit=10`)
        .then(({ tests }) => {
          if (cancelled) return;
          const rec = (tests ?? []).find((t) => t.type === pendingTest.type && t.startedAt >= pendingTest.startedAt && (t.status === 'done' || t.status === 'failed'));
          if (rec) {
            setPendingTest(null);
            setTestResult(rec);
            // Same policy as a test started here: a re-attached record describes
            // itself (status + reason), so a failure never surfaces as a result.
            const message = testMessage(rec);
            toast(message.tone, message.title, message.body);
            void loadNode();
          } else if (Date.now() > deadline) {
            // Request died with the previous page instance (e.g. webview
            // reload) — stop showing a spinner for a ghost.
            setPendingTest(null);
          }
        })
        .catch(() => {});
    }, 2_000);
    return () => {
      cancelled = true;
      clearInterval(poll);
    };
  }, [pendingTest, id, loadNode, setPendingTest, toast]);

  const exportNode = useCallback(
    (format: ExportFormat) => {
      if (!node) return Promise.resolve({ status: 'skipped' as const });
      return actions.downloadExport([node.id], format, `node-${node.id.slice(0, 8)}`, node.id.slice(0, 8));
    },
    [actions, node],
  );

  // The nav renders in every state, so the node area keeps one stable frame
  // while the record loads or fails — the chrome never appears out of nowhere
  // once data arrives.
  if (loading) {
    return (
      <div className="animate-fade-up">
        <NodesNav />
        <LoadingState label="Loading node…" />
      </div>
    );
  }
  // A 404 is not a failure to retry: the node is gone or the id is wrong, and
  // pressing "Try again" would fetch the same missing record forever. Route it
  // to the not-found state below (with a way back) instead of the error box.
  if (loadingError && !(loadingError instanceof ApiError && loadingError.status === 404)) {
    return (
      <div className="animate-fade-up">
        <NodesNav />
        <ErrorState error={loadingError} retry={loadNode} />
      </div>
    );
  }
  if (!node) {
    return (
      <div className="animate-fade-up">
        <NodesNav />
        <EmptyState
          title="Node not found"
          message="This node is not in the local pool. It may have been removed from its source since you last saw it."
          action={
            <Link
              to="/nodes"
              className="rounded-lg border border-accent/40 bg-accent-soft px-4 py-2 text-sm font-medium text-accent hover:brightness-110"
            >
              Back to Explorer
            </Link>
          }
        />
      </div>
    );
  }

  const medianProxy = (health?.medianLatencyMs as number | undefined) ?? node.medianProxyMs;
  const medianTcp = node.medianTcpMs;
  const runtimeEngine = tests[0]?.engine ?? null;
  const lastTestedAt = node.lastValidated ?? null;
  const rates = nodeRates(health, node);
  const location = node.country ? `${node.country}${node.city ? ` · ${node.city}` : ''}` : 'Location unknown';

  // Result box for the last probe, including the failure-intelligence read of
  // whatever the core actually returned.
  const resultBox = testResult ? (
    <Panel tone={testResult.status === 'done' ? 'default' : 'quiet'} className="mt-3">
      {testResult.status === 'done' ? (
        <p className="flex items-center gap-1.5 text-xs font-medium text-ok">
          <CheckCircle2 size={14} /> Test successful
        </p>
      ) : (
        <p className="flex items-center gap-1.5 text-xs font-medium text-danger">
          <ShieldX size={14} /> Test failed
        </p>
      )}
      <p className="mt-1 text-xs text-muted">
        {/* A failed run's latencyMs is how long the attempt took, not a
            measurement of the endpoint — labelling it "Latency" let a DNS
            failure that took 85 ms read like a fast result. Only a `done`
            record has latency; a failed one shows the attempt time instead. */}
        {testResult.latencyMs != null
          ? testResult.status === 'done'
            ? `Latency ${fmtMs(testResult.latencyMs)}`
            : `Attempt time ${fmtMs(testResult.latencyMs)}`
          : 'No latency reported'}
        {testResult.engine ? ` · measured via ${ENGINE_LABELS[testResult.engine as keyof typeof ENGINE_LABELS] ?? testResult.engine}` : ' · no runtime attributed'}
      </p>
      {testResult.error && (() => {
        const dx = diagnoseFailure(testResult.error);
        return (
          <div className="mt-2 border-l-2 border-danger/60 pl-2.5">
            {dx && (
              <p className="text-xs font-medium text-danger" title={testResult.error}>
                {dx.category} — {dx.summary}
              </p>
            )}
            {dx?.action && <p className="mt-0.5 text-xs text-muted">{dx.action}</p>}
            <p className="mt-0.5 break-all font-mono text-micro text-faint">{testResult.error}</p>
          </div>
        );
      })()}
    </Panel>
  ) : null;

  return (
    <DisclosureScope name="node-detail" className="animate-fade-up">
      <NodesNav current={node.remark || node.host} />

      <EngineHero
        glyph={
          <EngineGlyph glyph="from-accent/25 via-accent/10 to-transparent text-accent" size="lg">
            <Server size={22} />
          </EngineGlyph>
        }
        name={node.remark || node.host}
        tagline={`${PROTOCOL_LABELS[node.protocol] ?? node.protocol} · ${node.host}:${node.port}`}
        badges={
          <>
            <Badge tone={statusTone(node.status)}>
              <span className="capitalize">{node.status}</span>
            </Badge>
            <Badge tone="neutral">
              <span className="capitalize">{node.freshness}</span>
            </Badge>
            {node.favorite && (
              <Badge tone="warn">
                <Star size={11} className="fill-current" />
                favorite
              </Badge>
            )}
          </>
        }
        description={`${location}${node.isp ? ` — announced by ${node.isp}` : ''}. Probe history, health and export live here; every measurement is attributable to the local core that produced it.`}
        actions={
          <>
            <Button variant="secondary" size="sm" onClick={() => node && void actions.toggleFavorite(node)}>
              <Star size={14} className={node.favorite ? 'fill-current text-warn' : ''} />
              {node.favorite ? 'Favorited' : 'Favorite'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              loading={actions.busy(node.id, 'copy')}
              onClick={() => void actions.copyShareLink(node.id)}
              title="Copy the rebuilt share link for this node"
            >
              <Copy size={14} />
              Copy share link
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void exportNode('json')}>
              <Download size={14} />
              Export JSON
            </Button>
            <Button
              variant="ghost"
              size="sm"
              title="Compare direct vs VPN traceroutes to this node's endpoint"
              onClick={() => navigate(`/routes?tab=vpn-compare&target=${encodeURIComponent(node.ipv4[0] || node.host)}`)}
            >
              <RouteIcon size={14} />
              Direct vs VPN
            </Button>
            <NodeEngineActions nodeId={node.id} />
          </>
        }
        visual={<HeroVitals node={node} engine={runtimeEngine} lastTestedAt={lastTestedAt} />}
      />

      <MetricStrip
        className="mb-5"
        items={[
          { label: 'Median proxy', value: medianProxy != null ? fmtMs(medianProxy) : '—', hint: 'measured through the local core', mono: true },
          { label: 'Median TCP', value: medianTcp != null ? fmtMs(medianTcp) : '—', hint: 'direct reachability', mono: true },
          { label: 'Reliability', value: fmtPct(rates.reliabilityPct), tone: rates.reliabilityTone, hint: rates.probesRecorded > 0 ? `${rates.probesRecorded} probes recorded` : 'no probes recorded yet — nothing measured' },
          { label: 'Recent loss', value: fmtPct(rates.recentLossPct), tone: rates.lossTone, hint: 'lost probes in the recent window' },
        ]}
      />

      <Tabs
        defaultValue="overview"
        items={[
          { value: 'overview', label: 'Overview' },
          { value: 'tests', label: tests.length > 0 ? `Tests · ${tests.length}` : 'Tests' },
          { value: 'health', label: 'Health' },
          { value: 'export', label: 'Export' },
        ]}
      >
        {/* Sections inside every tab fold; Expand all / Collapse all works
            across all of them, because the scope wraps the tab set. */}
        <DisclosureToolbar className="mb-2" />
        <TabPanel value="overview">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
            <div className="min-w-0">
              <Section
                collapsible
                pinned
                id="endpoint"
                defaultOpen
                summary="Protocol, host, port, transport, TLS — the dial-in facts"
                title="Endpoint & transport"
                icon={<Network size={15} />}
                subtitle="What a client must dial to reach this node — no credentials, they are not stored in the clear."
              >
                <DetailGrid cols={3}>
                  <DetailItem label="Protocol" value={PROTOCOL_LABELS[node.protocol] ?? node.protocol} />
                  <DetailItem label="Host" value={node.host} mono />
                  <DetailItem label="Port" value={node.port} mono />
                  <DetailItem label="Transport" value={TRANSPORT_LABELS[node.transport] ?? node.transport} />
                  <DetailItem label="Security" value={node.security.toUpperCase()} />
                  {node.sni && <DetailItem label="SNI" value={node.sni} mono />}
                  {node.path && <DetailItem label="Path" value={node.path} mono />}
                  {node.hostHeader && <DetailItem label="Host header" value={node.hostHeader} mono />}
                  {node.serviceName && <DetailItem label="gRPC service" value={node.serviceName} />}
                  {node.flow && <DetailItem label="Flow" value={node.flow} />}
                  {node.alpn && node.alpn.length > 0 && <DetailItem label="ALPN" value={node.alpn.join(', ')} mono />}
                  {node.realityPublicKey && <DetailItem label="Reality public key" value={`${node.realityPublicKey.slice(0, 24)}…`} mono />}
                  <DetailItem label="Allow insecure" value={node.allowInsecure ? 'Yes' : 'No'} />
                  <DetailItem label="Addresses" value={node.ipv4.join(', ') || '—'} mono />
                  {node.ipv6.length > 0 && <DetailItem label="IPv6" value={node.ipv6.join(', ')} mono />}
                  <DetailItem label="Sources" value={node.sourceCount} mono />
                  <DetailItem label="Fingerprint" value={`${node.canonicalFingerprint.slice(0, 16)}…`} mono />
                </DetailGrid>
              </Section>

              <Section
                collapsible
                pinned
                id="geo"
                defaultOpen
                badge={<Badge tone={node.country ? 'neutral' : 'warn'}>{node.country || 'unknown'}</Badge>}
                summary={node.city ? `Resolved to ${node.city}${node.country ? `, ${node.country}` : ''}` : 'No reliable city — coordinates stay unknown rather than guessed'}
                title="Geolocation"
                icon={<Flag size={15} />}
                subtitle="GeoIP output is reported as stored — anycast and edge IPs deliberately stay Unknown rather than being guessed."
              >
                <GeoStatusNote node={node} onRecheck={() => void actions.recheckGeo(node.id)} checking={actions.busy(node.id, 'geo')} />
                <DetailGrid cols={3}>
                  <DetailItem label="Country" value={node.country || '—'} />
                  <DetailItem label="City" value={node.city || '—'} />
                  <DetailItem label="ASN" value={node.asn ? `AS${node.asn}` : '—'} mono />
                  <DetailItem label="ISP" value={node.isp || '—'} />
                  <DetailItem label="Organization" value={node.organization || '—'} />
                  <DetailItem label="Coordinates" value={node.lat != null && node.lon != null ? `${node.lat.toFixed(2)}, ${node.lon.toFixed(2)}` : '—'} mono />
                </DetailGrid>
                <Button variant="ghost" size="sm" className="mt-2" onClick={() => void actions.recheckGeo(node.id)} loading={actions.busy(node.id, 'geo')}>
                  <RefreshCw size={12} />
                  Force fresh lookup
                </Button>
              </Section>
            </div>

            <div className="min-w-0">
              <Section
                collapsible
                id="scoring"
                defaultOpen={false}
                summary="How this node's score, health and freshness are derived"
                title="Scoring & lifecycle"
                icon={<Activity size={15} />}
                subtitle="Derived from recorded probes and source agreement — never from a single lucky test."
              >
                <DetailGrid>
                  <DetailItem label="Score" value={node.score.toFixed(0)} mono />
                  <DetailItem label="Reliability" value={fmtPct(rates.reliabilityPct)} mono />
                  <DetailItem label="Freshness" value={<span className="capitalize">{node.freshness}</span>} />
                  <DetailItem label="Tags" value={node.tags.length > 0 ? node.tags.join(', ') : '—'} />
                  <DetailItem label="Last tested" value={node.lastValidated != null ? fmtDateTime(node.lastValidated) : '—'} mono />
                  <DetailItem label="First seen" value={fmtDateTime(node.firstSeen)} mono />
                  <DetailItem label="Last seen" value={fmtDateTime(node.lastSeen)} mono />
                </DetailGrid>
              </Section>

              <Section
                collapsible
                id="runtime"
                defaultOpen={false}
                summary="Which local core runs this node's probes, and how to change it"
                title="Measurement runtime"
                icon={<Server size={15} />}
                subtitle="Node probes are executed by the local core that owns this node's runtime."
              >
                <DataList>
                  <DataRow
                    title={<span className="text-sm">Latest probe runtime</span>}
                    subtitle="A node never probed by a core shows no runtime rather than a guess."
                    actions={
                      runtimeEngine ? (
                        <EngineBadge engine={runtimeEngine} />
                      ) : (
                        <span className="text-xs text-faint">not probed</span>
                      )
                    }
                  />
                  <DataRow
                    title={<span className="text-sm">Probes on record</span>}
                    subtitle={`${health?.successCount ?? 0} succeeded · ${health?.failureCount ?? 0} failed`}
                    actions={<span className="metric-num text-sm">{health?.testCount ?? 0}</span>}
                  />
                  <DataRow
                    title={<span className="text-sm">Consecutive failures</span>}
                    subtitle="A run of failures marks the node degraded before it is dropped."
                    actions={
                      <span className={`metric-num text-sm ${(health?.consecutiveFailures ?? 0) > 0 ? 'text-warn' : 'text-text'}`}>
                        {health?.consecutiveFailures ?? 0}
                      </span>
                    }
                  />
                </DataList>
              </Section>

              <Section
                collapsible
                pinned
                id="quick-tests"
                defaultOpen
                summary={`Run a real probe now — ${tests.length} already recorded`}
                title="Quick tests"
                icon={<Wifi size={15} />}
                subtitle="One probe per layer, run now against the real endpoint. Results are stored in history."
              >
                <div className="flex flex-wrap gap-2">
                  {(['tcp', 'tls', 'proxy'] as const).map((type) => (
                    <Button
                      key={type}
                      variant={testing === type ? 'primary' : 'secondary'}
                      size="sm"
                      disabled={!!testing}
                      onClick={() => runTest(type)}
                    >
                      {testing === type ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : type === 'tcp' ? (
                        <Wifi size={14} />
                      ) : type === 'tls' ? (
                        <Shield size={14} />
                      ) : (
                        <Network size={14} />
                      )}
                      {type === 'tcp' ? 'Test TCP' : type === 'tls' ? 'Test TLS' : 'Test Proxy'}
                    </Button>
                  ))}
                </div>
                {resultBox}
              </Section>
            </div>
          </div>
        </TabPanel>

        <TabPanel value="tests">
          <Section
            collapsible
            pinned
            id="history"
            defaultOpen
            badge={<Badge tone={tests.length > 0 ? 'neutral' : 'warn'}>{tests.length} probes</Badge>}
            summary={`${tests.length} recorded probe(s), newest first`}
            title="Probe history"
            icon={<Clock size={15} />}
            subtitle={`${tests.length} recorded probes, newest first — each attributed to the core that ran it.`}
          >
            {tests.length === 0 ? (
              <EmptyState title="No probes yet" message="Run a quick test from the Overview tab to record the first one." />
            ) : (
              <DataList>
                {tests.slice(0, 50).map((test) => (
                  <DataRow
                    key={`${test.nodeId}-${test.startedAt}`}
                    leading={
                      <Badge tone={test.status === 'done' ? 'ok' : 'danger'} className="w-16 justify-center">
                        {test.type.toUpperCase()}
                      </Badge>
                    }
                    title={
                      <>
                        <span className="metric-num text-sm">{test.latencyMs != null ? fmtMs(test.latencyMs) : '—'}</span>
                        <EngineBadge engine={test.engine} />
                      </>
                    }
                    subtitle={
                      test.error ? (
                        <span className="text-danger">{test.error}</span>
                      ) : test.tlsVersion ? (
                        <span>TLS {test.tlsVersion}</span>
                      ) : undefined
                    }
                    meta={fmtDateTime(test.startedAt)}
                  />
                ))}
              </DataList>
            )}
          </Section>
        </TabPanel>

        <TabPanel value="health">
          <MetricStrip
            className="mb-5"
            items={[
              ...healthMetricItems(rates, health?.medianLatencyMs ?? null),
            ]}
          />
          <Section
            collapsible
            id="outcomes"
            defaultOpen={false}
            summary="Success, failure and latency spread across all recorded probes"
            title="Outcome breakdown"
            icon={<Activity size={15} />}
            subtitle="Aggregated per node from the stored probe records."
          >
            <DataList>
              <DataRow
                title={<span className="text-sm">Successes</span>}
                actions={<span className="metric-num text-sm text-ok">{health?.successCount ?? 0}</span>}
              />
              <DataRow
                title={<span className="text-sm">Failures</span>}
                actions={<span className={`metric-num text-sm ${(health?.failureCount ?? 0) > 0 ? 'text-danger' : 'text-text'}`}>{health?.failureCount ?? 0}</span>}
              />
              <DataRow
                title={<span className="text-sm">Consecutive failures</span>}
                actions={<span className={`metric-num text-sm ${(health?.consecutiveFailures ?? 0) > 0 ? 'text-warn' : 'text-text'}`}>{health?.consecutiveFailures ?? 0}</span>}
              />
              <DataRow
                title={<span className="text-sm">Last success</span>}
                actions={<span className="metric-num text-sm text-muted">{health?.lastSuccessAt ? fmtDateTime(health.lastSuccessAt) : <span className="text-faint">never</span>}</span>}
              />
              <DataRow
                title={<span className="text-sm">Last failure</span>}
                actions={
                  <span className={`metric-num text-sm ${health?.lastFailureAt ? 'text-muted' : 'text-faint'}`}>
                    {health?.lastFailureAt ? fmtDateTime(health.lastFailureAt) : 'never'}
                  </span>
                }
              />
            </DataList>
          </Section>
        </TabPanel>

        <TabPanel value="export">
          <Section
            collapsible
            id="export"
            defaultOpen={false}
            summary="Export this single node for another client — metadata only, no secrets"
            title="Download configuration"
            icon={<Download size={15} />}
            subtitle="Rendered server-side for this single node, in the format each client expects."
          >
            <Panel>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    // Every button in this panel downloads a file — the glyph
                    // says download. "Copy share link" in the toolbar is the
                    // action that reaches the clipboard.
                    ['uri', 'URI', <Download size={14} key="uri" />],
                    ['plaintext', 'Plaintext', <Download size={14} key="pt" />],
                    ['base64', 'Base64', <Download size={14} key="b64" />],
                    ['json', 'JSON', <Download size={14} key="json" />],
                    ['clash', 'Clash', <Download size={14} key="clash" />],
                    ['singbox', 'Sing-box', <Download size={14} key="sb" />],
                  ] as const
                ).map(([format, label, icon]) => (
                  <Button key={format} variant="secondary" size="sm" onClick={() => void exportNode(format)}>
                    {icon}
                    {label}
                  </Button>
                ))}
              </div>
            </Panel>

            <p className="mt-4 text-micro font-semibold uppercase tracking-[0.14em] text-faint">Shape preview</p>
            <Panel tone="quiet" className="mt-1.5 max-h-64 overflow-auto font-mono text-micro leading-relaxed whitespace-pre-wrap text-muted">
              {node.protocol === 'vless' &&
                `vless://<password>@${node.host}:${node.port}?security=${node.security}&type=${node.transport}${node.sni ? `&sni=${node.sni}` : ''}${node.path ? `&path=${node.path}` : ''}${node.hostHeader ? `&host=${node.hostHeader}` : ''}${node.flow ? `&flow=${node.flow}` : ''}#${node.remark || node.host}`}
              {node.protocol === 'trojan' &&
                `trojan://<password>@${node.host}:${node.port}?sni=${node.sni}&type=${node.transport}${node.path ? `&path=${node.path}` : ''}#${node.remark || node.host}`}
              {node.protocol === 'shadowsocks' && `ss://<method>:<password>@${node.host}:${node.port}#${node.remark || node.host}`}
              {node.protocol === 'hysteria2' && `hysteria2://<password>@${node.host}:${node.port}?sni=${node.sni}#${node.remark || node.host}`}
              {node.protocol === 'tuic' &&
                `tuic://<password>@${node.host}:${node.port}?sni=${node.sni}&alpn=${node.alpn?.[0] || 'h3'}#${node.remark || node.host}`}
              {node.protocol === 'vmess' && 'VMess URI requires the node UUID — secrets are not stored in the clear, so no URI can be generated.'}
              {node.protocol === 'shadowsocksr' && 'SSR URI requires a base64-encoded config — secrets are not stored in the clear, so no URI can be generated.'}
              {node.protocol === 'wireguard' && 'WireGuard URI requires the node private key — secrets are not stored in the clear, so no URI can be generated.'}
            </Panel>
            <Notice tone="info" className="mt-3">
              Exports carry connection metadata only. Passwords, keys and UUIDs are never rendered here — provide them in your client.
            </Notice>
          </Section>
        </TabPanel>
      </Tabs>
    </DisclosureScope>
  );
}
