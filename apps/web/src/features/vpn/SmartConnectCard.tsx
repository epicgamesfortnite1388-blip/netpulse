import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BrainCircuit, CheckCircle2, RefreshCw, ShieldAlert, Telescope, XCircle } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/Toaster';
import { api } from '@/lib/api';
import { DisclosureScope } from '@/components/ui/Disclosure';
import { MetricStrip, Notice, Panel, Section } from '@/components/ui/Surface';

/**
 * Smart Connect — the decision surface for public nodes.
 *
 * The card renders the plan the backend actually produced: how many rows were
 * considered, why the rest were excluded (with counts), and the top candidates
 * with the components that produced each score. Verification is a separate,
 * explicit action because it dials third-party endpoints; the plan itself opens
 * no sockets.
 *
 * Honesty rules this UI follows:
 *   - "verified" is only ever said about the result of a probe that carried
 *     traffic, never about a stored score;
 *   - an empty list is explained by the exclusion counts, not by a spinner;
 *   - the privacy warning is shown before any connect step, and this card never
 *     connects on its own.
 */

interface SmartComponents {
  reliability: number;
  latency: number;
  freshness: number;
  evidence: number;
  sources: number;
  adaptiveBoost: number;
  failurePenalty: number;
}

interface SmartCandidate {
  nodeId: string;
  protocol: string;
  country: string | null;
  engine: string | null;
  score: number;
  components: SmartComponents;
  confidence: 'verified' | 'tested' | 'untested';
  trust: string;
  reasons: string[];
  probe: { at: number; status: string; latencyMs: number | null; httpStatus: number | null; verified: boolean; error: string | null } | null;
}

export interface SmartPlan {
  generatedAt: number;
  considered: number;
  excludedByReason: Record<string, number>;
  candidates: SmartCandidate[];
  chosen: SmartCandidate | null;
  decision: string;
  probesRun?: number;
  verified?: boolean;
  adaptive: {
    available: boolean;
    enabled: boolean;
    context: string | null;
    contextSummary: string | null;
    engineProbabilities: Array<{ engine: string; probability: number; confidence: string }>;
    note: string;
  };
  limits: string[];
  next?: { createProfile: string; connect: string; note: string } | null;
}

const CONFIDENCE_TONE = { verified: 'ok', tested: 'accent', untested: 'warn' } as const;

const EXCLUSION_LABEL: Record<string, string> = {
  revoked: 'revoked',
  failed: 'repeatedly failing',
  stale: 'stale',
  abandoned: 'unseen for 7+ days',
  'no-engine-installed': 'no compatible core installed',
  'unsupported-protocol': 'unsupported protocol',
  // The two configs the installed core refuses before dialling (plaintext VLESS,
  // keyless REALITY). Without a label the badge printed the raw enum.
  'engine-rejects-config': 'refused by the installed core',
};

function scoreTone(score: number): string {
  return score >= 70 ? 'text-ok' : score >= 45 ? 'text-accent' : 'text-warn';
}

export function SmartConnectCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const [plan, setPlan] = useState<SmartPlan | null>(null);

  const planQuery = useQuery({
    queryKey: ['vpn', 'smart-connect', 'plan'],
    queryFn: () => api.get<SmartPlan>('/vpn/smart-connect?limit=300'),
    refetchInterval: 60_000,
  });

  const verify = useMutation({
    mutationFn: () => api.post<SmartPlan>('/vpn/smart-connect', { maxProbes: 3 }),
    onSuccess: (result) => {
      setPlan(result);
      qc.invalidateQueries({ queryKey: ['vpn', 'smart-connect', 'plan'] });
      if (result.verified && result.chosen) {
        toast('ok', `Traffic verified through ${result.chosen.nodeId.slice(0, 8)}…`, `${result.probesRun} probe${result.probesRun === 1 ? '' : 's'}`);
      } else {
        toast('warn', 'No candidate carried traffic', `Probed ${result.probesRun ?? 0} candidate(s); staying disconnected is the correct outcome.`);
      }
    },
    onError: (err) => toast('error', 'Verification failed', err instanceof Error ? err.message : undefined),
  });

  const shown = plan ?? planQuery.data ?? null;

  return (
    <Section
      title="Smart Connect"
      subtitle="Choose a public configuration on evidence, then prove it"
      icon={<BrainCircuit size={15} />}
      badge={shown?.chosen ? <Badge tone={CONFIDENCE_TONE[shown.chosen.confidence]}>{shown.chosen.confidence}</Badge> : undefined}
      actions={
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => planQuery.refetch()}
            disabled={planQuery.isFetching || verify.isPending}
            title="Re-rank stored candidates (opens no connections)"
          >
            <RefreshCw size={13} className={planQuery.isFetching ? 'animate-spin' : ''} />
            Re-rank
          </Button>
          <Button
            size="sm"
            onClick={() => verify.mutate()}
            disabled={verify.isPending || !shown || shown.candidates.length === 0}
            title="Dial up to 3 candidates through the installed core, two at a time; traffic must actually traverse"
          >
            <Telescope size={13} />
            {verify.isPending ? 'Verifying…' : 'Verify best'}
          </Button>
        </div>
      }
      collapsible
      id="vpn-smart-connect"
      summary="Ranking, exclusions and bounded verification for public nodes"
    >
      {planQuery.isError ? (
        <Notice tone="warn" icon={<XCircle size={13} />}>
          {planQuery.error instanceof Error ? planQuery.error.message : 'Could not read the Smart Connect plan.'}
        </Notice>
      ) : !shown ? (
        <p className="text-sm text-muted">Reading stored candidates…</p>
      ) : (
        <SmartConnectBody plan={shown} />
      )}
    </Section>
  );
}

/**
 * The plan exactly as the user reads it, with no fetching of its own.
 *
 * Exported so a test renders the real markup — the counts, the exclusion
 * labels, the decision sentence and the per-candidate evidence — instead of a
 * re-implementation of it that can drift. `renderToStaticMarkup` is enough here
 * because nothing below reads state or effects.
 */
export function SmartConnectBody({ plan: shown }: { plan: SmartPlan }) {
  const excluded = Object.entries(shown.excludedByReason).sort((a, b) => b[1] - a[1]);
  const top = shown.candidates.slice(0, 3);

  return (
        <div className="space-y-5">
          <MetricStrip
            items={[
              { label: 'Considered', value: shown.considered.toLocaleString(), hint: 'stored public nodes' },
              { label: 'Candidates', value: shown.candidates.length.toLocaleString(), hint: 'survived every filter' },
              {
                label: 'Excluded',
                value: Object.values(shown.excludedByReason).reduce((a, b) => a + b, 0).toLocaleString(),
                tone: excluded.length > 0 ? 'warn' : 'default',
                hint: excluded.length > 0 ? 'see reasons below' : 'nothing filtered out',
              },
              {
                label: 'AI context',
                value: shown.adaptive.enabled ? 'learning on' : 'evidence only',
                hint: shown.adaptive.context ?? shown.adaptive.note,
              },
            ]}
          />

          <Notice tone={shown.chosen ? (shown.chosen.confidence === 'verified' ? 'ok' : 'info') : 'warn'} icon={<ShieldAlert size={13} />}>
            {shown.decision}
          </Notice>

          {excluded.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {excluded.map(([reason, count]) => (
                <Badge key={reason} tone="warn">
                  {EXCLUSION_LABEL[reason] ?? reason}: {count}
                </Badge>
              ))}
            </div>
          )}

          {top.length > 0 && (
            <div className="space-y-2">
              {top.map((candidate, index) => (
                <Panel key={candidate.nodeId} tone={index === 0 ? 'accent' : 'quiet'}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">
                        <span className="metric-num text-faint">{index + 1}.</span> {candidate.protocol}
                        {candidate.engine ? ` over ${candidate.engine}` : ''}
                        {candidate.country ? ` · ${candidate.country}` : ''}
                      </p>
                      <p className="mt-0.5 truncate text-micro text-faint">
                        {candidate.reasons.slice(0, 2).join(' · ')}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone={CONFIDENCE_TONE[candidate.confidence]}>{candidate.confidence}</Badge>
                      <Badge>{candidate.trust.toLowerCase().replace(/_/g, ' ')}</Badge>
                      <span className={`metric-num text-sm font-semibold ${scoreTone(candidate.score)}`}>{candidate.score}</span>
                    </div>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-micro text-muted sm:grid-cols-4">
                    <span>reliability {candidate.components.reliability}</span>
                    <span>latency {candidate.components.latency}</span>
                    <span>freshness {candidate.components.freshness}</span>
                    <span>evidence {candidate.components.evidence}</span>
                    <span>sources {candidate.components.sources}</span>
                    <span>
                      adaptive {candidate.components.adaptiveBoost > 0 ? '+' : ''}
                      {candidate.components.adaptiveBoost.toFixed(1)}
                    </span>
                    <span>
                      penalty {candidate.components.failurePenalty}
                    </span>
                    {candidate.probe && (
                      <span className={candidate.probe.verified ? 'text-ok' : 'text-warn'}>
                        {candidate.probe.verified ? (
                          <>
                            <CheckCircle2 size={10} className="mr-1 inline" />
                            verified {candidate.probe.latencyMs != null ? `${candidate.probe.latencyMs} ms` : ''}
                          </>
                        ) : (
                          <>probe failed</>
                        )}
                      </span>
                    )}
                  </div>
                </Panel>
              ))}
            </div>
          )}

          {shown.next && (
            <Notice tone="warn" icon={<ShieldAlert size={13} />}>
              Verified: this endpoint carried traffic <em>just now</em>. Its operator is unknown and can observe connection metadata. Connecting is a
              separate step you authorise; Smart Connect never connects on its own.
              <div className="mt-1 font-mono text-micro text-faint">
                {shown.next.createProfile} → {shown.next.connect}
              </div>
            </Notice>
          )}

          <DisclosureScope name="What this ranking does and does not mean">
            <ul className="space-y-1 text-micro leading-relaxed text-muted">
              {shown.limits.map((line) => (
                <li key={line}>{line}</li>
              ))}
              <li>Adaptive note: {shown.adaptive.note}</li>
            </ul>
          </DisclosureScope>
    </div>
  );
}
