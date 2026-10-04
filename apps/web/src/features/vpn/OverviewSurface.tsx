import { useQuery } from '@tanstack/react-query';
import { Activity, ChevronRight, Cpu, GitBranch, Globe, Route, Shield, ShieldCheck, Star, Zap } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { api } from '@/lib/api';

import { AdminAccessPanel } from './AdminAccessPanel';
import { EngineIntakeCard } from './EngineIntakeCard';
import { MANAGED_PROVIDER_META, PROXY_CORE_IDS, PROXY_CORE_META } from './engineMeta';
import { tunnelExitHint } from './tunnelExitHint';
import { DisclosureScope, DisclosureToolbar } from '@/components/ui/Disclosure';
import { DataList, DataRow, MetricStrip, Section } from '@/components/ui/Surface';
import { useAetherEngine, useKillSwitch, useProxyEngines, useVpnProviders, useVpnStatus } from './useVpnData';

import type { VpnSurfaceId } from './engineMeta';
import type { ReactNode } from 'react';
import type { ProxyEngineId, ProxyTunnelStatus } from '@netpulse/shared';

/**
 * VPN Overview — the dispatch surface.
 *
 * Read-only by design: each row reports what the backend currently observes and
 * opens the surface that can change it. Nothing here starts, stops or configures
 * a tunnel, so no control on this page can act on the wrong engine. The one
 * write is intake (paste a share link) — it adds a node or a profile, never a
 * tunnel.
 *
 * The rows are hairline-separated list items rather than eight separate cards:
 * one container, one border, and the engine state stays comparable down the
 * column instead of being spread across a grid of boxes.
 */

type Tone = 'ok' | 'warn' | 'neutral' | 'danger';

interface EngineRowData {
  surface: VpnSurfaceId;
  label: string;
  tagline: string;
  glyph: string;
  icon: ReactNode;
  tone: Tone;
  statusLabel: string;
  detail: string;
  /** live ring — reserved for the engine that currently owns a tunnel */
  live?: boolean;
}

/** The path each engine takes to the internet — the grouping the rail mirrors. */
const RELATIONSHIPS: Array<{ icon: ReactNode; title: string; body: string; aether?: boolean }> = [
  {
    icon: <Globe size={13} />,
    title: 'Circumvention binary',
    body: 'Aether runs its own binary. It scans for a route out of a filtered network and serves a local SOCKS5 proxy — no server config, no system routes.',
    aether: true,
  },
  {
    icon: <GitBranch size={13} />,
    title: 'Local cores → node tunnel',
    body: 'Xray, sing-box and V2Ray test public nodes and can carry the proxy tunnel. Two of them can be chained so the exit address differs from the entry edge.',
  },
  {
    icon: <ShieldCheck size={13} />,
    title: 'Native clients',
    body: 'WireGuard and OpenVPN drive the clients you installed. Only one tunnel runs at a time across all engines.',
  },
];

export function OverviewSurface({ onOpen }: { onOpen: (s: VpnSurfaceId) => void }) {
  const statusQuery = useVpnStatus();
  const enginesQuery = useProxyEngines();
  const providersQuery = useVpnProviders();
  const killSwitchQuery = useKillSwitch();
  const aetherQuery = useAetherEngine();
  const tunnelQuery = useQuery({
    queryKey: ['tunnel', 'status'],
    queryFn: () => api.get<{ tunnel: ProxyTunnelStatus }>('/vpn/tunnel/status'),
    refetchInterval: 5_000,
  });

  const status = statusQuery.data;
  const engines = enginesQuery.data?.engines ?? [];
  const preferred = enginesQuery.data?.preferred ?? 'auto';
  const effective = enginesQuery.data?.effective ?? null;
  const providers = providersQuery.data?.providers ?? [];
  const ks = killSwitchQuery.data?.killSwitch;
  const aether = aetherQuery.data;
  const tunnel = tunnelQuery.data?.tunnel;

  const core = (id: ProxyEngineId) => engines.find((e) => e.id === id);
  const provider = (id: string) => providers.find((p) => p.id === id);
  const installedCores = engines.filter((e) => e.available);
  const activeTunnel = status?.connected ? (status.providerId ?? 'a provider') : tunnel?.state === 'active' ? 'proxy tunnel' : null;

  const rows: EngineRowData[] = [
    {
      surface: 'aether',
      label: 'Aether',
      tagline: 'Circumvention tunnel',
      glyph: 'from-violet-500/30 to-cyan-400/10 text-violet-200',
      icon: <Globe size={16} />,
      tone: status?.providerId === 'aether' && status.connected ? 'ok' : aether?.installed ? 'neutral' : 'warn',
      statusLabel:
        status?.providerId === 'aether' && status.connected ? 'connected' : aether?.installed ? `v${aether.version ?? '?'}` : 'not installed',
      detail: aether?.installed ? aether.note : 'Install the engine to scan for a working route out of a filtered network.',
      live: status?.providerId === 'aether' && status.connected === true,
    },
    {
      surface: 'tunnel',
      label: 'Proxy Tunnel',
      tagline: 'Public nodes via local cores',
      glyph: 'from-cyan-500/25 to-sky-400/10 text-cyan-300',
      icon: <Route size={16} />,
      tone: tunnel?.state === 'active' ? 'ok' : tunnel?.state === 'down' ? 'danger' : installedCores.length === 0 ? 'warn' : 'neutral',
      statusLabel: tunnel?.state ?? 'idle',
      detail:
        tunnel?.state === 'active'
          ? `Exit ${tunnel.exitIp ?? 'unverified'}${tunnel.chain ? ' · nested chain' : ''}`
          : installedCores.length === 0
            ? 'No local core installed — install one on its tab to enable this path.'
            : `Ready — ${installedCores.length} core${installedCores.length === 1 ? '' : 's'} available${status?.connected ? ' · another tunnel is up' : ''}.`,
      live: tunnel?.state === 'active',
    },
    ...PROXY_CORE_IDS.map((id): EngineRowData => {
      const meta = PROXY_CORE_META[id];
      const info = core(id);
      const available = info?.available === true;
      return {
        surface: id,
        label: meta.label,
        tagline: meta.tagline,
        glyph: meta.glyph,
        icon: <Cpu size={16} />,
        tone: available ? (effective === id ? 'ok' : 'neutral') : 'warn',
        statusLabel: available ? (preferred === id ? 'preferred' : effective === id ? 'in use' : 'installed') : 'not installed',
        detail: available
          ? `${meta.protocols.length} protocols · ${meta.chainExit ? 'can be a chain exit hop' : 'cannot chain'}${info?.version ? ` · ${info.version}` : ''}`
          : 'Not on this machine — install it from its official release.',
      };
    }),
    ...(['wireguard', 'openvpn'] as const).map((id): EngineRowData => {
      const meta = MANAGED_PROVIDER_META[id];
      const info = provider(id);
      const available = info?.available === true;
      const connected = status?.providerId === id && status.connected === true;
      return {
        surface: id,
        label: meta.label,
        tagline: meta.tagline,
        glyph: meta.glyph,
        icon: id === 'wireguard' ? <Shield size={16} /> : <ShieldCheck size={16} />,
        tone: connected ? 'ok' : available ? 'neutral' : 'warn',
        statusLabel: connected ? 'connected' : available ? 'available' : 'not detected',
        detail: available ? (info?.capabilities.join(' · ') ?? 'detected on this machine') : `Install the native ${meta.label} client, then import a profile.`,
        live: connected,
      };
    }),
  ];

  return (
    <DisclosureScope name="vpn:overview" className="animate-fade-up">
      <MetricStrip
        className="mb-7"
        items={[
          {
            label: 'Active tunnel',
            value: activeTunnel ?? 'none',
            tone: activeTunnel ? 'ok' : 'faint',
            hint: tunnelExitHint({
              activeTunnel,
              verifiedPublicIp: status?.verifiedPublicIp,
              exitIp: tunnel?.exitIp,
            }),
          },
          {
            label: 'Kill switch',
            value: ks?.blocking ? 'ENGAGED' : ks?.enabled ? 'on' : 'off',
            tone: ks?.blocking ? 'danger' : ks?.enabled ? 'ok' : 'faint',
            hint: ks?.bypassSummary ? `exempt: ${ks.bypassSummary}` : 'fails closed when enabled',
          },
          {
            label: 'Local cores',
            value: `${installedCores.length}/3`,
            tone: installedCores.length > 0 ? 'default' : 'warn',
            hint: effective ? `${PROXY_CORE_META[effective].label} next up` : 'install one to test nodes',
          },
          {
            label: 'Node tunnel',
            value: tunnel?.state ?? 'idle',
            hint: tunnel?.chain ? `${tunnel.chain.hops.length}-hop chain` : 'single hop',
          },
        ]}
      />

      <DisclosureToolbar className="mb-2" />
      <Section
        variant="flat"
        collapsible
        pinned
        id="engines"
        defaultOpen
        summary={`${rows.filter((r) => r.live).length} running · ${rows.length} engines`}
        title="Engines"
        icon={<Activity size={15} />}
        subtitle="Live state read from the backend — open a row to control that engine"
      >
        <DataList className="rounded-xl border border-line bg-surface px-4">
          {rows.map((row) => (
            <DataRow
              key={row.surface}
              onClick={() => onOpen(row.surface)}
              leading={
                <span className={`flex h-9 w-9 items-center justify-center rounded-lg border border-line bg-gradient-to-br ${row.glyph}`}>
                  {row.icon}
                </span>
              }
              title={
                <>
                  <span className="text-sm font-medium text-text">{row.label}</span>
                  <Badge tone={row.tone}>{row.statusLabel}</Badge>
                  {row.live && <span className="h-1.5 w-1.5 rounded-full bg-ok animate-pulse-dot" aria-hidden />}
                </>
              }
              subtitle={row.tagline}
              meta={row.detail}
              actions={<ChevronRight size={15} className="text-faint" />}
            />
          ))}
        </DataList>
      </Section>

      {/* Intake lives on the first tab, not only on the sing-box tab: a config
          found anywhere should be usable without first knowing which engine
          will run it. Same card, same server-side counts. */}
      <EngineIntakeCard />

      {/* Administrator rights: the three features Windows gates behind an
          elevated token, what each one is doing right now, and the fix where
          the app can supply one. Cross-engine by nature, so it lives on the
          dispatch surface rather than inside any one engine tab. */}
      <Section
        variant="flat"
        collapsible
        id="admin"
        defaultOpen={false}
        summary="Elevation state for TUN capture, route changes and the system proxy"
        title="Administrator rights"
        subtitle="What this app can do that Windows only lets an administrator do"
      >
        <AdminAccessPanel />
      </Section>

      <Section
        variant="flat"
        collapsible
        id="relationships"
        defaultOpen={false}
        summary="Three ways this app can carry your traffic"
        title="How the pieces relate"
        subtitle="Which path each engine takes to the internet"
      >
        <div className="grid gap-y-4 sm:grid-cols-3 sm:gap-x-6">
          {RELATIONSHIPS.map((r, i) => (
            <div key={r.title} className={i > 0 ? 'sm:border-l sm:border-line sm:pl-6' : ''}>
              <p className={`flex items-center gap-1.5 text-sm ${r.aether ? 'text-violet-200' : 'text-text'}`}>
                {r.icon} {r.title}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted">{r.body}</p>
            </div>
          ))}
        </div>
      </Section>

      <div className="space-y-1.5 text-xs leading-relaxed text-faint">
        <p className="flex items-start gap-1.5">
          <Star size={12} className="mt-0.5 shrink-0" />
          &quot;Preferred&quot; is the saved core preference; &quot;in use&quot; is what the next node test will actually run on — the two differ
          whenever the preferred core is not installed.
        </p>
        <p className="flex items-start gap-1.5">
          <Zap size={12} className="mt-0.5 shrink-0" />
          Only one tunnel runs at a time across every engine, so connecting anywhere stops whatever was up before.
        </p>
      </div>
    </DisclosureScope>
  );
}
