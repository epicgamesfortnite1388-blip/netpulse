import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowUpDown,
  ChevronRight,
  Clock,
  Cpu,
  
  Flag,
  Globe2,
  Info,
  
  LocateFixed,
  RefreshCw,
  Search,
  Shield,
  ShieldCheck,
  ShieldX,
  SlidersHorizontal,
  Star,
  TrendingUp,
  Wifi,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DisclosureScope, DisclosureToolbar, FoldNote } from '@/components/ui/Disclosure';
import { NodesNav } from '@/features/nodes/NodesChrome';
import { EngineBadge as SharedEngineBadge, ENGINE_LABELS } from '@/components/EngineBadge';
import { Field } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { Segmented } from '@/components/ui/Segmented';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/States';
import { MiniMetric, Section, StatTile } from '@/components/ui/Surface';
import { useToast } from '@/components/Toaster';
import { api } from '@/lib/api';
import { fmtMs, fmtPct } from '@/lib/format';
import { useNodeActions } from '@/features/nodes/useNodeActions';
import { engineInstallErrorMessage, engineInstallMessage } from '@/features/nodes/nodeActionPolicy';
import type { EngineInstallResult } from '@/features/nodes/nodeActionPolicy';
import { GeoStatusBadge, geoReasonOf } from '@/lib/geoStatus';
import { usePersistentState } from '@/lib/usePersistentState';

import { canBecomeEngineProfile } from '@netpulse/shared';

import type {
  NodeProtocol,
  NodeSortDir,
  NodeSortField,
  NodeStatus,
  NodeView,
  ProxyEngineStatus,
} from '@netpulse/shared';

/**
 * Node Explorer — the public-node database, split by which local core last
 * tested a node.
 *
 * The previous version rendered a 16-column table inside a page whose wrapper
 * used theme tokens that do not exist (`bg-base`, `text-foreground`,
 * `text-status-ok`, …), so most of it silently rendered unstyled. It also
 * re-derived paging from the rows on screen. Here the server owns filtering,
 * sorting and paging through react-query keys, and every class maps to a real
 * design token.
 *
 * The runtime tabs are a filter, not a view switch, so the list is rendered
 * once beneath a segmented control instead of once per tab.
 */

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

interface NodeListResponse {
  nodes: NodeView[];
  total: number;
  limit: number;
  offset: number;
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

/** Runtime filter values the API accepts (matches `public_nodes.last_engine`). */
type RuntimeTab = 'all' | 'xray' | 'sing-box' | 'v2ray';

const RUNTIME_TABS: { value: RuntimeTab; label: string }[] = [
  { value: 'all', label: 'All runtimes' },
  { value: 'xray', label: 'Xray' },
  { value: 'sing-box', label: 'sing-box' },
  { value: 'v2ray', label: 'V2Ray' },
];

const SORT_OPTIONS: { value: NodeSortField; label: string; defaultDir: NodeSortDir }[] = [
  { value: 'score', label: 'Score', defaultDir: 'desc' },
  { value: 'proxyLatency', label: 'Proxy latency', defaultDir: 'asc' },
  { value: 'tcpLatency', label: 'TCP latency', defaultDir: 'asc' },
  { value: 'tlsLatency', label: 'TLS latency', defaultDir: 'asc' },
  { value: 'packetLoss', label: 'Packet loss', defaultDir: 'asc' },
  { value: 'reliability', label: 'Reliability', defaultDir: 'desc' },
  { value: 'country', label: 'Country', defaultDir: 'asc' },
  { value: 'engine', label: 'Runtime', defaultDir: 'asc' },
  { value: 'protocol', label: 'Protocol', defaultDir: 'asc' },
  { value: 'sourceCount', label: 'Source count', defaultDir: 'desc' },
  { value: 'lastSeen', label: 'Last seen', defaultDir: 'desc' },
];

/** Status glyph. Tones map to real tokens (the old `text-status-*` did not exist). */
function StatusGlyph({ status }: { status: NodeStatus | string }) {
  const base = 'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-2';
  switch (status) {
    case 'healthy':
    case 'proxy-tested':
      return <span className={base}><ShieldCheck size={15} className="text-ok" /></span>;
    case 'degraded':
    case 'tcp-tested':
      return <span className={base}><Shield size={15} className="text-warn" /></span>;
    case 'failed':
      return <span className={base}><ShieldX size={15} className="text-danger" /></span>;
    case 'stale':
      return <span className={base}><Clock size={15} className="text-warn" /></span>;
    case 'discovered':
    case 'parsed':
    case 'validated':
      return <span className={base}><Info size={15} className="text-muted" /></span>;
    default:
      return <span className={base}><Globe2 size={15} className="text-muted" /></span>;
  }
}

const PROTOCOL_STYLES: Record<string, string> = {
  vless: 'text-proto-sky bg-sky-500/10 border-sky-500/25',
  vmess: 'text-proto-violet bg-violet-500/10 border-violet-500/25',
  trojan: 'text-proto-orange bg-orange-500/10 border-orange-500/25',
  shadowsocks: 'text-proto-emerald bg-emerald-500/10 border-emerald-500/25',
  shadowsocksr: 'text-proto-emerald bg-emerald-500/10 border-emerald-500/25',
  hysteria2: 'text-proto-cyan bg-cyan-500/10 border-cyan-500/25',
  tuic: 'text-proto-indigo bg-indigo-500/10 border-indigo-500/25',
  wireguard: 'text-proto-amber bg-amber-500/10 border-amber-500/25',
  unknown: 'text-muted bg-surface-2 border-line',
};

function ProtocolBadge({ protocol }: { protocol: NodeProtocol }) {
  const style = PROTOCOL_STYLES[protocol] ?? PROTOCOL_STYLES['unknown'];
  return (
    <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-micro font-medium ${style}`}>
      {protocol.toUpperCase()}
    </span>
  );
}

function FreshnessDot({ freshness }: { freshness: string }) {
  const tone =
    freshness === 'fresh' ? 'bg-ok' : freshness === 'recent' ? 'bg-warn' : freshness === 'aging' ? 'bg-warn/60' : 'bg-faint';
  return <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${tone}`} title={freshness} />;
}

export default function NodeExplorerPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const [page, setPage] = usePersistentState<number>('nodes.page', 0);
  const [pageSize] = useState(50);

  // Filters/sort persist across tab switches — returning to the Explorer keeps
  // the user's working set instead of silently resetting to defaults.
  const [search, setSearch] = usePersistentState<string>('nodes.search', '');
  const [protocol, setProtocol] = usePersistentState<string>('nodes.protocol', 'all');
  const [status, setStatus] = usePersistentState<string>('nodes.status', 'all');
  const [transport, setTransport] = usePersistentState<string>('nodes.transport', 'all');
  const [security, setSecurity] = usePersistentState<string>('nodes.security', 'all');
  const [freshness, setFreshness] = usePersistentState<string>('nodes.freshness', 'all');
  const [runtime, setRuntime] = usePersistentState<RuntimeTab>('nodes.engine', 'all');
  const [sortField, setSortField] = usePersistentState<NodeSortField>('nodes.sortField', 'score');
  const [sortDir, setSortDir] = usePersistentState<NodeSortDir>('nodes.sortDir', 'desc');
  const [showFilters, setShowFilters] = usePersistentState<boolean>('nodes.showFilters', false);

  const [installingEngine, setInstallingEngine] = useState<string | null>(null);

  // Server-side filtering/sorting/paging — the query key IS the filter set, so
  // a cached page is reused until a filter actually changes. Memoized so the
  // callbacks that patch the cached page keep stable identities.
  const listKey = useMemo(
    () =>
      [
        'nodes',
        'list',
        { page, pageSize, protocol, status, transport, security, freshness, engine: runtime, search, sortField, sortDir },
      ] as const,
    [page, pageSize, protocol, status, transport, security, freshness, runtime, search, sortField, sortDir],
  );

  const statsQuery = useQuery({
    queryKey: ['nodes', 'stats'],
    queryFn: () => api.get<NodesStatsSummary>('/nodes/stats'),
    staleTime: 15_000,
  });

  const enginesQuery = useQuery({
    queryKey: ['nodes', 'engines'],
    queryFn: () => api.get<ProxyEngineStatus>('/nodes/engines'),
    staleTime: 60_000,
  });

  const listQuery = useQuery({
    queryKey: listKey,
    queryFn: () => {
      const params = new URLSearchParams();
      params.set('limit', String(pageSize));
      params.set('offset', String(page * pageSize));
      if (protocol !== 'all') params.set('protocol', protocol);
      if (status !== 'all') params.set('status', status);
      if (transport !== 'all') params.set('transport', transport);
      if (security !== 'all') params.set('security', security);
      if (freshness !== 'all') params.set('freshness', freshness);
      if (runtime !== 'all') params.set('engine', runtime);
      if (search.trim()) params.set('search', search.trim());
      params.set('sortField', sortField);
      params.set('sortDir', sortDir);
      return api.get<NodeListResponse>(`/nodes?${params.toString()}`);
    },
    // Keep the previous page on screen while the next one loads — paging must
    // not blank the table.
    placeholderData: keepPreviousData,
  });

  const nodes = useMemo(() => listQuery.data?.nodes ?? [], [listQuery.data]);
  const total = listQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const stats = statsQuery.data;
  const engines = enginesQuery.data;

  const activeFilterCount = [
    protocol !== 'all',
    status !== 'all',
    transport !== 'all',
    security !== 'all',
    freshness !== 'all',
    runtime !== 'all',
    search.trim().length > 0,
  ].filter(Boolean).length;

  const patchNode = useCallback(
    (node: NodeView) => {
      qc.setQueryData<NodeListResponse | undefined>(listKey, (prev) =>
        prev ? { ...prev, nodes: prev.nodes.map((n) => (n.id === node.id ? node : n)) } : prev,
      );
    },
    [qc, listKey],
  );

  // Every per-row action (test, geo re-check, favorite, copy link, export) comes
  // from one hook: it owns the in-flight state and the outcome wording, so a row
  // cannot describe the same refusal differently from the detail page. The only
  // page-specific behaviour is `onChanged` — the re-checked row is patched in
  // place so scroll position and other rows' spinners survive, while a list
  // refetch would replace the page under the user.
  const actions = useNodeActions<NodeView>({
    onChanged: (node) => {
      if (node) patchNode(node);
    },
  });

  const handleRefresh = useCallback(() => {
    setPage(0);
    void qc.invalidateQueries({ queryKey: ['nodes'] });
  }, [qc, setPage]);

  const clearFilters = useCallback(() => {
    setProtocol('all');
    setStatus('all');
    setTransport('all');
    setSecurity('all');
    setFreshness('all');
    setRuntime('all');
    setSearch('');
    setPage(0);
  }, [setFreshness, setPage, setProtocol, setSearch, setSecurity, setStatus, setTransport, setRuntime]);

  // Engine install/update: the backend downloads from the official release,
  // verifies the published SHA256 digest, and validates the binary with a real
  // `version` spawn before reporting success.
  const handleEngineInstall = useCallback(
    async (engineId: string) => {
      if (installingEngine) return;
      setInstallingEngine(engineId);
      try {
        const r = await api.post<EngineInstallResult>('/nodes/engines/install', { engine: engineId });
        const m = engineInstallMessage(r);
        toast(m.tone, m.title, m.body);
      } catch (err) {
        const m = engineInstallErrorMessage(err);
        toast(m.tone, m.title, m.body);
      } finally {
        setInstallingEngine(null);
        void qc.invalidateQueries({ queryKey: ['nodes'] });
      }
    },
    [installingEngine, qc, toast],
  );

  if (listQuery.isLoading) return <LoadingState label="Loading nodes…" />;
  if (listQuery.isError) return <ErrorState error={listQuery.error} retry={() => void listQuery.refetch()} />;

  return (
    <DisclosureScope name="nodes:explorer" className="stagger animate-fade-up">
      <PageHeader
        title="Node Explorer"
        description={`Public proxy configs discovered from subscription sources, each attributable to the local core that last tested it.${
          stats ? ` ${stats.total} stored · ${stats.healthy} healthy · ${stats.degraded} degraded · ${stats.failed} failed.` : ''
        }`}
        actions={
          <>
            <Button variant="secondary" onClick={handleRefresh} loading={listQuery.isFetching}>
              <RefreshCw size={13} />
              Refresh
            </Button>
          </>
        }
      />

      <NodesNav />
      <DisclosureToolbar className="mb-2" />

      <div className="mb-5 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Total nodes" value={stats?.total ?? '—'} hint="stored in the database" />
        <StatTile
          label="Healthy"
          value={stats?.healthy ?? '—'}
          tone={stats && stats.healthy > 0 ? 'ok' : 'faint'}
          hint={stats ? `${stats.discovered} never tested` : undefined}
        />
        <StatTile
          label="Stale"
          value={stats?.stale ?? '—'}
          tone={stats && stats.stale > 0 ? 'warn' : 'faint'}
          hint="not seen in over 24h"
        />
        <StatTile label="Favorited" value={stats?.favoriteCount ?? '—'} hint="pinned by you" />
      </div>

      {/* Proxy cores — honest availability, and the only place they get installed.
          Folded by default: it is reference material for what is otherwise a
          browsing page, and the folded header still reports the real counts. */}
      <Section
        title="Proxy cores"
        icon={<Cpu size={15} />}
        subtitle="Local cores that test nodes and carry the proxy tunnel"
        collapsible
        defaultOpen={false}
        id="proxy-cores"
        summary={
          engines
            ? `${(engines.engines ?? []).filter((e) => e.available).length} of ${(engines.engines ?? []).length} installed${
                engines.effective ? ` · proxy tests use ${ENGINE_LABELS[engines.effective]}` : ''
              }`
            : 'checking which local cores are installed'
        }
        badge={
          engines ? (
            <Badge tone={engines.effective ? 'ok' : 'warn'}>{engines.effective ? 'ready' : 'none installed'}</Badge>
          ) : null
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          {(engines?.engines ?? []).map((e) => (
            <span
              key={e.id}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                e.available ? 'border-ok/30 bg-ok/10 text-ok' : 'border-line bg-surface-2 text-muted'
              }`}
              title={e.available ? `${e.label} at ${e.path ?? 'unknown path'}` : `${e.label} not installed`}
            >
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${e.available ? 'bg-ok' : 'bg-faint'}`} />
              {e.label}
              <button
                type="button"
                className="underline decoration-dotted underline-offset-2 hover:text-text disabled:opacity-50"
                title={`${e.available ? 'Reinstall / update' : 'Install'} ${e.label} from its official release (checksum-verified)`}
                onClick={() => void handleEngineInstall(e.id)}
                disabled={installingEngine !== null}
              >
                {installingEngine === e.id ? 'installing…' : e.available ? 'update' : 'install'}
              </button>
            </span>
          ))}
          <span className="text-xs text-faint">
            {engines?.effective
              ? `Proxy tests will use ${ENGINE_LABELS[engines.effective]}${engines.preferred !== 'auto' ? ` (preferred: ${engines.preferred})` : ''}`
              : 'Install xray, sing-box or v2ray to enable proxy tests'}
          </span>
        </div>
      </Section>

      {/* Runtime division — the engine filter, whose counts come from the API. */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented<RuntimeTab>
          ariaLabel="Filter nodes by the local core that last tested them"
          value={runtime}
          onChange={(v) => {
            setRuntime(v);
            setPage(0);
          }}
          items={RUNTIME_TABS}
        />
        <Button variant="ghost" onClick={() => setShowFilters((v) => !v)}>
          <SlidersHorizontal size={13} />
          Filters
          {activeFilterCount > 0 && <Badge tone="accent">{activeFilterCount}</Badge>}
        </Button>
      </div>

      {showFilters && (
        <Section
          title="Filters"
          subtitle="Applied by the server — the counts below are real row counts, not the rows on screen"
          actions={
            activeFilterCount > 0 ? (
              <Button variant="ghost" onClick={clearFilters}>
                Clear all
              </Button>
            ) : null
          }
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Search">
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(0);
                  }}
                  placeholder="IP, hostname, fingerprint, ASN…"
                  className="h-9 w-full rounded-lg border border-line bg-surface-2 pl-8 pr-3 text-sm text-text placeholder:text-faint focus:border-accent/80 focus:outline-none"
                />
              </div>
            </Field>
            <Field label="Protocol">
              <select
                value={protocol}
                onChange={(e) => {
                  setProtocol(e.target.value);
                  setPage(0);
                }}
                className="h-9 w-full rounded-lg border border-line bg-surface-2 px-2 text-sm text-text focus:border-accent/80 focus:outline-none"
              >
                {PROTOCOL_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Status">
              <select
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value);
                  setPage(0);
                }}
                className="h-9 w-full rounded-lg border border-line bg-surface-2 px-2 text-sm text-text focus:border-accent/80 focus:outline-none"
              >
                {STATUS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Transport">
              <select
                value={transport}
                onChange={(e) => {
                  setTransport(e.target.value);
                  setPage(0);
                }}
                className="h-9 w-full rounded-lg border border-line bg-surface-2 px-2 text-sm text-text focus:border-accent/80 focus:outline-none"
              >
                {TRANSPORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Security">
              <select
                value={security}
                onChange={(e) => {
                  setSecurity(e.target.value);
                  setPage(0);
                }}
                className="h-9 w-full rounded-lg border border-line bg-surface-2 px-2 text-sm text-text focus:border-accent/80 focus:outline-none"
              >
                {SECURITY_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Freshness">
              <select
                value={freshness}
                onChange={(e) => {
                  setFreshness(e.target.value);
                  setPage(0);
                }}
                className="h-9 w-full rounded-lg border border-line bg-surface-2 px-2 text-sm text-text focus:border-accent/80 focus:outline-none"
              >
                {FRESHNESS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Sort by">
              <select
                value={sortField}
                onChange={(e) => {
                  const field = e.target.value as NodeSortField;
                  setSortField(field);
                  const opt = SORT_OPTIONS.find((o) => o.value === field);
                  setSortDir(opt?.defaultDir ?? 'desc');
                  setPage(0);
                }}
                className="h-9 w-full rounded-lg border border-line bg-surface-2 px-2 text-sm text-text focus:border-accent/80 focus:outline-none"
              >
                {SORT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Direction" hint="Runtime grouping always reads xray → sing-box → v2ray → untested">
              <Button variant="secondary" onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}>
                <ArrowUpDown size={13} className={`transition-transform ${sortDir === 'asc' ? 'rotate-180' : ''}`} />
                {sortDir === 'asc' ? 'Ascending' : 'Descending'}
              </Button>
            </Field>
          </div>
        </Section>
      )}

      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold tracking-tight">Nodes</h3>
        <span className="text-xs text-faint">
          {total === 0 ? 'no matches' : `showing ${page * pageSize + 1}–${Math.min((page + 1) * pageSize, total)} of ${total}`}
        </span>
      </div>

      {nodes.length === 0 ? (
        <EmptyState
          title="No nodes found"
          message={
            activeFilterCount > 0
              ? 'No node matches the current filters. Clear them to see the whole database.'
              : 'Import a subscription source on the Node Sources page to populate the database.'
          }
          action={activeFilterCount > 0 ? <Button variant="ghost" onClick={clearFilters}>Clear filters</Button> : undefined}
        />
      ) : (
        <div className="space-y-2.5">
          {nodes.map((node) => (
            <div
              key={node.id}
              className="rounded-xl border border-line bg-surface p-3.5 transition-colors hover:border-line-strong"
            >
              <div className="flex items-start gap-3">
                <StatusGlyph status={node.status} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <span className="break-all text-sm text-text">{node.label}</span>
                    <ProtocolBadge protocol={node.protocol} />
                    <Badge tone={node.security === 'reality' ? 'accent' : node.security === 'tls' ? 'ok' : 'neutral'}>{node.security}</Badge>
                    <span className="text-xs text-faint">{node.transport}</span>
                    {node.favorite && <Star size={12} className="fill-warn text-warn" />}
                  </div>

                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-faint">
                    {node.country ? (
                      <span className="flex items-center gap-1">
                        <Flag size={11} />
                        {node.country}
                        {node.city ? ` · ${node.city}` : ''}
                      </span>
                    ) : (
                      // Refused / unresolved geo: show WHY instead of a bare dash.
                      <GeoStatusBadge reason={geoReasonOf(node.geoStatusReason, node.lat != null)} />
                    )}
                    <span className="flex items-center gap-1.5">
                      <FreshnessDot freshness={node.freshness} />
                      {node.freshness}
                    </span>
                    <span className="capitalize">{node.status}</span>
                    {/* `label` above already shows the remark when it is safe to
                        show; this chip only adds value when the two differ (i.e.
                        the server withheld an address-shaped remark). Showing it
                        unconditionally would repeat the title. */}
                    {node.remark && node.remark !== node.label && (
                      <span className="max-w-[280px] truncate">{node.remark}</span>
                    )}
                  </div>

                  {/* Six across only fits once the labels are legible: at 1024px a
                      six-up grid leaves ~90px per cell and the uppercase
                      labels overflowed it (150 boxes clipped). Three across
                      from sm, six from xl. */}
                    <div className="mt-2.5 grid grid-cols-2 gap-1.5 sm:grid-cols-3 xl:grid-cols-6">
                    <MiniMetric label="Score" value={node.score.toFixed(0)} />
                    <MiniMetric label="Proxy" value={node.medianProxyMs != null ? fmtMs(node.medianProxyMs) : '—'} />
                    <MiniMetric label="TCP" value={node.medianTcpMs != null ? fmtMs(node.medianTcpMs) : '—'} />
                    <MiniMetric label="Loss" value={node.recentLossPct > 0 ? fmtPct(node.recentLossPct) : '0%'} />
                    <MiniMetric label="Reliability" value={fmtPct(node.reliabilityPct)} />
                    <MiniMetric label="Sources" value={String(node.sourceCount)} />
                  </div>
                </div>

                <div className="flex shrink-0 flex-col items-end gap-2">
                  {node.lastEngine ? (
                    <SharedEngineBadge
                      engine={node.lastEngine}
                      title={`Last proxy test ran through the ${ENGINE_LABELS[node.lastEngine]} runtime`}
                    />
                  ) : (
                    <span className="text-micro text-faint" title="Never proxy-tested — no engine has run against this node">
                      never tested
                    </span>
                  )}
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="rounded-md p-1.5 text-faint transition-colors hover:bg-surface-2 hover:text-warn"
                      title={node.favorite ? 'Remove from favorites' : 'Add to favorites'}
                      aria-label={node.favorite ? 'Remove from favorites' : 'Add to favorites'}
                      onClick={() => void actions.toggleFavorite(node)}
                    >
                      <Star size={14} className={node.favorite ? 'fill-warn text-warn' : ''} />
                    </button>
                    <button
                      type="button"
                      className="rounded-md p-1.5 text-faint transition-colors hover:bg-surface-2 hover:text-ok disabled:opacity-40"
                      title="Test TCP"
                      aria-label="Test TCP"
                      disabled={actions.anyBusy}
                      onClick={() => void actions.test(node.id, 'tcp')}
                    >
                      {actions.busy(node.id, 'test') ? <RefreshCw size={14} className="animate-spin" /> : <Wifi size={14} />}
                    </button>
                    <button
                      type="button"
                      className="rounded-md p-1.5 text-faint transition-colors hover:bg-surface-2 hover:text-accent disabled:opacity-40"
                      title={node.country || node.lat != null ? 'Re-check location (fresh GeoIP lookup)' : 'Look up location now'}
                      aria-label="Re-check location"
                      disabled={actions.anyBusy}
                      onClick={() => void actions.recheckGeo(node.id)}
                    >
                      {actions.busy(node.id, 'geo') ? <RefreshCw size={14} className="animate-spin" /> : <LocateFixed size={14} />}
                    </button>
                    {/* Promote straight from the row: scanning a list is when a
                        node is most likely to look worth keeping, and the share
                        link is rebuilt server-side either way.

                        Offered only for protocols a sing-box PROFILE can be
                        built from. A hysteria2/tuic node has no share-link form
                        that importer accepts, so the button would be a control
                        that can never work — it stays disabled and says why
                        instead. A promotable node whose credential was never
                        vaulted still refuses with the server's own reason. */}
                    <button
                      type="button"
                      className="rounded-md p-1.5 text-faint transition-colors hover:bg-surface-2 hover:text-accent disabled:opacity-40"
                      title={
                        canBecomeEngineProfile(node.protocol)
                          ? 'Use in an engine — store this node as a named engine profile'
                          : `${node.protocol} nodes have no share-link form an engine profile can be built from`
                      }
                      aria-label={`Add ${node.label} to an engine`}
                      disabled={actions.anyBusy || !canBecomeEngineProfile(node.protocol)}
                      onClick={() => void actions.promote(node.id)}
                    >
                      {actions.busy(node.id, 'promote') ? <RefreshCw size={14} className="animate-spin" /> : <Cpu size={14} />}
                    </button>
                    <button
                      type="button"
                      className="rounded-md p-1.5 text-faint transition-colors hover:bg-surface-2 hover:text-text"
                      title="View details"
                      aria-label={`View details for ${node.label}`}
                      onClick={() => navigate(`/nodes/${node.id}`)}
                    >
                      <ChevronRight size={14} />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-xs text-muted">
            Page {page + 1} of {totalPages}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              Previous
            </Button>
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

      <FoldNote id="reading-values" label="How to read these numbers" className="mt-4">
        <span className="flex items-start gap-1.5">
          <TrendingUp size={12} className="mt-0.5 shrink-0" />
          Every value on this page is a stored measurement or a database count. A node with no proxy measurement shows
          an em dash and &quot;never tested&quot; rather than a zero that would read as a fast result.
        </span>
      </FoldNote>
    </DisclosureScope>
  );
}
