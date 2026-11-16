import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Brain, Network, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { hasTauriIpc, tauriInvoke } from '@/lib/transport';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';

interface NaniStatus {
  enabled: boolean;
  intelligenceLevel: string;
  lastDiagnosis: { cause?: string; confidence?: string; latencyMs?: number } | null;
}

interface ShadowAssessment {
  apiId: string;
  at: number;
  ageMs: number;
  shadow: { status: string; category?: string };
  live: { health: string; failures: number; successes: number } | null;
}

interface ShadowHealthResponse {
  assessments: ShadowAssessment[];
  count: number;
}

interface PersonalizationStatus {
  schema_version: number;
  active_context: number | null;
  contexts: number;
  transitions: number;
  global_reliability: number;
  active_profile_confidence: number;
  tracked_metrics: number;
  reliability_pairs: number;
}

export default function NaniReportsPage() {
  const queryClient = useQueryClient();
  const { data: naniStatus, isError } = useQuery({
    queryKey: ['nani', 'status'],
    queryFn: () => api.get<NaniStatus>('/nani/status'),
    staleTime: 30_000,
  });
  const { data: personalization } = useQuery({
    queryKey: ['nani', 'personalization'],
    queryFn: () => tauriInvoke<PersonalizationStatus>('nani_personalization_status'),
    enabled: hasTauriIpc(),
    staleTime: 15_000,
  });
  const { data: shadowHealth, isError: shadowError } = useQuery({
    queryKey: ['nani', 'health', 'shadow'],
    queryFn: () => api.get<ShadowHealthResponse>('/nani/health/shadow'),
    refetchInterval: 10_000,
    staleTime: 0,
  });
  const reset = useMutation({
    mutationFn: async () => (await tauriInvoke<number>('nani_learning_reset')) ?? 0,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['nani', 'personalization'] });
      void queryClient.invalidateQueries({ queryKey: ['nani', 'status'] });
    },
  });

  return (
    <Card>
      <PageHeader
        title="NANI Reports"
        description="Status of the adaptive network intelligence engine. A diagnosis is shown only after it has actually run."
      />
      <CardBody className="space-y-4">
        <Card>
          <CardHeader title="System Status" icon={<Brain size={15} />} />
          <CardBody>
            {isError ? (
              <p className="text-sm text-muted">NANI status could not be read. No diagnosis is being claimed.</p>
            ) : naniStatus?.enabled ? (
              <div className="flex items-center gap-2">
                <span className="font-medium text-ok">● Active</span>
                <Badge tone="ok">{naniStatus.intelligenceLevel}</Badge>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <span className="font-medium text-muted">● Inactive</span>
              </div>
            )}
          </CardBody>
        </Card>

        {hasTauriIpc() && (
          <Card>
            <CardHeader
              title="Network personalization"
              icon={<Network size={15} />}
              actions={
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={reset.isPending || !personalization?.active_context}
                  onClick={() => reset.mutate()}
                >
                  <Trash2 size={13} /> Reset local profiles
                </Button>
              }
            />
            <CardBody className="space-y-1 text-sm">
              {personalization ? (
                <>
                  <p>
                    <span className="text-muted">Active profile:</span>{' '}
                    {personalization.active_context == null
                      ? 'none observed yet'
                      : `${personalization.contexts} local profile(s), active confidence ${(personalization.active_profile_confidence * 100).toFixed(0)}%`}
                  </p>
                  <p>
                    <span className="text-muted">Tracked baselines:</span>{' '}
                    {personalization.tracked_metrics} metric(s) · {personalization.reliability_pairs} context/API reliability pair(s)
                  </p>
                  <p>
                    <span className="text-muted">Transitions:</span> {personalization.transitions} ·{' '}
                    <span className="text-muted">global prior:</span>{' '}
                    {(personalization.global_reliability * 100).toFixed(0)}%
                  </p>
                  <p className="text-xs text-faint">
                    Local only. Profiles contain numeric baselines and random local ids — no SSIDs, addresses, or payloads.
                  </p>
                </>
              ) : (
                <p className="text-muted">No personalization state is available in this runtime.</p>
              )}
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader title="Shadow health" icon={<Brain size={15} />} />
          <CardBody className="space-y-2 text-sm">
            {shadowError ? (
              <p className="text-muted">Shadow health could not be read.</p>
            ) : shadowHealth?.assessments?.length ? (
              shadowHealth.assessments.map((assessment) => {
                const disagrees =
                  assessment.live != null && assessment.shadow.status !== assessment.live.health;
                return (
                  <div
                    key={assessment.apiId}
                    className={`rounded-md border px-3 py-2 ${
                      disagrees ? 'border-danger/60 bg-danger/10' : 'border-line bg-surface-2'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{assessment.apiId}</span>
                      {disagrees ? (
                        <Badge tone="danger">disagrees</Badge>
                      ) : (
                        <Badge tone="ok">agrees</Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted">
                      shadow: {assessment.shadow.status} · live:{' '}
                      {assessment.live?.health ?? 'n/a'} · age {Math.round(assessment.ageMs / 1000)}s
                    </p>
                  </div>
                );
              })
            ) : (
              <p className="text-muted">No buffered shadow assessments yet.</p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Last diagnosis" icon={<Brain size={15} />} />
          <CardBody>
            {naniStatus?.lastDiagnosis ? (
              <div className="space-y-1 text-sm">
                <p>
                  <span className="text-muted">Cause:</span> {naniStatus.lastDiagnosis.cause ?? 'not classified'}
                </p>
                <p>
                  <span className="text-muted">Confidence:</span>{' '}
                  {naniStatus.lastDiagnosis.confidence ?? 'not estimated'}
                </p>
                {naniStatus.lastDiagnosis.latencyMs != null && (
                  <p>
                    <span className="text-muted">Latency:</span> {naniStatus.lastDiagnosis.latencyMs} ms
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted">
                No diagnosis has been recorded yet. NANI does not invent a cause or a confidence value.
              </p>
            )}
          </CardBody>
        </Card>
      </CardBody>
    </Card>
  );
}
