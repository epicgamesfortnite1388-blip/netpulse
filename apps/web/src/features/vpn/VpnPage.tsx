import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as RTabs from '@radix-ui/react-tabs';
import { Cpu, Globe, Route, Shield, ShieldCheck, ShieldOff } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatusDot } from '@/components/ui/StatusDot';
import { useToast } from '@/components/Toaster';
import { api } from '@/lib/api';
import { usePersistentState } from '@/lib/usePersistentState';

import { AetherSurface } from './AetherSurface';
import { CoreSurface } from './CoreSurface';
import { EngineIntakeCard } from './EngineIntakeCard';
import { OverviewSurface } from './OverviewSurface';
import { ProviderSurface } from './ProviderSurface';
import { TunnelSurface } from './TunnelSurface';
import { PROXY_CORE_IDS, PROXY_CORE_META, PROVIDER_LABEL, VPN_SURFACES } from './engineMeta';
import { useAetherEngine, useKillSwitch, useProxyEngines, useVpnProviders, useVpnStatus } from './useVpnData';

import type { VpnSurfaceId } from './engineMeta';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ProxyTunnelStatus, VpnStatus } from '@netpulse/shared';

/**
 * VPN — one section, divided by engine.
 *
 * Two structural decisions own this file:
 *
 *  1. The rail is the navigation. Engines are grouped by HOW they reach the
 *     internet (circumvention binary / public-node cores / native clients)
 *     instead of being one flat strip of eight identical tabs, and each rail
 *     item carries the live state of its own engine. Opening an engine is
 *     therefore possible from anywhere on the page, not only from the Overview.
 *  2. The system bar is the only cross-engine surface. "What is up right now"
 *     and "what is blocking" exist in exactly one place, so no engine surface
 *     has to repeat it and none of them can disagree with each other.
 */

interface RailItem {
  id: VpnSurfaceId;
  label: string;
  icon: LucideIcon;
  glyph: string;
  dot: { tone: 'ok' | 'warn' | 'danger' | 'idle'; pulse?: boolean };
  state: string;
}

interface RailGroup {
  heading: string;
  items: RailItem[];
}

/** Everything the rail and the system bar need, resolved once. */
function useVpnShellState() {
  const statusQuery = useVpnStatus();
  const killSwitchQuery = useKillSwitch();
  const enginesQuery = useProxyEngines();
  const providersQuery = useVpnProviders();
  const aetherQuery = useAetherEngine();
  const tunnelQuery = useQuery({
    queryKey: ['tunnel', 'status'],
    queryFn: () => api.get<{ tunnel: ProxyTunnelStatus }>('/vpn/tunnel/status'),
    refetchInterval: 5_000,
  });

  return {
    statusQuery,
    status: statusQuery.data,
    killSwitch: killSwitchQuery.data?.killSwitch,
    engines: enginesQuery.data?.engines ?? [],
    preferred: enginesQuery.data?.preferred ?? 'auto',
    effective: enginesQuery.data?.effective ?? null,
    providers: providersQuery.data?.providers ?? [],
    aether: aetherQuery.data,
    tunnel: tunnelQuery.data?.tunnel,
  };
}

/** The cross-engine bar: one bordered strip, hairline-separated segments. */
function SystemBar({
  status,
  tunnel,
  killSwitchBlocking,
  blockingReason,
}: {
  status: VpnStatus | undefined;
  tunnel: ProxyTunnelStatus | undefined;
  killSwitchBlocking: boolean;
  blockingReason: string | null | undefined;
}) {
  const connected = status?.connected === true;
  const tunnelActive = tunnel?.state === 'active';
  const provider = status?.providerId ? (PROVIDER_LABEL[status.providerId] ?? status.providerId) : null;

  const tone = killSwitchBlocking ? 'danger' : connected || tunnelActive ? 'ok' : 'idle';
  const headline = killSwitchBlocking
    ? 'Kill switch engaged — traffic is blocked'
    : connected
      ? `Tunnel up via ${provider ?? 'a provider'}`
      : tunnelActive
        ? 'Proxy tunnel active'
        : 'No tunnel is up';

  const segments: Array<{ label: string; value: ReactNode; tone?: 'ok' | 'warn' | 'danger' }> = [];

  if (connected) {
    segments.push({ label: 'Profile', value: status?.serverName ?? '—' });
    segments.push({ label: 'Protocol', value: status?.protocol ?? '—' });
    if (status?.verifiedPublicIp) segments.push({ label: 'Exit', value: <span className="metric-num">{status.verifiedPublicIp}</span>, tone: 'ok' });
    if (status?.since != null) segments.push({ label: 'Up since', value: new Date(status.since).toLocaleTimeString() });
    if (status?.verification === 'failed') segments.push({ label: 'Routing', value: 'not through the tunnel', tone: 'danger' });
  }

  if (tunnelActive) {
    segments.push({ label: 'Node', value: tunnel?.nodeName ?? tunnel?.nodeId ?? '—' });
    segments.push({ label: 'Exit', value: <span className="metric-num">{tunnel?.exitIp ?? 'unverified'}</span> });
    if (tunnel?.engine) segments.push({ label: 'Core', value: tunnel.engine });
    if (tunnel?.chain) {
      segments.push({
        label: 'Chain',
        value: tunnel.chain.exitDiffers ? 'nested · exit differs' : 'nested · exit identical',
        tone: tunnel.chain.exitDiffers ? 'ok' : 'warn',
      });
    }
  }

  if (!connected && !tunnelActive) {
    segments.push({ label: 'Mode', value: 'nothing is carrying traffic' });
  }

  return (
    <div className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-line bg-surface px-4 py-3">
      <span className="flex items-center gap-2.5">
        <StatusDot tone={tone} pulse={tunnel?.state === 'starting' || tunnel?.state === 'stopping'} />
        <span className="text-sm text-text">{headline}</span>
      </span>

      {killSwitchBlocking && (
        <Badge tone="danger">
          <ShieldOff size={11} /> blocking
        </Badge>
      )}

      {segments.map((s) => (
        <span key={s.label} className="min-w-0 text-xs text-faint">
          {s.label}:{' '}
          <span className={s.tone === 'ok' ? 'text-ok' : s.tone === 'warn' ? 'text-warn' : s.tone === 'danger' ? 'text-danger' : 'text-muted'}>
            {s.value}
          </span>
        </span>
      ))}

      {killSwitchBlocking && blockingReason && (
        <span className="min-w-0 max-w-full truncate text-xs text-faint">Reason: {blockingReason}</span>
      )}
    </div>
  );
}

export default function VpnPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [surface, setSurface] = usePersistentState<VpnSurfaceId>('vpn.surface', 'overview');

  const {
    statusQuery,
    status,
    killSwitch,
    engines,
    preferred,
    effective,
    providers,
    aether,
    tunnel,
  } = useVpnShellState();

  const connected = status?.connected === true;
  const tunnelActive = tunnel?.state === 'active';

  const disconnect = useMutation({
    mutationFn: () => api.post<{ status: VpnStatus }>('/vpn/disconnect'),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['vpn'] }),
    onError: (err) => toast('error', 'Disconnect failed', err instanceof Error ? err.message : undefined),
  });

  const core = (id: string) => engines.find((e) => e.id === id);
  const provider = (id: string) => providers.find((p) => p.id === id);
  const installedCores = engines.filter((e) => e.available);

  const groups: RailGroup[] = [
    {
      heading: 'Dispatch',
      items: [
        {
          id: 'overview',
          label: 'Overview',
          icon: Shield,
          glyph: 'from-slate-400/20 to-slate-300/5 text-slate-200',
          dot: { tone: connected || tunnelActive ? 'ok' : 'idle' },
          state: connected || tunnelActive ? 'a tunnel is up' : 'no tunnel',
        },
      ],
    },
    {
      heading: 'Circumvention',
      items: [
        {
          id: 'aether',
          label: 'Aether',
          icon: Globe,
          glyph: 'from-violet-500/30 to-cyan-400/10 text-violet-200',
          dot: {
            tone: status?.providerId === 'aether' && connected ? 'ok' : aether?.installed ? 'idle' : 'warn',
          },
          state:
            status?.providerId === 'aether' && connected
              ? 'connected'
              : aether?.installed
                ? `v${aether.version ?? '?'} installed`
                : 'not installed',
        },
      ],
    },
    {
      heading: 'Node path',
      items: [
        {
          id: 'tunnel',
          label: 'Proxy Tunnel',
          icon: Route,
          glyph: 'from-cyan-500/25 to-sky-400/10 text-cyan-300',
          dot: { tone: tunnelActive ? 'ok' : tunnel?.state === 'down' ? 'danger' : installedCores.length ? 'idle' : 'warn' },
          state: tunnelActive ? `active · ${tunnel?.exitIp ?? 'unverified'}` : tunnel?.state === 'down' ? 'fault' : installedCores.length ? 'ready' : 'no core',
        },
        // Derived from the shared engine catalog, so a newly supported core
        // cannot be missing from this list.
        ...PROXY_CORE_IDS.map((id) => {
          const info = core(id);
          const available = info?.available === true;
          return {
            id,
            label: PROXY_CORE_META[id].shortLabel,
            icon: Cpu,
            glyph: PROXY_CORE_META[id].glyph,
            dot: { tone: available ? (effective === id ? 'ok' : 'idle') : 'warn' } as const,
            state: available ? (preferred === id ? 'preferred' : effective === id ? 'in use' : 'installed') : 'not installed',
          };
        }),
      ],
    },
    {
      heading: 'Native clients',
      items: (['wireguard', 'openvpn'] as const).map((id) => {
        const info = provider(id);
        const available = info?.available === true;
        const isConnected = status?.providerId === id && connected;
        return {
          id,
          label: id === 'wireguard' ? 'WireGuard' : 'OpenVPN',
          icon: ShieldCheck,
          glyph: id === 'wireguard' ? 'from-rose-500/25 to-orange-400/10 text-rose-300' : 'from-amber-500/25 to-yellow-400/10 text-amber-300',
          dot: { tone: isConnected ? 'ok' : available ? 'idle' : 'warn' } as const,
          state: isConnected ? 'connected' : available ? 'available' : 'not detected',
        };
      }),
    },
  ];

  const railItems = groups.flatMap((g) => g.items);
  const missing = VPN_SURFACES.filter((s) => !railItems.some((i) => i.id === s.id));

  return (
    <div>
      <PageHeader
        title="VPN"
        description="Every tunnel engine on this machine, divided by how it reaches the internet. One tunnel runs at a time; a surface only reports a tunnel it observed."
        actions={
          // Also offered while the kill switch is blocking: that state has no
          // connected tunnel, and Disconnect is the way out of it.
          connected || killSwitch?.blocking ? (
            <Button variant="danger" onClick={() => disconnect.mutate()} loading={disconnect.isPending}>
              <Shield size={13} />
              {connected ? 'Disconnect' : 'Release kill switch'}
            </Button>
          ) : null
        }
      />

      {statusQuery.isError && (
        <p className="mb-5 rounded-r-lg border-l-2 border-danger/60 bg-danger/5 px-3.5 py-2.5 text-xs text-danger">
          VPN status could not be read: {statusQuery.error instanceof Error ? statusQuery.error.message : 'unknown error'}.
          The surfaces below show nothing rather than stale state.
        </p>
      )}

      <SystemBar
        status={status}
        tunnel={tunnel}
        killSwitchBlocking={killSwitch?.blocking === true}
        blockingReason={killSwitch?.reason}
      />

      <RTabs.Root value={surface} onValueChange={(v) => setSurface(v as VpnSurfaceId)} orientation="vertical">
        <div className="grid gap-6 lg:grid-cols-[212px_minmax(0,1fr)] lg:items-start">
          {/* ------------------------------- rail ------------------------------ */}
          <RTabs.List
            aria-label="VPN engines"
            className="-mx-4 flex gap-x-4 overflow-x-auto px-4 pb-2 lg:mx-0 lg:sticky lg:top-20 lg:block lg:overflow-visible lg:px-0 lg:pb-0"
          >
            {groups.map((group) => (
              <div key={group.heading} className="flex shrink-0 gap-1.5 lg:mb-4 lg:block lg:shrink lg:gap-0">
                <p className="hidden px-2.5 pb-1.5 text-micro font-semibold uppercase tracking-[0.18em] text-faint lg:block">
                  {group.heading}
                </p>
                <div className="flex gap-1.5 lg:block lg:space-y-0.5">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    return (
                      <RTabs.Trigger
                        key={item.id}
                        value={item.id}
                        title={`${item.label} — ${item.state}`}
                        className="group flex w-auto shrink-0 items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-text data-[state=active]:border-line-strong data-[state=active]:bg-surface data-[state=active]:text-text lg:w-full"
                      >
                        <span
                          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-gradient-to-br ${item.glyph} group-data-[state=active]:opacity-100 lg:opacity-80`}
                        >
                          <Icon size={13} />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
                        <span className="hidden text-micro text-faint lg:inline group-data-[state=active]:text-muted">
                          <StatusDot tone={item.dot.tone} pulse={item.dot.pulse} size={6} />
                        </span>
                      </RTabs.Trigger>
                    );
                  })}
                </div>
              </div>
            ))}
            {/* Rail items the user has never seen before this build are appended
                rather than dropped, so a new surface is reachable immediately. */}
            {missing.length > 0 && (
              <p className="hidden text-micro text-faint lg:block">
                Not in the rail: {missing.map((m) => m.label).join(', ')}
              </p>
            )}
          </RTabs.List>

          {/* ------------------------------ engines ---------------------------- */}
          <div className="min-w-0">
            <RTabs.Content value="overview" className="animate-fade-up focus-visible:outline-none">
              <OverviewSurface onOpen={(id) => setSurface(id)} />
            </RTabs.Content>

            <RTabs.Content value="aether" className="animate-fade-up focus-visible:outline-none">
              <AetherSurface />
            </RTabs.Content>

            <RTabs.Content value="tunnel" className="animate-fade-up focus-visible:outline-none">
              <TunnelSurface />
            </RTabs.Content>

            <RTabs.Content value="xray" className="animate-fade-up focus-visible:outline-none">
              <CoreSurface engine="xray" />
            </RTabs.Content>

            <RTabs.Content value="sing-box" className="animate-fade-up focus-visible:outline-none">
              <CoreSurface engine="sing-box">
                <div className="mb-4 mt-1 flex items-center gap-3">
                  <div className="h-px flex-1 bg-line" />
                  <span className="text-micro uppercase tracking-[0.16em] text-faint">Managed tunnel · share links</span>
                  <div className="h-px flex-1 bg-line" />
                </div>
                <div className="space-y-7">
                  <EngineIntakeCard />
                  <ProviderSurface providerId="singbox" />
                </div>
              </CoreSurface>
            </RTabs.Content>

            <RTabs.Content value="hysteria" className="animate-fade-up focus-visible:outline-none">
              <CoreSurface engine="hysteria" />
            </RTabs.Content>

            <RTabs.Content value="v2ray" className="animate-fade-up focus-visible:outline-none">
              <CoreSurface engine="v2ray" />
            </RTabs.Content>

            <RTabs.Content value="wireguard" className="animate-fade-up focus-visible:outline-none">
              <ProviderSurface providerId="wireguard" />
            </RTabs.Content>

            <RTabs.Content value="openvpn" className="animate-fade-up focus-visible:outline-none">
              <ProviderSurface providerId="openvpn" />
            </RTabs.Content>
          </div>
        </div>
      </RTabs.Root>
    </div>
  );
}
