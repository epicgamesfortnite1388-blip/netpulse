import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  Activity,
  CheckCircle2,
  Download,
  Filter,
  Gauge,
  Globe2,
  History,
  Lightbulb,
  Play,
  Radar,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Square,
  Table2,
  Trash2,
  XCircle,
} from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { DisclosureScope, DisclosureToolbar } from '@/components/ui/Disclosure';
import { PageHeader } from '@/components/ui/PageHeader';
import { Progress } from '@/components/ui/Progress';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { TabPanel, Tabs } from '@/components/ui/Tabs';
import { api } from '@/lib/api';
import { useWsTestProgress } from '@/lib/ws';

import type {
  ConnectivityMeasurement,
  ConnectivityTarget,
  IranIncident,
  IranRecommendation,
  IranReport,
  IranSession,
  IranSessionSummary,
} from '@netpulse/shared';

const STATE_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'neutral'> = {
  Reachable: 'ok',
  'Partially Reachable': 'warn',
  'DNS Failure': 'neutral',
  'TCP Blocked': 'danger',
  'TLS Failure': 'danger',
  'HTTP Blocked': 'danger',
  'HTTP Error': 'warn',
  Timeout: 'warn',
  'Connection Reset': 'danger',
  'Routing Failure': 'warn',
  'IPv4 Only': 'ok',
  'IPv6 Only': 'ok',
  'VPN Only': 'warn',
  'Direct Only': 'warn',
  'Endpoint Unavailable': 'danger',
  Unknown: 'neutral',
};

const ASSESSMENT_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'neutral'> = {
  'Likely Reachable': 'ok',
  'Likely Filtered': 'danger',
  'Possible Filtering': 'warn',
  'Network Failure': 'warn',
  'Service Failure': 'neutral',
  'Insufficient Evidence': 'neutral',
};

interface CatalogResponse {
  categories: { id: string; name: string; targets: ConnectivityTarget[] }[];
  total: number;
  defaults: string[];
  custom: ConnectivityTarget[];
}

export default function IranConnectivityPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = searchParams.get('tab');
  const [tab, setTab] = useState(initialTab && ['overview', 'website', 'services', 'dns', 'filtering', 'vpn', 'recommendations', 'history'].includes(initialTab) ? initialTab : 'overview');

  const onTabChange = useCallback((v: string) => {
    setTab(v);
    if (v !== 'overview') {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set('tab', v);
        return next;
      });
    }
  }, [setSearchParams]);

  // catalog + connections
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [catalogError, setCatalogError] = useState<unknown>(null);
  const [connections, setConnections] = useState<{ id: string; name: string; mode: string }[]>([]);
  const [selectedTargets, setSelectedTargets] = useState<Set<string>>(new Set());

  // running session
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [session, setSession] = useState<IranSession | null>(null);
  const [running, setRunning] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [repeats, setRepeats] = useState(1);
  const [includeRoute, setIncludeRoute] = useState(false);

  // history / incidents / report
  const [sessions, setSessions] = useState<IranSession[]>([]);
  const [incidents, setIncidents] = useState<IranIncident[]>([]);
  const [recommendations, setRecommendations] = useState<IranRecommendation[]>([]);
  const [redact, setRedact] = useState(false);
  const [historyError, setHistoryError] = useState<unknown>(null);

  const sessionRef = useRef<IranSession | null>(null);

  const loadCatalog = useCallback(async () => {
    try {
      const c = await api.get<CatalogResponse>('/iran/catalog');
      setCatalog(c);
      setSelectedTargets(new Set(c.defaults));
    } catch (err) {
      setCatalogError(err);
    }
  }, []);

  const loadConnections = useCallback(async () => {
    try {
      const r = await api.get<{ connections: { id: string; name: string; mode: string }[] }>('/iran/connections');
      setConnections(r.connections);
    } catch {
      // connections are best-effort
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const [s, i] = await Promise.all([
        api.get<{ sessions: IranSession[] }>('/iran/sessions?limit=10'),
        api.get<{ incidents: IranIncident[] }>('/iran/incidents?days=30'),
      ]);
      setSessions(s.sessions);
      setIncidents(i.incidents);
    } catch (err) {
      setHistoryError(err);
    }
  }, []);

  const autoRun = useRef(searchParams.get('run') === '1');

  useEffect(() => {
    void loadCatalog();
    void loadConnections();
    void loadHistory();
  }, [loadCatalog, loadConnections, loadHistory]);

  const onWs = useCallback((msg: { type: string; sessionId?: string; pct?: number; message?: string; measurement?: ConnectivityMeasurement; session?: IranSession; error?: unknown }) => {
    if (msg.type === 'iran:progress') {
      setPct(msg.pct ?? null);
      if (msg.message) setStatusMsg(msg.message);
    } else if (msg.type === 'iran:measurement' && msg.measurement) {
      setSession((prev) => {
        if (!prev) return prev;
        const next = { ...prev, measurements: [...prev.measurements, msg.measurement!] };
        sessionRef.current = next;
        return next;
      });
    } else if (msg.type === 'iran:done' && msg.session) {
      setSession(msg.session);
      sessionRef.current = msg.session;
      setRunning(false);
      setPct(100);
      void loadHistory();
      const sid = msg.session.id;
      api.get<{ recommendations: IranRecommendation[] }>(`/iran/recommendations?sessionId=${encodeURIComponent(sid)}`).then((r) => setRecommendations(r.recommendations)).catch(() => undefined);
    } else if (msg.type === 'iran:error') {
      setRunError(String(msg.error ?? 'Test failed'));
      setRunning(false);
    }
  }, [loadHistory]);

  useWsTestProgress(sessionId, onWs);

  const startRun = useCallback(
    async (targetIds?: string[]) => {
      setRunError(null);
      setRunning(true);
      setPct(0);
      setStatusMsg('Starting Iran connectivity test…');
      const ids = targetIds ?? [...selectedTargets];
      try {
        const r = await api.post<{ sessionId: string }>('/iran/run', {
          targetIds: ids,
          repeats,
          includeRoute,
        });
        setSessionId(r.sessionId);
        setSession({
          id: r.sessionId,
          kind: 'interactive',
          status: 'running',
          error: null,
          startedAt: Date.now(),
          completedAt: null,
          connections: [],
          targetIds: ids,
          progress: 0,
          summary: null,
          measurements: [],
        });
      } catch (err) {
        setRunError(err instanceof Error ? err.message : 'Failed to start test');
        setRunning(false);
      }
    },
    [selectedTargets, repeats, includeRoute],
  );

  // support /iran?run=1 (command palette): auto-start once the catalog is ready
  useEffect(() => {
    if (autoRun.current && catalog && !running) {
      autoRun.current = false;
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete('run');
        return next;
      });
      void startRun();
    }
  }, [catalog, running, startRun, setSearchParams]);

  const toggleTarget = (id: string) => {
    setSelectedTargets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearHistory = useCallback(async () => {
    if (!window.confirm('Delete all Iran connectivity test history? This cannot be undone.')) return;
    try {
      await api.post('/iran/clear');
      setSessions([]);
      setIncidents([]);
      setRecommendations([]);
    } catch {
      // ignore
    }
  }, []);

  const exportReport = useCallback(async () => {
    if (!session) return;
    try {
      const report = await api.get<IranReport>(`/iran/report/${session.id}?redact=${redact ? '1' : '0'}`);
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `iran-connectivity-${session.id.slice(0, 8)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Export failed');
    }
  }, [session, redact]);

  const summary: IranSessionSummary | null = session?.summary ?? null;
  const measurements = useMemo(() => session?.measurements ?? [], [session]);
  const activeCells = measurements.filter((m) => m.dns || m.tcp || m.tls || m.http);

  const byCategory = useMemo(() => {
    const map = new Map<string, ConnectivityMeasurement[]>();
    for (const m of activeCells) {
      const t = catalog?.categories.find((c) => c.targets.some((x) => x.id === m.targetId));
      const cat = t?.name ?? 'Other';
      const list = map.get(cat) ?? [];
      list.push(m);
      map.set(cat, list);
    }
    return [...map.entries()];
  }, [activeCells, catalog]);

  if (catalogError) return <ErrorState error={catalogError} retry={() => void loadCatalog()} />;

  const vpnConnections = connections.filter((c) => c.mode === 'vpn');

  return (
    <DisclosureScope name="iran" className="space-y-5">
      <PageHeader
        title="Iran Connectivity"
        description="Measure, classify, compare and recommend — filtering is always an inference, never an assertion"
        actions={
          <div className="flex items-center gap-2">
            {redact && <Badge tone="warn">Privacy: IPs/hostnames redacted</Badge>}
            <Button variant="ghost" size="sm" onClick={() => setRedact((v) => !v)}>
              <ShieldCheck size={14} /> Privacy
            </Button>
            <Button variant="ghost" size="sm" onClick={exportReport} disabled={!session}>
              <Download size={14} /> Export report
            </Button>
            <Button variant="ghost" size="sm" onClick={clearHistory}>
              <Trash2 size={14} /> Delete history
            </Button>
          </div>
        }
      />
      <DisclosureToolbar className="-mt-2" />

      {/* one-click runner */}
      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-text">RUN IRAN CONNECTIVITY TEST</h3>
              {running && <Badge tone="accent">testing…</Badge>}
            </div>
            <p className="text-xs text-muted">
              Tests {selectedTargets.size} curated targets across {connections.length} connection{connections.length === 1 ? '' : 's'}
              {vpnConnections.length > 0 ? ` (${vpnConnections.length} VPN profile${vpnConnections.length === 1 ? '' : 's'} available)` : ' — import a VPN profile to compare paths'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-muted">
              Repeats
              <select
                className="rounded-lg border border-line bg-surface px-2 py-1.5 text-xs text-text"
                value={repeats}
                onChange={(e) => setRepeats(Number(e.target.value))}
              >
                <option value={1}>Run once</option>
                <option value={3}>Run 3×</option>
                <option value={5}>Run 5×</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <input type="checkbox" checked={includeRoute} onChange={(e) => setIncludeRoute(e.target.checked)} />
              Route probes
            </label>
            <Button size="md" onClick={() => void startRun()} disabled={running || selectedTargets.size === 0}>
              {running ? <Square size={14} /> : <Play size={14} />}
              {running ? 'Running…' : 'Run Iran test'}
            </Button>
          </div>
        </CardBody>
        {running && (
          <CardBody className="border-t border-line">
            <Progress value={pct ?? 0} />
            <p className="mt-2 text-xs text-muted">{statusMsg}</p>
          </CardBody>
        )}
        {runError && <CardBody className="border-t border-line"><p className="text-xs text-danger">{runError}</p></CardBody>}
      </Card>

      {/* health summary */}
      {summary && (
        <Card>
          <CardBody className="grid grid-cols-2 gap-4 md:grid-cols-6">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted">Connectivity health</p>
              <p className="text-2xl font-bold text-text">{summary.healthScore}<span className="text-sm text-muted"> / 100</span></p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted">Reachable</p>
              <p className="text-2xl font-bold text-ok">{summary.reachable}<span className="text-sm text-muted"> / {summary.total}</span></p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted">Possible filtering</p>
              <p className="text-2xl font-bold text-warn">{summary.possibleFiltering}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted">Network failures</p>
              <p className="text-2xl font-bold text-danger">{summary.networkFailures}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted">Unavailable services</p>
              <p className="text-2xl font-bold text-neutral">{summary.unavailableServices}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-muted">Best profile</p>
              <p className="text-sm font-semibold text-accent-strong">{summary.bestConnectionName ?? '—'}</p>
            </div>
          </CardBody>
        </Card>
      )}

      <Tabs value={tab} onValueChange={onTabChange} defaultValue="overview" items={[
        { value: 'overview', label: 'Overview' },
        { value: 'website', label: 'Website Tests' },
        { value: 'services', label: 'Service Tests' },
        { value: 'dns', label: 'DNS Tests' },
        { value: 'filtering', label: 'Filtering Analysis' },
        { value: 'vpn', label: 'VPN Comparison' },
        { value: 'recommendations', label: 'Recommendations' },
        { value: 'history', label: 'History' },
      ]}>
        <TabPanel value="overview">
          <div className="grid gap-5 lg:grid-cols-2">
            <Card fold={{ id: 'targets', pinned: true }}>
              <CardHeader icon={<Filter size={16} />} title="Select targets" subtitle={`${selectedTargets.size} selected of ${catalog?.total ?? 0}`} />
              <CardBody className="max-h-[560px] space-y-3 overflow-y-auto">
                {(catalog?.categories ?? []).map((cat) => (
                  <div key={cat.id}>
                    <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">{cat.name}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {cat.targets.map((t) => (
                        <button
                          key={t.id}
                          onClick={() => toggleTarget(t.id)}
                          className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                            selectedTargets.has(t.id)
                              ? 'border-accent bg-accent-soft text-accent-strong'
                              : 'border-line bg-surface text-muted hover:text-text'
                          }`}
                        >
                          {t.name}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
                {(catalog?.custom ?? []).length > 0 && (
                  <div>
                    <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Custom</p>
                    <div className="flex flex-wrap gap-1.5">
                      {(catalog?.custom ?? []).map((t) => (
                        <button key={t.id} onClick={() => toggleTarget(t.id)} className={`rounded-full border px-2.5 py-1 text-xs ${selectedTargets.has(t.id) ? 'border-accent bg-accent-soft text-accent-strong' : 'border-line bg-surface text-muted'}`}>
                          {t.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </CardBody>
            </Card>
            <Card
              fold={{
                id: 'connections',
                defaultOpen: false,
                summary: `${connections.length} connection${connections.length === 1 ? '' : 's'} compared on every target${vpnConnections.length > 0 ? ` · ${vpnConnections.length} VPN profile${vpnConnections.length === 1 ? '' : 's'}` : ''}`,
              }}
            >
              <CardHeader icon={<Gauge size={16} />} title="Connections" subtitle="What is compared on every target" />
              <CardBody className="space-y-2">
                {connections.map((c) => (
                  <div key={c.id} className="flex items-center justify-between rounded-lg border border-line bg-surface px-3 py-2">
                    <div className="flex items-center gap-2">
                      {c.mode === 'vpn' ? <ShieldCheck size={14} className="text-accent-strong" /> : <Globe2 size={14} className="text-muted" />}
                      <span className="text-sm text-text">{c.name}</span>
                    </div>
                    <Badge tone={c.mode === 'vpn' ? 'accent' : 'neutral'}>{c.mode === 'vpn' ? 'VPN profile' : 'direct'}</Badge>
                  </div>
                ))}
                {connections.length === 0 && <EmptyState title="No connections detected" message="Import a VPN profile or check the API." />}
                {vpnConnections.length === 0 && (
                  <p className="text-xs text-muted">
                    No VPN profiles are configured. The test still works — every target is measured over the direct connection. Import a profile in VPN → Profiles to enable the comparison matrix.
                  </p>
                )}
              </CardBody>
            </Card>
          </div>
        </TabPanel>

        <TabPanel value="website">
          <Card
            fold={{
              id: 'website-tests',
              pinned: true,
              summary: activeCells.length === 0 ? 'no measurements yet' : `${activeCells.length} measurement${activeCells.length === 1 ? '' : 's'} across targets`,
            }}
          >
            <CardHeader
              icon={<Globe2 size={16} />}
              title="Website Tests"
              subtitle="Live DNS → TCP → TLS → HTTPS pipeline per target"
              actions={
                <Button size="sm" onClick={() => void startRun([...selectedTargets].filter((id) => catalog?.categories.some((c) => ['Search', 'Social', 'Messaging', 'News', 'Productivity'].includes(c.name) && c.targets.some((t) => t.id === id))))} disabled={running}>
                  <Play size={12} /> Test websites
                </Button>
              }
            />
            <CardBody>
              {activeCells.length === 0 ? (
                <EmptyState title="No measurements yet" message="Run the Iran connectivity test to populate this table." />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
                        <th className="px-2 py-2">Target</th>
                        <th className="px-2 py-2">Connection</th>
                        <th className="px-2 py-2">DNS</th>
                        <th className="px-2 py-2">TCP</th>
                        <th className="px-2 py-2">TLS</th>
                        <th className="px-2 py-2">HTTPS</th>
                        <th className="px-2 py-2">Latency</th>
                        <th className="px-2 py-2">Assessment</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeCells.map((m) => (
                        <tr key={`${m.targetId}:${m.connectionId}`} className="border-b border-line/50">
                          <td className="px-2 py-1.5 font-medium text-text">{catalog?.categories.flatMap((c) => c.targets).find((t) => t.id === m.targetId)?.name ?? m.targetId}</td>
                          <td className="px-2 py-1.5 text-muted">{m.connectionName}</td>
                          <td className="px-2 py-1.5">{m.dns?.ok ? <CheckCircle2 size={14} className="text-ok" /> : <XCircle size={14} className="text-danger" />}</td>
                          <td className="px-2 py-1.5">{m.tcp?.ok ? <CheckCircle2 size={14} className="text-ok" /> : <XCircle size={14} className="text-danger" />}</td>
                          <td className="px-2 py-1.5">{m.tls?.ok ? <CheckCircle2 size={14} className="text-ok" /> : <XCircle size={14} className="text-danger" />}</td>
                          <td className="px-2 py-1.5">{m.http?.ok && (m.http.status ?? 0) < 400 ? <CheckCircle2 size={14} className="text-ok" /> : <XCircle size={14} className="text-danger" />}</td>
                          <td className="px-2 py-1.5 text-muted">{m.http?.latencyMs ?? m.tls?.latencyMs ?? m.tcp?.latencyMs ?? '—'} ms</td>
                          <td className="px-2 py-1.5"><Badge tone={ASSESSMENT_TONE[m.classification.assessment] ?? 'neutral'}>{m.classification.assessment}</Badge></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardBody>
          </Card>
        </TabPanel>

        <TabPanel value="services">
          <Card
            fold={{
              id: 'service-tests',
              summary: byCategory.length === 0 ? 'no measurements yet' : `${byCategory.length} categor${byCategory.length === 1 ? 'y' : 'ies'} with per-service evidence`,
            }}
          >
            <CardHeader icon={<Activity size={16} />} title="Service Tests" subtitle="Grouped by category with per-service evidence" />
            <CardBody className="space-y-5">
              {byCategory.length === 0 && <EmptyState title="No measurements yet" message="Run the Iran connectivity test to populate service results." />}
              {byCategory.map(([cat, ms]) => (
                <div key={cat}>
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{cat}</p>
                  <div className="space-y-1.5">
                    {ms.map((m) => (
                      <div key={`${m.targetId}:${m.connectionId}`} className="rounded-lg border border-line bg-surface p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-text">{catalog?.categories.flatMap((c) => c.targets).find((t) => t.id === m.targetId)?.name ?? m.targetId}</span>
                            <span className="text-xs text-muted">via {m.connectionName}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge tone={STATE_TONE[m.classification.state] ?? 'neutral'}>{m.classification.state}</Badge>
                            <Badge tone={ASSESSMENT_TONE[m.classification.assessment] ?? 'neutral'}>{m.classification.assessment}</Badge>
                            {m.score && <Badge tone="accent">score {m.score.total}</Badge>}
                          </div>
                        </div>
                        <ul className="mt-2 space-y-0.5 text-xs text-muted">
                          {m.classification.evidence.slice(0, 4).map((e, i) => <li key={i}>• {e}</li>)}
                        </ul>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </CardBody>
          </Card>
        </TabPanel>

        <TabPanel value="dns">
          <Card
            fold={{
              id: 'dns-tests',
              summary: activeCells.length === 0 ? 'no DNS measurements yet' : `${activeCells.length} measurement${activeCells.length === 1 ? '' : 's'} comparing system vs 1.1.1.1`,
            }}
          >
            <CardHeader
              icon={<Radar size={16} />}
              title="DNS Tests"
              subtitle="System resolver vs alternative resolver (1.1.1.1) — differing answers are reported, not asserted as censorship"
            />
            <CardBody>
              {activeCells.length === 0 ? (
                <EmptyState title="No DNS measurements yet" message="Run the test to compare DNS behavior across connections." />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
                        <th className="px-2 py-2">Target</th>
                        <th className="px-2 py-2">Connection</th>
                        <th className="px-2 py-2">Resolver</th>
                        <th className="px-2 py-2">A records</th>
                        <th className="px-2 py-2">AAAA</th>
                        <th className="px-2 py-2">CNAME</th>
                        <th className="px-2 py-2">Latency</th>
                        <th className="px-2 py-2">NXDOMAIN</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeCells.filter((m) => m.dns).map((m) => (
                        <tr key={`dns:${m.targetId}:${m.connectionId}`} className="border-b border-line/50">
                          <td className="px-2 py-1.5 font-medium text-text">{catalog?.categories.flatMap((c) => c.targets).find((t) => t.id === m.targetId)?.name ?? m.targetId}</td>
                          <td className="px-2 py-1.5 text-muted">{m.connectionName}</td>
                          <td className="px-2 py-1.5 text-muted">{m.dns!.resolver ?? 'system'}</td>
                          <td className="px-2 py-1.5 font-mono text-xs text-text">{(m.dns!.a ?? []).join(', ') || '—'}</td>
                          <td className="px-2 py-1.5 font-mono text-xs text-muted">{(m.dns!.aaaa ?? []).join(', ') || '—'}</td>
                          <td className="px-2 py-1.5 font-mono text-xs text-muted">{(m.dns!.cname ?? []).join(', ') || '—'}</td>
                          <td className="px-2 py-1.5 text-muted">{m.dns!.latencyMs ?? '—'} ms</td>
                          <td className="px-2 py-1.5">{m.dns!.nxdomain ? <Badge tone="warn">yes</Badge> : <Badge tone="ok">no</Badge>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="mt-3 text-xs text-muted">
                A differing answer between resolvers can indicate DNS manipulation — or a CDN anycast selection. The DNS differential note in each measurement's evidence states the observation without declaring it censorship.
              </p>
            </CardBody>
          </Card>
        </TabPanel>

        <TabPanel value="filtering">
          <Card
            fold={{
              id: 'filtering-analysis',
              summary: activeCells.length === 0 ? 'no analysis yet' : `${activeCells.length} measurement${activeCells.length === 1 ? '' : 's'} classified with confidence`,
            }}
          >
            <CardHeader icon={<ShieldAlert size={16} />} title="Filtering Analysis" subtitle="Evidence-based classification with confidence — never asserted from a single sample" />
            <CardBody className="space-y-3">
              {activeCells.length === 0 && <EmptyState title="No analysis yet" message="Run the test to see per-target classifications with confidence." />}
              {activeCells
                .filter((m) => m.classification.assessment !== 'Likely Reachable')
                .map((m) => (
                  <div key={`fa:${m.targetId}:${m.connectionId}`} className="rounded-lg border border-line bg-surface p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text">{catalog?.categories.flatMap((c) => c.targets).find((t) => t.id === m.targetId)?.name ?? m.targetId}</span>
                        <span className="text-xs text-muted">via {m.connectionName}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge tone={STATE_TONE[m.classification.state] ?? 'neutral'}>{m.classification.state}</Badge>
                        <Badge tone={ASSESSMENT_TONE[m.classification.assessment] ?? 'neutral'}>{m.classification.assessment}</Badge>
                        <Badge tone="neutral">confidence: {m.classification.confidence}</Badge>
                      </div>
                    </div>
                    <div className="mt-2 grid gap-2 lg:grid-cols-2">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Evidence</p>
                        <ul className="mt-1 space-y-0.5 text-xs text-muted">
                          {m.classification.evidence.map((e, i) => <li key={i}>• {e}</li>)}
                        </ul>
                      </div>
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Stages</p>
                        <div className="mt-1 flex flex-wrap gap-1">
                          <Badge tone={m.dns?.ok ? 'ok' : 'danger'}>DNS</Badge>
                          <Badge tone={m.tcp?.ok ? 'ok' : 'danger'}>TCP:{m.tcp?.port ?? 443}</Badge>
                          <Badge tone={m.tls?.ok ? 'ok' : 'danger'}>TLS</Badge>
                          <Badge tone={m.http?.ok ? 'ok' : 'danger'}>HTTPS</Badge>
                          {m.route && <Badge tone={m.route.ok ? 'ok' : 'warn'}>Route</Badge>}
                        </div>
                        <p className="mt-2 text-[11px] text-muted">
                          Samples: {m.samples} · {m.classification.evidence.length > 0 ? `${m.classification.evidence.length} evidence line${m.classification.evidence.length === 1 ? '' : 's'}` : ''}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              {activeCells.length > 0 && activeCells.every((m) => m.classification.assessment === 'Likely Reachable') && (
                <EmptyState title="No filtering indicators observed" message="All tested targets were reachable — no interference patterns detected on the tested paths." />
              )}
            </CardBody>
          </Card>
        </TabPanel>

        <TabPanel value="vpn">
          <Card
            fold={{
              id: 'vpn-comparison',
              summary:
                vpnConnections.length === 0
                  ? 'no VPN profiles configured — direct paths only'
                  : activeCells.length === 0
                    ? 'no comparison data yet'
                    : `${vpnConnections.length} VPN path${vpnConnections.length === 1 ? '' : 's'} against ${activeCells.length} measurement${activeCells.length === 1 ? '' : 's'}`,
            }}
          >
            <CardHeader
              icon={<Table2 size={16} />}
              title="VPN Comparison"
              subtitle="Direct vs VPN matrix — populated from real measurements only"
              actions={
                <Button size="sm" onClick={() => void startRun()} disabled={running || selectedTargets.size === 0}>
                  <RefreshCw size={12} /> Re-run matrix
                </Button>
              }
            />
            <CardBody>
              {vpnConnections.length === 0 && (
                <p className="mb-3 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-warn">
                  No VPN profiles configured. Import a profile in VPN → Profiles, then re-run the test to compare direct vs VPN paths on every target.
                </p>
              )}
              {activeCells.length === 0 ? (
                <EmptyState title="No comparison data" message="Run the Iran test to populate the matrix." />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
                        <th className="px-2 py-2">Service</th>
                        {connections.map((c) => <th key={c.id} className="px-2 py-2">{c.name}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {activeCells
                        .filter((m, i, arr) => arr.findIndex((x) => x.targetId === m.targetId) === i)
                        .map((m0) => (
                          <tr key={m0.targetId} className="border-b border-line/50">
                            <td className="px-2 py-1.5 font-medium text-text">{catalog?.categories.flatMap((c) => c.targets).find((t) => t.id === m0.targetId)?.name ?? m0.targetId}</td>
                            {connections.map((c) => {
                              const cell = activeCells.find((x) => x.targetId === m0.targetId && x.connectionId === c.id);
                              if (!cell) return <td key={c.id} className="px-2 py-1.5 text-muted">—</td>;
                              return (
                                <td key={c.id} className="px-2 py-1.5">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <Badge tone={STATE_TONE[cell.classification.state] ?? 'neutral'}>{cell.classification.state}</Badge>
                                    <span className="text-xs text-muted">{cell.http?.latencyMs ?? cell.tls?.latencyMs ?? cell.tcp?.latencyMs ?? '—'} ms</span>
                                  </div>
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}
              {session?.summary?.bestConnectionName && (
                <p className="mt-3 text-xs text-muted">
                  Best overall profile this session: <span className="font-semibold text-accent-strong">{session.summary.bestConnectionName}</span> — computed from measured scores, not assumptions.
                </p>
              )}
            </CardBody>
          </Card>
        </TabPanel>

        <TabPanel value="recommendations">
          <Card
            fold={{
              id: 'recommendations',
              summary: recommendations.length === 0 ? 'none yet — complete a test session' : `${recommendations.length} recommendation${recommendations.length === 1 ? '' : 's'} from recent measurements`,
            }}
          >
            <CardHeader icon={<Lightbulb size={16} />} title="Recommendations" subtitle="Best connection per service and category — only from recent measurements" />
            <CardBody className="space-y-3">
              {recommendations.length === 0 && <EmptyState title="No recommendations yet" message="Complete a test session to generate recommendations." />}
              {recommendations.map((r) => (
                <div key={`${r.targetId ?? 'cat'}:${r.connectionId}`} className="rounded-lg border border-line bg-surface p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-text">
                        {r.targetName ?? r.category}
                        {r.targetName == null && r.category && <span className="ml-2 text-xs font-normal text-muted">category</span>}
                      </p>
                      <p className="text-xs text-muted">{r.reason}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone="accent">{r.connectionName}</Badge>
                      {r.score != null && <Badge tone="neutral">score {r.score}</Badge>}
                      <Badge tone="neutral">conf: {r.confidence}</Badge>
                    </div>
                  </div>
                  <ul className="mt-2 space-y-0.5 text-xs text-muted">
                    {r.evidence.map((e, i) => <li key={i}>• {e}</li>)}
                  </ul>
                </div>
              ))}
            </CardBody>
          </Card>
        </TabPanel>

        <TabPanel value="history">
          {historyError != null && <div className="mb-4"><ErrorState error={historyError} retry={() => void loadHistory()} /></div>}
          <div className="grid gap-5 lg:grid-cols-2">
            <Card
              fold={{
                id: 'sessions',
                summary: sessions.length === 0 ? 'no sessions yet' : `${sessions.length} session${sessions.length === 1 ? '' : 's'} recorded`,
              }}
            >
              <CardHeader icon={<History size={16} />} title="Sessions" subtitle="Your personal connectivity history" />
              <CardBody className="space-y-2">
                {sessions.length === 0 && <EmptyState title="No sessions yet" message="Run the Iran test to build a personal connectivity history." />}
                {sessions.map((s) => (
                  <div key={s.id} className="rounded-lg border border-line bg-surface px-3 py-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Badge tone={s.status === 'done' ? 'ok' : s.status === 'running' ? 'accent' : 'danger'}>{s.status}</Badge>
                        <span className="text-sm text-text">{new Date(s.startedAt).toLocaleString()}</span>
                      </div>
                      {s.summary && (
                        <span className="text-xs text-muted">
                          {s.summary.reachable}/{s.summary.total} reachable · health {s.summary.healthScore}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {s.connections.map((c) => <Badge key={c.id} tone="neutral">{c.name}</Badge>)}
                    </div>
                  </div>
                ))}
              </CardBody>
            </Card>
            <Card
              fold={{
                id: 'incidents',
                summary: incidents.length === 0 ? 'no incidents detected' : `${incidents.length} detected change${incidents.length === 1 ? '' : 's'}`,
              }}
            >
              <CardHeader icon={<Activity size={16} />} title="Incidents" subtitle="Detected changes — a personal history, not a blocklist" />
              <CardBody className="space-y-2">
                {incidents.length === 0 && <EmptyState title="No incidents detected" message="Changes between sessions (became unreachable, recovered, DNS/route changed, latency increased) appear here." />}
                {incidents.map((inc) => (
                  <div key={inc.id} className="rounded-lg border border-line bg-surface px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Badge tone={inc.severity === 'critical' ? 'danger' : inc.severity === 'warn' ? 'warn' : 'accent'}>{inc.type}</Badge>
                      <span className="text-xs text-muted">{new Date(inc.observedAt).toLocaleString()}</span>
                    </div>
                    <p className="mt-1 text-xs text-text">{inc.message}</p>
                  </div>
                ))}
              </CardBody>
            </Card>
          </div>
        </TabPanel>
      </Tabs>
    </DisclosureScope>
  );
}