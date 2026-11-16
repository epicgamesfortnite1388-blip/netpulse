import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, Loader2, Plus, RotateCcw, ShieldCheck, Undo2 } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { Input, Select } from '@/components/ui/Field';
import { api } from '@/lib/api';

/**
 * Interactive recovery planner.
 *
 * Every action maps to a real endpoint in `apps/api/src/routes/nani.ts`:
 *   GET  /nani/apis                  list providers
 *   POST /nani/apis                  register a provider
 *   POST /nani/recovery/plan         plan against the supplied candidate routes
 *   GET  /nani/recovery/next         authoritative next step + runtime snapshot
 *   POST /nani/recovery/step         record a measured step outcome (state change)
 *   POST /nani/recovery/reset        discard the runtime recovery state (state change)
 *
 * Planning and `next` are read-only. Recording an outcome and resetting are real
 * backend state changes, so both are gated behind an explicit confirmation and
 * are never triggered by an LLM. The step list is rendered from the server's
 * snapshot, not from local assumptions, so a skipped/exhausted plan is visible
 * rather than silently drifting.
 */

interface ApiEntry {
  entry: { id: string; provider: string; endpoint: string };
}

type RouteKind = 'direct' | 'upstream-proxy' | 'ipv6' | 'alternate-dns';

interface PlanStep {
  id: string;
  kind: string;
  routeId: string;
  requiresAuthorization: boolean;
}

type StepStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'requires-permission'
  | 'insufficient-evidence';

interface RecoverySnapshot {
  statuses: Array<{ stepId: string; status: StepStatus }>;
  attempts: number;
  done: boolean;
  exhausted: boolean;
  planStatus: 'ready' | 'requires-permission' | 'insufficient-evidence';
  reason?: string;
}

interface PlanResult {
  ok?: boolean;
  recoveryId: string;
  apiId: string;
  status: 'ready' | 'requires-permission' | 'insufficient-evidence';
  reason?: string;
  steps: PlanStep[];
  rejected: Array<{ id: string; reason: string }>;
  /** Route this engine verified working; the rollback target. */
  knownGoodRouteId: string | null;
}

interface RollbackResult {
  ok?: boolean;
  apiId: string;
  routeId: string;
  recoveryId: string | null;
  skippedStepIds: string[];
  revertedStepId: string | null;
  message: string;
}

interface StepResult {
  ok?: boolean;
  recoveryId: string;
  stepId: string;
  status: StepStatus;
  snapshot: RecoverySnapshot;
  nextStepId: string | null;
}

interface ResetResult {
  ok?: boolean;
  apiId: string;
  previousRecoveryId: string | null;
  cleared: boolean;
  message: string;
}

interface Candidate {
  kind: RouteKind;
  authorized: boolean;
}

const KIND_LABEL: Record<RouteKind, string> = {
  direct: 'Direct connection',
  'upstream-proxy': 'Approved upstream proxy',
  ipv6: 'IPv6',
  'alternate-dns': 'Alternate DNS',
};

// Step kinds are route-scoped ("probe-direct", "activate-upstream-proxy"), so
// they are matched by prefix rather than by exact string.
const STEP_LABELS: Array<[prefix: string, label: string]> = [
  ['probe', 'Probe route'],
  ['activate', 'Activate route'],
  ['verify', 'Verify operation'],
  ['rollback', 'Roll back to known-good'],
];

function candidateFeatures(kind: RouteKind) {
  return {
    successPrior: 0.6,
    latencyMs: 150,
    latencyStdMs: 40,
    jitterMs: 10,
    packetLoss: 0.01,
    recoveryMs: 2_000,
    resourceCost: 0.3,
    risk: kind === 'direct' ? 0.2 : 0.4,
  };
}

function stepLabel(kind: string): string {
  const base = kind.split(':')[0] ?? kind;
  const match = STEP_LABELS.find(([prefix]) => base.startsWith(prefix));
  return match?.[1] ?? base;
}

function statusTone(status: StepStatus): 'ok' | 'warn' | 'danger' | 'neutral' | 'accent' {
  switch (status) {
    case 'succeeded':
      return 'ok';
    case 'failed':
      return 'danger';
    case 'requires-permission':
    case 'insufficient-evidence':
      return 'warn';
    case 'running':
      return 'accent';
    default:
      return 'neutral';
  }
}

const RECORDABLE: Array<{ status: 'succeeded' | 'failed' | 'skipped'; label: string; hint: string }> = [
  { status: 'succeeded', label: 'Measured success', hint: 'the operation worked on this route' },
  { status: 'failed', label: 'Measured failure', hint: 'the route was tried and did not work' },
  { status: 'skipped', label: 'Not attempted', hint: 'no measurement was made for this step' },
];

export function RecoveryControls() {
  const [apis, setApis] = useState<ApiEntry[]>([]);
  const [apiId, setApiId] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([
    { kind: 'direct', authorized: false },
  ]);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [snapshot, setSnapshot] = useState<RecoverySnapshot | null>(null);
  const [nextStepId, setNextStepId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ step: PlanStep; status: StepStatus } | null>(null);
  const [resetting, setResetting] = useState(false);
  /** Own confirmation state for the rollback action — never shared with step records. */
  const [rollbackConfirming, setRollbackConfirming] = useState(false);
  const [knownGood, setKnownGood] = useState<string | null>(null);

  const [showRegister, setShowRegister] = useState(false);
  const [regId, setRegId] = useState('netpulse-local');
  const [regProvider, setRegProvider] = useState('NetPulse sidecar');
  const [regEndpoint, setRegEndpoint] = useState('http://127.0.0.1:47615');
  const [regAuth, setRegAuth] = useState('none');

  const loadApis = useCallback(async () => {
    try {
      const res = await api.get<{ apis: ApiEntry[] }>('/nani/apis');
      setApis(res.apis);
      setApiId((prev) => prev || res.apis[0]?.entry.id || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not load APIs');
    }
  }, []);

  useEffect(() => {
    void loadApis();
  }, [loadApis]);

  const statusFor = useMemo(() => {
    const map = new Map<string, StepStatus>();
    for (const s of snapshot?.statuses ?? []) map.set(s.stepId, s.status);
    return (stepId: string): StepStatus => map.get(stepId) ?? 'pending';
  }, [snapshot]);

  const registerApi = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.post('/nani/apis', {
        id: regId,
        provider: regProvider,
        endpoint: regEndpoint,
        authType: regAuth,
      });
      await loadApis();
      setShowRegister(false);
      setNotice(`Registered API ${regId}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'registration failed');
    } finally {
      setBusy(false);
    }
  }, [regId, regProvider, regEndpoint, regAuth, loadApis]);

  /** Read the engine's authoritative next step + snapshot for the active plan. */
  const refreshNext = useCallback(async () => {
    if (!apiId) return null;
    const res = await api.get<{
      step: PlanStep | null;
      snapshot: RecoverySnapshot | null;
      knownGoodRouteId: string | null;
    }>(`/nani/recovery/next?apiId=${encodeURIComponent(apiId)}`);
    setSnapshot(res.snapshot);
    setNextStepId(res.step?.id ?? null);
    setKnownGood(res.knownGoodRouteId ?? null);
    return res;
  }, [apiId]);

  const planRecovery = useCallback(async () => {
    if (!apiId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setPlan(null);
    setSnapshot(null);
    setNextStepId(null);
    try {
      const stamp = Date.now().toString(36);
      const routes = candidates.map((c, i) => ({
        id: `${c.kind}-${stamp}-${i}`,
        kind: c.kind,
        authorized: c.authorized,
        tlsVerification: true,
        features: candidateFeatures(c.kind),
      }));
      // Carry the verified route so the plan includes its rollback step. Without
      // it the planner cannot know where to revert to.
      const res = await api.post<PlanResult>('/nani/recovery/plan', {
        apiId,
        routes,
        ...(knownGood ? { knownGoodRouteId: knownGood } : {}),
      });
      setPlan(res);
      setKnownGood(res.knownGoodRouteId ?? null);
      setRollbackConfirming(false);
      if (res.status === 'ready') {
        const next = await refreshNext();
        setNotice(
          next?.step
            ? `Plan ready. Next runnable step: ${next.step.id}.`
            : 'Plan ready, but no runnable step is available right now (cooldown or exhausted).',
        );
      } else {
        setNotice(res.reason ?? `Recovery status: ${res.status}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'recovery plan failed');
    } finally {
      setBusy(false);
    }
  }, [apiId, candidates, knownGood, refreshNext]);

  const fetchNext = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await refreshNext();
      setNotice(
        res?.step
          ? `Next step: ${res.step.id} (${stepLabel(res.step.kind)}).`
          : 'No runnable step: the plan is done, exhausted, or not planned yet.',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not read next step');
    } finally {
      setBusy(false);
    }
  }, [refreshNext]);

  const recordStep = useCallback(
    async (step: PlanStep, status: StepStatus) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const res = await api.post<StepResult>('/nani/recovery/step', {
          apiId,
          stepId: step.id,
          status,
        });
        setSnapshot(res.snapshot);
        setConfirming(null);
        // Re-read from the engine instead of guessing what comes next.
        const next = await refreshNext();
        const nextId = next?.step?.id ?? res.nextStepId;
        setNotice(
          `Recorded ${step.id} as ${status}. ${
            nextId ? `Next: ${nextId}.` : res.snapshot.done ? 'Plan complete.' : 'No further runnable step.'
          }`,
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : 'could not record step outcome');
      } finally {
        setBusy(false);
      }
    },
    [apiId, refreshNext],
  );

  /**
   * Revert the plan to the route this engine last verified.
   *
   * Its own action and its own confirmation: it ends the active plan (remaining
   * steps are recorded as skipped) instead of recording one step's outcome,
   * and it is refused by the backend when no route was ever verified.
   */
  const rollbackToKnownGood = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.post<RollbackResult>('/nani/recovery/rollback', { apiId });
      setRollbackConfirming(false);
      await refreshNext();
      setNotice(res.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'rollback failed');
    } finally {
      setBusy(false);
    }
  }, [apiId, refreshNext]);

  const resetRuntime = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<ResetResult>('/nani/recovery/reset', { apiId });
      setPlan(null);
      setSnapshot(null);
      setNextStepId(null);
      setResetting(false);
      setNotice(res.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'reset failed');
    } finally {
      setBusy(false);
    }
  }, [apiId]);

  const toggleKind = (kind: RouteKind, checked: boolean) => {
    setCandidates((prev) =>
      checked
        ? [...prev, { kind, authorized: false }]
        : prev.filter((c) => c.kind !== kind),
    );
  };

  return (
    <Card>
      <CardHeader
        title="Recovery planner"
        subtitle="Plan candidate routes, step through the engine's plan, and record real outcomes"
        actions={<Badge tone="warn">state changes require confirmation</Badge>}
      />

      <CardBody className="space-y-4">
        {apis.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck size={20} />}
            title="No APIs registered"
            message="Register an API provider to plan recovery against it."
          />
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-xs text-muted">
                API
                <Select value={apiId} onChange={(e) => setApiId(e.target.value)}>
                  {apis.map((a) => (
                    <option key={a.entry.id} value={a.entry.id}>
                      {a.entry.provider} ({a.entry.id})
                    </option>
                  ))}
                </Select>
              </label>
              <div className="text-xs text-muted">
                Candidate routes
                <div className="mt-1 space-y-1.5">
                  {(Object.keys(KIND_LABEL) as RouteKind[]).map((kind) => {
                    const candidate = candidates.find((c) => c.kind === kind);
                    return (
                      <div key={kind} className="flex items-center justify-between gap-2">
                        <label className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={Boolean(candidate)}
                            onChange={(e) => toggleKind(kind, e.target.checked)}
                            className="h-4 w-4 rounded border-line"
                          />
                          {KIND_LABEL[kind]}
                        </label>
                        {candidate && (
                          <label className="flex items-center gap-1.5 text-faint">
                            <input
                              type="checkbox"
                              checked={candidate.authorized}
                              onChange={(e) =>
                                setCandidates((prev) =>
                                  prev.map((c) =>
                                    c.kind === kind ? { ...c, authorized: e.target.checked } : c,
                                  ),
                                )
                              }
                              className="h-4 w-4 rounded border-line"
                            />
                            authorized
                          </label>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <p className="text-xs text-faint">
              TLS verification is always enforced. A route without authorization is reported as
              <span className="font-mono"> requires-permission</span> or rejected — never executed.
            </p>

            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => void planRecovery()}
                loading={busy && !plan}
                disabled={busy || !apiId || candidates.length === 0}
              >
                Plan recovery
              </Button>
              <Button variant="secondary" onClick={() => void fetchNext()} disabled={busy || !apiId}>
                <ArrowRight size={14} /> Fetch next step
              </Button>
              {knownGood && !rollbackConfirming ? (
                <Button
                  variant="secondary"
                  onClick={() => setRollbackConfirming(true)}
                  disabled={busy || !apiId || Boolean(snapshot?.done)}
                  title={
                    snapshot?.done
                      ? `Plan already finished — plan recovery again to revert to ${knownGood}`
                      : `Revert to ${knownGood}, the last route this engine verified`
                  }
                >
                  <Undo2 size={14} /> Roll back to known-good
                </Button>
              ) : null}
              {resetting ? (
                <>
                  <Button variant="danger" onClick={() => void resetRuntime()} loading={busy} disabled={busy}>
                    <RotateCcw size={14} /> Confirm reset
                  </Button>
                  <Button variant="ghost" onClick={() => setResetting(false)} disabled={busy}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button variant="ghost" onClick={() => setResetting(true)} disabled={busy || !apiId}>
                  <Undo2 size={14} /> Reset runtime state
                </Button>
              )}
            </div>

            {!knownGood && (
              <p className="text-xs text-faint">
                No known-good route yet — a route recorded as a verified success becomes the rollback
                target.
              </p>
            )}

            {notice && <p className="text-xs text-muted">{notice}</p>}
            {error && <ErrorState error={new Error(error)} retry={() => setError(null)} />}

            {plan && (
              <div className="space-y-2 rounded-lg border border-line bg-surface-2 p-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-text">Plan {plan.recoveryId}</span>
                  <Badge tone={plan.status === 'ready' ? 'ok' : plan.status === 'requires-permission' ? 'warn' : 'neutral'}>
                    {plan.status}
                  </Badge>
                  {snapshot && (
                    <>
                      <Badge tone="neutral">attempts {snapshot.attempts}</Badge>
                      {snapshot.done && <Badge tone="ok">done</Badge>}
                      {snapshot.exhausted && <Badge tone="danger">exhausted</Badge>}
                    </>
                  )}
                </div>

                {plan.reason && <p className="text-xs text-faint">{plan.reason}</p>}
                {plan.steps.length === 0 && <p className="text-xs text-faint">No actionable steps in this plan.</p>}

                <ol className="space-y-2">
                  {plan.steps.map((step, index) => {
                    const status = statusFor(step.id);
                    const isNext = step.id === nextStepId;
                    return (
                      <li
                        key={step.id}
                        className={`rounded border p-2 text-xs ${
                          isNext ? 'border-accent/60 bg-accent-soft' : 'border-line bg-surface'
                        }`}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-mono text-text">
                            {index + 1}. {step.id}
                          </span>
                          <div className="flex items-center gap-2">
                            <Badge tone={statusTone(status)}>{status}</Badge>
                            <Badge tone="neutral">{stepLabel(step.kind)}</Badge>
                            {isNext && <Badge tone="accent">next</Badge>}
                            {step.requiresAuthorization && <Badge tone="warn">authorization required</Badge>}
                          </div>
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {RECORDABLE.map((r) => (
                            <Button
                              key={r.status}
                              size="sm"
                              variant={r.status === 'succeeded' ? 'primary' : 'secondary'}
                              onClick={() => setConfirming({ step, status: r.status })}
                              disabled={busy || status !== 'pending'}
                              title={r.hint}
                            >
                              {r.label}…
                            </Button>
                          ))}
                        </div>
                      </li>
                    );
                  })}
                </ol>

                {plan.rejected.length > 0 && (
                  <div className="rounded border border-line bg-surface p-2 text-xs text-faint">
                    <div className="mb-1 text-muted">Rejected routes</div>
                    {plan.rejected.map((r) => (
                      <div key={r.id}>
                        <span className="font-mono">{r.id}</span>: {r.reason}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {rollbackConfirming && (
              <div className="rounded-lg border border-danger/50 bg-danger/10 p-3">
                <div className="flex items-start gap-2 text-sm text-text">
                  <Undo2 size={16} className="mt-0.5 text-danger" />
                  <div>
                    <div className="font-medium">Roll back to known-good route “{knownGood}”?</div>
                    <p className="mt-1 text-xs text-muted">
                      This ends the active plan: the rollback step is recorded as succeeded and every
                      unfinished step is recorded as skipped. The engine marks “{knownGood}” as the current
                      route — it does not change network configuration by itself, and the only way back is to
                      plan recovery again.
                    </p>
                  </div>
                </div>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" variant="danger" onClick={() => void rollbackToKnownGood()} disabled={busy}>
                    {busy ? <Loader2 size={13} className="animate-spin" /> : <Undo2 size={13} />}
                    Confirm rollback
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setRollbackConfirming(false)} disabled={busy}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {confirming && (
              <div className="rounded-lg border border-warn/50 bg-warn/10 p-3">
                <div className="flex items-start gap-2 text-sm text-text">
                  <AlertTriangle size={16} className="mt-0.5 text-warn" />
                  <div>
                    <div className="font-medium">
                      Record “{confirming.step.id}” as {confirming.status}?
                    </div>
                    <p className="mt-1 text-xs text-muted">
                      This writes a real outcome to the engine's recovery controller. A verified success
                      marks the route as activated and ends the plan; a failure starts the route cooldown and
                      can make a rollback step runnable. Runtime state can be reset afterwards.
                    </p>
                  </div>
                </div>
                <div className="mt-3 flex gap-2">
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => void recordStep(confirming.step, confirming.status)}
                    disabled={busy}
                  >
                    {busy ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}
                    Confirm {confirming.status}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(null)} disabled={busy}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </>
        )}

        {/* Register a provider (real POST /nani/apis) */}
        {showRegister ? (
          <div className="space-y-2 rounded-lg border border-line bg-surface-2 p-3">
            <div className="text-sm font-medium text-text">Register API provider</div>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-xs text-muted">
                API id
                <Input value={regId} onChange={(e) => setRegId(e.target.value)} />
              </label>
              <label className="text-xs text-muted">
                Provider
                <Input value={regProvider} onChange={(e) => setRegProvider(e.target.value)} />
              </label>
              <label className="text-xs text-muted">
                Endpoint
                <Input value={regEndpoint} onChange={(e) => setRegEndpoint(e.target.value)} />
              </label>
              <label className="text-xs text-muted">
                Auth type
                <Select value={regAuth} onChange={(e) => setRegAuth(e.target.value)}>
                  {['none', 'bearer', 'api-key', 'oauth2', 'basic'].map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </Select>
              </label>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void registerApi()} loading={busy} disabled={busy || !regId || !regEndpoint}>
                Register
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowRegister(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => setShowRegister(true)}>
            <Plus size={13} /> Register API
          </Button>
        )}
      </CardBody>
    </Card>
  );
}
