import { useCallback, useEffect, useMemo, useState } from 'react';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, HeartPulse, Play, Plus, RefreshCw, Server, Sparkles, Trash2 } from 'lucide-react';

import { LatencyChart } from '@/components/charts/LatencyChart';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { DisclosureScope, DisclosureToolbar } from '@/components/ui/Disclosure';
import { Field, Input, Select } from '@/components/ui/Field';
import { Metric } from '@/components/ui/Metric';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatusDot } from '@/components/ui/StatusDot';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/States';
import { useToast } from '@/components/Toaster';
import { api } from '@/lib/api';
import { serverCheckErrorMessage, serverCheckMessage } from '@/features/nodes/nodeActionPolicy';
import { usePersistentId } from '@/lib/usePersistentState';
import { fmtDateTime } from '@/lib/format';
import { useWsTestProgress } from '@/lib/ws';

import type { HealthSample, ServerRecord, ServerKind } from '@shared/models/servers';

interface SelectionCandidateResult {
  candidate: { id: string; name: string };
  score: number | null;
  label: string | null;
  rank: number;
  metrics: {
    pingAvgMs: number | null;
    jitterMs: number | null;
    lossPct: number | null;
    downloadMbps: number | null;
    uploadMbps: number | null;
    hops: number | null;
    routeScore: number | null;
  };
  reasons: string[];
  measured: string[];
}

interface SelectionDone {
  testId: string;
  results: SelectionCandidateResult[];
  recommended: SelectionCandidateResult | null;
  recommendation: string | null;
}

interface HealthResponse {
  serverId: string;
  samples: HealthSample[];
  monitorRunning: boolean;
}

const STATUS_TONE: Record<HealthSample['status'], 'ok' | 'warn' | 'danger'> = {
  online: 'ok',
  degraded: 'warn',
  offline: 'danger',
};

/**
 * Runs the smart-selection engine over the enabled servers and shows the
 * ranking with per-candidate reasons. The result is a recommendation only —
 * applying it (e.g. connecting a VPN profile) always stays a user action.
 */
function RecommendationCard({ servers }: { servers: ServerRecord[] }) {
  const toast = useToast();
  // testId persists across tab switches; useWsTestProgress re-attaches to the
  // WS stream on remount so a running recommendation is still visible.
  const [testId, setTestId] = usePersistentId('servers.recTestId');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ pct: number; message: string } | null>(null);
  const [result, setResult] = useState<SelectionDone | null>(null);

  useWsTestProgress(testId, (msg) => {
    if (msg.type === 'test:progress' && typeof msg.pct === 'number') {
      setProgress({ pct: msg.pct, message: String(msg.message ?? '') });
    }
    if (msg.type === 'test:done') {
      setResult((msg.result ?? null) as SelectionDone | null);
      setRunning(false);
      setProgress(null);
    }
  });

  const run = async () => {
    setRunning(true);
    setResult(null);
    setProgress({ pct: 0, message: 'Starting…' });
    try {
      const res = await api.post<{ testId: string }>('/servers/recommend', {});
      setTestId(res.testId);
    } catch (err) {
      setRunning(false);
      setProgress(null);
      toast('error', 'Recommendation failed', err instanceof Error ? err.message : undefined);
    }
  };

  if (servers.length < 2) {
    return (
      <Card className="mb-4">
        <CardBody>
          <p className="text-sm text-muted">Add at least two enabled servers to get a data-driven recommendation.</p>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card
      className="mb-4"
      fold={{
        id: 'smart-selection',
        defaultOpen: false,
        summary: result ? `${result.results.length} servers ranked` : 'not run yet — measures every enabled server',
      }}
    >
      <CardHeader
        title="Smart selection"
        subtitle="Measures every server and recommends the best one — weights: latency 25 · loss 20 · jitter 15 · download 15 · upload 10 · route 10 · load 5"
        icon={<Sparkles size={15} />}
        actions={
          <Button variant="primary" size="sm" onClick={() => void run()} loading={running} disabled={running}>
            <Sparkles size={13} />
            Recommend
          </Button>
        }
      />
      <CardBody>
        {running && progress && (
          <div className="mb-4">
            <div className="mb-1 flex items-center justify-between text-xs text-muted">
              <span>{progress.message}</span>
              <span className="metric-num">{progress.pct}%</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${progress.pct}%` }} />
            </div>
          </div>
        )}
        {result == null && !running && (
          <p className="text-sm text-muted">Runs a bounded measurement pass over every enabled server and ranks them. No configuration is changed automatically.</p>
        )}
        {result && (
          <div className="space-y-3">
            {result.recommendation && (
              <div className="rounded-lg border border-ok/40 bg-ok/10 px-4 py-3 text-sm text-ok">
                {result.recommendation}
              </div>
            )}
            <ul className="space-y-2">
              {result.results.map((r) => (
                <li key={r.candidate.id} className="rounded-lg border border-line bg-surface-2/60 px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2">
                      <Badge tone={r.rank === 1 ? 'accent' : 'neutral'}>#{r.rank}</Badge>
                      <span className="truncate text-sm text-text">{r.candidate.name}</span>
                    </span>
                    <span className="metric-num text-sm text-text">{r.score != null ? `${r.score}/100` : 'unreachable'}</span>
                  </div>
                  {r.reasons.length > 0 && (
                    <ul className="mt-1 list-inside list-disc text-micro text-faint">
                      {r.reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

export default function ServersPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const serversQuery = useQuery({
    queryKey: ['servers'],
    queryFn: () => api.get<{ servers: ServerRecord[] }>('/servers'),
    refetchInterval: 15_000,
  });

  const [monitorRunning, setMonitorRunning] = useState<boolean | null>(null);
  const [healthMap, setHealthMap] = useState<Record<string, HealthResponse>>({});
  const [checkedIds, setCheckedIds] = useState<Record<string, boolean>>({});

  // monitor state — polled while a server page is open so the toggle stays true
  const monitorQuery = useQuery({
    queryKey: ['health-monitor', 'status'],
    queryFn: () =>
      api.get<{ running: boolean }>('/health-monitor/status').catch(() => ({ running: false })),
    refetchInterval: 10_000,
  });
  useEffect(() => {
    if (monitorQuery.data != null) setMonitorRunning(monitorQuery.data.running);
  }, [monitorQuery.data]);

  const fetchHealth = useCallback(async (id: string) => {
    try {
      const res = await api.get<HealthResponse>(`/servers/${id}/health`);
      setHealthMap((prev) => ({ ...prev, [id]: res }));
    } catch {
      /* server-specific health can fail; keep the previous data */
    }
  }, []);

  // poll health samples for every listed server while monitoring is active
  const servers = useMemo(() => serversQuery.data?.servers ?? [], [serversQuery.data]);
  useEffect(() => {
    if (!monitorRunning || servers.length === 0) return;
    const poll = async () => {
      await Promise.all(servers.map((s) => fetchHealth(s.id)));
    };
    void poll();
    const t = setInterval(() => void poll(), 12_000);
    return () => clearInterval(t);
  }, [monitorRunning, servers, fetchHealth]);

  const toggleMonitor = async () => {
    const target = !monitorRunning;
    try {
      const res = await api.post<{ running: boolean }>(`/health-monitor/${target ? 'start' : 'stop'}`);
      setMonitorRunning(res.running);
      toast('ok', target ? 'Health monitoring started' : 'Health monitoring stopped');
      if (target) await Promise.all(servers.map((s) => fetchHealth(s.id)));
    } catch (err) {
      toast('error', 'Could not change monitor state', err instanceof Error ? err.message : undefined);
    }
  };

  const checkNow = async (id: string) => {
    setCheckedIds((prev) => ({ ...prev, [id]: true }));
    try {
      const res = await api.post<{ serverId: string; latest: HealthSample | null }>(`/servers/${id}/check`);
      const latest = res.latest;
      if (latest) {
        setHealthMap((prev) => {
          const existing = prev[id];
          return {
            ...prev,
            [id]: existing
              ? { ...existing, samples: [...existing.samples.slice(-99), latest] }
              : { serverId: id, samples: [latest], monitorRunning: monitorRunning ?? false },
          };
        });
      }
      // The message comes from the STORED sample (may be offline / degraded),
      // not from the request having completed — same policy as node tests.
      const m = serverCheckMessage(servers.find((s) => s.id === id)?.name ?? id, latest);
      toast(m.tone, m.title, m.body);
    } catch (err) {
      const m = serverCheckErrorMessage(err);
      toast(m.tone, m.title, m.body);
    } finally {
      setCheckedIds((prev) => ({ ...prev, [id]: false }));
    }
  };

  const removeServer = async (id: string) => {
    if (!window.confirm('Remove this server and its health history?')) return;
    try {
      await api.delete(`/servers/${id}`);
      toast('ok', 'Server removed');
      await queryClient.invalidateQueries({ queryKey: ['servers'] });
      setHealthMap((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } catch (err) {
      toast('error', 'Could not remove server', err instanceof Error ? err.message : undefined);
    }
  };

  return (
    <DisclosureScope name="servers">
      <PageHeader
        title="Servers"
        description="VPS, VPN and diagnostic endpoints. Health is measured periodically with ping, TCP, loss and jitter probes."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => void toggleMonitor()} loading={monitorRunning == null}>
              <HeartPulse size={14} />
              {monitorRunning ? 'Stop monitoring' : 'Start monitoring'}
            </Button>
            <AddServerButton onAdded={() => void serversQuery.refetch()} />
          </div>
        }
      />

      <DisclosureToolbar className="-mt-3 mb-2" />

      {serversQuery.isError && <ErrorState error={serversQuery.error} retry={() => void serversQuery.refetch()} />}
      {serversQuery.isLoading && <LoadingState label="Loading servers" />}

      {serversQuery.data && servers.length === 0 && (
        <EmptyState
          icon={<Server size={20} />}
          title="No servers configured"
          message="Add a VPS, VPN gateway or diagnostic endpoint. The monitor will measure its latency, packet loss and health automatically."
        />
      )}

      {servers.length > 0 && (
        <div className="space-y-4">
          <RecommendationCard servers={servers} />
          <Card
            className={monitorRunning ? 'border-accent/40' : ''}
            fold={{ id: 'server-list', pinned: true, defaultOpen: true }}
          >
            <CardHeader
              title={`${servers.length} servers`}
              subtitle={monitorRunning ? 'Monitoring active — samples refresh every 12 s' : 'Monitoring idle — samples refresh on demand'}
              icon={<Server size={15} />}
              actions={<Badge tone={monitorRunning ? 'accent' : 'neutral'}>{monitorRunning ? 'LIVE' : 'IDLE'}</Badge>}
            />
            <CardBody className="space-y-4">
              {servers.map((s) => {
                const health = healthMap[s.id];
                const latest = health?.samples[health.samples.length - 1];
                const chartData = (health?.samples ?? []).map((h, i) => ({ t: h.checkedAt, ms: h.pingMs, idx: i }));
                return (
                  <div key={s.id} className="rounded-xl border border-line bg-surface-2/60 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <StatusDot tone={latest ? STATUS_TONE[latest.status] : s.enabled ? 'idle' : 'offline'} pulse={monitorRunning === true} />
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{s.name}</div>
                          <div className="metric-num truncate text-xs text-faint">
                            {s.host}
                            {s.region ? ` · ${s.region}` : ''}
                          </div>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone="accent">{s.kind}</Badge>
                        {latest && <Badge tone={STATUS_TONE[latest.status]}>{latest.status}</Badge>}
                        {s.tags.map((t) => (
                          <Badge key={t} tone="neutral">{t}</Badge>
                        ))}
                      </div>
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <Metric label="Ping" value={latest?.pingMs ?? null} unit="ms" status={latest?.status === 'offline' ? 'bad' : latest?.status === 'degraded' ? 'warn' : 'idle'} />
                      <Metric label="Jitter" value={latest?.jitterMs ?? null} unit="ms" status="idle" />
                      <Metric label="Loss" value={latest?.packetLoss ?? null} unit="pct" status={latest != null && latest.packetLoss != null && latest.packetLoss > 0 ? 'warn' : 'idle'} />
                      <Metric label="Health" value={latest?.healthScore ?? null} status={latest?.healthScore != null ? (latest.healthScore >= 80 ? 'good' : latest.healthScore >= 50 ? 'warn' : 'bad') : 'idle'} />
                    </div>

                    {health && health.samples.length > 0 && (
                      <div className="mt-3">
                        <LatencyChart data={chartData} height={90} />
                      </div>
                    )}

                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
                      <span className="text-micro text-faint">
                        {latest ? `Last check ${fmtDateTime(latest.checkedAt)}` : 'No health samples yet'}
                      </span>
                      <div className="flex items-center gap-2">
                        <Button variant="ghost" size="sm" onClick={() => void fetchHealth(s.id)}>
                          <Activity size={13} />
                          Samples
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => void checkNow(s.id)} loading={checkedIds[s.id]} disabled={checkedIds[s.id]}>
                          <RefreshCw size={13} />
                          Check now
                        </Button>
                        <IconButton label={`Delete server ${s.name}`} variant="ghost" size="sm" onClick={() => void removeServer(s.id)}>
                          <Trash2 size={13} />
                        </IconButton>
                      </div>
                    </div>
                  </div>
                );
              })}
            </CardBody>
          </Card>
        </div>
      )}
    </DisclosureScope>
  );
}

function AddServerButton({ onAdded }: { onAdded: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ServerKind>('vps');
  const [host, setHost] = useState('');
  const [region, setRegion] = useState('');
  const [saving, setSaving] = useState(false);

  const addServer = async () => {
    setSaving(true);
    try {
      await api.post('/servers', {
        name,
        kind,
        host,
        region: region || null,
        capabilities: [],
        tags: [],
        enabled: true,
      });
      toast('ok', 'Server added');
      setOpen(false);
      setName('');
      setHost('');
      setRegion('');
      onAdded();
      await queryClient.invalidateQueries({ queryKey: ['servers'] });
    } catch (err) {
      toast('error', 'Could not add server', err instanceof Error ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <Button variant="primary" onClick={() => setOpen(true)}>
        <Plus size={14} />
        Add server
      </Button>
    );
  }

  return (
    <Card className="mb-5">
      <CardHeader title="New server" subtitle="Infrastructure metadata — the monitor probes its host periodically" />
      <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Amsterdam VPS #1" />
        </Field>
        <Field label="Kind">
          <Select value={kind} onChange={(e) => setKind(e.target.value as ServerKind)}>
            <option value="vps">VPS</option>
            <option value="diag">Diagnostic endpoint</option>
            <option value="speedtest">Speed-test server</option>
          </Select>
        </Field>
        <Field label="Host" hint="Hostname or IP">
          <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="203.0.113.10" />
        </Field>
        <Field label="Region (optional)">
          <Input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="eu-central" />
        </Field>
        <div className="flex items-end gap-2">
          <Button variant="primary" onClick={() => void addServer()} loading={saving} disabled={!name || !host}>
            <Play size={13} />
            Save
          </Button>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
        </div>
      </CardBody>
    </Card>
  );
}
