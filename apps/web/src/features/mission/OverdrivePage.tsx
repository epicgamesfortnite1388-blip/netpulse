import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  BookOpen,
  FlaskConical,
  Gauge,
  GitBranch,
  Network,
  RefreshCw,
  Satellite,
  ShieldCheck,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { Input } from '@/components/ui/Field';
import { DataList, DataRow, MetricStrip, Notice, Panel, Section } from '@/components/ui/Surface';
import { ErrorState, LoadingState } from '@/components/ui/States';
import { TabPanel, Tabs } from '@/components/ui/Tabs';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';

/**
 * Mission Overdrive.
 *
 * Two ledgers, deliberately separate:
 *
 *  - `/mission/status` (live) — what this process knows right now;
 *  - `/mission/overdrive` (measured) — what has actually been measured, read out
 *    of the artifacts those runs wrote.
 *
 * Neither is re-derived here. A figure is rendered from the artifact that holds
 * it, next to the artifact path and the caveats that run recorded, so a number
 * can always be traced back to the file it came from. When an artifact is
 * unreadable the row says so; it never renders a zero.
 *
 * There are no action buttons beyond re-reading. Connecting, probing and
 * provisioning have owners elsewhere with their own guards, and a second control
 * path on a reporting page is how guards get bypassed.
 */

type MissionState = 'verified' | 'observed' | 'not_tested' | 'unavailable' | 'blocked';

interface EvidenceMetric {
  label: string;
  value: string;
  hint?: string;
}

interface EvidenceRow {
  id: string;
  label: string;
  workstream: string;
  state: MissionState;
  measuredAt: number | null;
  headline: string;
  metrics: EvidenceMetric[];
  artifact: string;
  report: string | null;
  caveats: string[];
}

interface ResearchEntry {
  id: string;
  title: string;
  url: string | null;
  date: string | null;
  relevance: string | null;
  confidence: string | null;
  findings: string | null;
}

interface RequirementRow {
  index: number;
  text: string;
  state: MissionState;
  status: string;
}

interface OverdriveSnapshot {
  generatedAt: number;
  repoRoot: string | null;
  summary: {
    state: MissionState;
    counts: Record<MissionState, number>;
    headline: string;
    evidenceRows: number;
    researchSources: number;
    requirementsMet: number;
    requirementsTotal: number;
  };
  evidence: EvidenceRow[];
  research: { registry: string | null; total: number; entries: ResearchEntry[]; note: string };
  requirements: RequirementRow[];
  timeline: Array<{ ts: number; label: string; state: MissionState; artifact: string }>;
  report: {
    path: string | null;
    title: string | null;
    generatedAt: number | null;
    verdicts: Array<{ objective: string; status: string; evidence: string }>;
    note: string;
  };
  adaptive: {
    enabled: boolean;
    exploration: boolean;
    observationsKept: number;
    contextSummary: string;
    approvedStrategies: number;
    learned: Array<{
      contextSummary: string;
      strategyId: string;
      successProbability: number;
      confidence: 'none' | 'low' | 'medium' | 'high';
      successes: number;
      failures: number;
      meanSuccessMs: number | null;
    }>;
    refused: Array<{ id: string; reason: string }>;
    policyVersion: number | null;
    trustAnchor: { configured: boolean; keyId: string | null };
  } | null;
  activity: Array<{ id: number; ts: number; level: 'info' | 'warn' | 'error'; category: string; message: string }>;
  limits: string[];
}

interface MissionSubsystem {
  id: string;
  label: string;
  state: MissionState;
  headline: string;
  detail: string;
  source: string;
  checkedAt: number;
}

interface MissionSnapshot {
  generatedAt: number;
  summary: { state: MissionState; counts: Record<MissionState, number>; headline: string; detail: string };
  subsystems: MissionSubsystem[];
  limits: string[];
}

const STATE_TONE: Record<MissionState, 'ok' | 'warn' | 'danger' | 'neutral' | 'accent'> = {
  verified: 'ok',
  observed: 'accent',
  not_tested: 'neutral',
  unavailable: 'warn',
  blocked: 'danger',
};

const STATE_WORD: Record<MissionState, string> = {
  verified: 'verified',
  observed: 'observed',
  not_tested: 'not tested',
  unavailable: 'unavailable',
  blocked: 'blocked',
};

const VERDICT_TONE = (status: string): 'ok' | 'warn' | 'danger' | 'neutral' => {
  if (/^PASS/i.test(status)) return 'ok';
  if (/^FAIL/i.test(status)) return 'danger';
  if (/BLOCKED/i.test(status)) return 'warn';
  return 'neutral';
};

/** Median from the stage artifact, when the row exists. */
function stageMs(row: EvidenceRow | undefined, label: string): string | null {
  const m = row?.metrics.find((x) => x.label === label);
  return m ? m.value : null;
}

/**
 * Connection path, drawn from measured medians rather than invented motion.
 *
 * Each hop shows the number the stage artifact recorded. The travelling dot is
 * decoration, so it is skipped entirely when the reader asked for reduced motion.
 */
function ConnectionPath({ stages }: { stages: EvidenceRow | undefined }) {
  const hops = [
    { key: 'DNS', caption: 'local resolver' },
    { key: 'SOCKS CONNECT', caption: 'to tunnel' },
    { key: 'TLS', caption: 'handshake' },
    { key: 'first byte', caption: 'response' },
  ].map((h, i) => ({ ...h, i, value: stageMs(stages, h.key) }));

  const total = stageMs(stages, 'end to end');
  const measured = hops.some((h) => h.value !== null);

  return (
    <Panel className="overflow-hidden">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-mini font-medium text-text">Measured path · client → tunnel → destination</p>
        <Badge tone={measured ? 'ok' : 'neutral'}>{total ? `${total} end to end` : 'no stage artifact'}</Badge>
      </div>

      <div className="relative">
        {/* rail */}
        <div className="absolute left-0 right-0 top-[13px] h-px bg-line" aria-hidden />
        <div
          className="path-tracer absolute top-[11px] h-[5px] w-[5px] rounded-full bg-accent shadow-[0_0_10px_var(--color-accent)] motion-reduce:hidden"
          aria-hidden
        />
        <ol className="relative grid grid-cols-2 gap-y-5 sm:grid-cols-4">
          {hops.map((hop) => (
            <li key={hop.key} className="flex flex-col items-center text-center">
              <span
                className={`z-10 grid h-[27px] w-[27px] place-items-center rounded-full border text-micro ${
                  hop.value ? 'border-accent/40 bg-surface-2 text-accent-strong' : 'border-line bg-surface text-faint'
                }`}
                aria-hidden
              >
                {hop.i + 1}
              </span>
              <span className="mt-2 text-mini text-text">{hop.key}</span>
              <span className="metric-num text-sm text-accent-strong">{hop.value ?? '—'}</span>
              <span className="text-micro text-faint">{hop.caption}</span>
            </li>
          ))}
        </ol>
      </div>

      <p className="mt-4 border-t border-line pt-3 text-xs leading-relaxed text-muted">
        {measured
          ? 'These timings come from the run that exposed the leak: the tunnel refuses hostname-form CONNECT, so names were resolved by the local resolver — one millisecond because the query never left the host. The “DNS resolved inside the tunnel” row is the fix: DNS over TCP through the tunnel, 15/15 lookups at ~80 ms. The figures above are the before-state and are kept as recorded.'
          : 'Stage timings are unavailable until the stage artifact exists. Nothing is estimated in its place.'}
      </p>
    </Panel>
  );
}

export default function OverdrivePage() {
  const [filter, setFilter] = useState('');
  const [tab, setTab] = useState('overview');

  const overdrive = useQuery({
    queryKey: ['mission', 'overdrive'],
    queryFn: () => api.get<OverdriveSnapshot>('/mission/overdrive'),
    refetchInterval: 30_000,
  });

  const live = useQuery({
    queryKey: ['mission', 'status'],
    queryFn: () => api.get<MissionSnapshot>('/mission/status'),
    refetchInterval: 15_000,
  });

  const snapshot = overdrive.data;
  const stagesRow = snapshot?.evidence.find((e) => e.id === 'stages');

  const results = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const entries = snapshot?.research.entries ?? [];
    if (!q) return entries;
    return entries.filter((e) =>
      [e.id, e.title, e.findings, e.relevance, e.confidence, e.date].some((v) => v?.toLowerCase().includes(q)),
    );
  }, [filter, snapshot]);

  const busy = overdrive.isFetching || live.isFetching;

  return (
    <div>
      <PageHeader
        title="Mission Overdrive"
        description="Measured evidence, the research registry, the acceptance ledger and live subsystem state — each figure traceable to the artifact that recorded it. Read-only."
        actions={
          <button
            type="button"
            onClick={() => {
              void overdrive.refetch();
              void live.refetch();
            }}
            disabled={busy}
            className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-60"
          >
            <RefreshCw size={13} className={busy ? 'animate-spin' : ''} />
            {busy ? 'Reading…' : 'Re-read now'}
          </button>
        }
      />

      {overdrive.isError && <ErrorState error={overdrive.error} retry={() => void overdrive.refetch()} />}
      {overdrive.isLoading && <LoadingState label="Reading measured evidence" />}

      {snapshot && (
        <>
          <MetricStrip
            items={[
              {
                label: 'Iran-ready',
                value:
                  snapshot.summary.requirementsTotal > 0
                    ? `${snapshot.summary.requirementsMet}/${snapshot.summary.requirementsTotal}`
                    : '—',
                tone: snapshot.summary.requirementsMet > 0 ? 'warn' : 'faint',
                hint: 'requirements recorded as met in ROADMAP.md',
              },
              {
                label: 'Measured artifacts',
                value: String(snapshot.summary.counts.verified),
                tone: snapshot.summary.counts.verified > 0 ? 'ok' : 'faint',
                mono: true,
                hint: 'readable, timestamped runs — not hand-written claims',
              },
              {
                label: 'Research sources',
                value: String(snapshot.summary.researchSources),
                mono: true,
                hint: 'entries in the source registry',
              },
              {
                label: 'Unreadable',
                value: String(snapshot.summary.counts.unavailable),
                tone: snapshot.summary.counts.unavailable > 0 ? 'warn' : 'ok',
                mono: true,
                hint: 'rows that could not be read — not zeros',
              },
            ]}
          />

          <Notice tone="info" className="mt-4">
            {snapshot.summary.headline}. Snapshot read {timeAgo(snapshot.generatedAt)}
            {snapshot.repoRoot ? ` from ${snapshot.repoRoot}` : ' — repository root not found'}.
          </Notice>

          <div className="mt-6">
            <Tabs
              value={tab}
              onValueChange={setTab}
              items={[
                { value: 'overview', label: 'Overview' },
                { value: 'evidence', label: `Evidence (${snapshot.evidence.length})` },
                { value: 'research', label: `Research (${snapshot.research.total})` },
                { value: 'adaptive', label: 'Adaptive AI' },
                { value: 'infra', label: 'Infrastructure' },
                { value: 'report', label: 'Final report' },
              ]}
            >
              {/* ------------------------------ overview ------------------------------ */}
              <TabPanel value="overview">
                <div className="grid gap-5 lg:grid-cols-2">
                  <Section
                    title="Iran-ready ledger"
                    icon={<ShieldCheck size={15} />}
                    subtitle="Parsed from the authoritative roadmap. The page never upgrades a status."
                  >
                    {snapshot.requirements.length === 0 ? (
                      <Notice tone="warn">The Iran-ready section of ROADMAP.md did not parse, so no requirement state is shown.</Notice>
                    ) : (
                      <ul className="space-y-2.5">
                        {snapshot.requirements.map((r) => (
                          <li key={r.index} className="rounded-xl border border-line bg-surface px-3.5 py-3">
                            <div className="flex items-start justify-between gap-3">
                              <p className="text-xs leading-relaxed text-muted">
                                <span className="metric-num mr-2 text-faint">{r.index}</span>
                                {r.text}
                              </p>
                              <Badge tone={STATE_TONE[r.state]}>{r.status}</Badge>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Section>

                  <div className="space-y-5">
                    <ConnectionPath stages={stagesRow} />

                    <Section
                      title="Evidence timeline"
                      icon={<GitBranch size={15} />}
                      subtitle="Artifact timestamps only — no authored events."
                      actions={<Badge tone="neutral">{snapshot.timeline.length}</Badge>}
                    >
                      {snapshot.timeline.length === 0 ? (
                        <p className="text-xs text-faint">No timestamped artifacts were readable.</p>
                      ) : (
                        <ol className="relative space-y-3 border-l border-line pl-4">
                          {snapshot.timeline.map((t) => (
                            <li key={`${t.artifact}-${t.ts}`} className="relative">
                              <span className="absolute -left-[21px] top-1.5 h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
                              <p className="text-mini text-text">{t.label}</p>
                              <p className="font-mono text-micro text-faint">
                                {new Date(t.ts).toISOString()} · {t.artifact}
                              </p>
                            </li>
                          ))}
                        </ol>
                      )}
                    </Section>
                  </div>
                </div>
              </TabPanel>

              {/* ------------------------------ evidence ------------------------------ */}
              <TabPanel value="evidence">
                <Section
                  title="Measured artifacts"
                  icon={<FlaskConical size={15} />}
                  subtitle="Each card is one run. Numbers are quoted from the artifact, caveats are the ones that run recorded."
                  actions={<Badge tone="neutral">{snapshot.evidence.length} rows</Badge>}
                >
                  <div className="grid gap-4 lg:grid-cols-2">
                    {snapshot.evidence.map((row) => (
                      <article key={row.id} className="rounded-xl border border-line bg-surface p-4">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <p className="text-sm text-text">{row.label}</p>
                            <p className="font-mono text-micro uppercase tracking-[0.12em] text-faint">{row.workstream}</p>
                          </div>
                          <Badge tone={STATE_TONE[row.state]}>{STATE_WORD[row.state]}</Badge>
                        </div>

                        <p className="mt-2 text-xs leading-relaxed text-muted">{row.headline}</p>

                        {row.metrics.length > 0 && (
                          <dl className="mt-3 grid grid-cols-2 gap-2">
                            {row.metrics.map((m) => (
                              <div key={m.label} className="rounded-lg bg-surface-2 px-2.5 py-2">
                                <dt className="text-micro uppercase tracking-[0.1em] text-faint">{m.label}</dt>
                                <dd className="metric-num mt-0.5 text-xs text-text">{m.value}</dd>
                                {m.hint && <dd className="text-micro leading-snug text-faint">{m.hint}</dd>}
                              </div>
                            ))}
                          </dl>
                        )}

                        <ul className="mt-3 space-y-1.5">
                          {row.caveats.map((c) => (
                            <li key={c} className="flex items-start gap-2 text-micro leading-relaxed text-muted">
                              <span className="mt-1 h-1 w-1 shrink-0 rounded-full bg-faint" aria-hidden />
                              {c}
                            </li>
                          ))}
                        </ul>

                        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-2.5">
                          <code className="font-mono text-micro text-faint">{row.artifact}</code>
                          {row.report && <code className="font-mono text-micro text-faint">{row.report}</code>}
                          <span className="ml-auto text-micro text-faint">
                            {row.measuredAt ? new Date(row.measuredAt).toISOString() : 'no timestamp'}
                          </span>
                        </div>
                      </article>
                    ))}
                  </div>
                </Section>
              </TabPanel>

              {/* ------------------------------ research ------------------------------ */}
              <TabPanel value="research">
                <Section
                  title="Research registry"
                  icon={<BookOpen size={15} />}
                  subtitle={snapshot.research.note}
                  actions={
                    <Badge tone="neutral">
                      {results.length} of {snapshot.research.total}
                    </Badge>
                  }
                >
                  <div className="mb-3 max-w-md">
                    <Input
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      placeholder="Filter by title, finding, date or confidence…"
                      aria-label="Filter research sources"
                    />
                  </div>

                  {results.length === 0 ? (
                    <p className="py-6 text-center text-sm text-faint">No source matches that filter.</p>
                  ) : (
                    <DataList className="rounded-xl border border-line bg-surface px-4">
                      {results.map((entry) => (
                        <DataRow
                          key={entry.id}
                          leading={<span className="metric-num text-micro text-faint">{entry.id}</span>}
                          title={
                            <span className="flex flex-wrap items-baseline gap-2">
                              {entry.url ? (
                                <a
                                  href={entry.url}
                                  target="_blank"
                                  rel="noreferrer noopener"
                                  className="text-sm text-text underline decoration-line-strong underline-offset-2 hover:text-accent-strong"
                                >
                                  {entry.title}
                                </a>
                              ) : (
                                <span className="text-sm text-text">{entry.title}</span>
                              )}
                              {entry.relevance && <Badge tone="neutral">{entry.relevance}</Badge>}
                            </span>
                          }
                          subtitle={
                            <span className="space-y-1 text-xs leading-snug text-muted">
                              {entry.findings && <span className="block">{entry.findings}</span>}
                              <span className="block font-mono text-micro text-faint">
                                {[entry.date, entry.confidence].filter(Boolean).join(' · ')}
                              </span>
                            </span>
                          }
                        />
                      ))}
                    </DataList>
                  )}
                </Section>
              </TabPanel>

              {/* ------------------------------ adaptive ------------------------------ */}
              <TabPanel value="adaptive">
                <Section
                  title="Adaptive strategy selection"
                  icon={<Satellite size={15} />}
                  subtitle="Deterministic ranking over this machine's own recorded outcomes — not a learned claim about censorship."
                  actions={
                    snapshot.adaptive ? (
                      <Badge tone={snapshot.adaptive.enabled ? 'accent' : 'neutral'}>
                        {snapshot.adaptive.enabled ? 'ordering on' : 'ordering off'}
                      </Badge>
                    ) : (
                      <Badge tone="warn">unreadable</Badge>
                    )
                  }
                >
                  {!snapshot.adaptive ? (
                    <Notice tone="warn">Learning state could not be read; the engine keeps the default core order while unreadable.</Notice>
                  ) : (
                    <>
                      <Panel>
                        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted">
                          <span>
                            Context: <span className="text-text">{snapshot.adaptive.contextSummary || 'any network'}</span>
                          </span>
                          <span>
                            Approved: <span className="text-text">{snapshot.adaptive.approvedStrategies}</span>
                          </span>
                          <span>
                            Observations: <span className="text-text">{snapshot.adaptive.observationsKept}</span>
                          </span>
                          <span>
                            Policy:{' '}
                            <span className="text-text">
                              {snapshot.adaptive.policyVersion != null ? `v${snapshot.adaptive.policyVersion}` : 'none installed'}
                            </span>
                          </span>
                          <span>
                            Trust anchor:{' '}
                            <span className="text-text">
                              {snapshot.adaptive.trustAnchor.configured
                                ? `key ${snapshot.adaptive.trustAnchor.keyId ?? '—'}`
                                : 'none in this build'}
                            </span>
                          </span>
                        </div>
                      </Panel>

                      {snapshot.adaptive.learned.length === 0 ? (
                        <p className="mt-3 rounded-r-lg border-l-2 border-line bg-surface-2 px-3.5 py-2.5 text-xs leading-relaxed text-muted">
                          No strategy has enough evidence under a context yet, so the default engine order stands. One attempt is not a
                          pattern, and no failure here is labelled censorship.
                        </p>
                      ) : (
                        <DataList className="mt-3">
                          {snapshot.adaptive.learned.map((row) => (
                            <DataRow
                              key={`${row.contextSummary}|${row.strategyId}`}
                              title={
                                <span className="flex flex-wrap items-center gap-2">
                                  <span className="font-mono text-xs text-text">{row.strategyId}</span>
                                  <Badge tone={row.confidence === 'low' ? 'warn' : row.confidence === 'none' ? 'neutral' : 'ok'}>
                                    {row.confidence} confidence
                                  </Badge>
                                </span>
                              }
                              subtitle={
                                <span className="text-xs text-muted">
                                  on {row.contextSummary.trim() === '' ? 'any network' : row.contextSummary} · {row.successes} success /{' '}
                                  {row.failures} failure · {Math.round(row.successProbability * 100)}% success probability
                                  {row.meanSuccessMs != null ? ` · ~${Math.round(row.meanSuccessMs)} ms` : ''}
                                </span>
                              }
                            />
                          ))}
                        </DataList>
                      )}

                      {snapshot.adaptive.refused.length > 0 && (
                        <div className="mt-3">
                          <p className="mb-1.5 text-micro font-medium uppercase tracking-[0.12em] text-faint">Not usable for this node</p>
                          <ul className="space-y-1">
                            {snapshot.adaptive.refused.map((s) => (
                              <li key={s.id} className="flex flex-wrap items-baseline gap-x-3 text-xs">
                                <span className="font-mono text-muted">{s.id}</span>
                                <span className="text-faint">{s.reason}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </>
                  )}
                </Section>

                <Section
                  className="mt-5"
                  title="Recent activity"
                  icon={<Activity size={15} />}
                  subtitle="The application's own event log — real state changes and outcomes."
                  actions={<Badge tone="neutral">{snapshot.activity.length}</Badge>}
                >
                  {snapshot.activity.length === 0 ? (
                    <p className="py-6 text-center text-sm text-faint">No events recorded in this installation.</p>
                  ) : (
                    <div className="space-y-0.5">
                      {snapshot.activity.slice(0, 25).map((e) => (
                        <div key={e.id} className="flex items-start justify-between gap-3 rounded-lg px-2 py-2 hover:bg-surface-2">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <Badge tone={e.level === 'error' ? 'danger' : e.level === 'warn' ? 'warn' : 'neutral'}>{e.level}</Badge>
                            <Badge tone="accent">{e.category}</Badge>
                            <span className="text-mini text-text">{e.message}</span>
                          </div>
                          <span className="shrink-0 text-xs text-faint">{timeAgo(e.ts)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </Section>
              </TabPanel>

              {/* -------------------------------- infra ------------------------------- */}
              <TabPanel value="infra">
                <Section
                  title="Live subsystem ledger"
                  icon={<Network size={15} />}
                  subtitle="Read from this process's services, separately from the measured artifacts. “Not tested” means no evidence exists right now."
                  actions={
                    live.data ? (
                      <Badge tone={STATE_TONE[live.data.summary.state]}>{STATE_WORD[live.data.summary.state]}</Badge>
                    ) : (
                      <Badge tone="neutral">reading…</Badge>
                    )
                  }
                >
                  {live.isError ? (
                    <ErrorState error={live.error} retry={() => void live.refetch()} />
                  ) : !live.data ? (
                    <LoadingState label="Reading live state" />
                  ) : (
                    <DataList className="rounded-xl border border-line bg-surface px-4">
                      {live.data.subsystems.map((s) => (
                        <DataRow
                          key={s.id}
                          leading={<span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />}
                          title={
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="text-sm text-text">{s.label}</span>
                              <Badge tone={STATE_TONE[s.state]}>{STATE_WORD[s.state]}</Badge>
                            </span>
                          }
                          subtitle={<span className="text-xs leading-snug text-muted">{s.detail}</span>}
                          meta={
                            <span className="font-mono text-micro text-faint">
                              {s.headline} · source {s.source} · {timeAgo(s.checkedAt)}
                            </span>
                          }
                        />
                      ))}
                    </DataList>
                  )}
                </Section>

                <Section
                  className="mt-5"
                  title="Scope limits"
                  icon={<Gauge size={15} />}
                  subtitle="What neither ledger proves, stated next to the numbers."
                >
                  <ul className="space-y-1.5">
                    {[...snapshot.limits, ...(live.data?.limits ?? [])].map((limit) => (
                      <li key={limit} className="flex items-start gap-2 text-xs leading-relaxed text-muted">
                        <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-faint" aria-hidden />
                        {limit}
                      </li>
                    ))}
                  </ul>
                </Section>
              </TabPanel>

              {/* -------------------------------- report ------------------------------ */}
              <TabPanel value="report">
                <Section
                  title={snapshot.report.title ?? 'Final report'}
                  icon={<FlaskConical size={15} />}
                  subtitle={snapshot.report.note}
                  actions={<Badge tone={snapshot.report.path ? 'ok' : 'neutral'}>{snapshot.report.path ? 'artifact present' : 'no artifact'}</Badge>}
                >
                  {snapshot.report.path === null ? (
                    <Notice tone="warn">
                      No final report artifact is readable from this workspace. The acceptance matrix is not reproduced here, because a copy
                      would go stale.
                    </Notice>
                  ) : (
                    <>
                      <p className="mb-3 font-mono text-micro text-faint">
                        {snapshot.report.path}
                        {snapshot.report.generatedAt ? ` · ${new Date(snapshot.report.generatedAt).toISOString()}` : ''}
                      </p>
                      <div className="overflow-x-auto rounded-xl border border-line">
                        <table className="w-full border-collapse text-left">
                          <thead>
                            <tr className="bg-surface-2 text-micro uppercase tracking-[0.1em] text-faint">
                              <th className="px-3 py-2 font-medium">Objective</th>
                              <th className="px-3 py-2 font-medium">Verdict</th>
                              <th className="px-3 py-2 font-medium">Evidence</th>
                            </tr>
                          </thead>
                          <tbody>
                            {snapshot.report.verdicts.map((v) => (
                              <tr key={v.objective} className="border-t border-line align-top">
                                <td className="px-3 py-2 text-xs text-text">{v.objective}</td>
                                <td className="px-3 py-2">
                                  <Badge tone={VERDICT_TONE(v.status)}>{v.status}</Badge>
                                </td>
                                <td className="px-3 py-2 font-mono text-micro leading-relaxed text-faint">{v.evidence}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </Section>
              </TabPanel>
            </Tabs>
          </div>
        </>
      )}
    </div>
  );
}
