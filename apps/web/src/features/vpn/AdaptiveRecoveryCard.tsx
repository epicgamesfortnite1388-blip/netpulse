import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Brain, RotateCcw, ShieldAlert } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataList, DataRow, FieldPill, MetricStrip, Notice, Panel, Section } from '@/components/ui/Surface';
import { Switch } from '@/components/ui/Switch';
import { useToast } from '@/components/Toaster';
import { api } from '@/lib/api';

import { PROXY_CORE_META } from './engineMeta';

import type { ProxyEngineId } from '@netpulse/shared';

/**
 * What the adaptive engine learned, and the two controls over it.
 *
 * This card exists because "the app changed which core it tries" is exactly the
 * kind of invisible behaviour that erodes trust: the user must be able to see the
 * evidence behind a decision and switch the whole thing off. So it states, in the
 * app's own words:
 *
 *  - which strategies this machine may actually use, and why each is or is not
 *    usable (not installed, cannot dial this node, revoked by a policy update);
 *  - what it observed, per context, with the honest sample counts behind each
 *    number — a probability with two observations is labelled 'low', not hidden;
 *  - that no observation, however many, is by itself a DPI conclusion;
 *  - what the engine can and cannot change (it reorders installed cores; it can
 *    never add a node, a credential or a hostname);
 *  - one button to delete everything learned.
 *
 * It never writes a number the backend did not return.
 */

interface AdaptiveStrategyRow {
  id: string;
  engine: ProxyEngineId;
  approved: boolean;
  reason: string | null;
}

interface AdaptiveStatusDto {
  enabled: boolean;
  exploration: boolean;
  context: string;
  contextSummary: string;
  observationsKept: number;
  entries: Array<{
    context: string;
    contextSummary: string;
    strategyId: string;
    successes: number;
    failures: number;
    evidence: number;
    successProbability: number;
    confidence: 'none' | 'low' | 'medium' | 'high';
    meanSuccessMs: number | null;
    consecutiveFailures: number;
    updatedAt: number;
  }>;
  strategies: AdaptiveStrategyRow[];
  censorshipHint: { level: string; reason: string; dpiInferred: false } | null;
  lastResetAt: number | null;
  updatedAt: number | null;
  manifest: { installed: { version: number; applied: string[]; refused: string[] } | null; previousVersion: number | null; keyId: string | null };
  trustAnchor: { configured: boolean; keyId: string | null };
  scope: { dnsThroughTunnel: boolean; canChange: string; cannotChange: string };
  nodeId: string | null;
}

/**
 * `strategyIdFor()` builds `<engine>` or `<engine>+doh` (see @netpulse/shared), and
 * this card is the only place those ids are shown to a person — so it must parse
 * the ids that actually exist. Splitting on `@` (an earlier naming) made every
 * learned row print the raw id, which is why the suffix is stated here once.
 */
function strategyLabel(strategyId: string): string {
  const [engine, ...rest] = strategyId.split('+');
  const meta = PROXY_CORE_META[engine as ProxyEngineId];
  const name = meta?.label ?? engine;
  const suffix = rest.includes('doh') ? 'DNS through tunnel' : rest.join(' ').replace(/-/g, ' ');
  return suffix ? `${name} · ${suffix}` : name;
}

function contextLabel(row: { contextSummary: string }): string {
  return row.contextSummary.trim() === '' ? 'any network' : row.contextSummary;
}

const CONFIDENCE_TONE: Record<string, 'ok' | 'warn' | 'neutral'> = {
  high: 'ok',
  medium: 'ok',
  low: 'warn',
  none: 'neutral',
};

export function AdaptiveRecoveryCard({ nodeId }: { nodeId?: string | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [resetNote, setResetNote] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['adaptive', 'status', nodeId ?? null],
    queryFn: () => api.get<AdaptiveStatusDto>(`/adaptive/status${nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : ''}`),
    refetchInterval: 20_000,
  });

  const status = query.data;

  const planQuery = useQuery({
    queryKey: ['adaptive', 'plan', nodeId ?? null],
    queryFn: () => api.get<AdaptivePlanDto>(`/adaptive/plan?nodeId=${encodeURIComponent(nodeId!)}`),
    enabled: Boolean(nodeId),
    staleTime: 10_000,
  });

  const setToggles = useMutation({
    mutationFn: (patch: { enabled?: boolean; exploration?: boolean }) => api.put('/settings', { adaptive: patch }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['adaptive'] }),
    onError: (err) => toast('error', 'Could not save', err instanceof Error ? err.message : undefined),
  });

  const reset = useMutation({
    mutationFn: () => api.post<{ message: string }>('/adaptive/reset'),
    onSuccess: (r) => {
      setResetNote(r.message);
      void qc.invalidateQueries({ queryKey: ['adaptive'] });
      toast('ok', 'Learning data cleared', r.message);
    },
    onError: (err) => toast('error', 'Could not clear', err instanceof Error ? err.message : undefined),
  });

  const rollback = useMutation({
    mutationFn: () => api.post<{ ok: boolean; reason: string }>('/adaptive/policy/rollback'),
    onSuccess: (r) => {
      toast(r.ok ? 'ok' : 'error', r.ok ? 'Policy rolled back' : 'Nothing to roll back', r.reason);
      void qc.invalidateQueries({ queryKey: ['adaptive'] });
    },
    onError: (err) => toast('error', 'Could not roll back', err instanceof Error ? err.message : undefined),
  });

  if (query.isError) {
    return (
      <Section variant="flat" title="Adaptive connection intelligence" icon={<Brain size={15} />}>
        <Notice tone="warn">
          Learning state could not be read: {query.error instanceof Error ? query.error.message : 'unknown error'}. The engine keeps the default
          engine order while this is unreadable — nothing was changed.
        </Notice>
      </Section>
    );
  }

  if (!status) return null;

  const learnedRows = status.entries.filter((e) => e.confidence !== 'none');
  const approved = status.strategies.filter((s) => s.approved);
  const blocked = status.strategies.filter((s) => !s.approved);
  const plan = planQuery.data;

  return (
    <Section
      variant="flat"
      title="Adaptive connection intelligence"
      icon={<Brain size={15} />}
      subtitle="Learns which installed core reaches the internet on the network you are actually on, and tries that one first. Nothing here changes what is available — a core that is not installed, cannot dial this node, or is revoked by a signed policy update is never chosen."
      actions={
        <Badge tone={!status.enabled ? 'neutral' : learnedRows.length > 0 ? 'accent' : 'neutral'}>
          {!status.enabled ? 'ordering off' : learnedRows.length > 0 ? `${learnedRows.length} learned` : 'no evidence yet'}
        </Badge>
      }
    >
      <MetricStrip
        items={[
          {
            label: 'Context now',
            value: status.contextSummary,
            hint: 'derived from this app’s own observations',
          },
          {
            label: 'Approved strategies',
            value: String(approved.length),
            // Zero approved strategies means two different things: no node is
            // selected (nothing to evaluate) or this node's protocol excludes
            // every installed core. Only the second is a warning.
            tone: approved.length === 0 && status.nodeId ? 'warn' : 'default',
            hint:
              approved.length > 0
                ? 'installed, compatible, not revoked'
                : status.nodeId
                  ? 'no installed core fits this node'
                  : 'no active node — start a tunnel to evaluate one',
          },
          {
            label: 'Observations kept',
            value: String(status.observationsKept),
            hint: 'counts and timings only — no addresses, no destinations',
          },
          {
            label: 'Policy update',
            value: status.manifest.installed ? `v${status.manifest.installed.version}` : 'none',
            hint: status.trustAnchor.configured ? `verifying with key ${status.trustAnchor.keyId ?? '—'}` : 'no signing key in this build',
          },
        ]}
      />

      {/* ---------------- what it observed ---------------- */}
      {learnedRows.length > 0 ? (
        <DataList className="mt-3 rounded-xl border border-line bg-surface px-4">
          {learnedRows.map((row) => (
            <DataRow
              key={`${row.context}|${row.strategyId}`}
              leading={<span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />}
              title={<span className="text-sm text-text">{strategyLabel(row.strategyId)}</span>}
              subtitle={
                <span className="text-micro text-faint">
                  on {contextLabel(row)} · {row.successes} success / {row.failures} failure ·{' '}
                  {Math.round(row.successProbability * 100)}% success probability
                  {row.meanSuccessMs != null ? ` · ~${Math.round(row.meanSuccessMs)} ms to a working tunnel` : ''}
                  {row.consecutiveFailures > 0 ? ` · ${row.consecutiveFailures} consecutive failure(s)` : ''}
                </span>
              }
              actions={<Badge tone={CONFIDENCE_TONE[row.confidence] ?? 'neutral'}>{row.confidence} confidence</Badge>}
            />
          ))}
        </DataList>
      ) : (
        <p className="mt-3 rounded-r-lg border-l-2 border-line bg-surface-2 px-3.5 py-2.5 text-xs leading-relaxed text-muted">
          No strategy has enough evidence under a context yet, so the engine keeps the default engine order. A decision needs at least{' '}
          {status.observationsKept > 0 ? 'more than ' : ''}one verified outcome before it can change anything — a single attempt is not a pattern.
        </p>
      )}

      {/* ---------------- what it refuses to conclude ---------------- */}
      {status.censorshipHint ? (
        <Notice tone="warn" className="mt-3" icon={<ShieldAlert size={13} />}>
          {status.censorshipHint.reason}
        </Notice>
      ) : (
        <p className="mt-2 text-micro leading-relaxed text-faint">
          Failures are classified as DNS, transport, authentication, server outage, configuration or local-network before anything else is
          considered. None of them, alone or together, is reported here as censorship — a failed connection is not evidence of DPI.
        </p>
      )}

      {/* ---------------- why it would choose this ---------------- */}
      {plan && plan.decisions.length > 0 && (
        <Panel className="mt-3">
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <FieldPill label="Next attempt" value={strategyLabel(plan.decisions[0]!.strategyId)} />
            <FieldPill
              label="vs. default order"
              value={plan.changedFromBaseline ? 'changed by learning' : 'same as default'}
              tone={plan.changedFromBaseline ? 'warn' : 'default'}
            />
            {plan.exploratory && <Badge tone="neutral">one bounded exploration attempt enabled</Badge>}
          </div>
          <ol className="space-y-1.5">
            {plan.decisions.map((d, i) => (
              <li key={d.strategyId} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-line pb-1.5 last:border-b-0 last:pb-0">
                <span className="metric-num text-micro text-faint">{i + 1}</span>
                <span className="text-sm text-text">{strategyLabel(d.strategyId)}</span>
                <Badge tone={d.confidence === 'none' ? 'neutral' : d.confidence === 'high' ? 'ok' : 'warn'}>{d.confidence}</Badge>
                <span className="min-w-0 flex-1 text-xs leading-snug text-faint">{d.explanation}</span>
              </li>
            ))}
          </ol>
        </Panel>
      )}

      {/* ---------------- what it may not use, and why ---------------- */}
      {blocked.length > 0 && (
        <div className="mt-3">
          <p className="mb-1.5 text-micro font-medium uppercase tracking-[0.12em] text-faint">Not usable for this node</p>
          <ul className="space-y-1">
            {blocked.map((s) => (
              <li key={s.id} className="flex flex-wrap items-baseline gap-x-3 text-xs">
                <span className="text-muted">{strategyLabel(s.id)}</span>
                <span className="text-faint">{s.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ---------------- controls ---------------- */}
      <Panel className="mt-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <label className="flex items-center gap-2.5 text-sm text-text">
            <Switch
              checked={status.enabled}
              onCheckedChange={(checked) => setToggles.mutate({ enabled: checked })}
              label="Let the engine order the cores"
            />
            Let the engine order the cores
          </label>
          <label className="flex items-center gap-2.5 text-sm text-text">
            <Switch
              checked={status.exploration}
              onCheckedChange={(checked) => setToggles.mutate({ exploration: checked })}
              label="Allow bounded exploration"
            />
            Allow bounded exploration
          </label>
          <span className="text-micro text-faint">
            Exploration spends part of the attempt budget on a strategy that is not expected to win, in order to learn. It is off by default.
          </span>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <Button variant="secondary" onClick={() => reset.mutate()} loading={reset.isPending} disabled={reset.isPending}>
            <RotateCcw size={13} />
            {reset.isPending ? 'Clearing…' : 'Clear local learning data'}
          </Button>
          {status.manifest.previousVersion != null && (
            <Button variant="ghost" onClick={() => rollback.mutate()} loading={rollback.isPending} disabled={rollback.isPending}>
              Roll back policy to v{status.manifest.previousVersion}
            </Button>
          )}
          <span className="text-micro text-faint">{status.scope.canChange}.</span>
        </div>
        <p className="mt-2 text-micro leading-relaxed text-faint">
          It cannot change: {status.scope.cannotChange}.
          {status.lastResetAt != null ? ` Learning data was last cleared ${new Date(status.lastResetAt).toLocaleString()}.` : ''}
        </p>
      </Panel>

      {resetNote && (
        <Notice tone="ok" className="mt-3">
          {resetNote}
        </Notice>
      )}
    </Section>
  );
}

interface AdaptivePlanDto {
  context: string;
  contextSummary: string;
  status: 'active' | 'disabled' | 'no-approved-strategy';
  note: string;
  preferred: ProxyEngineId | null;
  changedFromBaseline: boolean;
  exploratory: { strategyId: string } | null;
  decisions: Array<{
    strategyId: string;
    engine: ProxyEngineId;
    explanation: string;
    successProbability: number;
    confidence: 'none' | 'low' | 'medium' | 'high';
    exploratory: boolean;
    reason: string;
  }>;
}
