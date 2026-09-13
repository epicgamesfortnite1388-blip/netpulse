import { useEffect, useState } from 'react';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  Download,
  FolderOpen,
  Play,
  RefreshCw,
  TriangleAlert,
  Wrench,
  XCircle,
} from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatusDot } from '@/components/ui/StatusDot';
import { useToast } from '@/components/Toaster';
import { useStartupHealth } from '@/lib/useStartupHealth';
import { api } from '@/lib/api';
import { subscribeTest } from '@/lib/ws';
import { desktopInfo, tauriInvoke } from '@/lib/transport';

import type { ScheduledRunStatus, VpnSelfTestResult } from '@shared/models/settings';

type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
function invokeFn(): InvokeFn | null {
  // tauriInvoke resolves __TAURI_INTERNALS__ / __TAURI__.core.invoke / top-level
  // — the top-level-only check silently returned null in packaged builds.
  return tauriInvoke as InvokeFn | null;
}

interface SelfTestPayload {
  last: VpnSelfTestResult | null;
  running: boolean;
  schedule: ScheduledRunStatus | null;
  safeMode: boolean;
}

/** Live VPN dry-run self-test state: initial fetch + WS push on every run. */
function useVpnSelfTest() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['vpn', 'selftest'],
    queryFn: () => api.get<SelfTestPayload>('/vpn/selftest'),
    refetchInterval: 60_000,
    staleTime: 10_000,
  });
  useEffect(() => {
    const unsub = subscribeTest('vpn-selftest', (msg) => {
      if (msg.type === 'vpn-selftest:done' && msg.result) {
        queryClient.setQueryData(['vpn', 'selftest'], (prev: SelfTestPayload | undefined) =>
          prev ? { ...prev, last: msg.result as VpnSelfTestResult, running: false } : prev,
        );
      } else if (msg.type === 'vpn-selftest:running') {
        queryClient.setQueryData(['vpn', 'selftest'], (prev: SelfTestPayload | undefined) =>
          prev ? { ...prev, running: true } : prev,
        );
      }
    });
    return unsub;
  }, [queryClient]);
  return query;
}

function StateBadge({ state }: { state: 'ok' | 'degraded' | 'failed' }) {
  const map = {
    ok: { tone: 'ok' as const, icon: <CheckCircle2 size={13} />, text: 'OK' },
    degraded: { tone: 'warn' as const, icon: <TriangleAlert size={13} />, text: 'Degraded' },
    failed: { tone: 'danger' as const, icon: <XCircle size={13} />, text: 'Failed' },
  } as const;
  const m = map[state];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        m.tone === 'ok'
          ? 'border-ok/30 bg-ok/10 text-ok'
          : m.tone === 'warn'
            ? 'border-warn/30 bg-warn/10 text-warn'
            : 'border-danger/40 bg-danger/10 text-danger'
      }`}
    >
      {m.icon}
      {m.text}
    </span>
  );
}

function SelfTestBadge({ state }: { state: VpnSelfTestResult['state'] }) {
  const map = {
    ok: { tone: 'ok' as const, icon: <CheckCircle2 size={13} />, text: 'OK' },
    unavailable: { tone: 'warn' as const, icon: <TriangleAlert size={13} />, text: 'Unavailable' },
    error: { tone: 'danger' as const, icon: <XCircle size={13} />, text: 'Error' },
  } as const;
  const m = map[state];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        m.tone === 'ok'
          ? 'border-ok/30 bg-ok/10 text-ok'
          : m.tone === 'warn'
            ? 'border-warn/30 bg-warn/10 text-warn'
            : 'border-danger/40 bg-danger/10 text-danger'
      }`}
    >
      {m.icon}
      {m.text}
    </span>
  );
}

/** Scheduled VPN dry-run self-test: last result, schedule state, Run now. */
function VpnSelfTestCard() {
  const toast = useToast();
  const { data, refetch } = useVpnSelfTest();
  const [running, setRunning] = useState(false);

  const last = data?.last ?? null;
  const sched = data?.schedule ?? null;
  const isRunning = running || (data?.running ?? false);

  const runNow = async () => {
    setRunning(true);
    try {
      await api.post('/vpn/selftest/run');
      await refetch();
    } catch (err) {
      toast('error', 'Self-test failed', err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="VPN tunnel self-test"
        subtitle="Scheduled dry-run — engine, key material, endpoint reachability. Never changes tunnel state."
      />
      <CardBody>
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm leading-relaxed text-muted">
            {isRunning
              ? 'Dry-run in progress…'
              : last
                ? last.detail
                : data?.safeMode
                  ? 'Safe Mode: self-tests are disabled.'
                  : 'No self-test has run yet. Run one now or wait for the scheduled interval.'}
          </p>
          {last && !isRunning && <SelfTestBadge state={last.state} />}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-faint">
          {last && <span>Checked {new Date(last.checkedAt).toLocaleTimeString()} · {last.tookMs} ms</span>}
          {last && <span>Engines: {Object.entries(last.engines).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none detected'}</span>}
          {last && <span>Profiles verified: {last.profilesChecked}</span>}
          {last?.endpointsReachable != null && <span>Endpoints reachable: {last.endpointsReachable}</span>}
          {sched?.enabled && sched.nextRunAt != null && !isRunning && (
            <span>Auto every {sched.intervalMin}m · next {new Date(sched.nextRunAt).toLocaleTimeString()}</span>
          )}
          {sched && !sched.enabled && <span>Auto checks off — enable in Settings → Automation</span>}
        </div>
        <div className="mt-3">
          <Button size="sm" variant="secondary" onClick={() => void runNow()} disabled={isRunning || data?.safeMode}>
            {isRunning ? <RefreshCw size={13} className="animate-spin" /> : <Play size={13} />} Run self-test now
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtRestartTime(unix: number | null): string {
  if (!unix) return 'unknown time';
  const d = new Date(unix * 1000);
  const ago = Math.max(0, Math.round((Date.now() - unix * 1000) / 1000));
  const when =
    ago < 60 ? `${ago}s ago` : ago < 3600 ? `${Math.round(ago / 60)}m ago` : `${Math.round(ago / 3600)}h ago`;
  return `${when} (${d.toLocaleTimeString()})`;
}

export default function SystemHealthPage() {
  const { phase, report, runtime, error, refresh } = useStartupHealth();
  const toast = useToast();
  const [desktop, setDesktop] = useState<{ appVersion: string; os: string; arch: string } | null>(null);
  const [logTail, setLogTail] = useState<string[] | null>(null);
  const [osName, setOsName] = useState<string>('');
  const [, setBusy] = useState<string | null>(null);
  const isDesktop = Boolean(
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__,
  );

  useEffect(() => {
    void desktopInfo().then(setDesktop).catch(() => undefined);
    // OS friendly name from the user agent (WebView2 reports Windows NT x.y)
    const m = navigator.userAgent.match(/Windows NT ([\d.]+)/);
    setOsName(m ? `Windows (NT ${m[1]})` : navigator.platform || 'unknown');
  }, []);

  const loadLogTail = () => {
    const invoke = invokeFn();
    if (!invoke) return;
    void invoke<string[]>('read_log_tail', { lines: 60 })
      .then((lines) => setLogTail(Array.isArray(lines) ? lines : []))
      .catch(() => setLogTail(null));
  };
  useEffect(loadLogTail, []);

  const runAction = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    try {
      await fn();
    } catch (err) {
      toast('error', 'Action failed', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const doExport = () =>
    runAction('export', async () => {
      const invoke = invokeFn();
      if (!invoke) {
        toast('error', 'Diagnostic export is a desktop-app feature');
        return;
      }
      const p = await invoke<string>('save_diagnostic_report');
      void p;
      toast('ok', 'Diagnostic report saved');
    });

  const doOpenLogs = () =>
    runAction('logs', async () => {
      const invoke = invokeFn();
      if (!invoke) {
        toast('error', 'Available in the desktop app');
        return;
      }
      const paths = await invoke<{ data_dir: string; log_dir: string }>('data_paths');
      await invoke('reveal_path', { path: paths.log_dir || paths.data_dir });
    });

  const doRestartBackend = () =>
    runAction('restart', async () => {
      const invoke = invokeFn();
      if (!invoke) {
        toast('error', 'Available in the desktop app');
        return;
      }
      await invoke('restart_backend');
      toast('ok', 'Backend restarting…');
      setTimeout(refresh, 3000);
    });

  const doRepair = () =>
    runAction('repair', async () => {
      const invoke = invokeFn();
      if (!invoke) {
        toast('error', 'Available in the desktop app');
        return;
      }
      await invoke('restart_backend');
      toast('ok', 'Internal services restarted');
      setTimeout(refresh, 3000);
    });

  const phaseLabel: Record<string, { text: string; tone: 'ok' | 'warn' | 'danger' | 'idle' }> = {
    starting: { text: 'Starting…', tone: 'idle' },
    checking: { text: 'Checking…', tone: 'warn' },
    ready: { text: 'Ready', tone: 'ok' },
    degraded: { text: 'Degraded', tone: 'warn' },
    recovery: { text: 'Recovery Required', tone: 'danger' },
  };
  const pl = phaseLabel[phase] ?? { text: phase, tone: 'idle' as const };

  return (
    <div>
      <PageHeader
        title="System Health"
        description="Live diagnostics for this installation — what is working, what is not, and what to do about it."
      />

      {/* Startup state */}
      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <StatusDot tone={pl.tone} pulse={phase !== 'ready'} size={12} />
            <div>
              <div className="text-base font-semibold">{pl.text}</div>
              <div className="text-xs text-faint">
                {error
                  ? `Last probe failed: ${error}`
                  : report
                    ? `Last check ${new Date(report.generatedAt).toLocaleTimeString()} · ${report.tookMs} ms`
                    : 'Waiting for first probe…'}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={refresh}>
              <RefreshCw size={13} /> Re-check now
            </Button>
            {isDesktop && (
              <>
                <Button size="sm" variant="secondary" onClick={() => void doExport()}>
                  <Download size={13} /> Export Diagnostic Report
                </Button>
                <Button size="sm" variant="secondary" onClick={() => void doOpenLogs()}>
                  <FolderOpen size={13} /> Open Logs Folder
                </Button>
                <Button size="sm" variant="secondary" onClick={() => void doRepair()}>
                  <Wrench size={13} /> Repair App
                </Button>
              </>
            )}
          </div>
        </CardBody>
      </Card>

      {/* Scheduled VPN dry-run self-test */}
      <div className="mt-5">
        <VpnSelfTestCard />
      </div>

      {/* Component checks */}
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        {report ? (
          report.checks.map((c) => (
            <Card key={c.id}>
              <CardHeader title={c.label} />
              <CardBody>
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm leading-relaxed text-muted">{c.detail}</p>
                  <StateBadge state={c.state} />
                </div>
                {c.action && c.state !== 'ok' && (
                  <div className="mt-3">
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => {
                        if (c.action?.kind === 'repair-restart-backend') void doRestartBackend();
                        else if (c.action?.kind === 'open-logs') void doOpenLogs();
                        else toast('ok', c.action?.label ?? 'See System Health page');
                      }}
                    >
                      <Wrench size={13} /> {c.action.label}
                    </Button>
                  </div>
                )}
              </CardBody>
            </Card>
          ))
        ) : (
          <Card>
            <CardBody>
              <p className="text-sm text-faint">
                {phase === 'recovery'
                  ? 'Backend is unreachable — the sidecar may have failed to start. Use Repair App above or Restart the application.'
                  : 'Running first health probe…'}
              </p>
            </CardBody>
          </Card>
        )}
      </div>

      {/* Environment */}
      <Card className="mt-5">
        <CardHeader title="Environment" subtitle="Version, platform and build information" />
        <CardBody className="grid gap-3 sm:grid-cols-2">
          {[
            ['App version', desktop?.appVersion ?? report?.version ?? '…'],
            ['Build type', isDesktop ? 'release (packaged desktop)' : 'development / web'],
            ['OS', desktop ? `${desktop.os} · ${osName}` : osName || '…'],
            ['Architecture', desktop?.arch ?? '…'],
            [
              'Backend',
              runtime
                ? runtime.sidecar_running
                  ? `running${runtime.sidecar_port ? ` · 127.0.0.1:${runtime.sidecar_port}` : ''} (restarts: ${runtime.sidecar_restarts})`
                  : 'not running'
                : '…',
            ],
            [
              'Last sidecar death',
              runtime
                ? runtime.last_restart_reason
                  ? `${fmtRestartTime(runtime.last_restart_at_unix)} — ${runtime.last_restart_reason}`
                  : 'none since this app started'
                : '…',
            ],
            ['Safe Mode', runtime ? (runtime.safe_mode ? 'ACTIVE' : 'off') : '…'],
            ['Data directory', runtime?.data_dir ?? '…'],
            ['Log file', runtime ? `${fmtBytes(runtime.log_file_bytes)} / cap ${fmtBytes(runtime.log_rotation_cap_bytes)}` : '…'],
          ].map(([k, v]) => (
            <div key={k} className="rounded-lg border border-line bg-surface-2 px-4 py-2.5">
              <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">{k}</div>
              <div className="mt-0.5 truncate font-mono text-xs text-muted" title={String(v)}>
                {String(v)}
              </div>
            </div>
          ))}
        </CardBody>
      </Card>

      {/* Boot log tail */}
      <Card className="mt-5">
        <CardHeader
          title="Startup log (last 60 lines)"
          subtitle="Secret-shaped lines are redacted before they reach this page"
        />
        <CardBody>
          <pre className="max-h-72 overflow-auto rounded-lg border border-line bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-faint">
            {logTail === null
              ? isDesktop
                ? 'Log unavailable.'
                : 'Log tail is only available in the installed desktop application.'
              : logTail.length === 0
                ? '(empty)'
                : logTail.join('\n')}
          </pre>
        </CardBody>
      </Card>
    </div>
  );
}
