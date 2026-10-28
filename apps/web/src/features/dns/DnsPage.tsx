import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Award, Globe, Plus, Play, ShieldCheck, ShieldX, Trash2, TrendingDown } from 'lucide-react';

import { LatencyChart } from '@/components/charts/LatencyChart';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { DisclosureScope, DisclosureToolbar } from '@/components/ui/Disclosure';
import { ExternalUrlLink } from '@/components/ui/ExternalUrlLink';
import { Field, Input } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { Progress } from '@/components/ui/Progress';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { ScheduleChip } from '@/components/ScheduleChip';
import { TabPanel, Tabs } from '@/components/ui/Tabs';
import { api } from '@/lib/api';
import { usePersistentId, usePersistentState } from '@/lib/usePersistentState';
import { useBackgroundTest } from '@/lib/useBackgroundTest';

import type { DnsBenchmarkRow, DnsLeakResult, DnsQualityLabel } from '@netpulse/shared';

/* ------------------------------- DTOs ------------------------------------- */

interface DnsServerSpec {
  id: string;
  name: string;
  ipv4: string | null;
  ipv6: string | null;
  dohUrl: string | null;
  dotHost: string | null;
  dnssec: boolean;
  kind: 'public' | 'custom';
  category: string;
  source?: string;
  verified: boolean;
  skipBenchmarkReason?: string;
  note?: string;
}

interface DnsProviderGroup {
  id: string;
  name: string;
  description: string;
  homepage: string;
  resolvers: DnsServerSpec[];
}

interface RecommendEntry {
  rank: number | null;
  providerId: string;
  name: string;
  transport: string;
  score: number | null;
  confidence: 'high' | 'medium' | 'low';
  badge?: string;
  reasons: string[];
}

interface RecommendResult {
  profile: string;
  profileLabel: string;
  note: string;
  entries: RecommendEntry[];
  vpnActive: boolean;
  vpnServerName: string | null;
  currentProviderId: string | null;
}

interface HistorySeries {
  providerId: string;
  name: string;
  transport: string;
  points: { ts: number; latencyAvgMs: number | null; reliabilityPct: number | null; timeouts: number; score: number | null }[];
}

interface DnssecDeepResult {
  providerId: string;
  name: string;
  classification: 'validating' | 'not-validating' | 'unreachable' | 'unknown';
  brokenZone: string;
  signedNoError: boolean | null;
  adBit: boolean | null;
  detail: string;
  testedAt: number;
}

type Transport = 'udp' | 'doh' | 'dot' | 'both';

const STATUS_TONE: Record<DnsQualityLabel, 'ok' | 'warn' | 'danger' | 'neutral'> = {
  excellent: 'ok',
  good: 'ok',
  fair: 'warn',
  poor: 'danger',
  unreachable: 'neutral',
};

const CONF_TONE: Record<string, 'ok' | 'warn' | 'neutral'> = { high: 'ok', medium: 'warn', low: 'neutral' };
const PROFILES = ['fastest', 'reliable', 'privacy', 'security', 'family', 'gaming', 'balanced'];
const RANGES = [
  { id: '24h', label: '24h' },
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
];

function rowIsOk(r: DnsBenchmarkRow): boolean {
  return r.ok > 0 && r.latencyAvgMs != null;
}

export default function DnsPage() {
  // Tab, provider selection, and the running benchmark id persist across tab
  // switches — benchmarks take tens of seconds server-side.
  const [tab, setTab] = usePersistentState<string>('dns.tab', 'benchmark');

  const [groups, setGroups] = useState<DnsProviderGroup[] | null>(null);
  const [catalogError, setCatalogError] = useState<unknown>(null);

  const [selected, setSelected] = usePersistentState<Set<string>>('dns.selected', new Set());
  const [transport, setTransport] = usePersistentState<Transport>('dns.transport', 'both');
  const [benchmarkId, setBenchmarkId] = usePersistentId('dns.benchmarkId');
  const [submitError, setSubmitError] = useState<unknown>(null);
  const benchmark = useBackgroundTest<{ testId: string; results: DnsBenchmarkRow[] }>(benchmarkId);
  const results = benchmark.result?.results ?? null;
  const running = benchmark.running;
  const error = submitError ?? benchmark.error;

  const [profile, setProfile] = usePersistentState<string>('dns.profile', 'balanced');
  const [recommend, setRecommend] = useState<RecommendResult | null>(null);

  // fetch recommendations whenever the tab is opened (the API computes them from
  // the latest persisted benchmark batch, so a fresh visit must not show an empty state)
  useEffect(() => {
    if (tab !== 'recommend') return;
    void api
      .get<RecommendResult>(`/dns/recommend?profile=${profile}`)
      .then(setRecommend)
      .catch(() => undefined);
  }, [tab, profile]);

  // same for the history tab: persisted benchmarks exist even on a fresh visit
  const [historyRange, setHistoryRange] = useState('7d');
  useEffect(() => {
    if (tab !== 'history') return;
    void api
      .get<{ series: HistorySeries[] }>(`/dns/history?range=${historyRange}`)
      .then((r) => setHistory(r.series))
      .catch(() => undefined);
    // refetch on tab open or when the range changes; refreshHistory() covers
    // the manual-refresh button
  }, [tab, historyRange]);

  const [history, setHistory] = useState<HistorySeries[] | null>(null);

  const [deepSpecId, setDeepSpecId] = useState<string>('');
  const [deep, setDeep] = useState<DnssecDeepResult | null>(null);
  const [deepBusy, setDeepBusy] = useState(false);

  const [leakId, setLeakId] = useState<string | null>(null);
  const leakRun = useBackgroundTest<DnsLeakResult>(leakId);
  const leak = leakRun.result;
  const leakRunning = leakRun.running;

  const [customForm, setCustomForm] = useState({ name: '', ipv4: '', ipv6: '', dohUrl: '', dotHost: '', dnssec: true });
  const [customList, setCustomList] = useState<DnsServerSpec[]>([]);
  const [customError, setCustomError] = useState<unknown>(null);

  useEffect(() => {
    api
      .get<{ groups: DnsProviderGroup[] }>('/dns/providers')
      .then((res) => {
        setGroups(res.groups);
        // default selection: the first benchmarkable resolver of each group
        const def = new Set<string>();
        for (const g of res.groups) {
          const r = g.resolvers.find((x) => !x.skipBenchmarkReason && (x.ipv4 || x.dohUrl || x.dotHost));
          if (r) def.add(r.id);
        }
        setSelected(def);
      })
      .catch(setCatalogError);
    api.get<DnsServerSpec[]>('/dns/providers/custom').then(setCustomList).catch(() => undefined);
  }, [setSelected]);

  const benchmarkable = useMemo(() => (groups ?? []).flatMap((g) => g.resolvers), [groups]);
  const allIds = useMemo(() => benchmarkable.filter((r) => !r.skipBenchmarkReason && (r.ipv4 || r.dohUrl || r.dotHost)).map((r) => r.id), [benchmarkable]);

  // deep link /gaming-style quick start: /dns?run=1 runs the default benchmark
  const ranOnce = useRef(false);
  useEffect(() => {
    if (!groups || selected.size === 0 || ranOnce.current) return;
    if (new URLSearchParams(window.location.search).get('run') === '1') {
      ranOnce.current = true;
      void runTest();
    }
    // deep-link quick start fires once once the catalog is loaded
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, selected.size]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, [setSelected]);

  const runTest = useCallback(async () => {
    setSubmitError(null);
    try {
      const res = await api.post<{ testId: string }>('/dns/test', { providers: [...selected], probes: 4, transport });
      setBenchmarkId(res.testId);
    } catch (err) {
      setSubmitError(err);
    }
  }, [selected, transport, setBenchmarkId]);

  // when a benchmark completes, refresh recommendations + history automatically
  useEffect(() => {
    if (!benchmark.result) return;
    void api.get<RecommendResult>(`/dns/recommend?profile=${profile}&transport=${transport === 'both' || transport === 'udp' ? 'udp' : transport}`).then(setRecommend).catch(() => undefined);
    void api.get<{ series: HistorySeries[] }>('/dns/history?range=7d').then((r) => setHistory(r.series)).catch(() => undefined);
  }, [benchmark.result, profile, transport]);

  const refreshHistory = useCallback(() => {
    void api.get<{ series: HistorySeries[] }>(`/dns/history?range=${historyRange}`).then((r) => setHistory(r.series)).catch(() => undefined);
  }, [historyRange]);

  const runDeep = useCallback(async () => {
    if (!deepSpecId) return;
    setDeepBusy(true);
    try {
      const res = await api.post<DnssecDeepResult>(`/dns/providers/${encodeURIComponent(deepSpecId)}/dnssec-deep`);
      setDeep(res);
    } catch (err) {
      setCustomError(err);
    } finally {
      setDeepBusy(false);
    }
  }, [deepSpecId]);

  const addCustom = useCallback(async () => {
    setCustomError(null);
    try {
      const res = await api.post<{ added: DnsServerSpec }>('/dns/providers/custom', {
        id: customForm.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40),
        name: customForm.name,
        ipv4: customForm.ipv4 || null,
        ipv6: customForm.ipv6 || null,
        dohUrl: customForm.dohUrl || null,
        dotHost: customForm.dotHost || null,
        dnssec: customForm.dnssec,
      });
      setCustomList((prev) => [...prev, res.added]);
      setCustomForm({ name: '', ipv4: '', ipv6: '', dohUrl: '', dotHost: '', dnssec: true });
    } catch (err) {
      setCustomError(err);
    }
  }, [customForm]);

  const removeCustom = useCallback(async (id: string) => {
    try {
      await api.delete(`/dns/providers/custom/${encodeURIComponent(id)}`);
      setCustomList((prev) => prev.filter((r) => r.id !== `custom-${id}`));
    } catch {
      // keep row; next refresh reconciles
    }
  }, []);

  const ranked = results ? [...results].filter(rowIsOk).sort((a, b) => (a.latencyAvgMs ?? 1e9) - (b.latencyAvgMs ?? 1e9)) : [];

  return (
    <DisclosureScope name="dns">
      <PageHeader
        title="DNS intelligence lab"
        description="Benchmark resolvers over UDP, DoH and DoT; verify DNSSEC; watch latency history; and get evidence-based resolver recommendations."
        actions={<ScheduleChip kind="dns" />}
      />
      <DisclosureToolbar className="-mt-3 mb-2" />

      <Tabs
        value={tab}
        onValueChange={setTab}
        items={[
          { value: 'benchmark', label: 'Benchmark' },
          { value: 'recommend', label: 'Recommend' },
          { value: 'history', label: 'History' },
          { value: 'dnssec', label: 'DNSSEC' },
          { value: 'custom', label: 'Custom resolvers' },
          { value: 'leak', label: 'Leak test' },
        ]}
      >
        {/* ------------------------------ benchmark ------------------------------ */}
        <TabPanel value="benchmark">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <div className="flex overflow-hidden rounded-lg border border-line">
              {(['udp', 'both', 'doh', 'dot'] as Transport[]).map((t) => (
                <button
                  key={t}
                  onClick={() => setTransport(t)}
                  className={`px-3 py-1.5 text-xs font-medium uppercase tracking-wide transition-colors ${
                    transport === t ? 'bg-accent-soft text-accent-strong' : 'bg-surface text-muted hover:text-text'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
            <Button variant="primary" onClick={runTest} loading={running}>
              <Play size={14} /> Run benchmark
            </Button>
            <Button variant="ghost" onClick={() => setSelected(new Set(allIds))} disabled={running}>
              Select all
            </Button>
            {selected.size > 0 && (
              <span className="text-xs text-faint">{selected.size} resolver{selected.size === 1 ? '' : 's'} selected</span>
            )}
          </div>

          {catalogError != null && (
            <div className="mb-5">
              <ErrorState error={catalogError} retry={() => window.location.reload()} />
            </div>
          )}

          {running && (
            <Card className="mb-5">
              <CardBody>
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span className="text-muted">{benchmark.message ?? 'Probing resolvers…'}</span>
                  <span className="font-mono text-faint">{benchmark.pct ?? 0}%</span>
                </div>
                <Progress value={benchmark.pct ?? 0} />
              </CardBody>
            </Card>
          )}

          {error != null && (
            <div className="mb-5">
              <ErrorState error={error} retry={runTest} />
            </div>
          )}

          {groups == null && !catalogError && <EmptyState icon={<Globe size={20} />} title="Loading catalog…" message="Fetching resolver providers." />}

          {groups != null && (
            <div className="grid gap-4 lg:grid-cols-2">
              {groups.map((g) => {
                const enabled = g.resolvers.filter((r) => !r.skipBenchmarkReason);
                if (enabled.length === 0) return null;
                return (
                  <Card key={g.id}>
                    <CardHeader
                      title={g.name}
                      subtitle={g.description}
                      actions={                        <ExternalUrlLink href={g.homepage} className="text-micro text-faint underline decoration-line underline-offset-2 hover:text-muted">source</ExternalUrlLink>
                      }
                    />
                    <CardBody className="space-y-1.5">
                      {g.resolvers.map((r) => {
                        const disabled = Boolean(r.skipBenchmarkReason);
                        const checked = selected.has(r.id);
                        return (
                          <button
                            key={r.id}
                            disabled={disabled}
                            onClick={() => toggle(r.id)}
                            className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                              checked ? 'border-accent/50 bg-accent-soft/60' : 'border-line bg-surface hover:border-line/80 hover:bg-surface-2'
                            } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
                          >
                            <div className="min-w-0">
                              <div className="truncate font-medium">{r.name}</div>
                              <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-micro text-faint">
                                {r.ipv4 && <span className="font-mono">{r.ipv4}</span>}
                                {r.dotHost && <Badge>DoT</Badge>}
                                {r.dohUrl && <Badge>DoH</Badge>}
                                {r.dnssec && <Badge tone="ok">DNSSEC</Badge>}
                                {!r.verified && <span className="italic">unverified</span>}
                              </div>
                              {r.note && <div className="mt-0.5 text-micro text-faint">{r.note}</div>}
                              {r.skipBenchmarkReason && <div className="mt-0.5 text-micro text-muted">{r.skipBenchmarkReason}</div>}
                            </div>
                            <div
                              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                                checked ? 'border-accent bg-accent' : 'border-line bg-surface-2'
                              }`}
                            >
                              {checked && <span className="text-micro font-bold text-on-accent">✓</span>}
                            </div>
                          </button>
                        );
                      })}
                    </CardBody>
                  </Card>
                );
              })}
            </div>
          )}

          {results && !running && (
            <Card className="mt-6">
              <CardHeader
                title="Results"
                subtitle="Ranked by average latency across successful probes"
                icon={<Award size={15} />}
                actions={
                  results.some((r) => r.vpnActive) ? (
                    <Badge tone="warn">through VPN</Badge>
                  ) : results.length > 0 ? (
                    <Badge tone="neutral">direct</Badge>
                  ) : undefined
                }
              />
              <CardBody className="overflow-x-auto p-0">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-line text-left text-micro uppercase tracking-wider text-faint">
                      <th className="px-5 py-2.5 font-medium">#</th>
                      <th className="px-3 py-2.5 font-medium">Resolver</th>
                      <th className="px-3 py-2.5 font-medium">Transport</th>
                      <th className="px-3 py-2.5 text-right font-medium">Avg</th>
                      <th className="px-3 py-2.5 text-right font-medium">Median</th>
                      <th className="px-3 py-2.5 text-right font-medium">p95</th>
                      <th className="px-3 py-2.5 text-right font-medium">Jitter</th>
                      <th className="px-3 py-2.5 text-right font-medium">Answered</th>
                      <th className="px-3 py-2.5 text-right font-medium">Score</th>
                      <th className="px-3 py-2.5 font-medium">DNSSEC</th>
                      <th className="px-5 py-2.5 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((r) => {
                      const rank = ranked.findIndex((x) => x.providerId === r.providerId) + 1;
                      return (
                        <tr key={`${r.providerId}-${r.transport}`} className="border-b border-line/60 last:border-0">
                          <td className="px-5 py-3 font-mono text-faint">{rowIsOk(r) ? rank : '—'}</td>
                          <td className="px-3 py-3 font-medium">{r.name}</td>
                          <td className="px-3 py-3 uppercase text-faint">{r.transport}</td>
                          <td className="px-3 py-3 text-right font-mono">{r.latencyAvgMs != null ? `${r.latencyAvgMs.toFixed(1)} ms` : '—'}</td>
                          <td className="px-3 py-3 text-right font-mono text-muted">{r.latencyMedianMs != null ? `${r.latencyMedianMs.toFixed(1)} ms` : '—'}</td>
                          <td className="px-3 py-3 text-right font-mono text-muted">{r.latencyP95Ms != null ? `${r.latencyP95Ms.toFixed(1)} ms` : '—'}</td>
                          <td className="px-3 py-3 text-right font-mono text-muted">{r.jitterMs != null ? `${r.jitterMs.toFixed(1)} ms` : '—'}</td>
                          <td className="px-3 py-3 text-right font-mono text-muted">
                            {r.ok}/{r.queries}
                          </td>
                          <td className="px-3 py-3 text-right font-mono">{r.score != null ? Math.round(r.score) : '—'}</td>
                          <td className="px-3 py-3">
                            {r.dnssec === true && <Badge tone="ok">Validating</Badge>}
                            {r.dnssec === false && <Badge tone="warn">Not validating</Badge>}
                            {r.dnssec === null && <span className="text-faint">n/a</span>}
                          </td>
                          <td className="px-5 py-3">
                            <Badge tone={STATUS_TONE[r.status]}>{r.error ?? r.status}</Badge>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </CardBody>
            </Card>
          )}

          {results == null && !running && error == null && groups != null && (
            <EmptyState
              icon={<Globe size={20} />}
              title="Awaiting first benchmark"
              message="Select resolvers above (or use the defaults) and choose transports. DNSSEC is verified against a deliberately broken zone; DoT requires outbound port 853."
            />
          )}
        </TabPanel>

        {/* ----------------------------- recommend ------------------------------ */}
        <TabPanel value="recommend">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {PROFILES.map((p) => (
              <button
                key={p}
                onClick={() => {
                  setProfile(p);
                  void api.get<RecommendResult>(`/dns/recommend?profile=${p}`).then(setRecommend).catch(() => undefined);
                }}
                className={`rounded-full border px-3 py-1 text-xs font-medium capitalize transition-colors ${
                  profile === p ? 'border-accent/50 bg-accent-soft text-accent-strong' : 'border-line bg-surface text-muted hover:text-text'
                }`}
              >
                {p}
              </button>
            ))}
          </div>

          {recommend == null && (
            <EmptyState
              icon={<TrendingDown size={20} />}
              title="No recommendation yet"
              message="Run a benchmark first — recommendations are computed from the latest completed run with per-resolver reasons and confidence."
            />
          )}

          {recommend && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-mini text-muted">
                  {recommend.note}
                </p>
                {recommend.vpnActive && (
                  <Badge tone="warn">
                    measured through VPN{recommend.vpnServerName ? ` · ${recommend.vpnServerName}` : ''}
                  </Badge>
                )}
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                {recommend.entries.map((e) => (
                  <Card key={`${e.providerId}-${e.transport}`} className={e.badge ? 'border-accent/40' : ''}>
                    <CardBody>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2">
                            {e.rank != null && <span className="font-mono text-xs text-faint">#{e.rank}</span>}
                            <span className="text-sm font-semibold">{e.name}</span>
                            {e.badge && <Badge tone={e.badge === 'recommended' ? 'ok' : e.badge === 'keep-current' ? 'neutral' : 'ok'}>{e.badge}</Badge>}
                          </div>
                          <div className="mt-1 text-micro uppercase tracking-wide text-faint">{e.transport}</div>
                        </div>
                        <div className="text-right">
                          <div className="font-mono text-lg">{e.score != null ? Math.round(e.score) : '—'}</div>
                          <Badge tone={CONF_TONE[e.confidence]}>{e.confidence} confidence</Badge>
                        </div>
                      </div>
                      <ul className="mt-3 space-y-1">
                        {e.reasons.map((r, i) => (
                          <li key={i} className="text-xs text-muted">
                            • {r}
                          </li>
                        ))}
                      </ul>
                    </CardBody>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </TabPanel>

        {/* ------------------------------ history ------------------------------- */}
        <TabPanel value="history">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            {RANGES.map((r) => (
              <button
                key={r.id}
                onClick={() => {
                  setHistoryRange(r.id);
                  refreshHistory();
                }}
                className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
                  historyRange === r.id ? 'border-accent/50 bg-accent-soft text-accent-strong' : 'border-line bg-surface text-muted hover:text-text'
                }`}
              >
                {r.label}
              </button>
            ))}
            <Button variant="ghost" onClick={refreshHistory}>
              Refresh
            </Button>
          </div>

          {history == null && (
            <EmptyState icon={<Globe size={20} />} title="No history yet" message="Completed benchmarks are persisted automatically. History powers the latency and reliability trend charts." />
          )}

          {history != null && history.length === 0 && (
            <EmptyState icon={<Globe size={20} />} title="Nothing in this window" message="Run a benchmark to start the time series." />
          )}

          {history != null && history.length > 0 && (
            <div className="grid gap-4 lg:grid-cols-2">
              {history.map((s) => {
                const last = s.points[s.points.length - 1];
                return (
                  <Card key={`${s.providerId}-${s.transport}`}>
                    <CardHeader
                      title={s.name}
                      subtitle={`${s.transport.toUpperCase()} · ${s.points.length} benchmark${s.points.length === 1 ? '' : 's'}`}
                      actions={
                        <span className="text-xs text-muted">
                          latest <span className="font-mono">{last?.latencyAvgMs != null ? `${last.latencyAvgMs.toFixed(1)} ms` : '—'}</span>
                        </span>
                      }
                    />
                    <CardBody>
                      <LatencyChart
                        data={s.points.map((p) => ({ t: p.ts, ms: p.latencyAvgMs }))}
                        height={90}
                      />
                      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                        <div>
                          <div className="text-micro uppercase tracking-wider text-faint">Reliability</div>
                          <div className="font-mono text-sm">
                            {last?.reliabilityPct != null ? `${Math.round(last.reliabilityPct)}%` : '—'}
                          </div>
                        </div>
                        <div>
                          <div className="text-micro uppercase tracking-wider text-faint">Timeouts</div>
                          <div className="font-mono text-sm">{last?.timeouts ?? '—'}</div>
                        </div>
                        <div>
                          <div className="text-micro uppercase tracking-wider text-faint">Score</div>
                          <div className="font-mono text-sm">{last?.score != null ? Math.round(last.score) : '—'}</div>
                        </div>
                      </div>
                    </CardBody>
                  </Card>
                );
              })}
            </div>
          )}
        </TabPanel>

        {/* ------------------------------ dnssec -------------------------------- */}
        <TabPanel value="dnssec">
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <select
              value={deepSpecId}
              onChange={(e) => setDeepSpecId(e.target.value)}
              className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent/80"
            >
              <option value="">Pick a resolver…</option>
              {benchmarkable
                .filter((r) => r.ipv4 && !r.skipBenchmarkReason)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} ({r.ipv4})
                  </option>
                ))}
            </select>
            <Button variant="primary" onClick={runDeep} loading={deepBusy} disabled={!deepSpecId}>
              <ShieldCheck size={14} /> Run deep DNSSEC check
            </Button>
          </div>

          {customError != null && (
            <div className="mb-4">
              <ErrorState error={customError} />
            </div>
          )}

          {deep && (
            <Card className={deep.classification === 'validating' ? 'border-ok/40' : deep.classification === 'not-validating' ? 'border-danger/40' : ''}>
              <CardHeader
                title={`${deep.name} — ${deep.classification.replace('-', ' ')}`}
                subtitle="Multi-signal check: deliberately broken zone + authenticated-data on a signed zone"
              />
              <CardBody>
                <div className="mb-3 flex flex-wrap gap-2">
                  <Badge tone={deep.classification === 'validating' ? 'ok' : deep.classification === 'not-validating' ? 'danger' : 'neutral'}>
                    {deep.classification === 'validating' ? 'DNSSEC validation confirmed' : deep.classification === 'not-validating' ? 'Not validating' : deep.classification === 'unreachable' ? 'Unreachable' : 'Inconclusive'}
                  </Badge>
                  <span className="text-xs text-faint">
                    broken zone: <span className="font-mono">{deep.brokenZone}</span> · AD bit:{' '}
                    <span className="font-mono">{deep.adBit == null ? 'n/a' : deep.adBit ? 'set' : 'not set'}</span>
                  </span>
                </div>
                <p className="text-mini leading-relaxed text-muted">{deep.detail}</p>
              </CardBody>
            </Card>
          )}

          {deep == null && !deepBusy && (
            <EmptyState
              icon={<ShieldCheck size={20} />}
              title="DNSSEC deep check"
              message="Queries the deliberately broken zone dnssec-failed.org (a validating resolver must SERVFAIL it) and watches the authenticated-data bit on a signed zone. Two signals, combined before classifying."
            />
          )}
        </TabPanel>

        {/* ------------------------------ custom -------------------------------- */}
        <TabPanel value="custom">
          <Card
            className="mb-5"
            fold={{ id: 'add-resolver', defaultOpen: false, summary: 'name, address and optional DoH/DoT — public addresses only' }}
          >
            <CardHeader title="Add a custom resolver" subtitle="Public addresses only — private, loopback and metadata ranges are rejected." icon={<Plus size={15} />} />
            <CardBody>
              <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                <Field label="Name">
                  <Input value={customForm.name} onChange={(e) => setCustomForm((f) => ({ ...f, name: e.target.value }))} placeholder="My router DoH" />
                </Field>
                <Field label="IPv4">
                  <Input value={customForm.ipv4} onChange={(e) => setCustomForm((f) => ({ ...f, ipv4: e.target.value }))} placeholder="1.2.3.4" />
                </Field>
                <Field label="IPv6 (optional)">
                  <Input value={customForm.ipv6} onChange={(e) => setCustomForm((f) => ({ ...f, ipv6: e.target.value }))} placeholder="2001:db8::1" />
                </Field>
                <Field label="DoH URL (optional)">
                  <Input value={customForm.dohUrl} onChange={(e) => setCustomForm((f) => ({ ...f, dohUrl: e.target.value }))} placeholder="https://dns.example.com/dns-query" />
                </Field>
                <Field label="DoT hostname (optional)">
                  <Input value={customForm.dotHost} onChange={(e) => setCustomForm((f) => ({ ...f, dotHost: e.target.value }))} placeholder="dns.example.com" />
                </Field>
                <div className="flex items-end pb-1">
                  <label className="flex items-center gap-2 text-sm text-muted">
                    <input
                      type="checkbox"
                      checked={customForm.dnssec}
                      onChange={(e) => setCustomForm((f) => ({ ...f, dnssec: e.target.checked }))}
                      className="accent-accent"
                    />
                    Validates DNSSEC
                  </label>
                </div>
              </div>
              <div className="mt-4">
                <Button variant="primary" onClick={addCustom} disabled={!customForm.name || (!customForm.ipv4 && !customForm.ipv6 && !customForm.dohUrl && !customForm.dotHost)}>
                  <Plus size={14} /> Add resolver
                </Button>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Your resolvers" subtitle={`${customList.length} stored in settings`} />
            <CardBody className="space-y-2">
              {customList.length === 0 && <p className="text-sm text-muted">No custom resolvers yet.</p>}
              {customList.map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <span className="font-medium">{r.name}</span>
                    <span className="ml-2 font-mono text-xs text-faint">
                      {r.ipv4 ?? ''}{r.dohUrl ? ' · DoH' : ''}{r.dotHost ? ' · DoT' : ''}
                    </span>
                  </div>
                  <button onClick={() => removeCustom(r.id.replace(/^custom-/, ''))} className="text-muted hover:text-danger" aria-label={`Remove ${r.name}`}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </CardBody>
          </Card>
        </TabPanel>

        {/* ------------------------------ leak ---------------------------------- */}
        <TabPanel value="leak">
          <div className="mb-5">
            <Button variant="primary" onClick={() => api.post<{ testId: string }>('/dns/leak-test').then((r) => setLeakId(r.testId))} loading={leakRunning}>
              <ShieldCheck size={14} /> Run leak test
            </Button>
          </div>

          {leak == null && !leakRunning && (
            <EmptyState
              icon={<ShieldCheck size={20} />}
              title="No leak check yet"
              message="Identifies the egress resolver behind each configured system DNS server, then flags resolvers that do not match your preferred DNS setting."
            />
          )}

          {leak && (
            <div className="space-y-5">
              <Card className={leak.leaked ? 'border-danger/40' : 'border-ok/40'}>
                <CardBody className="flex items-start gap-3">
                  {leak.leaked ? <ShieldX size={22} className="mt-0.5 shrink-0 text-danger" /> : <ShieldCheck size={22} className="mt-0.5 shrink-0 text-ok" />}
                  <div>
                    <h3 className={`text-sm font-semibold ${leak.leaked ? 'text-danger' : 'text-ok'}`}>
                      {leak.leaked ? 'DNS mismatch detected' : 'No obvious leak detected'}
                    </h3>
                    <p className="mt-1.5 text-mini leading-relaxed text-muted">{leak.explanation}</p>
                  </div>
                </CardBody>
              </Card>
              <Card>
                <CardHeader title="Detected resolvers" subtitle="Egress identities from resolver-identification lookups" />
                <CardBody>
                  <ul className="space-y-3">
                    {leak.resolvers.map((r, i) => (
                      <li key={`${r.ip}-${i}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                        <span className="font-mono text-text">{r.ip}</span>
                        {r.hostname && <span className="text-xs text-muted">{r.hostname}</span>}
                        <Badge tone={r.expected ? 'ok' : 'warn'} className="ml-auto">
                          {r.expected ? 'expected' : 'unexpected'}
                        </Badge>
                      </li>
                    ))}
                    {leak.resolvers.length === 0 && <li className="text-sm text-muted">No system DNS servers could be enumerated on this platform.</li>}
                  </ul>
                </CardBody>
              </Card>
            </div>
          )}
        </TabPanel>
      </Tabs>
    </DisclosureScope>
  );
}
