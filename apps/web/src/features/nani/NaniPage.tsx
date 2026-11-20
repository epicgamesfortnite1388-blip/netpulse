import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import {
  Activity,
  Brain,
  CheckCircle2,
  ChevronRight,
  Clock,
  Cpu,
  Database,
  HeartPulse,
  History as HistoryIcon,
  Loader2,
  MessageSquare,
  Network as NetworkIcon,
  Play,
  Radar,
  RefreshCw,
  Search,
  Send,
  Settings as SettingsIcon,
  Shield,
  ShieldCheck,
  Sparkles,
  Trash2,
  Zap,
} from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/States';
import { Input } from '@/components/ui/Field';
import { Metric } from '@/components/ui/Metric';
import { PageHeader } from '@/components/ui/PageHeader';
import { Notice } from '@/components/ui/Surface';
import { TabPanel, Tabs } from '@/components/ui/Tabs';

import {
  cancelInvestigation,
  explain,
  fetchDriftEvents,
  fetchHypothesisView,
  fetchLearningStatus,
  fetchNaniStatus,
  isDesktopNani,
  listInvestigations,
  runHealthCheck,
  startInvestigation,
  type HypothesisViewDto,
  type NaniLearningStatusDto,
  type NaniStatusDto,
  type NaniWebStatusDto,
} from './naniApi';
import { lastFailedHealthSignal, type NaniEventState } from './naniEvents';
import {
  deleteConversation,
  loadConversations,
  loadInvestigations,
  saveConversations,
  saveInvestigations,
  newId,
  clearNaniHistory,
  type NaniConversation,
  type NaniInvestigationRecord,
} from './naniStore';
import { calibrationDisplay, formatNats, formatShift, toRows } from './hypothesisView';
import { useNaniEvents } from './useNaniEvents';
import { RecoveryControls } from './RecoveryControls';

type Tab =
  | 'overview'
  | 'live'
  | 'recovery'
  | 'workspace'
  | 'hypotheses'
  | 'evidence'
  | 'network'
  | 'learning'
  | 'history'
  | 'settings';

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'overview', label: 'Overview', icon: <Brain size={14} /> },
  { id: 'live', label: 'Live Investigation', icon: <Activity size={14} /> },
  { id: 'recovery', label: 'Recovery', icon: <ShieldCheck size={14} /> },
  { id: 'workspace', label: 'AI Workspace', icon: <MessageSquare size={14} /> },
  { id: 'hypotheses', label: 'Hypotheses', icon: <Radar size={14} /> },
  { id: 'evidence', label: 'Evidence', icon: <Database size={14} /> },
  { id: 'network', label: 'Network Intel', icon: <NetworkIcon size={14} /> },
  { id: 'learning', label: 'Learning', icon: <Zap size={14} /> },
  { id: 'history', label: 'History', icon: <HistoryIcon size={14} /> },
  { id: 'settings', label: 'Settings', icon: <SettingsIcon size={14} /> },
];

/* ------------------------------------------------------------------ */
/*  AI activity core                                                   */
/* ------------------------------------------------------------------ */

function AiCore({ state }: { state: string }) {
  const active = !['Idle', 'Completed', 'Failed', 'Cancelled'].includes(state);
  return (
    <div className="relative mx-auto mb-7 flex h-40 w-40 items-center justify-center">
      <div className={`absolute inset-0 rounded-full border-2 ${active ? 'border-accent/40' : 'border-line'}`} />
      <div className={`absolute inset-4 rounded-full border ${active ? 'border-accent/60' : 'border-line'}`} />
      <div className={`flex h-20 w-20 items-center justify-center rounded-full ${active ? 'bg-accent/15' : 'bg-surface-2'}`}>
        <Brain size={32} className={active ? 'text-accent' : 'text-muted'} />
      </div>
      {active && (
        <div className="absolute inset-0 rounded-full border-2 border-accent/20 animate-pulse-dot" />
      )}
      <div className="absolute -bottom-6 text-xs font-medium text-muted">{state}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Derived views from real events                                     */
/* ------------------------------------------------------------------ */

interface DerivedHypothesis {
  id: string;
  confidence: number;
}

function deriveHypotheses(state: NaniEventState): DerivedHypothesis[] {
  for (let i = state.events.length - 1; i >= 0; i -= 1) {
    const e = state.events[i];
    if (!e) continue;
    if (e.type === 'DiagnosisUpdated') {
      const raw = e.payload.hypotheses;
      if (Array.isArray(raw)) {
        const out: DerivedHypothesis[] = [];
        for (const pair of raw) {
          if (Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'number') {
            out.push({ id: pair[0], confidence: pair[1] });
          }
        }
        if (out.length > 0) return out.sort((a, b) => b.confidence - a.confidence);
      }
    }
    if (e.type === 'nani:diagnosis:completed') {
      const top = e.payload.top;
      const conf = e.payload.confidence;
      if (typeof top === 'string' && typeof conf === 'number') {
        return [{ id: top, confidence: conf }];
      }
    }
  }
  return [];
}

interface DerivedEvidence {
  id: string;
  type: string;
  detail: string;
  at: number;
}

function deriveEvidence(state: NaniEventState): DerivedEvidence[] {
  const out: DerivedEvidence[] = [];
  for (const e of state.events) {
    if (e.type === 'FailureDetected') {
      out.push({
        id: `${e.seq}`,
        type: String(e.payload.category ?? 'failure'),
        detail: String(e.payload.summary ?? 'classified failure'),
        at: e.at,
      });
    } else if (e.type === 'nani:health:updated') {
      out.push({
        id: `${e.seq}`,
        type: 'health',
        detail: `status ${String(e.payload.status ?? '?')}${e.payload.latencyMs ? ` · ${String(e.payload.latencyMs)}ms` : ''}`,
        at: e.at,
      });
    } else if (e.type === 'DriftDetected') {
      out.push({
        id: `${e.seq}`,
        type: 'drift',
        detail: `metric ${String(e.payload.metric ?? '?')}`,
        at: e.at,
      });
    }
  }
  return out.reverse();
}

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export function NaniPage() {
  const [tab, setTab] = useState<Tab>('overview');
  const { state: events, available: eventsAvailable } = useNaniEvents();

  const [status, setStatus] = useState<{ desktop: NaniStatusDto | null; web: NaniWebStatusDto | null } | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [lastCheck, setLastCheck] = useState<LastHealthCheck | null>(null);

  const [learning, setLearning] = useState<NaniLearningStatusDto | null>(null);
  const [drift, setDrift] = useState<Array<Record<string, unknown>>>([]);

  const refreshStatus = useCallback(async () => {
    setStatusError(null);
    try {
      setStatus(await fetchNaniStatus());
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'status unavailable');
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (tab !== 'learning') return;
    let cancelled = false;
    void (async () => {
      try {
        const [l, d] = await Promise.all([fetchLearningStatus(), fetchDriftEvents()]);
        if (!cancelled) {
          setLearning(l);
          setDrift(d);
        }
      } catch {
        if (!cancelled) setLearning(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab]);

  const doHealthCheck = useCallback(async () => {
    setChecking(true);
    setCheckError(null);
    setCheckResult(null);
    try {
      const res = await runHealthCheck();
      const raw = res.desktop ?? `Health check complete: ${res.webChecked} API(s) checked`;
      setCheckResult(raw);
      setLastCheck(parseHealthCheckResult(raw, res.webChecked));
      await refreshStatus();
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : 'health check failed');
    } finally {
      setChecking(false);
    }
  }, [refreshStatus]);

  const desktop = status?.desktop ?? null;
  const web = status?.web ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="NANI"
        description="NetPulse Adaptive Network Intelligence — observe, investigate, understand, improve."
      />

      {/* One tab language for the product. This bar used to be hand-rolled —
          a bottom rule and a solid accent fill, unlike every other tab row in
          the app — and carried its own copy of the APG roving-focus logic.
          Radix already implements that model, so the shared `Tabs` primitive
          gives the same keyboard behaviour with none of the duplicate code,
          and NANI stops looking like a separate application. */}
      <Tabs
        items={TABS.map((t) => ({ value: t.id, label: t.label, icon: t.icon }))}
        value={tab}
        onValueChange={(v) => setTab(v as Tab)}
        size="sm"
        ariaLabel="NANI sections"
      >
        <TabPanel value="overview">
          <OverviewTab
            events={events}
            eventsAvailable={eventsAvailable}
            desktop={desktop}
            web={web}
            statusError={statusError}
            refreshStatus={refreshStatus}
            checking={checking}
            checkResult={checkResult}
            checkError={checkError}
            doHealthCheck={doHealthCheck}
            setTab={setTab}
          />
        </TabPanel>
        <TabPanel value="live">
          <LiveTab events={events} eventsAvailable={eventsAvailable} />
        </TabPanel>
        <TabPanel value="recovery">
          <RecoveryControls />
        </TabPanel>
        <TabPanel value="workspace">
          <WorkspaceTab events={events} setTab={setTab} />
        </TabPanel>
        <TabPanel value="hypotheses">
          <HypothesesTab events={events} />
        </TabPanel>
        <TabPanel value="evidence">
          <EvidenceTab events={events} />
        </TabPanel>
        <TabPanel value="network">
          <NetworkTab events={events} lastCheck={lastCheck} />
        </TabPanel>
        <TabPanel value="learning">
          <LearningTab learning={learning} drift={drift} />
        </TabPanel>
        <TabPanel value="history">
          <HistoryTab setTab={setTab} />
        </TabPanel>
        <TabPanel value="settings">
          <SettingsTab />
        </TabPanel>
      </Tabs>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Overview                                                           */
/* ------------------------------------------------------------------ */

function OverviewTab({
  events,
  eventsAvailable,
  desktop,
  web,
  statusError,
  refreshStatus,
  checking,
  checkResult,
  checkError,
  doHealthCheck,
  setTab,
}: {
  events: NaniEventState;
  eventsAvailable: boolean;
  desktop: NaniStatusDto | null;
  web: NaniWebStatusDto | null;
  statusError: string | null;
  refreshStatus: () => Promise<void>;
  checking: boolean;
  checkResult: string | null;
  checkError: string | null;
  doHealthCheck: () => Promise<void>;
  setTab: (t: Tab) => void;
}) {
  return (
    <div className="space-y-6">
      {/* One engine card, not two.
          "AI activity" and "Engine status" described the same engine from two
          angles and sat side by side at 1/3 and 2/3, so the narrower one was
          cramped and the wider one was two-thirds empty. Read together they are
          one instrument: the orb is what the engine is doing, the right column
          is what it reports and what you can do about it. */}
      <Card>
        <CardHeader
          title="Engine"
          subtitle="Authoritative Rust core / API — live state, not an inference"
          actions={
            <Button size="sm" variant="secondary" onClick={() => void refreshStatus()}>
              <RefreshCw size={14} /> Refresh
            </Button>
          }
        />
        <CardBody className="grid gap-6 @container lg:grid-cols-[200px_minmax(0,1fr)] lg:items-center lg:gap-8">
          <div className="flex flex-col items-center">
            <AiCore state={events.activity} />
            <p className="mt-1 text-center text-xs text-muted">{events.detail ?? 'No activity received yet'}</p>
          </div>

          <div className="min-w-0 space-y-3">
            {statusError ? (
              <ErrorState error={new Error(statusError)} retry={() => void refreshStatus()} />
            ) : !desktop && !web ? (
              <LoadingState label="Reading NANI status" />
            ) : desktop ? (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Metric label="Healthy APIs" value={desktop.healthy_apis} />
                <Metric label="Total APIs" value={desktop.total_apis} />
                <Metric label="Events (seq)" value={desktop.seq} />
                <Metric label="Recovery" value={desktop.recovery_active ? 1 : 0} />
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <Badge tone={web?.enabled ? 'ok' : 'neutral'}>{web?.intelligenceLevel ?? '—'}</Badge>
                <span className="text-sm text-muted">
                  {web?.lastDiagnosis?.cause
                    ? `Last diagnosis: ${web.lastDiagnosis.cause} (${web.lastDiagnosis.confidence ?? '?'})`
                    : 'No recent diagnosis recorded.'}
                </span>
              </div>
            )}

            {/* The stream is a capability, not a status. As a badge it competed
                with the engine's real state and read as a button; as a notice it
                says what is missing and why, and stops there. */}
            {!eventsAvailable && (
              <Notice tone="info">
                The live event stream is only exposed by the desktop application. This view shows engine
                status without it.
              </Notice>
            )}

            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
              <Button onClick={() => void doHealthCheck()} loading={checking} disabled={checking}>
                <Play size={14} /> Run health check
              </Button>
              {checkResult && <span className="text-xs text-ok">{checkResult}</span>}
              {checkError && <span className="text-xs text-danger">{checkError}</span>}
            </div>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="What would you like NANI to investigate?" subtitle="Natural-language requests" />
        <CardBody>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {[
              'Why is my connection unstable?',
              'Investigate unusually high latency.',
              'Compare my current network against previous sessions.',
              'Find which connection method performs best.',
              'Diagnose repeated connection failures.',
              'Analyze packet loss and jitter.',
              'Explain why a connection is failing.',
              'Run a network health investigation.',
            ].map((q) => (
              <button
                key={q}
                onClick={() => setTab('workspace')}
                className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-left text-xs text-muted hover:bg-surface-3 hover:text-text"
              >
                {q}
              </button>
            ))}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Recent events" subtitle="Actual backend activity" />
        <CardBody>
          {events.events.length === 0 ? (
            <EmptyState
              icon={<Activity size={20} />}
              title={eventsAvailable ? 'No events yet' : 'Event stream unavailable'}
              message={
                eventsAvailable
                  ? 'Events appear when NANI performs health checks, diagnoses, recovery, or learning updates.'
                  : 'The live NANI stream is only exposed by the desktop application. Web mode shows engine status only.'
              }
            />
          ) : (
            <ul className="space-y-1 font-mono text-xs">
              {events.events.slice(-12).reverse().map((e) => (
                <li key={e.eventId} className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                  <span className="text-faint">#{e.seq}</span>
                  <span className="text-muted">{e.type}</span>
                </li>
              ))}
            </ul>
          )}
          {events.gapCount > 0 && (
            <p className="mt-2 text-xs text-warn">
              {events.gapCount} sequence gap(s) detected — the replay fetch recovers retained events.
            </p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Live Investigation                                                 */
/* ------------------------------------------------------------------ */

const PIPELINE: { key: string; label: string; match: (t: string) => boolean }[] = [
  {
    key: 'observe',
    label: 'OBSERVE',
    match: (t) => t === 'TelemetryTick' || t === 'HealthCheckCompleted' || t === 'nani:health:updated',
  },
  { key: 'classify', label: 'CLASSIFY', match: (t) => t === 'FailureDetected' || t === 'ApiHealthChanged' },
  { key: 'hypothesize', label: 'HYPOTHESES', match: (t) => t === 'DiagnosisUpdated' || t === 'nani:diagnosis:completed' },
  { key: 'analyze', label: 'ANALYZE', match: (t) => t === 'DriftDetected' },
  { key: 'plan', label: 'PLAN RECOVERY', match: (t) => t === 'RecoveryStarted' || t === 'nani:recovery:planned' },
  { key: 'test', label: 'TEST', match: (t) => t === 'RecoveryStepCompleted' || t.startsWith('nani:recovery:step:') },
  { key: 'verify', label: 'VERIFY', match: (t) => t === 'RouteSelected' || t === 'nani:route:activated' },
  { key: 'learn', label: 'LEARN', match: (t) => t === 'LearningUpdate' },
];

type InvestigationCard = {
  id: string;
  query: string;
  stage: string;
  outcome: string | null;
  seq: number;
  started_at: number;
  updated_at: number;
  observation_count: number;
  hypothesis_count: number;
  top_hypothesis: string | null;
  confidence: number;
  result: string;
  error: string | null;
};

function LiveTab({ events, eventsAvailable }: { events: NaniEventState; eventsAvailable: boolean }) {
  const [investigations, setInvestigations] = useState<InvestigationCard[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seen = useMemo(() => new Set(events.events.map((e) => e.type)), [events.events]);

  const currentFromEvents = useMemo(() => {
    for (let i = events.events.length - 1; i >= 0; i -= 1) {
      const e = events.events[i];
      if (!e) continue;
      if (e.type === 'InvestigationStarted') {
        const id = e.payload.investigation_id;
        return typeof id === 'string' ? id : null;
      }
    }
    return null;
  }, [events.events]);

  useEffect(() => {
    if (!eventsAvailable) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await listInvestigations();
        if (!cancelled) setInvestigations(list);
      } catch {
        if (!cancelled) setInvestigations([]);
      }
    })();
    return () => { cancelled = true; };
  }, [eventsAvailable]);

  const refresh = useCallback(async () => {
    if (!eventsAvailable) return;
    try {
      const list = await listInvestigations();
      setInvestigations(list);
    } catch {
      setInvestigations([]);
    }
  }, [eventsAvailable]);

  const start = useCallback(async () => {
    const q = input.trim();
    if (!q || running) return;
    setRunning(true);
    setError(null);
    try {
      const id = await startInvestigation(q);
      setActiveId(id);
      setInput('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'start failed');
    } finally {
      setRunning(false);
    }
  }, [input, running, refresh]);

  const cancel = useCallback(async () => {
    const id = activeId ?? currentFromEvents;
    if (!id) return;
    setRunning(true);
    setError(null);
    try {
      const ok = await cancelInvestigation(id);
      if (ok) {
        setActiveId(null);
        await refresh();
      } else {
        setError('no running investigation to cancel');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'cancel failed');
    } finally {
      setRunning(false);
    }
  }, [activeId, currentFromEvents, refresh]);

  const active = investigations.find((i) => i.id === activeId) ?? null;

  if (!eventsAvailable && events.events.length === 0) {
    return (
      <Card>
        <CardBody>
          <EmptyState
            icon={<Activity size={20} />}
            title="Live investigation unavailable in web mode"
            message="The real-time NANI event stream is exposed by the desktop application. Open NetPulse desktop to watch a live investigation."
          />
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Investigation pipeline" subtitle="Driven by real backend events" />
        <CardBody className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {PIPELINE.map((stage) => {
              const done = Array.from(seen).some((t) => stage.match(t));
              return (
                <div
                  key={stage.key}
                  className={`rounded-lg border px-3 py-2 text-xs ${
                    done ? 'border-ok/40 bg-ok/10 text-ok' : 'border-line bg-surface-2 text-faint'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {done ? <CheckCircle2 size={12} className="text-ok" /> : <ChevronRight size={12} />}
                    <span className="font-medium">{stage.label}</span>
                  </div>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-faint">
            Stages mark the event kinds NANI has actually emitted this session. Nothing is simulated.
          </p>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Start investigation"
          subtitle="Natural-language request sent to the Rust engine"
          actions={
            <div className="flex items-center gap-2">
              <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="e.g. Why is my connection unstable?" disabled={running} />
              <Button onClick={start} loading={running} disabled={!input.trim() || running}>
                <Play size={14} /> Start
              </Button>
              {activeId && (
                <Button onClick={cancel} loading={running} variant="danger" disabled={!running && !activeId}>
                  <Zap size={14} /> Cancel
                </Button>
              )}
            </div>
          }
        />
        <CardBody className="space-y-3">
          {error && <p className="text-xs text-danger">{error}</p>}
          {running && <p className="text-xs text-muted">Request in flight…</p>}
          {active ? (
            <div className="rounded-lg border border-line bg-surface-2 p-3 text-sm space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-medium">Status</span>
                <Badge tone={active.outcome === 'Cancelled' ? 'neutral' : active.outcome === 'Failed' ? 'danger' : active.stage === 'Completed' || active.outcome === 'Completed' ? 'ok' : 'accent'}>
                  {active.stage}
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs text-muted">
                <div><span className="font-mono">Observations</span><div className="text-text">{active.observation_count}</div></div>
                <div><span className="font-mono">Hypotheses</span><div className="text-text">{active.hypothesis_count}</div></div>
                <div><span className="font-mono">Confidence</span><div className="text-text">{(active.confidence * 100).toFixed(1)}%</div></div>
                <div><span className="font-mono">Seq</span><div className="text-text">{active.seq}</div></div>
              </div>
              {active.top_hypothesis && <div className="mt-1 truncate text-text">{`Top: ${active.top_hypothesis}`}</div>}
              {active.result && <div className="mt-1 text-xs text-muted">{`Result: ${active.result}`}</div>}
              {active.error && <div className="mt-1 text-xs text-danger">{`Error: ${active.error}`}</div>}
            </div>
          ) : (
            <p className="text-xs text-muted">No active investigation. Start one above.</p>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Recent investigations"
          subtitle={`${investigations.length} stored · most recent first`}
          actions={<Button size="sm" variant="secondary" onClick={refresh}>Refresh</Button>}
        />
        <CardBody className="space-y-2">
          {investigations.length === 0 ? (
            <EmptyState icon={<HistoryIcon size={20} />} title="No investigations" message="Start an investigation to see it here." />
          ) : (
            <div className="space-y-1" role="list">
              {investigations.map((inv) => (
                <div
                  key={inv.id}
                  role="listitem"
                  className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm ${
                    activeId === inv.id ? 'bg-accent/10 border-accent/30' : 'border-line bg-surface-2 hover:bg-surface-3'
                  }`}
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium text-text">{inv.query}</div>
                    <div className="text-xs text-faint">
                      {new Date(inv.updated_at).toLocaleTimeString()} · {inv.stage} · {inv.outcome ?? '—'}
                    </div>
                  </div>
                  <Badge tone={inv.outcome === 'Cancelled' ? 'neutral' : inv.outcome === 'Failed' ? 'danger' : inv.outcome === 'Completed' ? 'ok' : 'accent'}>
                    {inv.stage}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Live event feed" subtitle={`${events.events.length} retained · bounded`} />
        <CardBody>
          {events.events.length === 0 ? (
            <EmptyState icon={<Activity size={20} />} title="No activity" message="Events appear as the engine works." />
          ) : (
            <ul className="space-y-1 font-mono text-xs">
              {events.events.slice().reverse().map((e) => (
                <li key={e.eventId} className="flex items-center gap-2">
                  <span className="text-faint">#{e.seq}</span>
                  <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                  <span className="text-muted">{e.type}</span>
                </li>
              ))}
            </ul>
          )}
          {events.gapCount > 0 && (
            <p className="mt-2 text-xs text-warn">
              {events.gapCount} sequence gap(s) detected — the replay fetch recovers retained events.
            </p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  AI Workspace                                                       */
/* ------------------------------------------------------------------ */

function WorkspaceTab({ events, setTab }: { events: NaniEventState; setTab: (t: Tab) => void }) {
  const [conversations, setConversations] = useState<NaniConversation[]>(() => loadConversations());
  const [activeId, setActiveId] = useState<string | null>(() => loadConversations()[0]?.id ?? null);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const active = conversations.find((c) => c.id === activeId) ?? null;

  const persist = useCallback((list: NaniConversation[]) => {
    setConversations(list);
    saveConversations(list);
  }, []);

  const startConversation = useCallback(() => {
    const c: NaniConversation = {
      id: newId(),
      title: 'New investigation',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    persist([c, ...conversations]);
    setActiveId(c.id);
  }, [conversations, persist]);

  const removeConversation = useCallback(
    (id: string) => {
      const next = deleteConversation(id);
      setConversations(next);
      if (activeId === id) setActiveId(next[0]?.id ?? null);
    },
    [activeId],
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [active?.messages.length]);

  const send = useCallback(async () => {
    const q = input.trim();
    if (!q || running || !active) return;
    setInput('');
    setError(null);
    setRunning(true);

    const userMsg = { id: newId(), role: 'user' as const, content: q, at: Date.now() };
    let list = conversations.map((c) =>
      c.id === active.id
        ? { ...c, title: c.messages.length === 0 ? q.slice(0, 60) : c.title, messages: [...c.messages, userMsg], updatedAt: Date.now() }
        : c,
    );
    persist(list);

    // Record the investigation in durable history.
    const inv: NaniInvestigationRecord = {
      id: newId(),
      query: q,
      status: 'Investigating',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      summary: null,
      error: null,
      eventCount: events.events.length,
    };
    saveInvestigations([inv, ...loadInvestigations()]);

    try {
      const res = await explain(q);
      const naniMsg = {
        id: newId(),
        role: 'nani' as const,
        content: res.text,
        at: Date.now(),
        source: res.source,
        warning: res.warning,
      };
      list = list.map((c) =>
        c.id === active.id ? { ...c, messages: [...c.messages, naniMsg], updatedAt: Date.now() } : c,
      );
      persist(list);
      saveInvestigations(
        loadInvestigations().map((i) =>
          i.id === inv.id ? { ...i, status: 'Completed', summary: res.text.slice(0, 200), updatedAt: Date.now() } : i,
        ),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'request failed';
      setError(msg);
      const naniMsg = { id: newId(), role: 'nani' as const, content: `Request failed: ${msg}`, at: Date.now(), error: true };
      list = list.map((c) =>
        c.id === active.id ? { ...c, messages: [...c.messages, naniMsg], updatedAt: Date.now() } : c,
      );
      persist(list);
      saveInvestigations(
        loadInvestigations().map((i) => (i.id === inv.id ? { ...i, status: 'Failed', error: msg, updatedAt: Date.now() } : i)),
      );
    } finally {
      setRunning(false);
    }
  }, [input, running, active, conversations, persist, events.events.length]);

  if (!active) {
    return (
      <Card>
        <CardBody className="py-10">
          <EmptyState
            icon={<MessageSquare size={20} />}
            title="No conversation yet"
            message="Start an investigation and NANI will explain its evidence, hypotheses and confidence."
          />
          <div className="mt-4 text-center">
            <Button onClick={startConversation}>
              <Sparkles size={14} /> New investigation
            </Button>
          </div>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
      <Card>
        <CardHeader title="Conversations" actions={<Button size="sm" variant="secondary" onClick={startConversation}>New</Button>} />
        <CardBody className="space-y-1">
          {conversations.map((c) => (
            <div key={c.id} className="flex items-center gap-1">
              <button
                onClick={() => setActiveId(c.id)}
                className={`flex-1 truncate rounded-md px-2 py-1.5 text-left text-xs ${
                  c.id === active.id ? 'bg-accent/10 text-accent-strong border-l-2 border-accent' : 'text-muted hover:bg-surface-2'
                }`}
              >
                {c.title}
              </button>
              <button onClick={() => removeConversation(c.id)} className="text-faint hover:text-danger" aria-label="Delete conversation">
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </CardBody>
      </Card>

      <div className="flex h-[calc(100vh-280px)] min-h-[300px] flex-col">
        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto rounded-lg border border-line bg-surface-2 p-4">
          {active.messages.length === 0 && (
            <p className="text-sm text-muted">
              Ask NANI about the current investigation. It answers from real engine facts; it cannot invent measurements.
            </p>
          )}
          {active.messages.map((m) => (
            <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[80%] rounded-xl px-4 py-3 text-sm ${
                  m.role === 'user' ? 'bg-accent text-on-accent' : m.error ? 'bg-danger/10 text-danger' : 'bg-surface border border-line text-text'
                }`}
              >
                <div className="whitespace-pre-wrap">{m.content}</div>
                <div className="mt-1 flex gap-2 text-micro opacity-60">
                  <span>{new Date(m.at).toLocaleTimeString()}</span>
                  {m.source && <span>{m.source}</span>}
                  {m.warning && <span>⚠ {m.warning}</span>}
                </div>
              </div>
            </div>
          ))}
          {running && (
            <div className="flex items-center gap-2 text-xs text-muted">
              <Loader2 size={12} className="animate-spin" /> NANI is analyzing…
            </div>
          )}
        </div>
        {error && <p className="mt-1 text-xs text-danger">{error}</p>}
        <form onSubmit={(e) => { e.preventDefault(); void send(); }} className="mt-2 flex gap-2">
          <Input value={input} onChange={(e: ChangeEvent<HTMLInputElement>) => setInput(e.target.value)} placeholder="Ask NANI…" disabled={running} />
          <Button type="submit" disabled={!input.trim() || running}>
            <Send size={14} />
          </Button>
        </form>
        <button onClick={() => setTab('live')} className="mt-1 self-start text-mini text-accent hover:underline">
          View live investigation →
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Hypotheses / Evidence / Network                                    */
/* ------------------------------------------------------------------ */

function HypothesesTab({ events }: { events: NaniEventState }) {
  const derived = useMemo(() => deriveHypotheses(events), [events]);
  const desktop = isDesktopNani();
  const [view, setView] = useState<HypothesisViewDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!isDesktopNani()) return;
    setLoading(true);
    setError(null);
    try {
      setView(await fetchHypothesisView());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'hypothesis view unavailable');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => toRows(view?.hypotheses ?? []), [view]);
  const probe = view?.selected_probe ?? null;
  const calibration = useMemo(() => (view ? calibrationDisplay(view) : null), [view]);

  return (
    <Card>
      <CardHeader
        title="Hypothesis explorer"
        subtitle="Priors and posteriors from the Rust diagnostic engine"
        actions={
          desktop ? (
            <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              <span className="ml-1">Refresh</span>
            </Button>
          ) : undefined
        }
      />
      <CardBody className="space-y-3">
        {error ? (
          <ErrorState error={new Error(error)} />
        ) : rows.length === 0 && derived.length === 0 ? (
          <EmptyState
            icon={<Radar size={20} />}
            title="No hypotheses yet"
            message={
              desktop
                ? 'Run a health check (or start an investigation) and the engine updates its posterior over the hypothesis space.'
                : 'Hypotheses appear when NANI emits a diagnosis update.'
            }
          />
        ) : rows.length === 0 ? (
          // Web mode has no Rust engine instance: show the event-derived
          // confidence rather than inventing priors.
          derived.map((h) => (
            <div key={h.id} className="space-y-1 rounded-lg border border-line bg-surface-2 p-3">
              <div className="flex items-center justify-between">
                <span className="font-medium text-text">{h.id}</span>
                <span className="font-mono text-xs text-muted">{Math.round(h.confidence * 100)}%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-surface">
                <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(0, Math.min(1, h.confidence)) * 100}%` }} />
              </div>
            </div>
          ))
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 text-xs text-faint">
              <span>
                Posterior entropy <span className="font-mono text-text">{formatNats(view?.entropy_nats ?? Number.NaN)}</span>
              </span>
              {view?.map_label && (
                <span>
                  MAP <span className="font-mono text-text">{view.map_label}</span>
                </span>
              )}
              {calibration && (
                <span title={calibration.note}>
                  {calibration.calibrated ? 'Calibrated confidence' : 'Confidence'}{' '}                  <span className="font-mono text-text">
                    {(Math.max(0, Math.min(1, calibration.confidence)) * 100).toFixed(1)}%
                  </span>
                  <span className="ml-1 text-faint">({calibration.note})</span>
                </span>
              )}
              <span className="flex items-center gap-1">
                bar = posterior ·<span className="inline-block h-2 w-0.5 bg-text" />= prior
              </span>
            </div>
            {rows.map((h) => (
              <div key={h.label} className="space-y-1 rounded-lg border border-line bg-surface-2 p-3">
                <div className="flex items-baseline justify-between">
                  <span className="font-medium text-text">{h.label}</span>
                  <span className="font-mono text-xs text-text">
                    {h.posteriorPct.toFixed(1)}%
                    <span className="ml-2 text-faint">prior {h.priorPct.toFixed(1)}%</span>
                  </span>
                </div>
                <div className="relative h-2 w-full overflow-hidden rounded-full bg-surface">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${h.posteriorPct}%` }} />
                  <div
                    className="absolute top-0 h-full w-0.5 bg-text"
                    style={{ left: `calc(${h.priorPct}% - 1px)` }}
                    title={`prior ${h.priorPct.toFixed(1)}%`}
                  />
                </div>
                <div className="text-xs text-faint">{formatShift(h.shift)} vs prior</div>
              </div>
            ))}
            <div className="rounded-lg border border-line bg-surface-2 p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-text">Selected probe</span>
                {probe ? <Badge tone="neutral">{probe.test_name}</Badge> : null}
              </div>
              {probe ? (
                <>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <div className="text-faint">Expected IG</div>
                      <div className="font-mono text-text">{formatNats(probe.expected_information_gain)}</div>
                    </div>
                    <div>
                      <div className="text-faint">Cost</div>
                      <div className="font-mono text-text">{probe.cost.toFixed(1)}</div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="mt-1 text-xs text-faint">
                  The engine has no candidate test to rank yet.
                </div>
              )}
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}

function EvidenceTab({ events }: { events: NaniEventState }) {
  const [filter, setFilter] = useState('');
  const evidence = useMemo(() => deriveEvidence(events), [events]);
  const filtered = evidence.filter(
    (e) => e.type.toLowerCase().includes(filter.toLowerCase()) || e.detail.toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <Card>
      <CardHeader title="Evidence explorer" subtitle="Actual observations and classifications" />
      <CardBody className="space-y-3">
        <div className="flex items-center gap-2">
          <Search size={14} className="text-faint" />
          <Input placeholder="Filter…" value={filter} onChange={(e: ChangeEvent<HTMLInputElement>) => setFilter(e.target.value)} />
        </div>
        {filtered.length === 0 ? (
          <EmptyState icon={<Database size={20} />} title="No evidence yet" message="Evidence appears when NANI records health checks or classified failures." />
        ) : (
          <div className="space-y-2">
            {filtered.map((e) => (
              <div key={e.id} className="rounded-lg border border-line bg-surface-2 p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs text-accent">ev-{e.id}</span>
                  <Badge tone="neutral">{e.type}</Badge>
                </div>
                <div className="mt-1 text-text">{e.detail}</div>
                <div className="mt-1 text-xs text-faint">{e.at ? new Date(e.at).toLocaleTimeString() : 'time not reported'}</div>
              </div>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

/** The last health check this session ran, as the engine reported it. */
interface LastHealthCheck {
  at: number;
  /** null when no health verdict was measured — never coerce attempts to healthy. */
  healthy: number | null;
  total: number;
  raw: string;
}

/**
 * Read the healthy/total counts out of the engine's health-check result string.
 *
 * Only the desktop aggregate verdict (`health_check_complete: 0/1 healthy`) is
 * a measured health value. The web path runs one check per registered API and
 * returns NO aggregate verdict, so `healthy` must stay null there: substituting
 * the attempt count (F-03) told users "N/N healthy" after failed checks.
 */
export function parseHealthCheckResult(raw: string, webChecked: number): LastHealthCheck {
  const match = raw.match(/(\d+)\s*\/\s*(\d+)\s+healthy/i);
  const healthy = match?.[1];
  const total = match?.[2];
  if (healthy !== undefined && total !== undefined) {
    return { at: Date.now(), healthy: Number(healthy), total: Number(total), raw };
  }
  // No verdict was reported. Record that N checks were attempted without
  // claiming any of them was healthy.
  return { at: Date.now(), healthy: null, total: webChecked, raw };
}

function NetworkTab({ events, lastCheck }: { events: NaniEventState; lastCheck: LastHealthCheck | null }) {
  // The desktop health check reports through `ApiHealthChanged`; the web bus
  // uses `nani:health:updated`. Counting only one of them left this tab empty
  // after a successful check.
  const health = useMemo(
    () =>
      events.events.filter(
        (e) =>
          e.type === 'nani:health:updated' ||
          e.type === 'ApiHealthChanged' ||
          e.type === 'HealthCheckCompleted' ||
          e.type === 'TelemetryTick',
      ).length,
    [events.events],
  );
  const gap = useMemo(() => lastFailedHealthSignal(events.events), [events.events]);
  const verdictText =
    lastCheck && lastCheck.healthy !== null ? `${lastCheck.healthy}/${lastCheck.total} healthy` : null;
  const lastCheckFailed =
    lastCheck !== null && lastCheck.healthy !== null && lastCheck.healthy < lastCheck.total;
  const checkedAt = lastCheck ? new Date(lastCheck.at).toLocaleTimeString() : null;
  return (
    <Card>
      <CardHeader title="Network intelligence" subtitle="Measurements from real events" />
      <CardBody className="space-y-3">
        {health === 0 ? (
          lastCheckFailed && verdictText ? (
            <EmptyState
              icon={<NetworkIcon size={20} />}
              title="Last health check failed before measuring"
              message={`The check at ${checkedAt} reported ${verdictText}, so no latency, loss or jitter sample was produced. NANI charts only measurements it actually made — retry once the endpoint is reachable.`}
            />
          ) : lastCheck && verdictText ? (
            <EmptyState
              icon={<NetworkIcon size={20} />}
              title="Last check passed; no samples yet"
              message={`The check at ${checkedAt} reported ${verdictText}, but no measurement event has arrived yet. Latency, loss and jitter appear as probes complete — nothing is synthesized in the meantime.`}
            />
          ) : lastCheck ? (
            // F-03: web mode measured no health verdict. Say so plainly instead
            // of inventing "N/N healthy" from the number of attempts.
            <EmptyState
              icon={<NetworkIcon size={20} />}
              title="Checks attempted; verdict unavailable"
              message={`${lastCheck.total} API check${lastCheck.total === 1 ? '' : 's'} were attempted at ${checkedAt}, but the backend reported no aggregate health verdict. NANI will not call an unmeasured result healthy — inspect the raw result below or run a desktop health check.`}
            />
          ) : gap ? (
            <EmptyState
              icon={<NetworkIcon size={20} />}
              title="Last check did not produce measurements"
              message={`${gap.label}${gap.at ? ` at ${new Date(gap.at).toLocaleTimeString()}` : ''}${
                gap.subject && !gap.label.includes(gap.subject) ? ` (${gap.subject})` : ''
              }. A check that fails before the probe stage yields no samples, so there is nothing to chart.`}
            />
          ) : (
            <EmptyState icon={<NetworkIcon size={20} />} title="No measurements yet" message="Run a health check to collect real latency and status data." />
          )
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Metric label="Health events" value={health} />
            <Metric label="Total events" value={events.events.length} />
            <Metric label="Gaps" value={events.gapCount} />
            <Metric label="Last seq" value={events.lastSeq} />
          </div>
        )}
        {lastCheck && health === 0 && (
          <div className="rounded-lg border border-line bg-surface-2 p-2 text-xs">
            <span className="text-muted">Last check result: </span>
            <span className="font-mono text-faint">{lastCheck.raw}</span>
          </div>
        )}
        {lastCheck && !lastCheckFailed && health > 0 && verdictText && (
          <p className="text-xs text-ok">
            Last check at {checkedAt}: {verdictText}.
          </p>
        )}
        <p className="text-xs text-faint">
          Latency/loss/jitter charts populate from real measurement events; no values are synthesized.
        </p>
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Learning / History / Settings                                      */
/* ------------------------------------------------------------------ */

function LearningTab({ learning, drift }: { learning: NaniLearningStatusDto | null; drift: Array<Record<string, unknown>> }) {
  return (
    <Card>
      <CardHeader title="Learning & memory" subtitle="Verified outcomes only" />
      <CardBody className="space-y-3">
        {!learning ? (
          <EmptyState
            icon={<Zap size={20} />}
            title="Learning data unavailable"
            message="Learning status is exposed by the desktop application. Web mode shows no local learning data."
          />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Metric label="Accepted" value={learning.measurements_accepted} />
              <Metric label="Rejected" value={learning.measurements_rejected} />
              <Metric label="Profiles" value={learning.profiles} />
              <Metric label="Reliability" value={Math.round(learning.global_reliability * 100)} unit="pct" />
            </div>
            <div className="rounded-lg border border-line bg-surface-2 p-3 text-sm">
              <div className="flex items-center gap-2 text-muted">
                <Shield size={14} /> Drift events: {drift.length}
              </div>
            </div>
          </>
        )}
      </CardBody>
    </Card>
  );
}

function HistoryTab({ setTab }: { setTab: (t: Tab) => void }) {
  const [items, setItems] = useState<NaniInvestigationRecord[]>(() => loadInvestigations());
  const [query, setQuery] = useState('');

  const remove = (id: string) => {
    const next = items.filter((i) => i.id !== id);
    setItems(next);
    saveInvestigations(next);
  };

  const filtered = items.filter(
    (i) => i.query.toLowerCase().includes(query.toLowerCase()) || (i.summary ?? '').toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <Card>
      <CardHeader
        title="Investigation history"
        subtitle={`${items.length} stored`}
        actions={<Button size="sm" variant="secondary" onClick={() => setTab('workspace')}>New</Button>}
      />
      <CardBody className="space-y-3">
        <div className="flex items-center gap-2">
          <Search size={14} className="text-faint" />
          <Input placeholder="Search history…" value={query} onChange={(e: ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)} />
        </div>
        {filtered.length === 0 ? (
          <EmptyState icon={<HistoryIcon size={20} />} title="No history" message="Investigations persist across restarts and appear here." />
        ) : (
          filtered.map((it) => (
            <div key={it.id} className="flex items-start justify-between gap-3 rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm">
              <div className="min-w-0">
                <div className="truncate font-medium text-text">{it.query}</div>
                <div className="text-xs text-faint">
                  {new Date(it.updatedAt).toLocaleString()} · {it.eventCount} events
                </div>
                {it.summary && <div className="mt-1 line-clamp-2 text-xs text-muted">{it.summary}</div>}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge tone={it.status === 'Failed' ? 'danger' : it.status === 'Completed' ? 'ok' : 'accent'}>{it.status}</Badge>
                <button onClick={() => remove(it.id)} className="text-faint hover:text-danger" aria-label="Delete investigation">
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))
        )}
      </CardBody>
    </Card>
  );
}

function SettingsTab() {
  const [confirming, setConfirming] = useState(false);
  const desktop = isDesktopNani();
  const clear = () => {
    clearNaniHistory();
    setConfirming(false);
  };
  return (
    <Card>
      <CardHeader title="NANI settings" subtitle="Privacy and diagnostics" />
      <CardBody className="space-y-4">
        <div className="rounded-lg border border-line bg-surface-2 p-3 text-sm text-muted">
          <div className="flex items-center gap-2">
            <Cpu size={14} /> Runtime: {desktop ? 'desktop (Rust engine authoritative)' : 'web (API mode)'}
          </div>
          <div className="mt-1 flex items-center gap-2">
            <HeartPulse size={14} /> External AI: deterministic diagnostics remain available when providers are disabled.
          </div>
        </div>

        <div className="rounded-lg border border-line bg-surface-2 p-3">
          <div className="text-sm font-medium text-text">Local history</div>
          <p className="mt-1 text-xs text-muted">
            Conversations and investigations are stored locally and survive restarts. Clearing removes them from this device.
          </p>
          {confirming ? (
            <div className="mt-2 flex items-center gap-2">
              <span className="text-xs text-danger">Delete all local NANI history?</span>
              <Button size="sm" variant="danger" onClick={clear}>Delete</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
            </div>
          ) : (
            <Button className="mt-2" size="sm" variant="secondary" onClick={() => setConfirming(true)}>
              <Trash2 size={13} /> Clear history
            </Button>
          )}
        </div>

        <p className="flex items-center gap-2 text-xs text-faint">
          <Clock size={12} /> Records are bounded (50 investigations, 200 messages each) to keep storage small.
        </p>
      </CardBody>
    </Card>
  );
}

export default NaniPage;
