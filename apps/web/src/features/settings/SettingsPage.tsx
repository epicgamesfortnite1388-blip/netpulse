import { useEffect, useState } from 'react';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, Save } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Field, Input, Select } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { Switch } from '@/components/ui/Switch';
import { TabPanel, Tabs } from '@/components/ui/Tabs';
import { Tooltip } from '@/components/ui/Tooltip';
import { ErrorState, LoadingState } from '@/components/ui/States';
import { useToast } from '@/components/Toaster';
import { api } from '@/lib/api';
import { tauriInvoke } from '@/lib/transport';
import { useScheduleStatus } from '@/lib/useScheduleStatus';

import type { AppSettings, ScheduleSettings, ScheduledRunStatus, ScoreWeights } from '@shared/models/settings';
import type { SettingsPatch } from '@shared/schemas/settings';
import type { GameDefinition } from '@netpulse/shared';
import type { ReactNode } from 'react';

function SectionNote({ children }: { children: ReactNode }) {
  return <p className="mb-4 text-xs leading-relaxed text-faint">{children}</p>;
}

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const query = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<{ settings: AppSettings }>('/settings'),
  });

  const [draft, setDraft] = useState<AppSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [caps, setCaps] = useState<PlatformCapabilities | null>(null);
  const scheduleQuery = useScheduleStatus();
  const scheduleStatus = scheduleQuery.data?.status;
  const gamesQuery = useQuery({
    queryKey: ['gaming', 'games'],
    queryFn: () => api.get<{ games: GameDefinition[] }>('/gaming/games'),
    staleTime: 60_000,
  });
  const games = gamesQuery.data?.games ?? [];

  useEffect(() => {
    api.get<PlatformCapabilities>('/meta/capabilities').then(setCaps).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (query.data?.settings && draft === null) setDraft(query.data.settings);
  }, [query.data, draft]);

  if (query.isError) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  if (query.isLoading || !draft) return <LoadingState label="Loading settings" />;

  const patch = (section: keyof AppSettings, value: Partial<AppSettings[keyof AppSettings]>) => {
    setDraft({ ...draft, [section]: { ...draft[section], ...value } });
  };

  const setWeight = (key: keyof ScoreWeights, value: number) => {
    setDraft({
      ...draft,
      optimization: { ...draft.optimization, weights: { ...draft.optimization.weights, [key]: value } },
    });
  };

  const save = async (sectionPatch: SettingsPatch) => {
    setSaving(true);
    try {
      await api.put('/settings', sectionPatch);
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast('ok', 'Settings saved');
    } catch (err) {
      toast('error', 'Could not save settings', err instanceof Error ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const runScheduled = async (kind: 'dns' | 'gaming' | 'vpn') => {
    setSaving(true);
    try {
      await api.post('/settings/schedule/run', { kind });
      await queryClient.invalidateQueries({ queryKey: ['settings', 'schedule'] });
      toast('ok', kind === 'dns' ? 'DNS benchmark started' : kind === 'vpn' ? 'VPN self-test started' : 'Gaming test started');
    } catch (err) {
      toast('error', 'Could not start scheduled run', err instanceof Error ? err.message : undefined);
    } finally {
      setSaving(false);
    }
  };

  const weightSum = Object.values(draft.optimization.weights).reduce((a, b) => a + b, 0);

  return (
    <div>
      <PageHeader title="Settings" description="Defaults for tests, scoring and future VPN behavior. Additional sections are added as modules ship." />

      <Tabs
        defaultValue="general"
        items={[
          { value: 'general', label: 'General' },
          { value: 'network', label: 'Network' },
          { value: 'diagnostics', label: 'Diagnostics' },
          { value: 'optimization', label: 'Optimization' },
          { value: 'vpn', label: 'VPN' },
          { value: 'automation', label: 'Automation' },
          { value: 'platform', label: 'Platform' },
        ]}
      >
        <TabPanel value="general">
          <Card>
            <CardHeader title="General" />
            <CardBody className="max-w-xl space-y-4">
              <Field label="Theme">
                <Select
                  value={draft.general.theme}
                  onChange={(e) => patch('general', { theme: e.target.value as AppSettings['general']['theme'] })}
                >
                  <option value="dark">Dark (default)</option>
                  <option value="system">System</option>
                  <option value="light">Light</option>
                </Select>
              </Field>
              <Field label="Language">
                <Select value={draft.general.language} onChange={(e) => patch('general', { language: e.target.value })}>
                  <option value="en">English</option>
                </Select>
              </Field>
              <Field label="Units">
                <Select value={draft.general.units} onChange={(e) => patch('general', { units: e.target.value as 'metric' | 'imperial' })}>
                  <option value="metric">Metric</option>
                  <option value="imperial">Imperial</option>
                </Select>
              </Field>
              <div className="flex items-center justify-between rounded-lg border border-line bg-surface-2 px-4 py-3">
                <div>
                  <div className="text-sm">Notifications</div>
                  <div className="text-xs text-faint">Toast notifications for finished tests and failures</div>
                </div>
                <Switch
                  checked={draft.general.notifications}
                  onCheckedChange={(v) => patch('general', { notifications: v })}
                />
              </div>
              <Button variant="primary" loading={saving} onClick={() => void save({ general: draft.general })}>
                <Save size={14} /> Save general
              </Button>
            </CardBody>
          </Card>
        </TabPanel>

        <TabPanel value="network">
          <Card>
            <CardHeader title="Network" />
            <CardBody className="max-w-xl space-y-4">
              <Field label="IP preference" hint="Which address family tests should prefer">
                <Select
                  value={draft.network.ipPreference}
                  onChange={(e) => patch('network', { ipPreference: e.target.value as AppSettings['network']['ipPreference'] })}
                >
                  <option value="auto">Automatic</option>
                  <option value="4">Prefer IPv4</option>
                  <option value="6">Prefer IPv6</option>
                </Select>
              </Field>
              <Field label="Test timeout (ms)" hint="Per-operation timeout for network probes">
                <Input
                  type="number"
                  min={500}
                  max={30000}
                  value={draft.network.testTimeoutMs}
                  onChange={(e) => patch('network', { testTimeoutMs: Number(e.target.value) })}
                />
              </Field>
              <Field label="Probes per test" hint="Default number of probes (ping packets)">
                <Input
                  type="number"
                  min={1}
                  max={50}
                  value={draft.network.probes}
                  onChange={(e) => patch('network', { probes: Number(e.target.value) })}
                />
              </Field>
              <Button variant="primary" loading={saving} onClick={() => void save({ network: draft.network })}>
                <Save size={14} /> Save network
              </Button>
            </CardBody>
          </Card>
        </TabPanel>

        <TabPanel value="diagnostics">
          <Card>
            <CardHeader title="Diagnostics" />
            <CardBody className="max-w-xl space-y-4">
              <Field label="Default test target">
                <Input
                  value={draft.diagnostics.defaultTestTarget}
                  onChange={(e) => patch('diagnostics', { defaultTestTarget: e.target.value })}
                />
              </Field>
              <Field label="Ping count" hint="Packets per ping test">
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={draft.diagnostics.pingCount}
                  onChange={(e) => patch('diagnostics', { pingCount: Number(e.target.value) })}
                />
              </Field>
              <Field label="Route depth (max hops)" hint="Used by the route checker and traceroute">
                <Input
                  type="number"
                  min={3}
                  max={64}
                  value={draft.diagnostics.routeDepth}
                  onChange={(e) => patch('diagnostics', { routeDepth: Number(e.target.value) })}
                />
              </Field>
              <Field label="Packet loss threshold (%)" hint="Above this, routes/servers are flagged degraded">
                <Input
                  type="number"
                  min={0}
                  max={100}
                  value={draft.diagnostics.packetLossThresholdPct}
                  onChange={(e) => patch('diagnostics', { packetLossThresholdPct: Number(e.target.value) })}
                />
              </Field>
              <Button variant="primary" loading={saving} onClick={() => void save({ diagnostics: draft.diagnostics })}>
                <Save size={14} /> Save diagnostics
              </Button>
            </CardBody>
          </Card>
        </TabPanel>

        <TabPanel value="optimization">
          <Card>
            <CardHeader
              title="Scoring weights"
              subtitle="Applied to the route/endpoint/optimization scoring engine"
              actions={
                <span className={`metric-num text-xs ${weightSum === 100 ? 'text-ok' : 'text-danger'}`}>
                  Σ {weightSum} / 100
                </span>
              }
            />
            <CardBody className="max-w-xl">
              <SectionNote>
                Weights must sum to 100. The engine only counts components that were actually measured and
                renormalizes the rest.
              </SectionNote>
              <div className="grid grid-cols-2 gap-4">
                {(Object.keys(draft.optimization.weights) as (keyof ScoreWeights)[]).map((key) => (
                  <Field key={key} label={key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}>
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      value={draft.optimization.weights[key]}
                      onChange={(e) => setWeight(key, Number(e.target.value))}
                    />
                  </Field>
                ))}
              </div>
              <div className="mt-4">
                <Button
                  variant="primary"
                  loading={saving}
                  disabled={weightSum !== 100}
                  onClick={() => void save({ optimization: draft.optimization })}
                >
                  <Save size={14} /> Save weights
                </Button>
              </div>
            </CardBody>
          </Card>
        </TabPanel>

        <TabPanel value="vpn">
          <Card>
            <CardHeader title="VPN" subtitle="Behavior preferences for the VPN engine" />
            <CardBody className="max-w-xl space-y-4">
              <SectionNote>
                Kill switch and auto-connect require platform support: WireGuard exposes a kill switch on
                Windows (via the WireGuard service) and needs block-outside rules on Linux. Preferences
                apply to future connections; they never change a running tunnel silently.
              </SectionNote>
              {(
                [
                  ['killSwitch', 'Kill switch', 'Block all traffic if the VPN drops'],
                  ['autoConnect', 'Auto-connect', 'Connect on app start'],
                  ['autoSelectServer', 'Auto-select server', 'Pick the best server by score'],
                  ['dnsThroughVpn', 'DNS through VPN', 'Prevent DNS leaks by tunneling DNS'],
                ] as const
              ).map(([key, label, hint]) => (
                <Tooltip key={key} content={hint}>
                  <div className="flex items-center justify-between rounded-lg border border-line bg-surface-2 px-4 py-3">
                    <div>
                      <div className="text-sm">{label}</div>
                      <div className="text-xs text-faint">{hint}</div>
                    </div>
                    <Switch
                      checked={draft.vpn[key]}
                      disabled
                      onCheckedChange={(v) => patch('vpn', { [key]: v })}
                    />
                  </div>
                </Tooltip>
              ))}
            </CardBody>
          </Card>
        </TabPanel>

        <TabPanel value="automation">
          <AutoTestPanel
            settings={draft.automation}
            saving={saving}
            onSettings={(p) => patch('automation', p)}
            onSave={() => void save({ automation: draft.automation })}
          />
          <div className="mt-6 grid items-start gap-6 xl:grid-cols-2">
            <SchedulePanel
              kind="dns"
              title="DNS benchmark"
              description="Re-run the resolver benchmark automatically so latency history and recommendations stay current without manual runs."
              settings={draft.scheduling}
              status={scheduleStatus?.dns}
              saving={saving}
              onSettings={(p) => patch('scheduling', p)}
              onSave={() => void save({ scheduling: draft.scheduling })}
              onRunNow={() => void runScheduled('dns')}
            />
            <SchedulePanel
              kind="gaming"
              title="Gaming region test"
              description="Re-test reachability and latency to your chosen game's documented service endpoints on a schedule."
              settings={draft.scheduling}
              status={scheduleStatus?.gaming}
              saving={saving}
              games={games}
              onSettings={(p) => patch('scheduling', p)}
              onSave={() => void save({ scheduling: draft.scheduling })}
              onRunNow={() => void runScheduled('gaming')}
            />
            <SchedulePanel
              kind="vpn"
              title="VPN tunnel self-test"
              description="Periodic dry-run tunnel check — engine presence, stored key material and endpoint reachability. Never connects or changes tunnel state; no elevation needed."
              settings={draft.scheduling}
              status={scheduleStatus?.vpn}
              saving={saving}
              onSettings={(p) => patch('scheduling', p)}
              onSave={() => void save({ scheduling: draft.scheduling })}
              onRunNow={() => void runScheduled('vpn')}
            />
          </div>
        </TabPanel>

        <TabPanel value="platform">
          <Card>
            <CardHeader
              title="Platform capabilities"
              subtitle="What this machine actually supports — no silent fallbacks"
            />
            <CardBody className="max-w-xl">
              <SectionNote>
                Capabilities are detected live (a single ICMP probe against 1.1.1.1, VPN binary detection).
                DoT works only when outbound TCP 853 is allowed by your network; DoH uses port 443.
              </SectionNote>
              {caps == null ? (
                <p className="text-sm text-faint">Detecting…</p>
              ) : (
                <div className="space-y-2">
                  {[
                    ['icmpPing', 'ICMP ping (latency/loss/jitter)'],
                    ['tcpProbe', 'TCP connect timing'],
                    ['dnsUdp', 'DNS over UDP'],
                    ['dnsDoH', 'DNS over HTTPS'],
                    ['dnsDoT', 'DNS over TLS'],
                    ['traceroute', 'Traceroute'],
                    ['mtuDiscovery', 'MTU discovery'],
                  ].map(([key, label]) => {
                    const c = caps[key as keyof PlatformCapabilities] as { state: string; note: string } | undefined;
                    if (!c) return null;
                    return (
                      <div key={key} className="flex items-start justify-between gap-3 rounded-lg border border-line bg-surface-2 px-4 py-2.5">
                        <div className="min-w-0">
                          <div className="text-sm">{label}</div>
                          <div className="text-[11px] text-faint">{c.note}</div>
                        </div>
                        <CapBadge state={c.state} />
                      </div>
                    );
                  })}
                  <div className="pt-2">
                    <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">VPN engines</div>
                    <div className="space-y-2">
                      {Object.entries(caps.vpn).map(([key, v]) => (
                        <div key={key} className="flex items-center justify-between gap-3 rounded-lg border border-line bg-surface-2 px-4 py-2.5">
                          <div className="text-sm capitalize">{key}</div>
                          <CapBadge state={v.installed ? 'supported' : 'unavailable'} />
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </CardBody>
          </Card>

          <RecoveryCard />
        </TabPanel>
      </Tabs>
    </div>
  );
}

/**
 * Recovery actions for a wedged installation. Safe Mode disables all
 * networking until the next normal launch; Reset moves every data file into
 * a timestamped backup dir and restarts the backend on a fresh database.
 */
function RecoveryCard() {
  const toast = useToast();
  const [resetting, setResetting] = useState(false);
  const isDesktop = Boolean(
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__,
  );

  const enterSafeMode = () => {
    if (!isDesktop) {
      toast('error', 'Safe Mode is a desktop-app feature');
      return;
    }
    // A file can't change its own command line — instruct + hint via exit.
    // In desktop mode the Rust side also listens for this command.
    tauriInvoke('netpulse_safe_mode');
    toast(
      'ok',
      'To start in Safe Mode: launch NetPulse with the "NetPulse (Safe Mode)" shortcut, or run netpulse-desktop.exe --safe-mode',
    );
  };

  const resetState = async () => {
    if (!isDesktop) {
      toast('error', 'Reset App State is a desktop-app feature');
      return;
    }
    const confirmed = window.confirm(
      'Reset App State?\n\n' +
        'All app data (history, settings, VPN profiles, node database) is MOVED into a timestamped backup folder — nothing is deleted. ' +
        'The backend then restarts on a fresh database.',
    );
    if (!confirmed) return;
    setResetting(true);
    try {
      const backupDir = await tauriInvoke<string>('reset_app_state');
      toast('ok', `State backed up${typeof backupDir === 'string' ? ` to ${backupDir}` : ''} — restarting…`);
      // The sidecar exits + respawns; reconnect when it is back.
      setTimeout(() => window.location.reload(), 2500);
    } catch (err) {
      toast('error', 'Reset failed', err instanceof Error ? err.message : String(err));
      setResetting(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Recovery"
        subtitle="Repair a wedged installation without losing data"
      />
      <CardBody className="max-w-xl space-y-4">
        <div className="rounded-lg border border-line bg-surface-2 p-4">
          <div className="text-sm font-medium">Safe Mode</div>
          <p className="mt-1 text-xs leading-relaxed text-faint">
            Starts the app with networking, VPN and scanners disabled. Use it
            when a broken network configuration or misbehaving benchmark keeps
            the app from working. Launch via the "NetPulse (Safe Mode)"
            shortcut or <code className="font-mono">netpulse-desktop.exe --safe-mode</code>.
          </p>
          <Button className="mt-3" variant="secondary" onClick={enterSafeMode}>
            How to start in Safe Mode
          </Button>
        </div>
        <div className="rounded-lg border border-danger/30 bg-danger/5 p-4">
          <div className="text-sm font-medium">Reset app state</div>
          <p className="mt-1 text-xs leading-relaxed text-faint">
            Moves every file in the app data directory into{' '}
            <code className="font-mono">backup-&lt;timestamp&gt;</code> and
            restarts the backend on a fresh database. History, settings and
            profiles are preserved in the backup — nothing is deleted.
          </p>
          <Button className="mt-3" variant="danger" disabled={resetting} onClick={() => void resetState()}>
            {resetting ? 'Backing up & restarting…' : 'Reset app state…'}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

/**
 * Adaptive node auto-tester controls. Writes the `automation.autoTestNodes`
 * settings section; the backend scheduler re-arms on settings change.
 */
function AutoTestPanel({
  settings,
  saving,
  onSettings,
  onSave,
}: {
  settings: AppSettings['automation'];
  saving: boolean;
  onSettings: (patch: Partial<AppSettings['automation']>) => void;
  onSave: () => void;
}) {
  const cfg = settings.autoTestNodes;
  return (
    <Card>
      <CardHeader
        title="Node auto-tester"
        subtitle="Bounded batches that keep imported node measurements current — never-validated nodes first, then stale-good, then unstable"
      />
      <CardBody className="max-w-xl space-y-4">
        <SectionNote>
          Runs cheap TCP reachability probes only — proxy tests (which launch a local
          engine) stay manual. Dead nodes unseen for 14 days are retired to the
          "stale" state; their history is kept. Changing these settings re-arms the
          scheduler immediately.
        </SectionNote>
        <div className="flex items-center justify-between rounded-lg border border-line bg-surface-2 px-4 py-3">
          <div>
            <div className="text-sm">Enabled</div>
            <div className="text-xs text-faint">Test a small batch of nodes automatically at the interval below</div>
          </div>
          <Switch
            checked={cfg.enabled}
            onCheckedChange={(v) =>
              onSettings({ autoTestNodes: { ...cfg, enabled: v } })
            }
          />
        </div>
        <Field label="Interval (minutes)" hint="Between 10 minutes and 4 hours">
          <Input
            type="number"
            min={10}
            max={240}
            step={5}
            value={cfg.intervalMinutes}
            disabled={!cfg.enabled}
            onChange={(e) => {
              const n = Number(e.target.value);
              const v = Number.isFinite(n) ? Math.min(240, Math.max(10, Math.round(n))) : 30;
              onSettings({ autoTestNodes: { ...cfg, intervalMinutes: v } });
            }}
          />
        </Field>
        <div className="flex justify-end">
          <Button variant="primary" loading={saving} onClick={onSave}>
            <Save size={14} /> Save auto-test settings
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

function SchedulePanel({
  kind,
  title,
  description,
  settings,
  status,
  saving,
  games,
  onSettings,
  onSave,
  onRunNow,
}: {
  kind: 'dns' | 'gaming' | 'vpn';
  title: string;
  description: string;
  settings: ScheduleSettings;
  status?: ScheduledRunStatus;
  saving: boolean;
  games?: GameDefinition[];
  onSettings: (patch: Partial<ScheduleSettings>) => void;
  onSave: () => void;
  onRunNow: () => void;
}) {
  const enabled = kind === 'dns' ? settings.dnsEnabled : kind === 'vpn' ? settings.vpnSelfTestEnabled : settings.gamingEnabled;
  const intervalMin = kind === 'dns' ? settings.dnsIntervalMin : kind === 'vpn' ? settings.vpnSelfTestIntervalMin : settings.gamingIntervalMin;

  return (
    <Card>
      <CardHeader title={title} subtitle={description} />
      <CardBody className="space-y-4">
        <div className="flex items-center justify-between rounded-lg border border-line bg-surface-2 px-4 py-3">
          <div>
            <div className="text-sm">Enabled</div>
            <div className="text-xs text-faint">Run automatically at the interval below</div>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={(v) => onSettings(kind === 'dns' ? { dnsEnabled: v } : kind === 'vpn' ? { vpnSelfTestEnabled: v } : { gamingEnabled: v })}
          />
        </div>
        <Field label="Interval (minutes)" hint="Between 15 minutes and 7 days; runs never overlap">
          <Input
            type="number"
            min={15}
            max={10080}
            step={15}
            value={intervalMin}
            disabled={!enabled}
            onChange={(e) => {
              const n = Number(e.target.value);
              const v = Number.isFinite(n) ? Math.min(10080, Math.max(15, Math.round(n))) : 60;
              onSettings(kind === 'dns' ? { dnsIntervalMin: v } : kind === 'vpn' ? { vpnSelfTestIntervalMin: v } : { gamingIntervalMin: v });
            }}
          />
        </Field>
        {kind === 'gaming' && (
          <Field label="Game" hint="Which game's regions to test; auto-picks the first catalog game when unset">
            <Select
              value={settings.gamingGameId ?? ''}
              onChange={(e) => onSettings({ gamingGameId: e.target.value || null })}
            >
              <option value="">Auto (first catalog game)</option>
              {(games ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-[11px] leading-relaxed text-faint">
          {status?.running && <span className="text-warn">Run in progress… </span>}
          {status?.lastRunAt != null
            ? <>Last run {new Date(status.lastRunAt).toLocaleTimeString()} · {status.lastResult === 'ok' ? 'succeeded' : status.lastResult === 'error' ? 'failed' : 'unknown'}</>
            : 'No automatic run yet'}
          {status?.nextRunAt != null && enabled && <> · next run {new Date(status.nextRunAt).toLocaleTimeString()}</>}
          {status?.lastError && <div className="mt-1 text-danger">{status.lastError}</div>}
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onRunNow} disabled={saving || status?.running}>
            <Play size={14} /> Run now
          </Button>
          <Button variant="primary" onClick={onSave} loading={saving}>
            <Save size={14} /> Save schedule
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

function CapBadge({ state }: { state: string }) {
  const tone = state === 'supported' ? 'ok' : state === 'partial' ? 'warn' : state === 'requires-permission' ? 'warn' : 'neutral';
  return (
    <span
      className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
        tone === 'ok'
          ? 'border-ok/30 bg-ok/10 text-ok'
          : tone === 'warn'
            ? 'border-warn/30 bg-warn/10 text-warn'
            : 'border-line bg-surface text-faint'
      }`}
    >
      {state.replace(/-/g, ' ')}
    </span>
  );
}

interface PlatformCapabilities {
  generatedAt: number;
  icmpPing: { state: string; note: string };
  tcpProbe: { state: string; note: string };
  dnsUdp: { state: string; note: string };
  dnsDoH: { state: string; note: string };
  dnsDoT: { state: string; note: string };
  traceroute: { state: string; note: string };
  mtuDiscovery: { state: string; note: string };
  vpn: Record<string, { installed: boolean; note: string }>;
}
