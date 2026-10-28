import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  Download,
  Globe,
  KeyRound,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  ShieldX,
  Square,
  TriangleAlert,
  Zap,
} from 'lucide-react';
import { Suspense, lazy, useState } from 'react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { useToast } from '@/components/Toaster';
import { api } from '@/lib/api';

import { AdminAccessPanel, PrivilegeGate } from './AdminAccessPanel';
import { MANAGED_PROVIDER_META } from './engineMeta';
import { TUN_TONE_CLASS, tunClaim, tunRemedy, watchdogClaim } from './tunStatus';
import { DisclosureScope, DisclosureToolbar } from '@/components/ui/Disclosure';
import { Chip, DataList, DataRow, EngineGlyph, MetricStrip, Notice, Panel, Section, Skeleton } from '@/components/ui/Surface';
import { providerIsActive, useAetherEngine, useKillSwitch, useVpnHealth, useVpnProfiles, useVpnStatus } from './useVpnData';

import type { CoreState } from './AetherCore';
import type { VpnStatus } from '@netpulse/shared';

/**
 * Aether — the flagship surface.
 *
 * The whole tab is one immersive stage: a single dark panel that frames the live
 * WebGL core, the engine's identity and its controls. Everything the backend
 * reports appears once, in the place that makes it most legible:
 *
 *   - the stage carries state, exit and the honest connection phases
 *   - the telemetry strip carries live counters (only while a tunnel is up)
 *   - flat sections carry profiles, kill switch, provenance and capabilities
 *
 * Nothing here can show motion for a tunnel the backend does not report: the
 * core is a pure function of the state read from `/vpn/status`, and every phase
 * below is derived from a value that arrived over IPC.
 */

/** Chunk-split: `three` is only pulled in when the Aether tab is opened. */
const AetherCore = lazy(() => import('./AetherCore'));

const PROTOCOLS: Array<{ value: AetherSettings['protocol']; label: string; hint: string }> = [
  { value: 'masque', label: 'MASQUE (HTTP/3)', hint: 'Disguises traffic as ordinary HTTPS over QUIC — the default' },
  { value: 'wg', label: 'WireGuard (WARP)', hint: 'Classic WireGuard — lighter and faster' },
  { value: 'gool', label: 'WARP-in-WARP (gool)', hint: 'Two nested WireGuard tunnels — extra security at a speed cost' },
  { value: 'mim', label: 'MASQUE-in-MASQUE', hint: 'Two nested MASQUE hops — changes the observed exit address' },
];

const SCAN_MODES: Array<{ value: AetherSettings['scanMode']; label: string; hint: string }> = [
  { value: 'turbo', label: 'Turbo — first answer wins', hint: 'Fastest search, lightest probe traffic' },
  { value: 'balanced', label: 'Balanced — fastest of a few', hint: 'The default trade-off' },
  { value: 'thorough', label: 'Thorough — sweep whole ranges', hint: 'Finds more routes, emits more probes' },
  { value: 'stealth', label: 'Stealth — few probes in flight', hint: 'Lowest profile, slower to find a route' },
  { value: 'ironclad', label: 'Ironclad — real tunnel per candidate', hint: 'Proves each candidate but is the slowest' },
];

const NOIZE: Array<{ value: AetherSettings['noize']; label: string }> = [
  { value: 'default', label: 'Default (per protocol)' },
  { value: 'off', label: 'Off' },
  { value: 'light', label: 'Light' },
  { value: 'firewall', label: 'Firewall' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'gfw', label: 'GFW (heavy filtering)' },
  { value: 'aggressive', label: 'Aggressive' },
];

interface AetherSettings {
  protocol: 'masque' | 'wg' | 'gool' | 'mim';
  scanMode: 'turbo' | 'balanced' | 'thorough' | 'stealth' | 'ironclad';
  transport: 'h3' | 'h2';
  ipVersion: 'v4' | 'v6' | 'both';
  noize: 'default' | 'off' | 'light' | 'firewall' | 'balanced' | 'gfw' | 'aggressive';
  quickReconnect: boolean;
}

const DEFAULT_SETTINGS: AetherSettings = {
  protocol: 'masque',
  scanMode: 'balanced',
  transport: 'h3',
  ipVersion: 'v4',
  noize: 'default',
  quickReconnect: true,
};

/** Caption shown inside the stage — says what the motion means. */
const CORE_LABEL: Record<CoreState, string> = {
  idle: 'standby',
  starting: 'acquiring route',
  active: 'tunnel active',
  down: 'fault',
};

/** Accent per state, used by the stage's rings and caption. */
const CORE_ACCENT: Record<CoreState, string> = {
  idle: 'border-violet-300/25 text-violet-100/85',
  starting: 'border-amber-300/35 text-amber-100/90',
  active: 'border-cyan-300/45 text-cyan-100',
  down: 'border-red-400/40 text-red-100/90',
};

function formatBytes(n: number | null | undefined): string {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v.toFixed(v >= 100 || u === 0 ? 0 : 1)} ${units[u]}`;
}

function VerificationBadge({ status }: { status: VpnStatus | undefined }) {
  const v = status?.verification ?? 'not_verified';
  if (!status?.connected) return null;
  if (v === 'verified')
    return (
      <Badge tone="ok">
        <ShieldCheck size={11} /> verified exit
      </Badge>
    );
  if (v === 'failed')
    return (
      <Badge tone="danger">
        <ShieldX size={11} /> not routing
      </Badge>
    );
  if (v === 'unavailable') return <Badge tone="warn">unverified (IP check unavailable)</Badge>;
  return <Badge tone="neutral">unverified</Badge>;
}

/**
 * One connection phase.
 *
 * `done` is set ONLY from a value the backend reported. `running` only while the
 * mutation that would produce it is actually in flight. A phase that is neither
 * reads "pending" — this surface never advances a checklist to look busy.
 */
interface Phase {
  label: string;
  detail: string;
  done: boolean;
  running?: boolean;
}

function PhaseTrack({ phases }: { phases: Phase[] }) {
  return (
    <ol className="flex flex-wrap items-start gap-x-6 gap-y-3">
      {phases.map((p) => (
        <li key={p.label} className="flex min-w-[132px] items-start gap-2.5">
          <span
            aria-hidden
            // h-5/w-5 (not h-4/w-4): the tick is now the 12px floor token, and
            // a 12px glyph does not fit legibly inside a 16px circle.
            className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-micro font-bold ${
              p.done
                ? 'border-cyan-300/60 bg-cyan-400/20 text-cyan-100'
                : p.running
                  ? 'border-amber-300/70 bg-amber-400/10 text-amber-100 animate-pulse-dot'
                  : 'border-white/15 bg-white/5 text-white/35'
            }`}
          >
            {p.done ? '✓' : p.running ? '•' : ''}
          </span>
          <span className="min-w-0">
            <span className={`block text-xs font-medium ${p.done ? 'text-white/90' : p.running ? 'text-amber-100' : 'text-white/45'}`}>{p.label}</span>
            <span className="mt-0.5 block text-micro leading-snug text-white/40">{p.detail}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The live core inside the stage.
 *
 * A single dark viewport with the orbital rings and the HUD chips floating over
 * it. There is no inner border: the stage is the frame, so the WebGL light can
 * bleed to the edges instead of being cropped into a card.
 */
function CorePortal({ state, exitIp, latencyMs }: { state: CoreState; exitIp: string | null; latencyMs: number | null }) {
  return (
    <div className="relative min-h-[300px] lg:min-h-[340px]">
      {/* orbital rings + energy sweep, all inert decoration */}
      <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div
          className="aether-sweep absolute h-[86%] w-[86%] rounded-full opacity-60 blur-[2px]"
          style={{ maskImage: 'radial-gradient(circle, transparent 46%, #000 62%, #000 84%, transparent 96%)', WebkitMaskImage: 'radial-gradient(circle, transparent 46%, #000 62%, #000 84%, transparent 96%)' }}
        />
        <div className={`aether-orbit absolute h-[74%] w-[74%] rounded-full border ${CORE_ACCENT[state]}`} />
        <div className={`aether-orbit-slow absolute h-[92%] w-[92%] rounded-full border border-dashed opacity-60 ${CORE_ACCENT[state]}`} />
        <div className="absolute h-[52%] w-[52%] rounded-full border border-white/5" />
        {state === 'active' && <span className={`aether-ping absolute h-[40%] w-[40%] rounded-full border ${CORE_ACCENT[state]}`} />}
      </div>

      <div className="absolute inset-0">
        <Suspense
          fallback={
            <div className="flex h-full w-full items-center justify-center">
              <span className="aether-halo h-24 w-24 rounded-full bg-gradient-to-br from-violet-500/60 to-cyan-400/30 blur-md" />
            </div>
          }
        >
          <AetherCore state={state} />
        </Suspense>
      </div>

      {/* HUD — the numbers that prove what the picture is showing */}
      <div className="pointer-events-none absolute inset-x-4 bottom-3 flex items-end justify-between gap-2">
        <span className={`aether-chip rounded-full px-2.5 py-1 text-micro font-semibold uppercase tracking-[0.2em] ${CORE_ACCENT[state].split(' ')[1]}`}>
          {CORE_LABEL[state]}
        </span>
        <span className="flex flex-wrap justify-end gap-1.5">
          {latencyMs != null && (
            <span className="aether-chip aether-hud-value rounded-full px-2.5 py-1 text-micro">{latencyMs.toFixed(0)} ms</span>
          )}
          {exitIp && <span className="aether-chip aether-hud-value rounded-full px-2.5 py-1 text-micro">exit {exitIp}</span>}
        </span>
      </div>

      {[
        'left-3 top-3 border-l border-t',
        'right-3 top-3 border-r border-t',
        'left-3 bottom-3 border-b border-l',
        'right-3 bottom-3 border-b border-r',
      ].map((c) => (
        <span key={c} aria-hidden className={`pointer-events-none absolute h-3 w-3 border-violet-300/35 ${c}`} />
      ))}
    </div>
  );
}

export function AetherSurface() {
  const qc = useQueryClient();
  const toast = useToast();

  const engineQuery = useAetherEngine();
  const profilesQuery = useVpnProfiles();
  const statusQuery = useVpnStatus();
  const killSwitchQuery = useKillSwitch();

  const status = statusQuery.data;
  const engine = engineQuery.data;
  const installed = engine?.installed === true && engine.version != null;
  const active = providerIsActive(status, 'aether');
  const aetherProfiles = (profilesQuery.data?.profiles ?? []).filter((p) => p.providerId === 'aether');
  const healthQuery = useVpnHealth(active);

  const [settings, setSettings] = useState<AetherSettings>(DEFAULT_SETTINGS);
  const [showTuning, setShowTuning] = useState(false);

  // System-wide (TUN) mode. The preference lives on the provider and is applied
  // at the next connect; the live proof is `status.tun`, which the backend only
  // sets to 'active' after a real trace traversed the whole path.
  const tunActive = active && status?.tun === 'active';
  const tunMutation = useMutation({
    mutationFn: (enabled: boolean) => api.post<{ tun: boolean }>('/vpn/aether/tun', { enabled }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['vpn', 'aether'] });
      void qc.invalidateQueries({ queryKey: ['vpn', 'admin'] });
      toast(
        'ok',
        data.tun ? 'System-wide mode requested' : 'System-wide mode off',
        data.tun
          ? 'The next Aether connect will try to claim the OS default route through the TUN gateway.'
          : 'The next Aether connect stays in SOCKS5 proxy mode.',
      );
    },
    onError: (err) => toast('error', 'Could not change system-wide mode', err instanceof Error ? err.message : undefined),
  });

  const install = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; status: string; version: string | null; error: string | null; checksumVerified: boolean }>(
        '/vpn/aether/engine/install',
      ),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['vpn', 'aether'] });
      void qc.invalidateQueries({ queryKey: ['vpn', 'providers'] });
      if (data.ok) {
        toast(
          'ok',
          `Aether ${data.status} (v${data.version ?? '?'})`,
          data.checksumVerified ? 'SHA256 verified against the published release digest.' : undefined,
        );
      } else {
        toast('error', 'Aether install failed', data.error ?? undefined);
      }
    },
    onError: (err) => toast('error', 'Aether install failed', err instanceof Error ? err.message : undefined),
  });

  const createProfile = useMutation({
    mutationFn: (s: AetherSettings) =>
      api.post<{ profile: { id: string; name: string } }>('/vpn/profiles', {
        providerId: 'aether',
        name: `Aether (${s.protocol}/${s.scanMode})`,
        configText: JSON.stringify(s),
      }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['vpn', 'profiles'] });
      setShowTuning(false);
      toast('ok', `Profile "${data.profile.name}" ready`);
    },
    onError: (err) => toast('error', 'Profile creation failed', err instanceof Error ? err.message : undefined),
  });

  const connect = useMutation({
    mutationFn: (profileId: string) => api.post<{ status: VpnStatus }>('/vpn/connect', { profileId }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['vpn'] });
      if (data.status.verification === 'verified') toast('ok', 'Aether tunnel verified', data.status.verificationNote ?? undefined);
      else toast('warn', 'Aether tunnel up (unverified exit)', data.status.verificationNote ?? undefined);
    },
    onError: (err) => {
      void qc.invalidateQueries({ queryKey: ['vpn'] });
      toast('error', 'Aether connect failed', err instanceof Error ? err.message : undefined);
    },
  });

  const disconnect = useMutation({
    mutationFn: () => api.post<{ status: VpnStatus }>('/vpn/disconnect'),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['vpn'] }),
    onError: (err) => toast('error', 'Disconnect failed', err instanceof Error ? err.message : undefined),
  });

  const reconnect = useMutation({
    mutationFn: (profileId: string) => api.post<{ status: VpnStatus }>('/vpn/reconnect', { profileId }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['vpn'] }),
    onError: (err) => toast('error', 'Reconnect failed', err instanceof Error ? err.message : undefined),
  });

  const ks = killSwitchQuery.data?.killSwitch;
  // TUN mode's claims come from their one owner (./tunStatus), so the Aether
  // surface and the tunnel card cannot disagree about what is protected.
  const tunView = status?.providerId === 'aether' ? tunClaim(status) : null;
  const tunFix = status?.providerId === 'aether' ? tunRemedy(status.tunBlockedBy) : null;
  const watchdog = watchdogClaim(status?.tunWatchdog, status?.tun);
  const failedSince = connect.isError || (status?.providerId === 'aether' && status?.verification === 'failed');
  const coreState: CoreState = connect.isPending || install.isPending ? 'starting' : active ? 'active' : failedSince ? 'down' : 'idle';
  const exitIp = active ? (status?.verifiedPublicIp ?? null) : null;
  const latencyMs = active ? (healthQuery.data?.endpointLatencyMs ?? null) : null;
  const noneUp = status?.connected !== true;

  const phases: Phase[] = [
    {
      label: 'Engine verified',
      detail: installed ? `v${engine?.version} passed its own self-check` : install.isPending ? 'downloading and verifying' : 'binary not installed',
      done: installed,
      running: install.isPending,
    },
    {
      label: 'Route acquired',
      detail: active ? 'serving a local SOCKS5 proxy' : connect.isPending ? 'scanning the network' : 'no tunnel is up',
      done: active,
      running: connect.isPending,
    },
    {
      label: 'Exit observed',
      detail: exitIp ? `read through the tunnel: ${exitIp}` : 'no exit address read yet',
      done: exitIp != null,
    },
    {
      label: 'Traffic verified',
      detail: active ? (status?.verification ?? 'not verified') : 'nothing to verify',
      done: status?.verification === 'verified',
    },
  ];

  const capabilityChips: Array<{ label: string; on: boolean; note?: string }> = [
    { label: 'MASQUE / WARP protocols', on: true, note: 'masque · wg · gool · mim' },
    { label: 'Local SOCKS5 proxy', on: true, note: '127.0.0.1:1819' },
    { label: 'Route selection by scanning', on: true },
    { label: 'Kill switch integration', on: true, note: 'fails closed on drop' },
    { label: 'System route / adapter change', on: false, note: 'proxy mode only — no system routes' },
    { label: 'Nested-mode exit hop', on: false, note: 'nested mode chains the local cores' },
  ];

  return (
    <DisclosureScope name="vpn:aether" className="stagger animate-fade-up">
      {/* ================================ stage ================================ */}
      <section className="aether-stage mb-7">
        <div className="relative grid gap-6 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_minmax(300px,400px)] lg:items-center lg:gap-8">
          {/* ------------------------------ identity ---------------------------- */}
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <EngineGlyph glyph="from-violet-500/30 to-cyan-400/10 text-violet-200" size="lg">
                <Globe size={24} />
              </EngineGlyph>
              <span className="text-micro font-semibold uppercase tracking-[0.22em] text-violet-200/70">
                circumvention engine · masque / warp family
              </span>
            </div>

            <h2 className="aether-text mt-4 text-4xl font-semibold tracking-tight sm:text-5xl">Aether</h2>

            <p className="mt-2 max-w-xl text-sm leading-relaxed text-white/60">
              Its own binary, not a protocol this app speaks. It scans for a route out of a filtered network and serves whatever it finds on{' '}
              <code className="text-white/80">socks5://127.0.0.1:1819</code> — there is no server config to paste.
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              {engine ? (
                <Badge tone={installed ? 'ok' : 'warn'}>{installed ? `engine v${engine.version}` : 'engine not installed'}</Badge>
              ) : (
                <Skeleton className="h-5 w-28" />
              )}
              {active && <VerificationBadge status={status} />}
              {ks?.blocking && <Badge tone="danger">kill switch engaged</Badge>}
              {!engineQuery.isLoading && aetherProfiles.length === 0 && <Badge tone="neutral">no profile yet</Badge>}
            </div>

            {/* No container: the stage is already the frame, so the phases sit
                on it behind a hairline instead of inside another box. */}
            <div className="mt-6 border-t border-white/10 pt-4">
              <PhaseTrack phases={phases} />
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-2">
              {/* With no profile there is nothing to connect to, so the first
                  action is the one that creates one — Connect stays visible but
                  disabled, and says why on hover. */}
              {!aetherProfiles[0] && installed && !active && (
                <Button
                  variant="primary"
                  onClick={() => setShowTuning(true)}
                  className="aether-cta h-10 border-cyan-300/50 bg-cyan-400/15 px-5 text-cyan-50 hover:bg-cyan-400/25"
                >
                  <Plus size={13} />
                  Create profile
                </Button>
              )}

              {!active ? (
                <Button
                  variant={aetherProfiles[0] ? 'primary' : 'ghost'}
                  onClick={() => aetherProfiles[0] && connect.mutate(aetherProfiles[0].id)}
                  loading={connect.isPending}
                  disabled={!installed || !aetherProfiles[0] || !noneUp}
                  title={
                    !installed
                      ? 'Install the engine first'
                      : !aetherProfiles[0]
                        ? 'Create a profile first'
                        : !noneUp
                          ? 'Another tunnel is up — disconnect it first'
                          : 'Scan for a route and serve it on a local SOCKS5 proxy'
                  }
                  className={
                    aetherProfiles[0]
                      ? 'aether-cta h-10 border-cyan-300/50 bg-cyan-400/15 px-5 text-cyan-50 hover:bg-cyan-400/25'
                      : 'h-10 border border-white/10 text-white/50'
                  }
                >
                  <Play size={13} />
                  Connect
                </Button>
              ) : (
                <Button
                  variant="danger"
                  onClick={() => disconnect.mutate()}
                  loading={disconnect.isPending}
                  className="h-10 border-rose-300/40 bg-rose-500/15 px-5 text-rose-50 hover:bg-rose-500/25"
                >
                  <Square size={12} />
                  Disconnect
                </Button>
              )}

              {active && (
                <Button
                  variant="ghost"
                  onClick={() => aetherProfiles[0] && reconnect.mutate(aetherProfiles[0].id)}
                  loading={reconnect.isPending}
                  className="border border-white/10 text-white/70 hover:bg-white/5 hover:text-white"
                >
                  <RefreshCw size={12} />
                  Reconnect
                </Button>
              )}

              <Button
                variant="ghost"
                onClick={() => install.mutate()}
                loading={install.isPending}
                title="Download the verified binary from the official GitHub releases"
                className="border border-white/10 text-white/70 hover:bg-white/5 hover:text-white"
              >
                <Download size={13} />
                {installed ? 'Update engine' : 'Install engine'}
              </Button>

            </div>

            <p className="mt-4 max-w-xl text-micro leading-relaxed text-white/40">
              {active && status?.since != null
                ? `Tunnel up since ${new Date(status.since).toLocaleTimeString()}${status.endpoint ? ` · endpoint ${status.endpoint}` : ''}.`
                : installed
                  ? 'The binary is checksum-verified before it is ever executed. Create a profile to scan for a working route.'
                  : 'Install the engine to begin — nothing is reported working until a real exit address is observed through the tunnel.'}
            </p>
          </div>

          {/* -------------------------------- core ------------------------------ */}
          <CorePortal state={coreState} exitIp={exitIp} latencyMs={latencyMs} />
        </div>
      </section>

      {/* ============================== telemetry ============================= */}
      {active ? (
        <MetricStrip
          className="mb-5"
          items={[
            { label: 'Received', value: formatBytes(healthQuery.data?.rxBytes), mono: true, hint: 'reported by the engine' },
            { label: 'Sent', value: formatBytes(healthQuery.data?.txBytes), mono: true, hint: 'reported by the engine' },
            {
              label: 'Handshake age',
              value: healthQuery.data?.handshakeAgeSec != null ? `${healthQuery.data.handshakeAgeSec}s` : '—',
              mono: true,
              hint: 'seconds since the last handshake',
            },
            {
              label: 'Endpoint latency',
              value: healthQuery.data?.endpointLatencyMs != null ? `${healthQuery.data.endpointLatencyMs.toFixed(1)} ms` : '—',
              mono: true,
              hint: 'live measurement to the current endpoint',
            },
          ]}
        />
      ) : (
        <Notice tone="info" className="mb-5" icon={<Activity size={13} />}>
          No live counters: byte, handshake and latency figures are only shown while a tunnel is actually up, because they are read from the running
          engine.
        </Notice>
      )}

      {status?.providerId === 'aether' && status.verificationNote && (
        <Notice tone={status.verification === 'failed' ? 'danger' : 'warn'} className="mb-5" icon={<TriangleAlert size={13} />}>
          {status.verificationNote}
        </Notice>
      )}

      {/* ============================== operation ============================= */}
      {/* One place to fold the whole surface: the four reference sections below
          are folded by default, so the page opens on what it is FOR. */}
      <DisclosureToolbar className="mb-2" />
      <div className="grid gap-x-8 lg:grid-cols-2">
        <Section
          variant="flat"
          collapsible
          pinned
          id="profiles"
          defaultOpen
          badge={
            aetherProfiles.length > 0 ? (
              <Badge tone={active ? 'ok' : 'neutral'}>{active ? '1 active' : `${aetherProfiles.length} saved`}</Badge>
            ) : undefined
          }
          summary={aetherProfiles.length > 0 ? `${aetherProfiles.length} profile(s) — one is enough, variants are allowed` : 'No profile yet'}
          title="Profiles"
          icon={<KeyRound size={15} />}
          subtitle="Each profile holds its own tunnel settings — one is enough, variants are allowed"
          actions={
            <Button variant="ghost" onClick={() => setShowTuning((v) => !v)}>
              <Plus size={12} />
              {showTuning ? 'Close' : 'New'}
            </Button>
          }
        >
          {showTuning && (
            <AetherTuning
              settings={settings}
              setSettings={setSettings}
              busy={createProfile.isPending}
              disabled={!installed}
              onCreate={() => createProfile.mutate(settings)}
            />
          )}

          {profilesQuery.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-11" />
              <Skeleton className="h-11" />
            </div>
          ) : aetherProfiles.length === 0 ? (
            <Panel tone="aether">
              <p className="text-sm text-text">No Aether profile yet</p>
              <p className="mt-1 text-xs leading-relaxed text-muted">
                {installed
                  ? 'Create one and Aether scans for a working route, then serves it on a local SOCKS5 proxy.'
                  : 'Install the engine first — profile creation needs the verified binary.'}
              </p>
              {installed && (
                <Button variant="secondary" className="mt-3" onClick={() => setShowTuning(true)}>
                  <Plus size={12} />
                  Create profile
                </Button>
              )}
            </Panel>
          ) : (
            <DataList className="rounded-xl border border-line bg-surface px-4">
              {aetherProfiles.map((p) => (
                <DataRow
                  key={p.id}
                  tone={active ? 'active' : 'default'}
                  leading={
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-500/10 text-violet-200">
                      <Globe size={14} />
                    </span>
                  }
                  title={
                    <>
                      <span className="text-sm text-text">{p.name}</span>
                      <Badge tone={active ? 'ok' : 'neutral'}>{active ? 'active' : 'idle'}</Badge>
                    </>
                  }
                  subtitle={p.endpoint ?? 'local SOCKS5 · 127.0.0.1:1819'}
                  actions={
                    active ? (
                      <Button variant="ghost" onClick={() => disconnect.mutate()} loading={disconnect.isPending}>
                        <Square size={12} />
                        Stop
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        onClick={() => connect.mutate(p.id)}
                        loading={connect.isPending && connect.variables === p.id}
                        disabled={!installed || !noneUp}
                      >
                        <Play size={12} />
                        Connect
                      </Button>
                    )
                  }
                />
              ))}
            </DataList>
          )}
        </Section>

        {/* ========================= system-wide mode ======================== */}
        <Section
          variant="flat"
          collapsible
          id="tun"
          defaultOpen={false}
          badge={
            <Badge tone={tunActive ? 'ok' : engine?.tun ? 'warn' : 'neutral'}>
              {tunActive ? 'capturing' : engine?.tun ? 'requested' : 'off'}
            </Badge>
          }
          summary={tunActive ? 'Capturing now — every app goes through the tunnel' : 'Not capturing — traffic follows the normal system route'}
          title="System-wide mode (TUN)"
          icon={<Globe size={15} />}
          subtitle="Capture every app, not just the ones that honour a proxy setting"
        >
          <Panel tone={tunActive ? 'accent' : 'quiet'} className="space-y-3">
            <label className="flex items-start gap-2 text-xs text-muted">
              <input
                type="checkbox"
                className="mt-0.5 h-3.5 w-3.5 accent-[var(--color-accent,#6366f1)]"
                checked={engine?.tun ?? false}
                disabled={tunMutation.isPending}
                onChange={(e) => tunMutation.mutate(e.target.checked)}
              />
              <span className="flex flex-wrap items-center gap-1.5">
                <Globe size={12} />
                Put a TUN gateway in front of Aether&apos;s SOCKS5 port so the OS default route carries your traffic.
                Applied at the next connect — an active tunnel is never re-routed underneath you.
              </span>
            </label>

            {/* Live state of the ENGINE'S OWN tunnel, which may be up right now
                from an earlier connect. */}
            {status?.providerId === 'aether' && tunView && (
              <p className={`text-xs leading-relaxed ${TUN_TONE_CLASS[tunView.tone]}`}>{tunView.sentence}</p>
            )}
            {status?.providerId === 'aether' && watchdog && (
              <p className={`text-xs leading-relaxed ${TUN_TONE_CLASS[watchdog.tone]}`}>{watchdog.text}</p>
            )}
            {status?.providerId === 'aether' && status.tunError && (
              <p className={`text-xs leading-relaxed ${status.tunBlockedBy === 'kill-switch' ? 'text-danger' : 'text-warn'}`}>
                {status.tunError}
                {tunFix ? ` ${tunFix}` : ''}
              </p>
            )}
            {tunMutation.isError && (
              <p className="text-xs text-danger">Could not save the system-wide preference: the backend refused it.</p>
            )}
          </Panel>

          {/* The privilege that stands between the user and a system-wide
              tunnel, with the fix attached when one exists. */}
          {(engine?.tun ?? false) && <PrivilegeGate id="tun-gateway" className="mt-3" />}
          {(engine?.tun ?? false) && <AdminAccessPanel compact />}

          <p className="mt-2 text-micro leading-relaxed text-faint">
            Why a gateway instead of Aether claiming the route itself: Aether speaks SOCKS5 and nothing else. One sing-box
            gateway in front of it gives Aether the same system-wide mode the local cores use — one mechanism for every engine,
            and one place where the route is claimed and released.
          </p>
        </Section>

        <Section
          variant="flat"
          collapsible
          id="kill-switch"
          defaultOpen={false}
          badge={<Badge tone={ks?.blocking ? 'danger' : ks?.armed ? 'warn' : ks?.enabled ? 'ok' : 'neutral'}>{ks?.blocking ? 'engaged' : ks?.armed ? 'armed' : ks?.enabled ? 'on' : 'off'}</Badge>}
          summary={ks?.blocking ? 'Traffic is being blocked right now' : 'Nothing is blocked right now'}
          title="Kill switch"
          icon={<ShieldCheck size={15} />}
          subtitle="Live enforcement state — not the preference"
        >
          <Panel tone={ks?.blocking ? 'default' : 'quiet'} className={ks?.blocking ? 'bg-danger/10' : ''}>
            <p className={`text-sm font-medium ${ks?.blocking ? 'text-danger' : 'text-text'}`}>
              {ks?.blocking
                ? 'ENGAGED — traffic is being blocked'
                : ks?.armed
                  ? 'Armed (holding the previous state)'
                  : ks?.enabled
                    ? 'On (idle — nothing to block)'
                    : 'Off'}
            </p>
            {ks?.reason && ks.blocking && <p className="mt-1 text-xs text-muted">Reason: {ks.reason}</p>}
            {ks?.note && <p className="mt-1 text-xs leading-relaxed text-muted">{ks.note}</p>}
            {ks?.bypassSummary && <p className="mt-1 text-xs text-faint">Exempt from the block: {ks.bypassSummary}</p>}
            {!ks && <p className="mt-1 text-xs text-faint">Kill-switch state unavailable.</p>}
            {ks?.blocking && (
              <Button variant="danger" className="mt-3" onClick={() => disconnect.mutate()} loading={disconnect.isPending}>
                <Square size={11} />
                Release kill switch
              </Button>
            )}
          </Panel>
          <p className="mt-2 text-micro leading-relaxed text-faint">
            The preference lives in Settings → VPN. When it is on, a dropped tunnel fails closed instead of silently falling back to the direct path —
            that is the difference between this row and the switch.
          </p>
        </Section>
      </div>

      {/* ============================== provenance ============================ */}
      <Section
        variant="flat"
        collapsible
        id="provenance"
        defaultOpen={false}
        badge={<Badge tone={installed ? 'ok' : 'warn'}>{engine?.version ? `v${engine.version}` : 'not installed'}</Badge>}
        summary="Where the binary comes from and how it is verified"
        title="Engine provenance"
        icon={<Zap size={15} />}
        subtitle={MANAGED_PROVIDER_META.aether.binaryNote}
      >
        <div className="grid gap-y-3 sm:grid-cols-2 sm:gap-x-6">
          <div className="space-y-2">
            <ProvenanceRow label="Installed version" value={engine?.version ? `v${engine.version}` : 'not installed'} />
            <ProvenanceRow label="Self-check" value={installed ? 'passed (`-v`)' : 'not run'} />
            <ProvenanceRow label="Upstream" value="github.com/CluvexStudio/Aether" />
          </div>
          <div className="space-y-2 sm:border-l sm:border-line sm:pl-6">
            <ProvenanceRow label="Binary" value={engine?.path ?? '—'} mono />
            <ProvenanceRow label="Integrity" value="SHA256 against the published release digest" />
            <ProvenanceRow
              label="Modes"
              value={engine?.tun ? 'proxy + TUN gateway (system-wide) requested' : 'proxy only — no system route claimed'}
            />
          </div>
        </div>
      </Section>

      {/* ============================= capabilities =========================== */}
      <Section
        variant="flat"
        collapsible
        id="capabilities"
        defaultOpen={false}
        summary={`${capabilityChips.filter((c) => c.on).length} of ${capabilityChips.length} supported`}
        title="Documented capabilities"
        subtitle="What this engine is built to do — a static matrix, not a live measurement"
      >
        <div className="flex flex-wrap gap-1.5">
          {capabilityChips.map((c) => (
            <Chip key={c.label} state={c.on ? 'on' : 'off'} title={c.note}>
              {c.on ? '✓' : '×'} {c.label}
              {c.note && <span className="text-faint">· {c.note}</span>}
            </Chip>
          ))}
        </div>
      </Section>
    </DisclosureScope>
  );
}

/** One `label → value` line in the provenance grid. Long values truncate. */
function ProvenanceRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line pb-1.5 last:border-b-0">
      <span className="shrink-0 text-xs text-faint">{label}</span>
      <span title={value} className={`min-w-0 truncate text-right text-xs text-muted ${mono ? 'metric-num' : ''}`}>
        {value}
      </span>
    </div>
  );
}

/** The tuning form — mirrors the Aether settings JSON the provider stores. */
function AetherTuning({
  settings,
  setSettings,
  busy,
  disabled,
  onCreate,
}: {
  settings: AetherSettings;
  setSettings: (updater: (prev: AetherSettings) => AetherSettings) => void;
  busy: boolean;
  disabled: boolean;
  onCreate: () => void;
}) {
  const selectedProtocol = PROTOCOLS.find((p) => p.value === settings.protocol);
  return (
    <Panel tone="aether" className="mb-4 space-y-3">
      <p className="text-xs leading-relaxed text-muted">
        These settings are stored with the profile and passed to the Aether binary. Scan mode decides how hard it searches; obfuscation decides how the
        traffic looks on the wire.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Protocol" hint={selectedProtocol?.hint}>
          <select
            className="h-9 w-full rounded-lg border border-line bg-surface-2 px-2 text-sm"
            value={settings.protocol}
            onChange={(e) => setSettings((s) => ({ ...s, protocol: e.target.value as AetherSettings['protocol'] }))}
          >
            {PROTOCOLS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Scan mode" hint={SCAN_MODES.find((m) => m.value === settings.scanMode)?.hint}>
          <select
            className="h-9 w-full rounded-lg border border-line bg-surface-2 px-2 text-sm"
            value={settings.scanMode}
            onChange={(e) => setSettings((s) => ({ ...s, scanMode: e.target.value as AetherSettings['scanMode'] }))}
          >
            {SCAN_MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="MASQUE transport">
          <select
            className="h-9 w-full rounded-lg border border-line bg-surface-2 px-2 text-sm"
            value={settings.transport}
            onChange={(e) => setSettings((s) => ({ ...s, transport: e.target.value as AetherSettings['transport'] }))}
          >
            <option value="h3">HTTP/3 (QUIC)</option>
            <option value="h2">HTTP/2 (TCP — for UDP-blocked networks)</option>
          </select>
        </Field>
        <Field label="IP version">
          <select
            className="h-9 w-full rounded-lg border border-line bg-surface-2 px-2 text-sm"
            value={settings.ipVersion}
            onChange={(e) => setSettings((s) => ({ ...s, ipVersion: e.target.value as AetherSettings['ipVersion'] }))}
          >
            <option value="v4">IPv4</option>
            <option value="v6">IPv6</option>
            <option value="both">Both</option>
          </select>
        </Field>
        <Field label="Obfuscation (noize)">
          <select
            className="h-9 w-full rounded-lg border border-line bg-surface-2 px-2 text-sm"
            value={settings.noize}
            onChange={(e) => setSettings((s) => ({ ...s, noize: e.target.value as AetherSettings['noize'] }))}
          >
            {NOIZE.map((n) => (
              <option key={n.value} value={n.value}>
                {n.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Quick reconnect">
          <label className="flex h-9 items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={settings.quickReconnect}
              onChange={(e) => setSettings((s) => ({ ...s, quickReconnect: e.target.checked }))}
            />
            re-test the last working gateway first
          </label>
        </Field>
      </div>
      <Button variant="primary" onClick={onCreate} loading={busy} disabled={disabled}>
        <Plus size={12} />
        Create profile
      </Button>
      {disabled && <p className="text-xs text-faint">Install the Aether engine first — the binary comes checksum-verified from the official releases.</p>}
    </Panel>
  );
}
