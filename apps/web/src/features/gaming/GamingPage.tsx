import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Activity, Gamepad2, Play, Radio, ShieldCheck, Square, TrendingUp } from 'lucide-react';

import { Gauge } from '@/components/charts/Gauge';
import { LatencyChart } from '@/components/charts/LatencyChart';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { DisclosureScope, DisclosureToolbar } from '@/components/ui/Disclosure';
import { PageHeader } from '@/components/ui/PageHeader';
import { ScheduleChip } from '@/components/ScheduleChip';
import { Progress } from '@/components/ui/Progress';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { TabPanel, Tabs } from '@/components/ui/Tabs';
import { api } from '@/lib/api';
import { usePersistentId, usePersistentState } from '@/lib/usePersistentState';
import { useBackgroundTest } from '@/lib/useBackgroundTest';
import { subscribeTest } from '@/lib/ws';

import type { GameDefinition, GameRegionResult, GamingComparison, GamingSessionState, GamingTestResult } from '@netpulse/shared';

const RANK_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'neutral'> = {
  'best-region': 'ok',
  'second-best': 'ok',
  unstable: 'warn',
  'not-recommended': 'neutral',
};

const METHOD_LABEL: Record<string, string> = {
  'tcp-connect': 'TCP connect RTT',
  'tls-handshake': 'TLS handshake RTT',
  'icmp-rtt': 'ICMP RTT',
  http: 'HTTP RTT',
};

const REACH_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'neutral'> = {
  reachable: 'ok',
  'service-reachable-icmp-blocked': 'ok',
  partial: 'warn',
  timeout: 'warn',
  'dns-failure': 'neutral',
  'connection-refused': 'danger',
  unreachable: 'danger',
  unknown: 'neutral',
};

export default function GamingPage() {
  const [tab, setTab] = usePersistentState<string>('gaming.tab', 'regions');

  const [games, setGames] = useState<GameDefinition[]>([]);
  const [catalogError, setCatalogError] = useState<unknown>(null);
  const [gameId, setGameId] = usePersistentState<string>('gaming.gameId', '');
  const [showNote, setShowNote] = useState(false);

  // Test ID persists across tab switches — useBackgroundTest re-attaches to
  // the WS stream AND the persisted record on remount.
  const [testId, setTestId] = usePersistentId('gaming.testId');
  // The server publishes the full GamingTestResult as `result` on test:done,
  // and the poll fallback replays the persisted summary with the same shape.
  const test = useBackgroundTest<GamingTestResult>(testId);
  const results = test.result ?? null;
  const running = test.running;
  const error = test.error;

  // Gaming sessions outlive the page (server-side sampler at intervalMs);
  // re-attach on remount via the session detail endpoint instead of orphaning
  // the user's live session view.
  const [session, setSession] = useState<GamingSessionState | null>(null);
  const [sessionError, setSessionError] = useState<unknown>(null);
  const [compare, setCompare] = useState<GamingComparison | null>(null);
  const [compareBusy, setCompareBusy] = useState<null | 'direct' | 'vpn'>(null);

  useEffect(() => {
    api
      .get<{ games: GameDefinition[] }>('/gaming/games')
      .then((res) => {
        setGames(res.games);
        const wanted = new URLSearchParams(window.location.search).get('game');
        const first = res.games.find((g) => g.id === wanted) ?? res.games[0] ?? null;
        if (first) setGameId(first.id);
      })
      .catch(setCatalogError);
  }, []);

  const game = useMemo(() => games.find((g) => g.id === gameId) ?? null, [games, gameId]);

  const runTest = useCallback(async () => {
    if (!gameId) return;
    try {
      const res = await api.post<{ testId: string }>('/gaming/test', { gameId });
      setTestId(res.testId);
      setTab('regions');
    } catch (err) {
      setCatalogError(err);
    }
  }, [gameId]);

  const startSession = useCallback(async () => {
    if (!gameId) return;
    setSessionError(null);
    try {
      const res = await api.post<GamingSessionState>('/gaming/session', { gameId, intervalMs: 10_000 });
      setSession(res);
      try { sessionStorage.setItem('np.ui.gaming.sessionId', JSON.stringify({ id: res.sessionId })); } catch { /* unmounted state */ }
    } catch (err) {
      setSessionError(err);
    }
  }, [gameId]);

  const stopSession = useCallback(async () => {
    if (!session?.sessionId) return;
    try {
      const res = await api.post<{ stopped: boolean; state: GamingSessionState }>(`/gaming/session/${session.sessionId}/stop`);
      if (res.state) setSession(res.state);
      try { sessionStorage.removeItem('np.ui.gaming.sessionId'); } catch { /* ignore */ }
    } catch (err) {
      setSessionError(err);
    }
  }, [session]);

  // Re-attach to a session started before a tab switch / remount.
  useEffect(() => {
    if (session) return; // live state already present
    let savedId: string | null = null;
    try {
      const raw = sessionStorage.getItem('np.ui.gaming.sessionId');
      savedId = raw ? (JSON.parse(raw) as { id: string }).id : null;
    } catch {
      savedId = null;
    }
    if (!savedId) return;
    void api
      .get<GamingSessionState>(`/gaming/session/${encodeURIComponent(savedId)}`)
      .then((s) => {
        if (s.running || s.samples.length > 0) setSession(s);
        else sessionStorage.removeItem('np.ui.gaming.sessionId');
      })
      .catch(() => sessionStorage.removeItem('np.ui.gaming.sessionId'));
  }, [session]);

  // deep-linkable quick checks: /gaming?game=valorant&run=1 or &session=1
  const [searchParams] = useSearchParams();
  const didRunRef = useRef(false);
  const didSessionRef = useRef(false);
  useEffect(() => {
    if (!games.length || !gameId) return;
    if (searchParams.get('run') === '1' && !didRunRef.current) {
      didRunRef.current = true;
      void runTest();
    } else if (searchParams.get('session') === '1' && !didSessionRef.current) {
      didSessionRef.current = true;
      void startSession();
    }
    // deep-link quick start fires once once the catalog is loaded
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [games, gameId, searchParams]);

  // live samples + events for the running session
  const sessionId = session?.sessionId ?? null;
  const sessionRunning = session?.running ?? false;
  useEffect(() => {
    if (!sessionId) return;
    return subscribeTest(sessionId, (msg) => {
      if (msg.type === 'gaming:sample') {
        const sample = (msg as unknown as { sample: GamingSessionState['samples'][number] }).sample;
        setSession((s) => (s ? { ...s, samples: [...s.samples, sample].slice(-500) } : s));
      } else if (msg.type === 'gaming:event') {
        const ev = (msg as unknown as { event: { ts: number; message: string } }).event;
        setSession((s) => (s ? { ...s, events: [...s.events, ev].slice(-200) } : s));
      }
    });
  }, [sessionId]);

  const captureCompare = useCallback(
    async (mode: 'direct' | 'vpn') => {
      if (!gameId) return;
      setCompareBusy(mode);
      try {
        await api.post('/gaming/compare', { gameId, mode });
        const res = await api.get<GamingComparison>(`/gaming/compare?gameId=${encodeURIComponent(gameId)}`);
        setCompare(res);
      } catch (err) {
        setCompareBusy(null);
        setSessionError(err);
      }
    },
    [gameId],
  );

  const loadCompare = useCallback(async () => {
    if (!gameId) return;
    const res = await api.get<GamingComparison>(`/gaming/compare?gameId=${encodeURIComponent(gameId)}`).catch(() => null);
    if (res) setCompare(res);
  }, [gameId]);

  useEffect(() => {
    void loadCompare();
  }, [loadCompare]);

  const sessionLatency = useMemo(() => session?.samples.map((s) => ({ t: s.ts, ms: s.latencyMs })) ?? [], [session]);
  const sessionEvents = session?.events ?? [];

  return (
    <DisclosureScope name="gaming">
      <PageHeader
        title="Gaming network intelligence"
        description="Measure reachability and latency to documented publisher service endpoints per region, rank your best regions, then monitor stability while you play."
        actions={<ScheduleChip kind="gaming" />}
      />

      <Card className="mb-6">
        <CardBody>
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={gameId}
              onChange={(e) => setGameId(e.target.value)}
              className="min-w-52 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-text outline-none focus:border-accent"
            >
              {games.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                  {g.category === 'platform' ? ' (platform)' : ''}
                </option>
              ))}
            </select>
            <Button variant="primary" onClick={runTest} loading={running} disabled={!gameId}>
              <Play size={14} /> Test regions
            </Button>
            <Button variant="ghost" onClick={startSession} disabled={!gameId || sessionRunning}>
              <Radio size={14} /> Start session monitor
            </Button>
            <button onClick={() => setShowNote((v) => !v)} className="text-xs text-faint underline decoration-line underline-offset-2 hover:text-muted">
              methodology
            </button>
          </div>

          {game?.note && showNote && (
            <p className="mt-3 rounded-lg border border-line bg-surface-2 px-3 py-2 text-[12px] leading-relaxed text-muted">{game.note}</p>
          )}
          {game?.statusUrl && (
            <p className="mt-2 text-[11px] text-faint">
              Publisher status: <a className="underline decoration-line underline-offset-2 hover:text-muted" href={game.statusUrl} target="_blank" rel="noreferrer">{game.statusUrl}</a>
            </p>
          )}
        </CardBody>
      </Card>

      {catalogError != null && (
        <div className="mb-5">
          <ErrorState error={catalogError} retry={runTest} />
        </div>
      )}

      <DisclosureToolbar className="-mt-3 mb-2" />

      <Tabs
        value={tab}
        onValueChange={setTab}
        items={[
          { value: 'regions', label: 'Region latency' },
          { value: 'session', label: 'Session monitor' },
          { value: 'compare', label: 'Direct vs VPN' },
        ]}
      >
        <TabPanel value="regions">
          {running && (
            <Card className="mb-5">
              <CardBody>
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span className="text-muted">{test.message ?? 'Measuring regions…'}</span>
                  <span className="font-mono text-faint">{test.pct ?? 0}%</span>
                </div>
                <Progress value={test.pct ?? 0} />
              </CardBody>
            </Card>
          )}

          {error != null && (
            <div className="mb-5">
              <ErrorState error={error} retry={runTest} />
            </div>
          )}

          {results == null && !running && error == null && (
            <EmptyState
              icon={<Gamepad2 size={20} />}
              title="Run a region test"
              message="Tests each region's documented service front door with a TCP connect or TLS handshake and ranks regions by latency, reachability and stability."
            />
          )}

          {results && (
            <div className="space-y-5">
              {results.regions.length > 0 && results.regions.every((r) => r.reachability !== 'reachable') && (
                <Card className="border-warn/40 bg-warn/5">
                  <CardBody>
                    <div className="flex items-center gap-2 text-sm font-medium text-warn">
                      <ShieldCheck size={14} /> Nothing reachable — likely geo-filtering, not an outage
                    </div>
                    <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
                      Every region front door failed from your network. From a geo-filtered or sanctioned region (most game
                      publishers block Iranian IPs, for example), this usually means the publisher is blocking your country — the
                      same endpoint often works fine elsewhere. Try benchmarking DNS in the <b>DNS Lab</b> (it lists Iranian
                      resolvers such as Shecan and Begzar that restore access to sanctioned services) and retest, or open the{' '}
                      <b>Direct vs VPN</b> tab to measure whether a tunnel restores reachability.
                    </p>
                  </CardBody>
                </Card>
              )}
              {results.score && (
                <Card>
                  <CardBody className="flex flex-wrap items-center gap-6">
                    <div className="flex flex-col items-center gap-2">
                      <Gauge value={results.score.score} label={`Gaming score · ${results.gameName}`} size={150} />
                      {results.vpnActive && (
                        <Badge tone="warn">
                          through VPN{results.vpnServerName ? ` · ${results.vpnServerName}` : ''}
                        </Badge>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3 className="mb-3 text-sm font-semibold">What feeds the score</h3>
                      <div className="grid gap-2 sm:grid-cols-2">
                        {results.score.components.map((c) => (
                          <div key={c.key} className="flex items-start justify-between gap-2 rounded-lg border border-line bg-surface px-3 py-2">
                            <div className="min-w-0">
                              <div className="text-xs font-medium capitalize">{c.label}</div>
                              <div className="mt-0.5 text-[11px] text-faint">{c.detail}</div>
                            </div>
                            <Badge tone={c.band === 'excellent' ? 'ok' : c.band === 'good' ? 'ok' : c.band === 'fair' ? 'warn' : c.band === 'poor' ? 'danger' : 'neutral'}>
                              {c.band}
                            </Badge>
                          </div>
                        ))}
                      </div>
                    </div>
                  </CardBody>
                </Card>
              )}

              <div className="grid gap-4 lg:grid-cols-2">
                {results.regions.map((r: GameRegionResult) => (
                  <Card
                    key={r.regionId}
                    className={r.rankLabel === 'best-region' ? 'border-ok/40' : r.rankLabel === 'not-recommended' ? 'opacity-80' : ''}
                    fold={{
                      id: `region-${r.regionId}`,
                      // Open: the region list IS this test's result, so a folded
                      // default would hide the answer. Folding is for parking the
                      // regions you are not comparing right now — and the folded
                      // header still carries this region's own numbers.
                      defaultOpen: true,
                      summary: `${r.latencyMs != null ? `${Math.round(r.latencyMs)} ms` : 'no response'} · ${r.reachability.replace(/-/g, ' ')}${r.score != null ? ` · score ${Math.round(r.score)}` : ''}`,
                    }}
                  >
                    <CardHeader
                      title={r.rank != null ? `#${r.rank} · ${r.regionName}` : r.regionName}
                      subtitle={
                        <span className="flex flex-wrap items-center gap-1.5">
                          {r.rankLabel && <Badge tone={RANK_TONE[r.rankLabel]}>{r.rankLabel.replace('-', ' ')}</Badge>}
                          <Badge tone={REACH_TONE[r.reachability] ?? 'neutral'}>{r.reachability.replace(/-/g, ' ')}</Badge>
                        </span>
                      }
                      actions={
                        <div className="text-right">
                          <div className="font-mono text-base">{r.latencyMs != null ? `${Math.round(r.latencyMs)} ms` : '—'}</div>
                          {r.score != null && <div className="text-[11px] text-faint">score {Math.round(r.score)}</div>}
                        </div>
                      }
                    />
                    <CardBody>
                      <p className="text-[12px] leading-relaxed text-muted">{r.reason}</p>
                      <ul className="mt-3 space-y-1 border-t border-line/60 pt-2">
                        {r.endpoints.map((e, i) => (
                          <li key={i} className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span
                                title={e.endpoint.source ? `Source: ${e.endpoint.source}${e.endpoint.note ? ` — ${e.endpoint.note}` : ''}` : undefined}
                                className={e.endpoint.verified ? 'shrink-0 text-ok' : 'shrink-0 text-faint'}
                              >
                                {e.endpoint.verified ? '✓' : '?'}
                              </span>
                              <span className="truncate font-mono text-text">{e.endpoint.hostname}</span>
                            </span>
                            <span className="flex items-center gap-2 text-faint">
                              {METHOD_LABEL[e.method] ?? e.method}
                              {e.latencyMs != null && <span className="font-mono text-muted">{Math.round(e.latencyMs)} ms</span>}
                              {e.reachability !== 'reachable' && e.error && <span className="text-faint">{e.error.slice(0, 40)}</span>}
                            </span>
                          </li>
                        ))}
                      </ul>
                      <p className="mt-1.5 text-[10px] leading-relaxed text-faint">
                        ✓ = verified against official documentation · ? = documented at time of writing, not re-verified today — hover for the source.
                      </p>
                    </CardBody>
                  </Card>
                ))}
              </div>
            </div>
          )}
        </TabPanel>

        <TabPanel value="session">
          {sessionError != null && (
            <div className="mb-4">
              <ErrorState error={sessionError} retry={startSession} />
            </div>
          )}

          {!session && (
            <EmptyState
              icon={<Activity size={20} />}
              title="Monitor a session"
              message="Samples latency every 10 seconds to the selected game's endpoint, records spikes and interruptions, and persists samples to history."
            />
          )}

          {session && (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-sm">
                  <Badge tone={sessionRunning ? 'ok' : 'neutral'}>{sessionRunning ? 'running' : 'stopped'}</Badge>
                  <span className="text-muted">
                    {session.samples.length} sample{session.samples.length === 1 ? '' : 's'} · every {session.intervalMs / 1000}s
                  </span>
                </div>
                {sessionRunning ? (
                  <Button variant="danger" onClick={stopSession}>
                    <Square size={14} /> Stop monitor
                  </Button>
                ) : (
                  <Button variant="ghost" onClick={startSession}>
                    <Radio size={14} /> Restart
                  </Button>
                )}
              </div>

              <Card
                fold={{
                  id: 'session-latency',
                  pinned: true,
                  summary: `${session.samples.length} sample${session.samples.length === 1 ? '' : 's'} · every ${session.intervalMs / 1000}s`,
                }}
              >
                <CardHeader title="Latency over time" subtitle="Live samples from the session target" icon={<TrendingUp size={15} />} />
                <CardBody>
                  <LatencyChart data={sessionLatency} height={150} />
                </CardBody>
              </Card>

              {sessionEvents.length > 0 && (
                <Card
                  fold={{
                    id: 'session-events',
                    summary: `${sessionEvents.length} event${sessionEvents.length === 1 ? '' : 's'} recorded this session`,
                  }}
                >
                  <CardHeader title="Detected events" subtitle="Spikes, loss bursts and connectivity changes" />
                  <CardBody>
                    <ul className="space-y-2">
                      {[...sessionEvents].reverse().map((ev, i) => (
                        <li key={`${ev.ts}-${i}`} className="flex items-start gap-3 text-sm">
                          <span className="mt-0.5 font-mono text-[11px] text-faint">
                            {new Date(ev.ts).toLocaleTimeString()}
                          </span>
                          <span className="text-muted">{ev.message}</span>
                        </li>
                      ))}
                    </ul>
                  </CardBody>
                </Card>
              )}
            </div>
          )}
        </TabPanel>

        <TabPanel value="compare">
          <div className="mb-5 flex flex-wrap items-center gap-3">
            <Button variant="ghost" onClick={() => captureCompare('direct')} loading={compareBusy === 'direct'} disabled={!gameId}>
              <ShieldCheck size={14} /> Capture DIRECT
            </Button>
            <Button variant="ghost" onClick={() => captureCompare('vpn')} loading={compareBusy === 'vpn'} disabled={!gameId}>
              <ShieldCheck size={14} /> Capture via VPN
            </Button>
            <p className="w-full text-[12px] text-faint">
              Capture once without the VPN and once with the VPN connected, then compare. The tool only claims a VPN improves routing when measurements show it.
            </p>
          </div>

          {compare == null && (
            <EmptyState icon={<ShieldCheck size={20} />} title="No comparison yet" message="Run one capture without the VPN and one through the tunnel." />
          )}

          {compare && (
            <div className="space-y-4">
              <Card className={compare.winner === 'vpn' ? 'border-ok/40' : ''}>
                <CardBody>
                  <div className="mb-4 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-lg border border-line bg-surface p-4">
                      <div className="text-[11px] uppercase tracking-wider text-faint">Direct</div>
                      <div className="mt-1 font-mono text-2xl">{compare.direct?.latencyMs != null ? `${Math.round(compare.direct.latencyMs)} ms` : 'not captured'}</div>
                      {compare.direct && <div className="mt-1 text-[11px] text-faint">{new Date(compare.direct.createdAt).toLocaleString()}</div>}
                    </div>
                    <div className="rounded-lg border border-line bg-surface p-4">
                      <div className="text-[11px] uppercase tracking-wider text-faint">VPN {compare.vpn?.serverName ? `· ${compare.vpn.serverName}` : ''}</div>
                      <div className="mt-1 font-mono text-2xl">{compare.vpn?.latencyMs != null ? `${Math.round(compare.vpn.latencyMs)} ms` : 'not captured'}</div>
                      {compare.vpn && <div className="mt-1 text-[11px] text-faint">{new Date(compare.vpn.createdAt).toLocaleString()}</div>}
                    </div>
                  </div>
                  {compare.winner && (
                    <div className="flex items-center gap-2">
                      <Badge tone="ok">{compare.winner === 'vpn' ? 'VPN path faster' : 'Direct path faster'}</Badge>
                      {compare.differenceMs != null && <span className="font-mono text-sm text-muted">− {Math.round(compare.differenceMs)} ms</span>}
                      <Badge tone={compare.confidence === 'high' ? 'ok' : 'warn'}>{compare.confidence} confidence</Badge>
                    </div>
                  )}
                  <p className="mt-3 text-[13px] leading-relaxed text-muted">{compare.reason}</p>
                </CardBody>
              </Card>
            </div>
          )}
        </TabPanel>
      </Tabs>
    </DisclosureScope>
  );
}

