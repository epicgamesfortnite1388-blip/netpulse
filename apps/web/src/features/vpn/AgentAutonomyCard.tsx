import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, GraduationCap, Lock, RefreshCw, ShieldCheck, ShieldOff } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { MetricStrip, Notice, Panel, Section } from '@/components/ui/Surface';
import { Switch } from '@/components/ui/Switch';
import { api } from '@/lib/api';

/**
 * What the discovery agent may do on its own.
 *
 * Every value here is returned by `GET /api/v1/agent/permissions` — the same
 * object the enforcement code reads. The card exists because an agent that
 * probes the internet for you has to answer three questions without being asked:
 * what is it allowed to do, how much of it per hour, and what has it been refused.
 *
 * The one control is a pause for UNATTENDED work. It cannot grant anything: the
 * forbidden list is code, not a setting, and there is no button here that could
 * change that.
 */

interface CapabilityRow {
  id: string;
  tier: 'always' | 'budgeted' | 'user-only' | 'forbidden';
  title: string;
  allows: string;
  bound: string;
  granted: 'always' | 'granted' | 'paused' | 'user-only' | 'forbidden';
  usedThisHour: number;
  limitPerHour: number | null;
  remaining: number | null;
}

interface AgentDecisionRow {
  at: number;
  capability: string;
  origin: 'autonomous' | 'user';
  allowed: boolean;
  code: string;
  reason: string;
  count: number;
  detail: string | null;
}

export interface AgentPermissionsDto {
  version: number;
  paused: boolean;
  capabilities: CapabilityRow[];
  recent: AgentDecisionRow[];
  note: string;
  limits: { fetchPerHour: number | null; probesPerHour: number | null; verifyPerHour: number | null };
  cannot: string[];
  enforcement: Array<{ action: string; capability: string; where: string; onDenial: string }>;
  training: {
    observationsKept: number;
    calibration: {
      samples: number;
      brier: number;
      baselineBrier: number;
      skill: number;
      meanPredicted: number;
      observedRate: number;
    } | null;
    note: string;
  };
}

export interface TrainResult {
  attempted: number;
  verified: number;
  failed: number;
  byEngine: Record<string, { attempted: number; verified: number }>;
  calibrationAfter: AgentPermissionsDto['training']['calibration'];
  note: string;
}

const TIER_TONE: Record<CapabilityRow['tier'], 'ok' | 'accent' | 'warn' | 'danger'> = {
  always: 'ok',
  budgeted: 'accent',
  'user-only': 'warn',
  forbidden: 'danger',
};

const TIER_LABEL: Record<CapabilityRow['tier'], string> = {
  always: 'always',
  budgeted: 'budgeted',
  'user-only': 'user only',
  forbidden: 'denied',
};

function budgetRow(caps: CapabilityRow[], id: string): CapabilityRow | undefined {
  return caps.find((c) => c.id === id);
}

function timeOf(at: number): string {
  try {
    return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '—';
  }
}

export function AgentAutonomyCard() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['agent', 'permissions'],
    queryFn: () => api.get<AgentPermissionsDto>('/agent/permissions'),
    refetchInterval: 60_000,
  });

  const setPaused = useMutation({
    mutationFn: (paused: boolean) => api.post<AgentPermissionsDto>('/agent/autonomy', { paused }),
    onSuccess: (data) => {
      queryClient.setQueryData(['agent', 'permissions'], data);
    },
  });

  const [trained, setTrained] = useState<TrainResult | null>(null);
  const train = useMutation({
    mutationFn: () => api.post<TrainResult>('/vpn/smart-connect/train', { size: 6, concurrency: 2 }),
    onSuccess: (result) => {
      setTrained(result);
      void queryClient.invalidateQueries({ queryKey: ['agent', 'permissions'] });
    },
  });

  const data = query.data;

  return (
    <Section
      title="Agent autonomy"
      subtitle="What the discovery agent may do on its own, and what it may never do"
      icon={<Bot size={15} />}
      badge={
        data ? (
          <Badge tone={data.paused ? 'warn' : 'ok'}>{data.paused ? 'paused' : 'autonomous'}</Badge>
        ) : undefined
      }
      actions={
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => train.mutate()}
            disabled={train.isPending || data?.paused !== false}
            title="Probe up to 6 candidates and learn from every attempt, failures included; charged to the hourly verification allowance"
          >
            <GraduationCap size={13} className={train.isPending ? 'animate-pulse' : ''} />
            {train.isPending ? 'Training…' : 'Train'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
            title="Re-read the capability policy"
          >
            <RefreshCw size={13} className={query.isFetching ? 'animate-spin' : ''} />
            Refresh
          </Button>
          {data && (
            <label className="flex items-center gap-2 text-sm text-muted">
              <span className="text-micro uppercase tracking-[0.14em] text-faint">Unattended</span>
              <Switch
                checked={!data.paused}
                disabled={setPaused.isPending}
                onCheckedChange={(next) => setPaused.mutate(!next)}
                label={data.paused ? 'Resume unattended discovery' : 'Pause unattended discovery'}
              />
            </label>
          )}
        </div>
      }
      collapsible
      id="vpn-agent-autonomy"
      summary="Capabilities, hourly budgets and recent refusals for the AI agent"
    >
      {query.isError ? (
        <Notice tone="warn" icon={<ShieldOff size={13} />}>
          {query.error instanceof Error ? query.error.message : 'Could not read the agent permission policy.'}
        </Notice>
      ) : !data ? (
        <p className="text-sm text-muted">Reading the capability policy…</p>
      ) : (
        <AutonomyBody
          data={data}
          trained={trained}
          trainError={train.isError ? (train.error instanceof Error ? train.error.message : 'request failed') : null}
        />
      )}
    </Section>
  );
}

/**
 * The policy exactly as the user reads it, with no fetching of its own.
 *
 * Exported so a render test covers the real budgets, the never-permitted list,
 * the refusal log and the calibration tile — the three things this card exists
 * to answer without being asked.
 */
export function AutonomyBody({
  data,
  trained = null,
  trainError = null,
}: {
  data: AgentPermissionsDto;
  trained?: TrainResult | null;
  trainError?: string | null;
}) {
  const allowed = data.capabilities.filter((c) => c.tier !== 'forbidden');
  const denied = data.capabilities.filter((c) => c.tier === 'forbidden');
  const refusals = data.recent.filter((d) => !d.allowed).slice(-4).reverse();
  const probes = budgetRow(data.capabilities, 'network:probe-endpoint');
  const fetches = budgetRow(data.capabilities, 'network:fetch-source');
  const verifies = budgetRow(data.capabilities, 'network:verify-traffic');

  return (
    <div className="space-y-5">
          <Notice tone={data.paused ? 'warn' : 'info'} icon={<ShieldCheck size={13} />}>
            {data.note}
          </Notice>

          <MetricStrip
            items={[
              {
                label: 'Probes / hour',
                value: probes?.limitPerHour == null ? 'off' : `${probes.usedThisHour} / ${probes.limitPerHour}`,
                hint: 'unattended endpoint checks',
                mono: true,
              },
              {
                label: 'Fetches / hour',
                value: fetches?.limitPerHour == null ? 'off' : `${fetches.usedThisHour} / ${fetches.limitPerHour}`,
                hint: 'registered public feeds',
                mono: true,
              },
              {
                label: 'Verifications / hour',
                value: verifies?.limitPerHour == null ? 'off' : `${verifies.usedThisHour} / ${verifies.limitPerHour}`,
                hint: 'Smart Connect, on request',
                mono: true,
              },
              {
                label: 'Permanently denied',
                value: String(denied.length),
                hint: 'no setting can grant these',
                tone: 'danger',
                mono: true,
              },
              {
                label: 'Calibration skill',
                value: data.training.calibration ? data.training.calibration.skill.toFixed(3) : '—',
                hint: data.training.calibration
                  ? `Brier ${data.training.calibration.brier} vs ${data.training.calibration.baselineBrier} baseline`
                  : 'no scored prediction yet',
                tone: data.training.calibration ? (data.training.calibration.skill > 0 ? 'ok' : 'warn') : 'default',
                mono: true,
              },
            ]}
          />

          <Notice tone="info" icon={<GraduationCap size={13} />}>
            {data.training.note}
            {trained && (
              <span className="mt-1 block">
                Last batch: probed {trained.attempted}, {trained.verified} carried traffic, {trained.failed} did not.
              </span>
            )}
            {trainError && <span className="mt-1 block">Training refused: {trainError}</span>}
          </Notice>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel>
              <div className="mb-2 flex items-center gap-2">
                <ShieldCheck size={13} className="text-muted" />
                <p className="text-sm font-semibold text-strong">Allowed, with limits</p>
              </div>
              <ul className="space-y-2.5">
                {allowed.map((c) => (
                  <li key={c.id} className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={TIER_TONE[c.tier]}>{TIER_LABEL[c.tier]}</Badge>
                      <span className="text-sm font-medium text-strong">{c.title}</span>
                      {c.limitPerHour != null && (
                        <span className="metric-num text-micro text-faint">
                          {c.usedThisHour}/{c.limitPerHour} this hour
                        </span>
                      )}
                    </div>
                    <p className="text-xs leading-relaxed text-muted">{c.allows}</p>
                    <p className="text-micro leading-snug text-faint">{c.bound}</p>
                  </li>
                ))}
              </ul>
            </Panel>

            <div className="space-y-4">
              <Panel>
                <div className="mb-2 flex items-center gap-2">
                  <Lock size={13} className="text-muted" />
                  <p className="text-sm font-semibold text-strong">Never permitted</p>
                </div>
                <ul className="space-y-2">
                  {denied.map((c) => (
                    <li key={c.id} className="flex flex-wrap items-center gap-2">
                      <Badge tone="danger">{TIER_LABEL[c.tier]}</Badge>
                      <span className="text-sm text-strong">{c.title}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-micro leading-snug text-faint">
                  This list lives in code, not in settings. No stored setting, request or model output can add to it.
                </p>
              </Panel>

              <Panel>
                <div className="mb-2 flex items-center gap-2">
                  <ShieldOff size={13} className="text-muted" />
                  <p className="text-sm font-semibold text-strong">Recent refusals</p>
                </div>
                {refusals.length === 0 ? (
                  <p className="text-xs text-muted">Nothing has been refused since start-up.</p>
                ) : (
                  <ul className="space-y-2">
                    {refusals.map((d, i) => (
                      <li key={`${d.at}-${d.capability}-${i}`} className="text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="metric-num text-micro text-faint">{timeOf(d.at)}</span>
                          <Badge tone={d.origin === 'autonomous' ? 'warn' : 'neutral'}>{d.origin}</Badge>
                          <span className="metric-num text-micro text-muted">{d.capability}</span>
                          <span className="text-micro text-faint">{d.code}</span>
                        </div>
                        <p className="mt-0.5 leading-snug text-muted">{d.reason}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </div>
          </div>

          <div className="rounded-xl border border-line bg-surface px-4 py-3">
            <p className="text-micro font-semibold uppercase tracking-[0.16em] text-faint">Where the gate is wired</p>
            <ul className="mt-2 space-y-1.5 text-xs text-muted">
              {data.enforcement.map((e) => (
                <li key={e.action}>
                  <span className="text-strong">{e.action}</span> → <span className="metric-num text-micro">{e.capability}</span>
                  <span className="text-faint"> · {e.where} · </span>
                  {e.onDenial}
                </li>
              ))}
            </ul>
          </div>
    </div>
  );
}
