import { useQuery } from '@tanstack/react-query';
import { Activity, RefreshCw, Satellite, ShieldCheck } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/Badge';
import { DetailLevelControl, DetailLevelProvider } from '@/components/ui/DetailLevel';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Field';
import { DataList, DataRow, MetricStrip, Notice, Panel, Section } from '@/components/ui/Surface';
import { ErrorState, LoadingState } from '@/components/ui/States';
import { api } from '@/lib/api';
import { fmtClock, timeAgo } from '@/lib/format';

/**
 * Mission Control.
 *
 * This page reports one thing: what this process actually established, and how
 * strongly. It exists because a dashboard of green banners is indistinguishable
 * from a dashboard of invented numbers, so every row carries the evidence class
 * the backend assigned it (`verified / observed / not_tested / unavailable /
 * blocked`) and names the service it came from.
 *
 * It has no action buttons other than re-reading the snapshot. Connecting,
 * testing, provisioning and revoking already have owners elsewhere, each with
 * its own guards; a second control path here would be a way around them.
 */

type MissionState = 'verified' | 'observed' | 'not_tested' | 'unavailable' | 'blocked';

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
  summary: {
    state: MissionState;
    counts: Record<MissionState, number>;
    headline: string;
    detail: string;
  };
  subsystems: MissionSubsystem[];
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
    trustAnchor: { configured: boolean; keyId: string | null };
    policyVersion: number | null;
  } | null;
  activity: Array<{ id: number; ts: number; level: 'info' | 'warn' | 'error'; category: string; message: string }>;
  limits: string[];
}

/**
 * Tone per class. `not_tested` is deliberately neutral rather than green: an
 * absence of evidence is not a pass, and colour is the fastest way to imply one.
 */
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

/** `MetricStrip` has no "neutral" tone: faint is the honest rendering of untested. */
const METRIC_TONE: Record<MissionState, 'ok' | 'warn' | 'danger' | 'faint' | 'default'> = {
  verified: 'ok',
  observed: 'default',
  not_tested: 'faint',
  unavailable: 'warn',
  blocked: 'danger',
};

function strategyLabel(strategyId: string): string {
  const [engine, ...rest] = strategyId.split('+');
  const suffix = rest.includes('doh') ? 'DNS through tunnel' : rest.join(' ').replace(/-/g, ' ');
  const name = engine === 'sing-box' ? 'sing-box' : (engine ?? strategyId);
  return suffix ? `${name} · ${suffix}` : name;
}

export default function MissionControlPage() {
  const [level, setLevel] = useState<string>('');
  const [category, setCategory] = useState<string>('');

  const query = useQuery({
    queryKey: ['mission', 'status'],
    queryFn: () => api.get<MissionSnapshot>('/mission/status'),
    refetchInterval: 15_000,
  });

  const snapshot = query.data;
  const activity = (snapshot?.activity ?? []).filter(
    (e) => (level === '' || e.level === level) && (category === '' || e.category === category),
  );
  const categories = [...new Set((snapshot?.activity ?? []).map((e) => e.category))].sort();

  // Information-dense reporting page: default to Context (2) so the verdict,
  // counts and subsystem ledger are present without the raw event log.
  return (
    <DetailLevelProvider scope="mission" defaultLevel={2} depth={4}>
    <div>
      <PageHeader
        title="Mission Control"
        description="What this process actually established — every row names its evidence class and the service it came from. Read-only: nothing here connects, scans or changes state."
        actions={
          <button
            type="button"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
            className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-text disabled:opacity-60"
          >
            <RefreshCw size={13} className={query.isFetching ? 'animate-spin' : ''} />
            {query.isFetching ? 'Reading…' : 'Re-read now'}
          </button>
        }
      />

      <div className="-mt-3 mb-2"><DetailLevelControl /></div>

      {query.isError && <ErrorState error={query.error} retry={() => void query.refetch()} />}
      {query.isLoading && <LoadingState label="Reading mission state" />}

      {snapshot && (
        <>
          <MetricStrip
            items={[
              {
                label: 'Overall',
                value: STATE_WORD[snapshot.summary.state],
                tone: METRIC_TONE[snapshot.summary.state],
                hint: 'weakest claim in the ledger, not the strongest',
              },
              {
                label: 'Verified',
                value: String(snapshot.summary.counts.verified),
                tone: snapshot.summary.counts.verified > 0 ? 'ok' : 'faint',
                hint: 'a measurement this process performed',
              },
              {
                label: 'Not tested / blocked',
                value: `${snapshot.summary.counts.not_tested} / ${snapshot.summary.counts.blocked}`,
                tone: snapshot.summary.counts.blocked > 0 ? 'danger' : snapshot.summary.counts.not_tested > 0 ? 'warn' : 'ok',
                hint: 'no evidence, or an external dependency',
              },
              {
                label: 'Observations kept',
                value: String(snapshot.adaptive?.observationsKept ?? 0),
                mono: true,
                hint: 'local adaptive learning, counts and timings only',
              },
            ]}
          />

          <Notice tone="info" className="mt-4">
            {snapshot.summary.detail} Snapshot read {timeAgo(snapshot.generatedAt)}.
          </Notice>

          {/* -------------------------- subsystem ledger -------------------------- */}
          <Section
            className="mt-6"
            title="Subsystem ledger"
            detail={2}
            icon={<ShieldCheck size={15} />}
            subtitle="One row per subsystem. “Verified” only ever means a measurement in this process supports it; “not tested” means no evidence exists right now."
            actions={<Badge tone="neutral">{snapshot.subsystems.length} subsystems</Badge>}
          >
            <DataList className="rounded-xl border border-line bg-surface px-4">
              {snapshot.subsystems.map((s) => (
                <DataRow
                  key={s.id}
                  leading={<span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />}
                  title={
                    <>
                      <span className="text-sm text-text">{s.label}</span>
                      <Badge tone={STATE_TONE[s.state]}>{STATE_WORD[s.state]}</Badge>
                    </>
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
          </Section>

          {/* ----------------------------- adaptive ------------------------------ */}
          <Section
            title="Adaptive strategy selection"
            detail={3}
            icon={<Satellite size={15} />}
            subtitle="Which installed core the engine would try first, on what evidence, and what it refuses to claim."
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
              <Notice tone="warn">
                Learning state could not be read. The engine keeps the default core order while unreadable — nothing was changed.
              </Notice>
            ) : (
              <>
                <Panel>
                  <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted">
                    <span>
                      Context: <span className="text-text">{snapshot.adaptive.contextSummary || 'any network'}</span>
                    </span>
                    <span>
                      Approved strategies: <span className="text-text">{snapshot.adaptive.approvedStrategies}</span>
                    </span>
                    <span>
                      Exploration: <span className="text-text">{snapshot.adaptive.exploration ? 'on' : 'off'}</span>
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

                {snapshot.adaptive.learned.length > 0 ? (
                  <DataList className="mt-3">
                    {snapshot.adaptive.learned.map((row) => (
                      <DataRow
                        key={`${row.contextSummary}|${row.strategyId}`}
                        title={
                          <>
                            <span className="text-sm text-text">{strategyLabel(row.strategyId)}</span>
                            <Badge tone={row.confidence === 'low' ? 'warn' : row.confidence === 'none' ? 'neutral' : 'ok'}>
                              {row.confidence} confidence
                            </Badge>
                          </>
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
                ) : (
                  <p className="mt-3 rounded-r-lg border-l-2 border-line bg-surface-2 px-3.5 py-2.5 text-xs leading-relaxed text-muted">
                    No strategy has enough evidence under a context yet, so the default engine order stands. A single attempt is not a pattern, and no
                    failure here is labelled censorship.
                  </p>
                )}

                {snapshot.adaptive.refused.length > 0 && (
                  <div className="mt-3">
                    <p className="mb-1.5 text-micro font-medium uppercase tracking-[0.12em] text-faint">Not usable for this node</p>
                    <ul className="space-y-1">
                      {snapshot.adaptive.refused.map((s) => (
                        <li key={s.id} className="flex flex-wrap items-baseline gap-x-3 text-xs">
                          <span className="text-muted">{strategyLabel(s.id)}</span>
                          <span className="text-faint">{s.reason}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </Section>

          {/* ------------------------------ activity ----------------------------- */}
          <Section
            title="Live mission activity"
            detail={4}
            icon={<Activity size={15} />}
            subtitle="The app’s own event log — real state changes, test outcomes and warnings, newest first."
            actions={<Badge tone="neutral">{activity.length} of {snapshot.activity.length}</Badge>}
          >
            <div className="mb-3 flex flex-wrap gap-2">
              <div className="w-36">
                <Select value={level} onChange={(e) => setLevel(e.target.value)} aria-label="Filter activity by severity">
                  <option value="">All severities</option>
                  <option value="info">Info</option>
                  <option value="warn">Warning</option>
                  <option value="error">Error</option>
                </Select>
              </div>
              <div className="w-44">
                <Select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Filter activity by category">
                  <option value="">All categories</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            {activity.length === 0 ? (
              <p className="py-6 text-center text-sm text-faint">
                {snapshot.activity.length === 0 ? 'No events recorded yet in this installation.' : 'No events match the current filters.'}
              </p>
            ) : (
              <div className="space-y-0.5">
                {activity.map((e) => (
                  <div key={e.id} className="flex items-start justify-between gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-surface-2">
                    <div className="flex min-w-0 items-start gap-3">
                      <span className="metric-num shrink-0 pt-0.5 text-xs text-faint">{fmtClock(e.ts)}</span>
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <Badge tone={e.level === 'error' ? 'danger' : e.level === 'warn' ? 'warn' : 'neutral'}>{e.level}</Badge>
                        <Badge tone="accent">{e.category}</Badge>
                        <span className="text-mini text-text">{e.message}</span>
                      </div>
                    </div>
                    <span className="shrink-0 text-xs text-faint">{timeAgo(e.ts)}</span>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* ------------------------------- limits ------------------------------ */}
          <Section title="What this page does not prove" subtitle="Stated next to the numbers rather than in a footnote.">
            <ul className="space-y-1.5">
              {snapshot.limits.map((limit) => (
                <li key={limit} className="flex items-start gap-2 text-xs leading-relaxed text-muted">
                  <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-faint" aria-hidden />
                  {limit}
                </li>
              ))}
            </ul>
          </Section>
        </>
      )}
    </div>
    </DetailLevelProvider>
  );
}
