import { useCallback, useEffect, useMemo, useState } from 'react';

import { useNavigate } from 'react-router';

import {
  ArrowUpDown,
  Clock,
  Download,
  Flag,
  Globe2,
  Info,
  LocateFixed,
  RefreshCw,
  Search,
  Shield,
  ShieldCheck,
  ShieldX,
  Star,
  TrendingUp,
  ChevronRight,
  Wifi,
} from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/States';
import { useToast } from '@/components/Toaster';
import { api } from '@/lib/api';
import { GeoStatusBadge, geoReasonOf } from '@/lib/geoStatus';
import { usePersistentState } from '@/lib/usePersistentState';
import { fmtMs, fmtPct } from '@/lib/format';

import type {
  NodeProtocol,
  NodeStatus,
  NodeSortField,
  NodeSortDir,
  NodeSort,
  NodeFilter,
  NodeTestResult,
  PublicNode,
  ProxyEngineStatus,
} from '@netpulse/shared';

/** Summary counts returned by GET /nodes/stats */
interface NodesStatsSummary {
  total: number;
  discovered: number;
  healthy: number;
  degraded: number;
  failed: number;
  stale: number;
  favoriteCount: number;
  protocolBreakdown: Record<string, number>;
  countryBreakdown: Record<string, number>;
  transportBreakdown: Record<string, number>;
}

const PROTOCOL_OPTIONS: { value: NodeProtocol | 'all'; label: string }[] = [
  { value: 'all', label: 'All protocols' },
  { value: 'vless', label: 'VLESS' },
  { value: 'vmess', label: 'VMess' },
  { value: 'trojan', label: 'Trojan' },
  { value: 'shadowsocks', label: 'Shadowsocks' },
  { value: 'shadowsocksr', label: 'ShadowsocksR' },
  { value: 'hysteria2', label: 'Hysteria2' },
  { value: 'tuic', label: 'TUIC' },
  { value: 'wireguard', label: 'WireGuard' },
  { value: 'unknown', label: 'Unknown' },
];

const STATUS_OPTIONS: { value: NodeStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All statuses' },
  { value: 'healthy', label: 'Healthy' },
  { value: 'degraded', label: 'Degraded' },
  { value: 'failed', label: 'Failed' },
  { value: 'stale', label: 'Stale' },
  { value: 'discovered', label: 'Discovered' },
];

const TRANSPORT_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: 'All transports' },
  { value: 'tcp', label: 'TCP' },
  { value: 'ws', label: 'WebSocket' },
  { value: 'grpc', label: 'gRPC' },
  { value: 'http', label: 'HTTP' },
  { value: 'quic', label: 'QUIC' },
  { value: 'udp', label: 'UDP' },
];

const SECURITY_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: 'All security' },
  { value: 'none', label: 'None' },
  { value: 'tls', label: 'TLS' },
  { value: 'reality', label: 'Reality' },
];

const FRESHNESS_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: 'All freshness' },
  { value: 'fresh', label: 'Fresh (<1h)' },
  { value: 'recent', label: 'Recent (<6h)' },
  { value: 'aging', label: 'Aging (<24h)' },
  { value: 'stale', label: 'Stale (>24h)' },
];

const SORT_OPTIONS: { value: NodeSortField; label: string; defaultDir: NodeSortDir }[] = [
  { value: 'score', label: 'Score', defaultDir: 'desc' },
  { value: 'proxyLatency', label: 'Proxy latency', defaultDir: 'asc' },
  { value: 'tcpLatency', label: 'TCP latency', defaultDir: 'asc' },
  { value: 'tlsLatency', label: 'TLS latency', defaultDir: 'asc' },
  { value: 'packetLoss', label: 'Packet loss', defaultDir: 'asc' },
  { value: 'reliability', label: 'Reliability', defaultDir: 'desc' },
  { value: 'country', label: 'Country', defaultDir: 'asc' },
  { value: 'protocol', label: 'Protocol', defaultDir: 'asc' },
  { value: 'sourceCount', label: 'Source count', defaultDir: 'desc' },
  { value: 'lastSeen', label: 'Last seen', defaultDir: 'desc' },
];

function StatusIcon({ status }: { status: NodeStatus }) {
  switch (status) {
    case 'healthy':
    case 'proxy-tested':
      return <ShieldCheck size={13} className="text-status-ok" />;
    case 'degraded':
    case 'tcp-tested':
    case 'tcp-tested':
      return <Shield size={13} className="text-status-warn" />;
    case 'failed':
      return <ShieldX size={13} className="text-status-danger" />;
    case 'discovered':
    case 'parsed':
    case 'validated':
      return <Info size={13} className="text-status-neutral" />;
    case 'stale':
      return <Clock size={13} className="text-status-warn" />;
    default:
      return <Globe2 size={13} className="text-status-neutral" />;
  }
}

function ProtocolBadge({ protocol }: { protocol: NodeProtocol }) {
  const colors: Record<NodeProtocol, string> = {
    vless: 'text-blue-400 bg-blue-500/10',
    vmess: 'text-purple-400 bg-purple-500/10',
    trojan: 'text-orange-400 bg-orange-500/10',
    shadowsocks: 'text-green-400 bg-green-500/10',
    shadowsocksr: 'text-green-400 bg-green-500/10',
    hysteria2: 'text-cyan-400 bg-cyan-500/10',
    tuic: 'text-indigo-400 bg-indigo-500/10',
    wireguard: 'text-yellow-400 bg-yellow-500/10',
    unknown: 'text-gray-400 bg-gray-500/10',
  };

  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${colors[protocol] || 'text-gray-400 bg-gray-500/10'}`}>
      {protocol.toUpperCase()}
    </span>
  );
}

function FreshnessDot({ freshness }: { freshness: string }) {
  switch (freshness) {
    case 'fresh':
      return <span className="inline-block w-2 h-2 rounded-full bg-status-ok" title="Fresh" />;
    case 'recent':
      return <span className="inline-block w-2 h-2 rounded-full bg-status-warn" title="Recent" />;
    case 'aging':
      return <span className="inline-block w-2 h-2 rounded-full bg-amber-500" title="Aging" />;
    case 'stale':
      return <span className="inline-block w-2 h-2 rounded-full bg-gray-500" title="Stale" />;
    default:
      return <span className="inline-block w-2 h-2 rounded-full bg-gray-600" />;
  }
}

/** Local core that produced the node's most recent proxy measurement. */
function EngineBadge({ engine }: { engine: 'xray' | 'sing-box' }) {
  const style = engine === 'xray'
    ? 'text-sky-400 bg-sky-500/10'
    : 'text-fuchsia-400 bg-fuchsia-500/10';
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${style}`}
      title={`Last proxy test ran through the ${engine === 'xray' ? 'Xray-core' : 'sing-box'} runtime`}
    >
      {engine}
    </span>
  );
}

function buildFilters(opts: {
  protocol?: string;
  country?: string;
  asn?: string;
  status?: string;
  transport?: string;
  security?: string;
  freshness?: string;
  favorite?: boolean;
  search?: string;
  minScore?: number;
  maxLatency?: number;
  minReliability?: number;
}): NodeFilter[] {
  const filters: NodeFilter[] = [];
  if (opts.protocol && opts.protocol !== 'all') {
    filters.push({ field: 'protocol', op: 'eq', value: opts.protocol });
  }
  if (opts.country) {
    filters.push({ field: 'country', op: 'eq', value: opts.country });
  }
  if (opts.asn) {
    filters.push({ field: 'asn', op: 'eq', value: Number(opts.asn) });
  }
  if (opts.status && opts.status !== 'all') {
    filters.push({ field: 'status', op: 'eq', value: opts.status });
  }
  if (opts.transport && opts.transport !== 'all') {
    filters.push({ field: 'transport', op: 'eq', value: opts.transport });
  }
  if (opts.security && opts.security !== 'all') {
    filters.push({ field: 'security', op: 'eq', value: opts.security });
  }
  if (opts.freshness && opts.freshness !== 'all') {
    filters.push({ field: 'freshness', op: 'eq', value: opts.freshness });
  }
  if (opts.favorite !== undefined) {
    filters.push({ field: 'favorite', op: 'eq', value: opts.favorite });
  }
  if (opts.minScore != null && opts.minScore > 0) {
    filters.push({ field: 'score', op: 'gte', value: opts.minScore });
  }
  if (opts.maxLatency != null && opts.maxLatency > 0) {
    filters.push({ field: 'medianProxyMs', op: 'lte', value: opts.maxLatency });
  }
  if (opts.minReliability != null && opts.minReliability > 0) {
    filters.push({ field: 'reliabilityPct', op: 'gte', value: opts.minReliability });
  }
  return filters;
}

function applyFilters(nodes: PublicNode[], filters: NodeFilter[]): PublicNode[] {
  if (filters.length === 0) return nodes;
  return nodes.filter((n) => {
    for (const f of filters) {
      let value: unknown;
      switch (f.field) {
        case 'protocol':
          value = n.protocol;
          break;
        case 'country':
          value = n.country;
          break;
        case 'asn':
          value = n.asn;
          break;
        case 'status':
          value = n.status;
          break;
        case 'transport':
          value = n.transport;
          break;
        case 'security':
          value = n.security;
          break;
        case 'tls':
          value = n.security === 'tls' || n.security === 'reality';
          break;
        case 'reality':
          value = n.security === 'reality';
          break;
        case 'ipv4':
          value = n.ipv4.length > 0;
          break;
        case 'ipv6':
          value = n.ipv6.length > 0;
          break;
        case 'sourceCount':
          value = n.sourceCount;
          break;
        case 'score':
          value = n.score;
          break;
        case 'medianProxyMs':
          value = n.medianProxyMs;
          break;
        case 'medianTcpMs':
          value = n.medianTcpMs;
          break;
        case 'medianTlsMs':
          value = n.medianTlsMs;
          break;
        case 'recentLossPct':
          value = n.recentLossPct;
          break;
        case 'reliabilityPct':
          value = n.reliabilityPct;
          break;
        case 'lastValidated':
          value = n.lastValidated;
          break;
        case 'favorite':
          value = n.favorite;
          break;
        case 'freshness':
          value = n.freshness;
          break;
        default:
          continue;
      }

      if (f.op === 'eq') {
        if (value !== f.value) return false;
      } else if (f.op === 'neq') {
        if (value === f.value) return false;
      } else if (f.op === 'gt') {
        if ((value as number) <= (f.value as number)) return false;
      } else if (f.op === 'gte') {
        if ((value as number) < (f.value as number)) return false;
      } else if (f.op === 'lt') {
        if ((value as number) >= (f.value as number)) return false;
      } else if (f.op === 'lte') {
        if ((value as number) > (f.value as number)) return false;
      } else if (f.op === 'contains' && typeof value === 'string') {
        if (!value.toLowerCase().includes(String(f.value).toLowerCase())) return false;
      }
    }
    return true;
  });
}

function applySort(nodes: PublicNode[], sort: NodeSort): PublicNode[] {
  const { field, dir } = sort;
  const multiplier = dir === 'asc' ? 1 : -1;

  return [...nodes].sort((a, b) => {
    let av: number | string | null = 0;
    let bv: number | string | null = 0;

    switch (field) {
      case 'proxyLatency':
        av = a.medianProxyMs ?? Infinity;
        bv = b.medianProxyMs ?? Infinity;
        break;
      case 'tcpLatency':
        av = a.medianTcpMs ?? Infinity;
        bv = b.medianTcpMs ?? Infinity;
        break;
      case 'tlsLatency':
        av = a.medianTlsMs ?? Infinity;
        bv = b.medianTlsMs ?? Infinity;
        break;
      case 'packetLoss':
        av = a.recentLossPct;
        bv = b.recentLossPct;
        break;
      case 'reliability':
        av = a.reliabilityPct;
        bv = b.reliabilityPct;
        break;
      case 'score':
        av = a.score;
        bv = b.score;
        break;
      case 'country':
        av = a.country ?? '';
        bv = b.country ?? '';
        break;
      case 'city':
        av = a.city ?? '';
        bv = b.city ?? '';
        break;
      case 'asn':
        av = a.asn ?? 0;
        bv = b.asn ?? 0;
        break;
      case 'isp':
        av = a.isp ?? '';
        bv = b.isp ?? '';
        break;
      case 'protocol':
        av = a.protocol;
        bv = b.protocol;
        break;
      case 'port':
        av = a.port;
        bv = b.port;
        break;
      case 'transport':
        av = a.transport;
        bv = b.transport;
        break;
      case 'tls':
        av = a.security;
        bv = b.security;
        break;
      case 'reality':
        av = a.security === 'reality' ? 1 : 0;
        bv = b.security === 'reality' ? 1 : 0;
        break;
      case 'ipv4':
        av = a.ipv4.length;
        bv = b.ipv4.length;
        break;
      case 'ipv6':
        av = a.ipv6.length;
        bv = b.ipv6.length;
        break;
      case 'source':
      case 'sourceCount':
        av = a.sourceCount;
        bv = b.sourceCount;
        break;
      case 'firstSeen':
        av = a.firstSeen;
        bv = b.firstSeen;
        break;
      case 'lastSeen':
        av = a.lastSeen;
        bv = b.lastSeen;
        break;
      case 'stability':
        av = a.reliabilityPct;
        bv = b.reliabilityPct;
        break;
      default:
        av = a.lastSeen;
        bv = b.lastSeen;
    }

    if (av == null && bv == null) return 0;
    if (av == null) return 1 * multiplier;
    if (bv == null) return -1 * multiplier;
    if (typeof av === 'string' && typeof bv === 'string') {
      return av.localeCompare(bv) * multiplier;
    }
    return ((av as number) - (bv as number)) * multiplier;
  });
}

export default function NodeExplorerPage() {
  const toast = useToast();
  const navigate = useNavigate();

  // State
  const [loading, setLoading] = useState(true);
  const [loadingError, setLoadingError] = useState<unknown>(null);
  const [stats, setStats] = useState<NodesStatsSummary | null>(null);
  const [engines, setEngines] = useState<ProxyEngineStatus | null>(null);

  const [nodes, setNodes] = useState<PublicNode[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = usePersistentState<number>('nodes.page', 0);
  const [pageSize] = useState(50);

  // Filters/Sort persist across tab switches — returning to the Explorer keeps
  // the user's working set instead of silently resetting to defaults.
  const [search, setSearch] = usePersistentState<string>('nodes.search', '');
  const [protocol, setProtocol] = usePersistentState<string>('nodes.protocol', 'all');
  const [status, setStatus] = usePersistentState<string>('nodes.status', 'all');
  const [transport, setTransport] = usePersistentState<string>('nodes.transport', 'all');
  const [security, setSecurity] = usePersistentState<string>('nodes.security', 'all');
  const [freshness, setFreshness] = usePersistentState<string>('nodes.freshness', 'all');
  const [sortField, setSortField] = usePersistentState<NodeSortField>('nodes.sortField', 'score');
  const [sortDir, setSortDir] = usePersistentState<NodeSortDir>('nodes.sortDir', 'desc');
  const [minScore] = useState<number | undefined>(undefined);
  const [maxLatency] = useState<number | undefined>(undefined);
  const [minReliability] = useState<number | undefined>(undefined);

  // Load stats + nodes from API
  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setLoadingError(null);

      const [statsRes, nodesRes, enginesRes] = await Promise.all([
        api.get<NodesStatsSummary>('/nodes/stats'),
        api.get<{ nodes: PublicNode[]; total: number }>(`/nodes?limit=${pageSize}&offset=${page * pageSize}${protocol === 'all' ? '' : `&protocol=${encodeURIComponent(protocol)}`}${status === 'all' ? '' : `&status=${encodeURIComponent(status)}`}${transport === 'all' ? '' : `&transport=${encodeURIComponent(transport)}`}${security === 'all' ? '' : `&security=${encodeURIComponent(security)}`}${freshness === 'all' ? '' : `&freshness=${encodeURIComponent(freshness)}`}${search ? `&search=${encodeURIComponent(search)}` : ''}${minScore ? `&minScore=${minScore}` : ''}${maxLatency ? `&maxLatency=${maxLatency}` : ''}${minReliability ? `&minReliability=${minReliability}` : ''}${sortField ? `&sortField=${sortField}` : ''}${sortDir ? `&sortDir=${sortDir}` : ''}`),
        api.get<ProxyEngineStatus>('/nodes/engines').catch(() => null),
      ]);

      setStats(statsRes);
      setNodes(nodesRes.nodes || []);
      setTotal(nodesRes.total || 0);
      setEngines(enginesRes);
    } catch (err) {
      setLoadingError(err);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, protocol, status, transport, security, freshness, search, sortField, sortDir, minScore, maxLatency, minReliability]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Rebuild filters when filters change
  const filters = useMemo(() => buildFilters({
    protocol,
    status,
    transport,
    security,
    freshness,
    search,
    minScore,
    maxLatency,
    minReliability,
  }), [protocol, status, transport, security, freshness, search, minScore, maxLatency, minReliability]);

  // Apply filters client-side
  const filteredNodes = useMemo(() => {
    let result = nodes;
    if (filters.length > 0) {
      result = applyFilters(result, filters);
    }
    return applySort(result, { field: sortField, dir: sortDir });
  }, [nodes, filters, sortField, sortDir]);

  const displayedNodes = filteredNodes.slice(page * pageSize, (page + 1) * pageSize);
  const totalPages = Math.max(1, Math.ceil(filteredNodes.length / pageSize));

  const handleTestNode = useCallback(async (nodeId: string, type: 'tcp' | 'tls' | 'proxy' | 'icmp' = 'tcp') => {
    try {
      const result = await api.post<NodeTestResult>(`/nodes/${nodeId}/test`, { type });
      toast('ok', `Tested ${nodeId}`, `Latency: ${result.latencyMs?.toFixed(1)} ms`);
    } catch (err) {
      toast('error', 'Test failed', err instanceof Error ? err.message : undefined);
    }
  }, [toast]);

  const handleFavorite = useCallback(async (nodeId: string, favorite: boolean) => {
    try {
      await api.post(`/nodes/${nodeId}/favorite`, { favorite });
      loadData();
    } catch (err) {
      toast('error', 'Failed to update favorite', err instanceof Error ? err.message : undefined);
    }
  }, [loadData, toast]);

  // Per-row geo re-check (same endpoint + outcome-honest toasts as the detail
  // page, so the action works without navigating away from the list). Only the
  // re-checked row refreshes — swapping the whole table on every lookup would
  // reset scroll position and in-flight row states.
  const [geoCheckingId, setGeoCheckingId] = useState<string | null>(null);
  const handleGeoRecheck = useCallback(async (nodeId: string) => {
    if (geoCheckingId) return;
    setGeoCheckingId(nodeId);
    try {
      const res = await api.post<{ result: { outcome: string; reason: string }; node: PublicNode | null }>(`/nodes/${nodeId}/geo-recheck`, {});
      if (res.node) {
        setNodes((prev) => prev.map((n) => (n.id === nodeId ? res.node! : n)));
      }
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
      setGeoCheckingId(null);
    }
  }, [geoCheckingId, toast]);

  const handleExport = useCallback(async (format: 'uri' | 'plaintext' | 'base64' | 'json' | 'clash' | 'singbox') => {
    try {
      const nodeIds = filteredNodes.map((n) => n.id).join(',');
      const result = await api.get<string>(`/nodes/export?nodeIds=${encodeURIComponent(nodeIds)}&format=${format}`);

      const blob = new Blob([result], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `nodes-${format}-${Date.now()}.txt`;
      a.click();
      URL.revokeObjectURL(url);
      toast('ok', 'Exported', `${format} — ${filteredNodes.length} nodes`);
    } catch (err) {
      toast('error', 'Export failed', err instanceof Error ? err.message : undefined);
    }
  }, [filteredNodes, toast]);

  const handleRefresh = useCallback(() => {
    setPage(0);
    void loadData();
  }, [loadData]);

  if (loading) {
    return <LoadingState label="Loading nodes..." />;
  }
  if (loadingError) {
    return <ErrorState error={loadingError} retry={loadData} />;
  }

  return (
    <div className="min-h-screen bg-base text-foreground">
<CardHeader title="Node Explorer" subtitle={`${stats?.total ?? '—'} public configs discovered · ${stats?.healthy ?? '—'} healthy · ${stats?.favoriteCount ?? '—'} favorited`} />

      {/* Proxy core engines — honest availability for proxy tests */}
      {engines && (
        <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-muted">
          <span className="font-medium">Proxy cores:</span>
          {engines.engines.map((e) => (
            <span
              key={e.id}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full ${e.available ? 'bg-status-ok/10 text-status-ok' : 'bg-gray-500/10 text-gray-400'}`}
              title={e.available ? `${e.label} at ${e.path}` : `${e.label} not installed`}
            >
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${e.available ? 'bg-status-ok' : 'bg-gray-500'}`} />
              {e.label}
            </span>
          ))}
          <span className="text-gray-500">
            {engines.effective
              ? `proxy tests will use ${engines.effective === 'xray' ? 'Xray-core' : 'sing-box'}${engines.preferred !== 'auto' ? ` (preferred: ${engines.preferred})` : ''}`
              : 'install xray or sing-box to enable proxy tests'}
          </span>
        </div>
      )}

      {/* Stats cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 px-6 py-4">
        <Card>
          <CardBody>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded bg-status-ok/10">
                <Wifi size={20} className="text-status-ok" />
              </div>
              <div>
                <p className="text-2xl font-bold">{stats?.total ?? 0}</p>
                <p className="text-xs text-muted">Total nodes</p>
              </div>
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded bg-status-warn/10">
                <ShieldCheck size={20} className="text-status-warn" />
              </div>
              <div>
                <p className="text-2xl font-bold">{stats?.healthy ?? 0}</p>
                <p className="text-xs text-muted">Healthy</p>
              </div>
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded bg-amber-500/10">
                <Clock size={20} className="text-amber-500" />
              </div>
              <div>
                <p className="text-2xl font-bold">{stats?.stale ?? 0}</p>
                <p className="text-xs text-muted">Stale</p>
              </div>
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <div className="flex items-center gap-3">
              <div className="p-2 rounded bg-blue-500/10">
                <Star size={20} className="text-blue-400" />
              </div>
              <div>
                <p className="text-2xl font-bold">{stats?.favoriteCount ?? 0}</p>
                <p className="text-xs text-muted">Favorited</p>
              </div>
            </div>
          </CardBody>
        </Card>
      </div>

      {/* Filters */}
      <Card className="px-6 py-4">
        <CardBody>
          <div className="flex flex-wrap gap-3 items-end">
            <div className="flex-1 min-w-[200px]">
              <Field label="Search">
                <div className="relative">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                    placeholder="IP, hostname, fingerprint, ASN..."
                    className="w-full pl-8 pr-3 py-2 bg-base-200 border-none rounded-md text-sm placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
              </Field>
            </div>

            <div className="flex flex-wrap gap-2">
              <Field label="Protocol">
                <select
                  value={protocol}
                  onChange={(e) => { setProtocol(e.target.value); setPage(0); }}
                  className="bg-base-200 border-none rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  {PROTOCOL_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </Field>

              <Field label="Status">
                <select
                  value={status}
                  onChange={(e) => { setStatus(e.target.value); setPage(0); }}
                  className="bg-base-200 border-none rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  {STATUS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </Field>

              <Field label="Transport">
                <select
                  value={transport}
                  onChange={(e) => { setTransport(e.target.value); setPage(0); }}
                  className="bg-base-200 border-none rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  {TRANSPORT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </Field>

              <Field label="Security">
                <select
                  value={security}
                  onChange={(e) => { setSecurity(e.target.value); setPage(0); }}
                  className="bg-base-200 border-none rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  {SECURITY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </Field>

              <Field label="Freshness">
                <select
                  value={freshness}
                  onChange={(e) => { setFreshness(e.target.value); setPage(0); }}
                  className="bg-base-200 border-none rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  {FRESHNESS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </Field>

              <Field label="Sort">
                <select
                  value={sortField}
                  onChange={(e) => {
                    const field = e.target.value as NodeSortField;
                    setSortField(field);
                    // Toggle direction if same field
                    if (field === sortField) {
                      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
                    } else {
                      const opt = SORT_OPTIONS.find((o) => o.value === field);
                      setSortDir(opt?.defaultDir || 'desc');
                    }
                    setPage(0);
                  }}
                  className="bg-base-200 border-none rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  {SORT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </Field>

              <Button variant="ghost" size="sm" onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}>
                <ArrowUpDown size={14} className={`transition-transform ${sortDir === 'asc' ? 'rotate-180' : ''}`} />
              </Button>
            </div>

            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => handleExport('uri')}>
                <Download size={14} />
                Export
              </Button>
              <Button variant="secondary" size="sm" onClick={handleRefresh}>
                <RefreshCw size={14} />
                Refresh
              </Button>
            </div>
          </div>
        </CardBody>
      </Card>

      {/* Nodes table */}
      <Card className="px-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-base-300">
                <th className="text-left py-3 px-4 w-10"></th>
                <th className="text-left py-3 px-4">Host</th>
                <th className="text-left py-3 px-4">Protocol</th>
                <th className="text-left py-3 px-4">Port</th>
                <th className="text-left py-3 px-4">Transport</th>
                <th className="text-left py-3 px-4">Security</th>
                <th className="text-left py-3 px-4">Country</th>
                <th className="text-left py-3 px-4">Score</th>
                <th className="text-left py-3 px-4">Proxy</th>
                <th className="text-left py-3 px-4">Runtime</th>
                <th className="text-left py-3 px-4">TCP</th>
                <th className="text-left py-3 px-4">Loss</th>
                <th className="text-left py-3 px-4">Reliability</th>
                <th className="text-left py-3 px-4">Sources</th>
                <th className="text-left py-3 px-4">Freshness</th>
                <th className="text-right py-3 px-4"></th>
              </tr>
            </thead>
            <tbody>
              {displayedNodes.map((node, idx) => (
                <tr
                  key={node.id}
                  className="border-b border-base-200 hover:bg-base-200/50 transition-colors"
                  style={{ animationDelay: `${idx * 30}ms` }}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <StatusIcon status={node.status} />
                      <span className="text-xs text-muted capitalize">{node.status}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col">
                      <span className="font-mono text-xs break-all">{node.host}</span>
                      {node.ipv4.length > 0 && (
                        <span className="text-[10px] text-muted font-mono">{node.ipv4[0]}</span>
                      )}
                      {node.remark && (
                        <span className="text-[10px] text-muted truncate max-w-[200px]">{node.remark}</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <ProtocolBadge protocol={node.protocol} />
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">{node.port}</td>
                  <td className="px-4 py-3">
                    <span className="text-xs text-muted">{node.transport}</span>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={node.security === 'reality' ? 'accent' : node.security === 'tls' ? 'ok' : 'neutral'}>
                      {node.security}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    {node.country ? (
                      <div className="flex items-center gap-1.5">
                        <Flag size={12} className="text-muted" />
                        <span className="text-xs">{node.country}</span>
                        {node.city && <span className="text-[10px] text-muted">{node.city}</span>}
                      </div>
                    ) : (
                      // Refused / unresolved geo: show WHY instead of a bare
                      // dash that reads as missing data.
                      <GeoStatusBadge reason={geoReasonOf(node.geoStatusReason, node.lat != null)} />
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <TrendingUp size={12} className="text-muted" />
                      <span className="font-mono text-xs">{node.score.toFixed(0)}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {node.medianProxyMs != null ? fmtMs(node.medianProxyMs) : '—'}
                  </td>
                  <td className="px-4 py-3">
                    {node.lastEngine ? (
                      <EngineBadge engine={node.lastEngine} />
                    ) : (
                      <span className="text-xs text-muted" title="Never proxy-tested — no engine has run against this node">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {node.medianTcpMs != null ? fmtMs(node.medianTcpMs) : '—'}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {node.recentLossPct > 0 ? fmtPct(node.recentLossPct) : '0%'}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {fmtPct(node.reliabilityPct)}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    <span className="text-muted">{node.sourceCount}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1.5">
                      <FreshnessDot freshness={node.freshness} />
                      <span className="text-xs text-muted capitalize">{node.freshness}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-1">
                      {node.favorite ? (
                        <Star size={14} className="text-yellow-400 fill-yellow-400" />
                      ) : (
                        <Star size={14} className="text-muted hover:text-yellow-400 cursor-pointer" onClick={() => handleFavorite(node.id, true)} />
                      )}
                      <button
                        className="text-muted hover:text-status-ok"
                        onClick={() => handleTestNode(node.id, 'tcp')}
                        title="Test TCP"
                      >
                        <Wifi size={14} />
                      </button>
                      <button
                        className="text-muted hover:text-accent disabled:opacity-40 disabled:cursor-not-allowed"
                        onClick={() => void handleGeoRecheck(node.id)}
                        disabled={geoCheckingId != null}
                        title={node.country || node.lat != null ? 'Re-check location (fresh GeoIP lookup)' : 'Look up location now'}
                      >
                        {geoCheckingId === node.id
                          ? <RefreshCw size={14} className="animate-spin" />
                          : <LocateFixed size={14} />}
                      </button>
                      <a
                        href={`/nodes/${node.id}`}
                        className="text-muted hover:text-status-warn"
                        onClick={(e) => {
                          e.preventDefault();
                          navigate(`/nodes/${node.id}`);
                        }}
                        title="View details"
                      >
                        <ChevronRight size={14} />
                      </a>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {displayedNodes.length === 0 && !loading && (
          <div className="p-8 text-center">
            <EmptyState
              title="No nodes found"
              message="Try adjusting your filters or search terms."
              action={
                <Button variant="ghost" onClick={() => {
                  setProtocol('all');
                  setStatus('all');
                  setTransport('all');
                  setSecurity('all');
                  setFreshness('all');
                  setSearch('');
                  setPage(0);
                  void loadData();
                }}>
                  Clear filters
                </Button>
              }
            />
          </div>
        )}
      </Card>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-6 py-4">
          <p className="text-xs text-muted">
            Showing {(page * pageSize) + 1}–{Math.min((page + 1) * pageSize, total)} of {total} nodes
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              Previous
            </Button>
            <span className="text-xs text-muted">Page {page + 1} of {totalPages}</span>
            <Button
              variant="ghost"
              size="sm"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
