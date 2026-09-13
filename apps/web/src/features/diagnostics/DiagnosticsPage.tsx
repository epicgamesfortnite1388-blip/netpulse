import { useCallback, useEffect, useState } from 'react';

import { useQuery } from '@tanstack/react-query';
import { Activity, HeartPulse, Network, Play, Waves } from 'lucide-react';

import { LatencyChart } from '@/components/charts/LatencyChart';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Metric } from '@/components/ui/Metric';
import { PageHeader } from '@/components/ui/PageHeader';
import { Progress } from '@/components/ui/Progress';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/States';
import { api } from '@/lib/api';
import { usePersistentId } from '@/lib/usePersistentState';
import { useBackgroundTest } from '@/lib/useBackgroundTest';
import { subscribeTest } from '@/lib/ws';

interface DiagnosticStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'skipped' | 'error';
  detail?: string;
}

interface DiagnosticReport {
  testId: string;
  startedAt: number;
  finishedAt: number | null;
  steps: DiagnosticStep[];
  findings: { severity: string; title: string; message: string }[];
}

interface BufferbloatResult {
  idleLatencyMs: number | null;
  downloadLoadLatencyMs: number | null;
  uploadLoadLatencyMs: number | null;
  downloadIncreaseMs: number | null;
  uploadIncreaseMs: number | null;
  grade: string | null;
  explanation: string;
}

interface MtuResult {
  mtu: number | null;
  probablePath: string | null;
  note: string | null;
}

interface CgnatResult {
  detected: boolean | null;
  publicIp: string | null;
  explanation: string;
}

interface StabilityStatus {
  running: boolean;
  intervalMs: number | null;
  sampleCount: number;
}

interface StabilitySample {
  t: number;
  latencyMs: number | null;
  jitterMs: number | null;
  lossPct: number | null;
  dnsMs: number | null;
  online: boolean;
}

const STEP_TONE = {
  pending: 'neutral',
  running: 'accent',
  done: 'ok',
  skipped: 'neutral',
  error: 'danger',
} as const;

export default function DiagnosticsPage() {
  // Test IDs persist across tab switches — useBackgroundTest re-attaches to
  // WS progress AND polls the persisted record, so a complete-diagnostic that
  // keeps running while the user browses other tabs is still live on return.
  const [diagId, setDiagId] = usePersistentId('diag.id');
  const diag = useBackgroundTest<DiagnosticReport>(diagId);
  const report = diag.result;
  const running = diag.running;
  const error = diag.error;

  // live diagnostic log from WS progress messages
  const [liveLog, setLiveLog] = useState<string[]>([]);
  useEffect(() => {
    if (diagId == null) return;
    const unsubscribe = subscribeTest(diagId, (msg) => {
      if (msg.type === 'test:progress' && msg.message) {
        setLiveLog((prev) => [...prev.slice(-24), msg.message as string]);
      }
    });
    return unsubscribe;
  }, [diagId]);

  const [bbId, setBbId] = usePersistentId('diag.bbId');
  const bb = useBackgroundTest<BufferbloatResult>(bbId);
  const bufferbloat = bb.result;
  const bbRunning = bb.running;
  const bbError = bb.error;

  const [mtuId, setMtuId] = usePersistentId('diag.mtuId');
  const mtuState = useBackgroundTest<MtuResult>(mtuId);
  const mtu = mtuState.result;
  const mtuRunning = mtuState.running;

  const [cgnat, setCgnat] = useState<CgnatResult | null>(null);
  const [toolError, setToolError] = useState<string | null>(null);

  const stabilityStatus = useQuery({
    queryKey: ['stability', 'status'],
    queryFn: () => api.get<StabilityStatus>('/stability/status'),
    refetchInterval: 5_000,
  });
  const stabilitySamples = useQuery({
    queryKey: ['stability', 'samples'],
    queryFn: () => api.get<{ samples: StabilitySample[] }>('/stability/samples?limit=120'),
    refetchInterval: 6_000,
    enabled: stabilityStatus.data?.running === true,
  });

  const runComplete = useCallback(async () => {
    setDiagId(null);
    setLiveLog([]);
    try {
      const res = await api.post<{ testId: string }>('/diagnostics/complete');
      setDiagId(res.testId);
    } catch {
      setDiagId(null);
    }
  }, []);

  const runBufferbloat = useCallback(async () => {
    setBbId(null);
    try {
      const res = await api.post<{ testId: string }>('/diagnostics/bufferbloat', { loadDurationMs: 6_000 });
      setBbId(res.testId);
    } catch {
      setBbId(null);
    }
  }, []);

  const runMtu = useCallback(async () => {
    setMtuId(null);
    try {
      const res = await api.post<{ testId: string }>('/diagnostics/mtu');
      setMtuId(res.testId);
    } catch {
      setMtuId(null);
    }
  }, []);

  const runCgnat = useCallback(async () => {
    setToolError(null);
    try {
      const res = await api.post<{ result: CgnatResult }>('/diagnostics/cgnat');
      setCgnat(res.result);
    } catch (err) {
      setToolError(err instanceof Error ? err.message : 'CGNAT check failed');
    }
  }, []);

  const toggleStability = useCallback(async () => {
    if (stabilityStatus.data?.running) await api.post('/stability/stop');
    else await api.post('/stability/start', { intervalMs: 5_000 });
    void stabilityStatus.refetch();
  }, [stabilityStatus]);

  const chartData = (stabilitySamples.data?.samples ?? [])
    .filter((s) => s.latencyMs != null)
    .map((s) => ({ t: s.t, ms: s.latencyMs as number }));

  const gradeTone = (g: string | null) =>
    g == null ? 'neutral' : g === 'A' || g === 'B' ? 'ok' : g === 'C' ? 'warn' : 'danger';

  return (
    <div>
      <PageHeader
        title="Diagnostics"
        description="One-click complete diagnostic plus focused tools: bufferbloat grading, path-MTU discovery, CGNAT detection and continuous stability monitoring."
        actions={
          <Button variant="primary" onClick={() => void runComplete()} loading={running} disabled={running}>
            <Play size={14} />
            Run complete diagnostic
          </Button>
        }
      />

      {error != null && <ErrorState error={new Error(error)} retry={() => void runComplete()} />}

      {running && (
        <Card className="mb-5">
          <CardBody className="space-y-2">
            <div className="mb-1 flex items-center justify-between text-sm">
              <span className="text-muted">{diag.message ?? 'Running diagnostic…'}</span>
              <span className="font-mono text-faint">{diag.pct != null ? `${diag.pct}%` : '…'}</span>
            </div>
            <Progress value={diag.pct ?? 0} />
            {liveLog.length > 0 && (
              <ul className="mt-3 space-y-1 border-t border-line pt-3">
                {liveLog.map((line, i) => (
                  <li key={i} className="font-mono text-[11px] text-faint">
                    {line}
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      )}

      {report && !running && (
        <Card className="mb-5">
          <CardHeader
            title="Last diagnostic report"
            icon={<HeartPulse size={15} />}
            subtitle={`${report.steps.filter((s) => s.status === 'done').length}/${report.steps.length} steps succeeded · ${new Date(report.startedAt).toLocaleTimeString()}`}
          />
          <CardBody className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              {report.steps.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-3 rounded-lg bg-surface-2 px-3 py-2 text-[13px]">
                  <span className="text-muted">{s.label}</span>
                  <span className="flex items-center gap-2 text-xs text-faint">
                    {s.detail}
                    <Badge tone={STEP_TONE[s.status]}>{s.status}</Badge>
                  </span>
                </div>
              ))}
            </div>
            {report.findings.length > 0 && (
              <div className="space-y-1.5">
                {report.findings.map((f, i) => (
                  <div key={i} className="flex items-start gap-2 text-[13px]">
                    <Badge tone={f.severity === 'error' ? 'danger' : f.severity === 'warn' ? 'warn' : f.severity === 'good' ? 'ok' : 'neutral'}>
                      {f.severity}
                    </Badge>
                    <span className="text-muted">
                      <span className="text-text">{f.title}:</span> {f.message}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <Card>
          <CardHeader
            title="Bufferbloat"
            icon={<Waves size={15} />}
            actions={bufferbloat?.grade && <Badge tone={gradeTone(bufferbloat.grade)}>grade {bufferbloat.grade}</Badge>}
          />
          <CardBody>
            {bufferbloat ? (
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-2">
                  <Metric label="Idle" value={bufferbloat.idleLatencyMs} unit="ms" />
                  <Metric label="Down" value={bufferbloat.downloadLoadLatencyMs} unit="ms" />
                  <Metric label="Up" value={bufferbloat.uploadLoadLatencyMs} unit="ms" />
                </div>
                <p className="text-xs leading-relaxed text-faint">{bufferbloat.explanation}</p>
              </div>
            ) : (
              <p className="py-2 text-sm text-faint">Measures idle latency, then latency under real download and upload load. Grade A means latency barely moves under load.</p>
            )}
            <Button className="mt-3" variant="ghost" onClick={() => void runBufferbloat()} loading={bbRunning} disabled={bbRunning}>
              Run test
            </Button>
            {bbError && <p className="mt-2 text-xs text-danger">{bbError}</p>}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="MTU discovery" icon={<Network size={15} />} />
          <CardBody>
            {mtu ? (
              <div className="space-y-2">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-2xl text-text">{mtu.mtu ?? '—'}</span>
                  <span className="text-xs text-faint">bytes · {mtu.probablePath ?? ''}</span>
                </div>
                {mtu.note && <p className="text-xs leading-relaxed text-faint">{mtu.note}</p>}
              </div>
            ) : (
              <p className="py-2 text-sm text-faint">Finds the largest unfragmented packet your path supports. Values below 1500 can stall some TLS handshakes.</p>
            )}
            <Button className="mt-3" variant="ghost" onClick={() => void runMtu()} loading={mtuRunning} disabled={mtuRunning}>
              Probe MTU
            </Button>
            {mtuState.error && <p className="mt-2 text-xs text-danger">{mtuState.error}</p>}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="CGNAT detection" icon={<Activity size={15} />} />
          <CardBody>
            {cgnat ? (
              <div className="space-y-2">
                <Badge tone={cgnat.detected ? 'warn' : 'ok'}>{cgnat.detected ? 'CGNAT detected' : 'no CGNAT detected'}</Badge>
                {cgnat.publicIp && <p className="text-xs text-faint">public IPv4: <span className="font-mono">{cgnat.publicIp}</span></p>}
                <p className="text-xs leading-relaxed text-faint">{cgnat.explanation}</p>
              </div>
            ) : (
              <p className="py-2 text-sm text-faint">Compares your router's WAN address against your observed public IP to detect carrier-grade NAT (100.64.0.0/10).</p>
            )}
            <Button className="mt-3" variant="ghost" onClick={() => void runCgnat()}>
              Check
            </Button>
          </CardBody>
        </Card>
      </div>

      {toolError && <ErrorState error={new Error(toolError)} retry={() => setToolError(null)} />}

      <Card className="mt-5">
        <CardHeader
          title="Connection stability monitor"
          icon={<HeartPulse size={15} />}
          subtitle="Samples latency, jitter, loss and DNS every few seconds and records outages as events"
          actions={
            <Button variant={stabilityStatus.data?.running ? 'danger' : 'primary'} onClick={() => void toggleStability()}>
              {stabilityStatus.data?.running ? 'Stop monitor' : 'Start monitor'}
            </Button>
          }
        />
        <CardBody>
          {stabilityStatus.isLoading && <LoadingState label="Reading monitor state" />}
          {stabilityStatus.data && !stabilityStatus.data.running && (
            <EmptyState icon={<HeartPulse size={20} />} title="Monitor idle" message="Start the monitor to keep watching your connection in the background. Events appear in the Events timeline." />
          )}
          {stabilityStatus.data?.running && (
            <>
              <div className="mb-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Metric label="Samples" value={stabilitySamples.data?.samples.length ?? stabilityStatus.data.sampleCount} />
                <Metric label="Interval (s)" value={stabilityStatus.data.intervalMs != null ? Math.round(stabilityStatus.data.intervalMs / 1000) : null} />
              </div>
              {chartData.length > 1 ? (
                <LatencyChart data={chartData} height={160} />
              ) : (
                <p className="py-4 text-center text-sm text-faint">Collecting samples…</p>
              )}
            </>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
