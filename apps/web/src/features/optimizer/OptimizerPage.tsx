import { useCallback, useState } from 'react';

import { useQuery } from '@tanstack/react-query';
import { Gauge, Play, Swords } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState, ErrorState } from '@/components/ui/States';
import { Progress } from '@/components/ui/Progress';
import { Field } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { api } from '@/lib/api';
import { usePersistentId, usePersistentState } from '@/lib/usePersistentState';
import { useBackgroundTest } from '@/lib/useBackgroundTest';

interface OptimizationCandidateResult {
  candidate: { id: string; name: string; kind: string; host: string; port: number | null };
  score: number | null;
  label: string | null;
  rank: number;
  metrics: {
    pingAvgMs: number | null;
    jitterMs: number | null;
    lossPct: number | null;
    tcpMs: number | null;
    hops: number | null;
    routeScore: number | null;
  };
}

interface OptimizationRunResponse {
  testId: string;
  weights: Record<string, number>;
  results: OptimizationCandidateResult[];
  best: OptimizationCandidateResult | null;
}

interface CandidateInput {
  id: string;
  name: string;
  host: string;
  port?: number;
}

export default function OptimizerPage() {
  const serversQuery = useQuery({
    queryKey: ['servers'],
    queryFn: () => api.get<{ servers: { id: string; name: string; host: string; port: number | null; kind: string }[] }>('/servers'),
  });

  // Candidate list is user input — persist it so a tab switch mid-run doesn't
  // wipe an expensive paste.
  const [candidateText, setCandidateText] = usePersistentState<string>('optimizer.candidates', '');
  const [testId, setTestId] = usePersistentId('optimizer.testId');
  const [submitError, setSubmitError] = useState<unknown>(null);
  const state = useBackgroundTest<OptimizationRunResponse>(testId);

  const parseCandidates = useCallback((): CandidateInput[] => {
    return candidateText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line, i) => {
        // "name,host:port" or "host:port" or "host"
        const [label, rest] = line.includes(',') ? [line.slice(0, line.indexOf(',')), line.slice(line.indexOf(',') + 1)] : [null, line];
        const host = rest.replace(/:\d+$/, '').trim();
        const portMatch = rest.match(/:(\d+)$/);
        return {
          id: `c-${i}`,
          name: label?.trim() || host,
          host,
          port: portMatch ? Number(portMatch[1]) : undefined,
        };
      })
      .filter((c) => c.host.length > 0);
  }, [candidateText]);

  const run = useCallback(async (candidates: CandidateInput[]) => {
    if (candidates.length === 0) return;
    setSubmitError(null);
    try {
      const id = await api.post<{ testId: string }>('/optimizer/run', {
        candidates,
        probes: 4,
        withRoute: false,
      }).then((r) => r.testId);
      setTestId(id);
    } catch (err) {
      setSubmitError(err);
    }
  }, []);

  const runConfigured = useCallback(() => {
    const servers = (serversQuery.data?.servers ?? [])
      .map((s) => ({ id: s.id, name: s.name, host: s.host, port: s.port ?? undefined }));
    void run(servers.length > 0 ? servers : parseCandidates());
  }, [serversQuery.data, parseCandidates, run]);

  const runCustom = useCallback(() => void run(parseCandidates()), [parseCandidates, run]);

  const running = state.running;
  const result = state.result;
  const error = submitError ?? state.error;

  return (
    <div>
      <PageHeader
        title="Optimizer"
        description="Measure every candidate with the full probe battery, score them with the weighted engine and rank them. Weights are configurable in Settings."
        actions={
          <Button variant="primary" onClick={runConfigured} loading={running} disabled={running}>
            <Play size={14} />
            Run optimization
          </Button>
        }
      />

      {running && (
        <Card className="mb-5">
          <CardBody>
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="text-muted">{state.message ?? 'Measuring candidates…'}</span>
              <span className="font-mono text-faint">{state.pct ?? 0}%</span>
            </div>
            <Progress value={state.pct ?? 0} />
          </CardBody>
        </Card>
      )}

      {error != null && (
        <div className="mb-5">
          <ErrorState error={error} retry={runConfigured} />
        </div>
      )}

      {result == null && !running && error == null && (
        <EmptyState
          icon={<Gauge size={20} />}
          title="No optimization run yet"
          message="Runs live probes (ICMP latency, jitter, packet loss and TCP connect) against each candidate from your server list, scores them with the shared weighted engine and ranks the field. Candidates that never respond rank last with honest nulls — no fabricated numbers."
        />
      )}

      {result && (
        <div className="space-y-5">
          {result.best && (
            <Card className="border-ok/40">
              <CardHeader title="Recommendation" icon={<Swords size={15} />} subtitle="Based on this run's live measurements and the configured weights" />
              <CardBody className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
                <span className="text-lg font-semibold text-ok">{result.best.candidate.name}</span>
                <span className="font-mono text-sm text-muted">{result.best.candidate.host}{result.best.candidate.port ? `:${result.best.candidate.port}` : ''}</span>
                <Badge tone="ok">score {result.best.score ?? '—'}</Badge>
                {result.best.metrics.pingAvgMs != null && <span className="text-xs text-faint">ping {result.best.metrics.pingAvgMs.toFixed(1)} ms</span>}
                {result.best.metrics.lossPct != null && <span className="text-xs text-faint">loss {result.best.metrics.lossPct.toFixed(1)}%</span>}
              </CardBody>
            </Card>
          )}

          <Card>
            <CardHeader title="Ranked results" subtitle={`${result.results.length} candidates · weights: ${Object.entries(result.weights ?? {}).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(' · ') || 'unavailable'}`} />
            <CardBody className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-[11px] uppercase tracking-wider text-faint">
                    <th className="px-5 py-2.5 font-medium">#</th>
                    <th className="px-3 py-2.5 font-medium">Candidate</th>
                    <th className="px-3 py-2.5 font-medium">Host</th>
                    <th className="px-3 py-2.5 text-right font-medium">Ping</th>
                    <th className="px-3 py-2.5 text-right font-medium">Jitter</th>
                    <th className="px-3 py-2.5 text-right font-medium">Loss</th>
                    <th className="px-3 py-2.5 text-right font-medium">TCP</th>
                    <th className="px-5 py-2.5 text-right font-medium">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {[...result.results].sort((a, b) => a.rank - b.rank).map((r) => (
                    <tr key={r.candidate.id} className="border-b border-line/60 last:border-0">
                      <td className="px-5 py-3 font-mono text-faint">{r.rank}</td>
                      <td className="px-3 py-3 font-medium">{r.candidate.name}</td>
                      <td className="px-3 py-3 font-mono text-xs text-muted">{r.candidate.host}{r.candidate.port ? `:${r.candidate.port}` : ''}</td>
                      <td className="px-3 py-3 text-right font-mono">{r.metrics.pingAvgMs != null ? `${r.metrics.pingAvgMs.toFixed(1)} ms` : '—'}</td>
                      <td className="px-3 py-3 text-right font-mono text-muted">{r.metrics.jitterMs != null ? `${r.metrics.jitterMs.toFixed(1)} ms` : '—'}</td>
                      <td className="px-3 py-3 text-right font-mono text-muted">{r.metrics.lossPct != null ? `${r.metrics.lossPct.toFixed(1)}%` : '—'}</td>
                      <td className="px-3 py-3 text-right font-mono text-muted">{r.metrics.tcpMs != null ? `${r.metrics.tcpMs.toFixed(1)} ms` : '—'}</td>
                      <td className="px-5 py-3 text-right">
                        {r.score != null ? <Badge tone={r.score >= 75 ? 'ok' : r.score >= 45 ? 'warn' : 'danger'}>{r.score}</Badge> : <Badge tone="neutral">no response</Badge>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardBody>
          </Card>
        </div>
      )}

      <Card className="mt-5">
        <CardHeader title="Custom candidates" subtitle="One per line: host[:port] or name,host[:port]" />
        <CardBody className="space-y-3">
          <Field label="Candidate list">
            <textarea
              className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-xs text-text placeholder:text-faint focus:border-accent focus:outline-none"
              rows={4}
              placeholder={'1.1.1.1:443\nGoogle DNS,8.8.8.8:443\nspeed.cloudflare.com'}
              value={candidateText}
              onChange={(e) => setCandidateText(e.target.value)}
            />
          </Field>
          <Button variant="ghost" onClick={runCustom} loading={running} disabled={running || parseCandidates().length === 0}>
            <Play size={14} />
            Run on custom list
          </Button>
        </CardBody>
      </Card>
    </div>
  );
}
