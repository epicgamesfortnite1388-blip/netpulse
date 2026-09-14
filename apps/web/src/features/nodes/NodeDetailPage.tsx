import { useCallback, useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router';

import {
  CheckCircle2,
  Copy,
  Download,
  Flag,
  Globe2,
  Info,
  Loader2,
  RefreshCw,
  Shield,
  ShieldCheck,
  ShieldX,
  Star,
  Wifi,
  ChevronRight,
  Network,
  Route as RouteIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { EngineBadge, ENGINE_LABELS } from '@/components/EngineBadge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Tabs, TabPanel } from '@/components/ui/Tabs';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/States';
import { useToast } from '@/components/Toaster';
import { api } from '@/lib/api';
import { GEO_STATUS_COPY, geoReasonOf } from '@/lib/geoStatus';
import { usePersistentState } from '@/lib/usePersistentState';
import { diagnoseFailure } from '@/lib/failureIntelligence';
import { fmtMs, fmtPct, fmtDateTime } from '@/lib/format';

import type { PublicNode, NodeTestResult } from '@netpulse/shared';

type NodeWebDTO = PublicNode;

/** Aggregated health record returned by GET /nodes/:id/health */
interface NodeHealthSummary {
  testCount: number;
  successCount: number;
  failureCount: number;
  reliabilityPct: number;
  medianLatencyMs: number | null;
  lossPct: number;
  consecutiveFailures: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
}

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
    <Card className="mb-6">
      <CardBody className="flex items-start gap-2.5 text-[13px] leading-relaxed text-muted">
        <Info size={15} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-text">{x.title}</p>
          <p className="mt-0.5">{x.detail}</p>
          {reason !== 'anycast' && reason !== 'edge_fabric' && (
            <Button variant="ghost" size="sm" className="mt-2" onClick={onRecheck} loading={checking}>
              <RefreshCw size={12} />
              Re-check location
            </Button>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

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

  // In-flight geo re-check (survives tab switches like pendingTest does not
  // need persistence: the POST is short-lived and the result is a node refetch).
  const [geoChecking, setGeoChecking] = useState(false);
  const recheckGeo = useCallback(async () => {
    if (!id || geoChecking) return;
    setGeoChecking(true);
    try {
      const res = await api.post<{ result: { outcome: string; reason: string }; node: NodeWebDTO | null }>(`/nodes/${id}/geo-recheck`, {});
      if (res.node) setNode(res.node);
      const r = res.result;
      if (r.outcome === 'resolved' || r.outcome === 'vouched') {
        toast('ok', 'Location updated', r.outcome === 'vouched' ? 'User-attested coordinates applied.' : 'Fresh GeoIP lookup completed.');
      } else if (r.outcome === 'refused') {
        toast('warn', 'No location available', r.reason === 'anycast' ? 'This IP is anycast — GeoIP answers for it are artifacts, so it stays Unknown.' : 'This IP belongs to a global edge network — GeoIP would report a registry office, not a location.');
      } else if (r.outcome === 'busy') {
        toast('warn', 'Geo worker busy', 'A background lookup is running — this node is queued. Try again in a moment.');
      } else {
        toast('error', 'Lookup failed', r.reason === 'private_only' ? 'Node has only private addresses — nothing to geolocate.' : 'The geolocation service did not answer. It retries in the background.');
      }
    } catch (err) {
      toast('error', 'Re-check failed', err instanceof Error ? err.message : undefined);
    } finally {
      setGeoChecking(false);
    }
  }, [id, geoChecking, toast]);

  const runTest = useCallback(async (type: 'tcp' | 'tls' | 'proxy' | 'icmp') => {
    if (!id) return;
    const startedAt = Date.now();
    setPendingTest({ type, startedAt });
    try {
      const result = await api.post<NodeTestResult>(`/nodes/${id}/test`, { type });
      setTestResult(result);
      toast('ok', `Test ${type} complete`, `${result.latencyMs?.toFixed(1)} ms`);
      void loadNode();
    } catch (err) {
      toast('error', `Test ${type} failed`, err instanceof Error ? err.message : undefined);
      setTestResult({ nodeId: id!, type, status: 'failed', startedAt, finishedAt: Date.now(), latencyMs: null, totalMs: null, error: err instanceof Error ? err.message : String(err), tlsVersion: null, authorized: null, httpStatus: null, responseSize: null, family: null, probedIp: null, testEndpoint: null, engine: null });
    } finally {
      setPendingTest(null);
    }
  }, [id, loadNode, setPendingTest, toast]);

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
            if (rec.status === 'done') toast('ok', `Test ${rec.type} complete`, rec.latencyMs != null ? `${rec.latencyMs.toFixed(1)} ms` : undefined);
            else toast('error', `Test ${rec.type} failed`, rec.error ?? undefined);
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

  const toggleFavorite = useCallback(async () => {
    if (!node) return;
    try {
      await api.post(`/nodes/${node.id}/favorite`, { favorite: !node.favorite });
      toast('ok', node.favorite ? 'Removed from favorites' : 'Added to favorites');
      void loadNode();
    } catch (err) {
      toast('error', 'Failed to update favorite', err instanceof Error ? err.message : undefined);
    }
  }, [node, loadNode, toast]);

  const exportConfig = useCallback(async (format: 'uri' | 'plaintext' | 'base64' | 'json' | 'clash' | 'singbox') => {
    if (!node) return;
    try {
      const result = await api.get<string>(`/nodes/export?nodeIds=${encodeURIComponent(node.id)}&format=${encodeURIComponent(format)}`);
      const blob = new Blob([result], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `node-${node.id.slice(0, 8)}.${format === 'base64' ? 'b64' : format}`;
      a.click();
      URL.revokeObjectURL(url);
      toast('ok', 'Exported', `${format} — ${node.id.slice(0, 8)}`);
    } catch (err) {
      toast('error', 'Export failed', err instanceof Error ? err.message : undefined);
    }
  }, [node, toast]);

  if (loading) return <LoadingState label="Loading node..." />;
  if (loadingError) return <ErrorState error={loadingError} retry={loadNode} />;
  if (!node) return            <EmptyState title="Node not found" message="It may have been removed." />;

  const medianProxy = (health?.medianLatencyMs as number | undefined) ?? node.medianProxyMs;
  const medianTcp = node.medianTcpMs;

  return (
    <div className="min-h-screen bg-base text-foreground">
      <div className="sticky top-0 z-10 bg-base/95 backdrop-blur border-b border-base-300">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate(-1)}
              className="p-1.5 rounded hover:bg-base-200 text-muted hover:text-foreground transition-colors"
            >
              <ChevronRight size={18} className="rotate-180" />
            </button>
            <CardHeader
              title={node.remark || node.host}
              subtitle={`${PROTOCOL_LABELS[node.protocol] || node.protocol} · ${node.host}:${node.port}`}
            />
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={toggleFavorite}>
              {node.favorite ? (
                <Star size={16} className="text-yellow-400 fill-yellow-400" />
              ) : (
                <Star size={16} className="text-muted hover:text-yellow-400" />
              )}
              {node.favorite ? 'Favorited' : 'Favorite'}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => exportConfig('uri')}>
              <Copy size={14} />
              Copy URI
            </Button>
            <Button variant="secondary" size="sm" onClick={() => exportConfig('json')}>
              <Download size={14} />
              Export
            </Button>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto px-6 py-6">
        {/* Status header */}
        <Card className="mb-6">
          <CardBody>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="flex items-center gap-3 p-3 rounded-lg bg-base-200/50">
                <div className={`p-2 rounded-full ${node.status === 'healthy' ? 'bg-status-ok/10' : node.status === 'failed' ? 'bg-status-danger/10' : 'bg-status-warn/10'}`}>
                  {node.status === 'healthy' ? <ShieldCheck size={20} className="text-status-ok" /> :
                   node.status === 'failed' ? <ShieldX size={20} className="text-status-danger" /> :
                   <Shield size={20} className="text-status-warn" />}
                </div>
                <div>
                  <p className="text-sm font-medium capitalize">{node.status}</p>
                  <p className="text-xs text-muted capitalize">{node.confidence} confidence</p>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 rounded-lg bg-base-200/50">
                <Globe2 size={20} className="text-muted" />
                <div>
                  <p className="text-sm font-medium">{node.host}</p>
                  <p className="text-xs text-muted font-mono">{node.ipv4?.[0] || 'no IPv4'}</p>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 rounded-lg bg-base-200/50">
                <Flag size={20} className="text-muted" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{node.country || 'Unknown location'}</p>
                  {node.city && <p className="text-xs text-muted">{node.city}</p>}
                  {node.asn && <p className="text-xs text-muted">AS{node.asn}</p>}
                  {node.isp && <p className="text-xs text-muted">{node.isp}</p>}
                </div>
                <Button variant="ghost" size="sm" className="shrink-0" onClick={() => void recheckGeo()} loading={geoChecking} title="Force a fresh geolocation lookup for this node">
                  <RefreshCw size={12} />
                  Re-check
                </Button>
              </div>
              <div className="flex items-center gap-3 p-3 rounded-lg bg-base-200/50">
                <Network size={20} className="text-muted" />
                <div>
                  <p className="text-sm font-medium">{TRANSPORT_LABELS[node.transport] || node.transport}</p>
                  <p className="text-xs text-muted">{node.security !== 'none' ? `· ${node.security.toUpperCase()}`.replace('TLS', 'TLS') : '· no TLS'}</p>
                </div>
              </div>
            </div>
          </CardBody>
        </Card>

        <GeoStatusNote node={node} onRecheck={() => void recheckGeo()} checking={geoChecking} />

        {/* Technical details */}
        <Card className="mb-6">
          <CardHeader title="Technical Details" subtitle={`Fingerprint: ${node.canonicalFingerprint.slice(0, 16)}…`} />
          <CardBody>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                <div className="col-span-2">
                  <span className="text-xs text-muted">Protocol</span>
                  <span className="font-medium">{PROTOCOL_LABELS[node.protocol] || node.protocol}</span>
                </div>
                <div className="col-span-2">
                  <span className="text-xs text-muted">Port</span>
                  <span className="font-medium font-mono">{node.port}</span>
                </div>
                <div className="col-span-2">
                  <span className="text-xs text-muted">Transport</span>
                  <span className="font-medium">{TRANSPORT_LABELS[node.transport] || node.transport}</span>
                </div>
                <div className="col-span-2">
                  <span className="text-xs text-muted">Security</span>
                  <span className="font-medium">{node.security.toUpperCase()}</span>
                </div>
                {node.sni && (
                  <div className="col-span-2">
                    <span className="text-xs text-muted">SNI</span>
                    <span className="font-medium font-mono text-xs">{node.sni}</span>
                  </div>
                )}
                {node.path && (
                  <div className="col-span-2">
                    <span className="text-xs text-muted">Path</span>
                    <span className="font-medium font-mono text-xs">{node.path}</span>
                  </div>
                )}
                {node.hostHeader && (
                  <div className="col-span-2">
                    <span className="text-xs text-muted">Host Header</span>
                    <span className="font-medium font-mono text-xs">{node.hostHeader}</span>
                  </div>
                )}
                {node.serviceName && (
                  <div className="col-span-2">
                    <span className="text-xs text-muted">gRPC Service</span>
                    <span className="font-medium">{node.serviceName}</span>
                  </div>
                )}
                {node.flow && (
                  <div className="col-span-2">
                    <span className="text-xs text-muted">Flow</span>
                    <span className="font-medium">{node.flow}</span>
                  </div>
                )}
                {node.allowInsecure && (
                  <div className="col-span-2">
                    <span className="text-xs text-muted">Allow Insecure</span>
                    <span className="font-medium">Yes</span>
                  </div>
                )}
                {node.realityPublicKey && (
                  <div className="col-span-2">
                    <span className="text-xs text-muted">Reality Public Key</span>
                    <span className="font-medium font-mono text-xs">{node.realityPublicKey.slice(0, 24)}… </span>
                  </div>
                )}
                <div className="col-span-2">
                  <span className="text-xs text-muted">IPv4 Addresses</span>
                  <span className="font-medium">{node.ipv4.join(', ') || '—'}</span>
                </div>
                {node.ipv6.length > 0 && (
                  <div className="col-span-2">
                    <span className="text-xs text-muted">IPv6 Addresses</span>
                    <span className="font-medium font-mono text-xs">{node.ipv6.join(', ')}</span>
                  </div>
                )}
                <div className="col-span-2">
                  <span className="text-xs text-muted">Source Count</span>
                  <span className="font-medium">{node.sourceCount}</span>
                </div>
                <div className="col-span-2">
                  <span className="text-xs text-muted">ASN</span>
                  <span className="font-medium">{node.asn ? `AS${node.asn}` : '—'}</span>
                </div>
                {node.isp && (
                  <div className="col-span-2">
                    <span className="text-xs text-muted">ISP</span>
                    <span className="font-medium">{node.isp}</span>
                  </div>
                )}
                {node.organization && (
                  <div className="col-span-2">
                    <span className="text-xs text-muted">Organization</span>
                    <span className="font-medium">{node.organization}</span>
                  </div>
                )}
                <div className="col-span-2">
                  <span className="text-xs text-muted">Score</span>
                  <span className="font-medium">{node.score.toFixed(0)}</span>
                </div>
                <div className="col-span-2">
                  <span className="text-xs text-muted">Reliability</span>
                  <span className="font-medium">{fmtPct(node.reliabilityPct)}</span>
                </div>
                <div className="col-span-2">
                  <span className="text-xs text-muted">Median Proxy</span>
                  <span className="font-medium font-mono">{medianProxy != null ? fmtMs(medianProxy) : '—'}</span>
                </div>
                <div className="col-span-2">
                  <span className="text-xs text-muted">Median TCP</span>
                  <span className="font-medium font-mono">{medianTcp != null ? fmtMs(medianTcp) : '—'}</span>
                </div>
                <div className="col-span-2">
                  <span className="text-xs text-muted">Recent Loss</span>
                  <span className="font-medium">{fmtPct(node.recentLossPct)}</span>
                </div>
                <div className="col-span-2">
                  <span className="text-xs text-muted">Last Tested</span>
                  <span className="font-medium">{fmtDateTime(node.lastValidated ?? 0)}</span>
                </div>
                <div className="col-span-2">
                  <span className="text-xs text-muted">First Seen</span>
                  <span className="font-medium">{fmtDateTime(node.firstSeen)}</span>
                </div>
                <div className="col-span-2">
                  <span className="text-xs text-muted">Last Seen</span>
                  <span className="font-medium">{fmtDateTime(node.lastSeen)}</span>
                </div>
                <div className="col-span-2">
                  <span className="text-xs text-muted">Freshness</span>
                  <span className="font-medium">{node.freshness}</span>
                </div>
                <div className="col-span-2">
                  <span className="text-xs text-muted">Tags</span>
                  <span className="font-medium">{node.tags.length > 0 ? node.tags.join(', ') : '—'}</span>
                </div>
              </div>
            </div>
          </CardBody>
        </Card>

        {/* Quick test buttons */}
        <Card className="mb-6">
          <CardHeader title="Quick Tests" subtitle="Test individual components of this node" />
          <CardBody>
            <div className="flex flex-wrap gap-2">
              {(['tcp', 'tls', 'proxy'] as const).map((type) => (
                <Button
                  key={type}
                  variant={testing === type ? 'primary' : 'secondary'}
                  size="sm"
                  disabled={!!testing}
                  onClick={() => runTest(type)}
                >
                  {testing === type ? <Loader2 size={14} className="animate-spin" /> : (
                    type === 'tcp' ? <Wifi size={14} /> :
                    type === 'tls' ? <Shield size={14} /> :
                    <Network size={14} />
                  )}
                  {type === 'tcp' ? 'Test TCP' : type === 'tls' ? 'Test TLS' : 'Test Proxy'}
                </Button>
              ))}
              <Button
                variant="secondary"
                size="sm"
                title="Compare direct vs VPN traceroutes to this node's endpoint"
                onClick={() => navigate(`/routes?tab=vpn-compare&target=${encodeURIComponent(node.ipv4[0] || node.host)}`)}
              >
                <RouteIcon size={14} />
                Direct vs VPN
              </Button>
            </div>
            {testResult && (
              <div className="mt-4 p-3 rounded-lg bg-base-200/50 text-sm">
                <p className="font-medium">
                  {testResult.status === 'done' ? (
                    <span className="text-status-ok flex items-center gap-1"><CheckCircle2 size={14} /> Test successful</span>
                  ) : (
                    <span className="text-status-danger flex items-center gap-1"><ShieldX size={14} /> Test failed</span>
                  )}
                </p>
                {testResult.latencyMs != null && (
                  <p className="text-muted">Latency: {testResult.latencyMs != null ? fmtMs(testResult.latencyMs) : '—'}</p>
                )}
                {testResult.engine && (
                  <p className="text-muted text-xs">measured via {ENGINE_LABELS[testResult.engine as keyof typeof ENGINE_LABELS] ?? testResult.engine}</p>
                )}
                {testResult.error && (() => {
                  const dx = diagnoseFailure(testResult.error);
                  return (
                    <div className="mt-1 rounded border border-danger/30 bg-danger/5 p-2">
                      {dx && (
                        <p className="text-xs font-medium" title={testResult.error}>
                          {dx.category} — {dx.summary}
                        </p>
                      )}
                      {dx?.action && <p className="text-muted mt-0.5 text-xs">{dx.action}</p>}
                      <p className="text-muted mt-0.5 font-mono text-[11px] break-all">{testResult.error}</p>
                    </div>
                  );
                })()}
              </div>
            )}
          </CardBody>
        </Card>

        {/* Tabs */}
        <Tabs defaultValue="details" items={[
          { value: 'details', label: 'Details' },
          { value: 'history', label: 'History' },
          { value: 'export', label: 'Export' },
        ]}>
          <TabPanel value="details">
            <Card>
              <CardHeader title="Recent Tests" subtitle={`${tests.length} tests recorded`} />
              <CardBody>
                {tests.length === 0 ? (
                  <EmptyState title="No tests yet" message="Run a quick test above to see results here." />
                ) : (
                  <div className="space-y-2">
                    {tests.slice(0, 20).map((test) => (
                      <div key={`${test.nodeId}-${test.startedAt}`} className="flex items-center justify-between p-3 rounded-lg bg-base-200/30 text-sm">
                        <div className="flex items-center gap-3">
                          <Badge tone={test.status === 'done' ? 'ok' : 'danger'}>
                            {test.type.toUpperCase()}
                          </Badge>
                          <EngineBadge engine={test.engine} title={`This measurement was produced by the ${ENGINE_LABELS[test.engine as keyof typeof ENGINE_LABELS] ?? test.engine} runtime`} />
                          {test.latencyMs != null && (
                            <span className="font-mono">{test.latencyMs != null ? fmtMs(test.latencyMs) : '—'}</span>
                          )}
                          {test.tlsVersion && (
                            <span className="text-xs text-muted">{test.tlsVersion}</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-muted">{fmtDateTime(test.startedAt)}</span>
                          {test.error && <span className="text-xs text-danger">{test.error}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardBody>
            </Card>
          </TabPanel>

          <TabPanel value="history">            <Card>
              <CardHeader title="Health History" subtitle="Aggregated statistics" />
              <CardBody>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div className="col-span-2 md:col-span-1">
                    <span className="text-xs text-muted">Total Tests</span>
                    <span className="font-medium">{health?.testCount ?? 0}</span>
                  </div>
                  <div className="col-span-2 md:col-span-1">
                    <span className="text-xs text-muted">Successes</span>
                    <span className="font-medium">{health?.successCount ?? 0}</span>
                  </div>
                  <div className="col-span-2 md:col-span-1">
                    <span className="text-xs text-muted">Failures</span>
                    <span className="font-medium">{health?.failureCount ?? 0}</span>
                  </div>
                  <div className="col-span-2 md:col-span-1">
                    <span className="text-xs text-muted">Reliability</span>
                    <span className="font-medium">{fmtPct(health?.reliabilityPct ?? 0)}</span>
                  </div>
                  <div className="col-span-2 md:col-span-1">
                    <span className="text-xs text-muted">Median Latency</span>
                    <span className="font-medium font-mono">{health?.medianLatencyMs != null ? fmtMs(health.medianLatencyMs) : '—'}</span>
                  </div>
                  <div className="col-span-2 md:col-span-1">
                    <span className="text-xs text-muted">Packet Loss</span>
                    <span className="font-medium">{fmtPct(health?.lossPct ?? 0)}</span>
                  </div>
                  <div className="col-span-2 md:col-span-1">
                    <span className="text-xs text-muted">Consecutive Failures</span>
                    <span className="font-medium">{health?.consecutiveFailures ?? 0}</span>
                  </div>
                  <div className="col-span-2 md:col-span-1">
                    <span className="text-xs text-muted">Last Success</span>
                    <span className="font-medium">{fmtDateTime(health?.lastSuccessAt ?? 0)}</span>
                  </div>
                  <div className="col-span-2 md:col-span-1">
                    <span className="text-xs text-muted">Last Failure</span>
                    <span className="font-medium">{fmtDateTime(health?.lastFailureAt ?? 0)}</span>
                  </div>
                </div>
              </CardBody>
            </Card>
          </TabPanel>

          <TabPanel value="export">
            <Card>
              <CardHeader title="Export Configuration" subtitle="Download this node in various formats" />
              <CardBody>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" size="sm" onClick={() => exportConfig('uri')}>
                    <Copy size={14} /> URI
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => exportConfig('plaintext')}>
                    <Copy size={14} /> Plaintext
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => exportConfig('base64')}>
                    <Copy size={14} /> Base64
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => exportConfig('json')}>
                    <Download size={14} /> JSON
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => exportConfig('clash')}>
                    <Download size={14} /> Clash
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => exportConfig('singbox')}>
                    <Download size={14} /> Sing-box
                  </Button>
                </div>
                <div className="mt-4 p-4 rounded-lg bg-base-200/50 text-xs font-mono whitespace-pre-wrap max-h-64 overflow-auto">
                  {node.protocol === 'vless' && (
                    `vless://<password>@${node.host}:${node.port}?security=${node.security}&type=${node.transport}${node.sni ? `&sni=${node.sni}` : ''}${node.path ? `&path=${node.path}` : ''}${node.hostHeader ? `&host=${node.hostHeader}` : ''}${node.flow ? `&flow=${node.flow}` : ''}#${node.remark || node.host}`
                  )}
                  {node.protocol === 'trojan' && (
                    `trojan://<password>@${node.host}:${node.port}?sni=${node.sni}&type=${node.transport}${node.path ? `&path=${node.path}` : ''}#${node.remark || node.host}`
                  )}
                  {node.protocol === 'shadowsocks' && (
                    `ss://<method>:<password>@${node.host}:${node.port}#${node.remark || node.host}`
                  )}
                  {node.protocol === 'hysteria2' && (
                    `hysteria2://<password>@${node.host}:${node.port}?sni=${node.sni}#${node.remark || node.host}`
                  )}
                  {node.protocol === 'tuic' && (
                    `tuic://<password>@${node.host}:${node.port}?sni=${node.sni}&alpn=${node.alpn?.[0] || 'h3'}#${node.remark || node.host}`
                  )}
                  {node.protocol === 'vmess' && (
                    <span className="text-muted">VMess URI requires UUID — cannot be generated without secrets</span>
                  )}
                  {node.protocol === 'shadowsocksr' && (
                    <span className="text-muted">SSR URI requires base64-encoded config — cannot be generated without secrets</span>
                  )}
                  {node.protocol === 'wireguard' && (
                    <span className="text-muted">WireGuard URI requires private key — cannot be generated without secrets</span>
                  )}
                </div>
                <p className="mt-2 text-xs text-muted">
                  Note: Export URIs contain only connection metadata. Secrets (passwords, keys, UUIDs) must be provided separately.
                </p>
              </CardBody>
            </Card>
          </TabPanel>
        </Tabs>
      </div>
    </div>
  );
}
