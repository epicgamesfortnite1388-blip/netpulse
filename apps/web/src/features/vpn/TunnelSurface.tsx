import { Route, TriangleAlert } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';

import { DiscoveryCard } from './DiscoveryCard';
import { PROXY_CORE_META } from './engineMeta';
import { ProxyTunnelCard } from './ProxyTunnelCard';
import { EngineGlyph, EngineHero, MetricStrip, Notice } from '@/components/ui/Surface';
import { VpnHistoryCard } from './VpnHistoryCard';
import { useProxyEngines } from './useVpnData';

/**
 * Proxy Tunnel — the public-node path.
 *
 * This is where the app routes this machine through a tested public node using a
 * local core. It is deliberately NOT filed under Aether or under one core:
 * Aether runs its own binary, while this path is served by whichever of
 * xray / sing-box / v2ray is installed, so it gets its own surface instead of
 * being duplicated into three tabs or hidden inside one.
 */
export function TunnelSurface() {
  const enginesQuery = useProxyEngines();
  const engines = enginesQuery.data?.engines ?? [];
  const installed = engines.filter((e) => e.available);
  const effective = enginesQuery.data?.effective ?? null;

  return (
    <div className="animate-fade-up">
      <EngineHero
        glyph={
          <EngineGlyph glyph="from-cyan-500/25 to-sky-400/10 text-cyan-300" size="lg">
            <Route size={24} />
          </EngineGlyph>
        }
        name="Proxy Tunnel"
        tagline="Route this machine through a tested public node"
        description="Starts a local core with the node's real secret from the vault, verifies traffic actually exits through it, then optionally hands the system proxy to 127.0.0.1 and restores the previous setting on stop. Nothing is reported active before a real exit IP is observed."
        badges={
          <>
            <Badge tone={installed.length > 0 ? 'ok' : 'warn'}>
              {installed.length === 0 ? 'no local core installed' : `${installed.length} core${installed.length === 1 ? '' : 's'} installed`}
            </Badge>
            {effective && <Badge tone="accent">{PROXY_CORE_META[effective].label} next</Badge>}
          </>
        }
      />

      <MetricStrip
        className="mb-5"
        items={[
          {
            label: 'Local cores',
            value: installed.length === 0 ? 'none' : installed.map((e) => PROXY_CORE_META[e.id].label).join(', '),
            tone: installed.length === 0 ? 'warn' : 'default',
            hint: 'install one from the core tabs',
          },
          {
            label: 'Engine next up',
            value: effective ? PROXY_CORE_META[effective].label : '—',
            hint: enginesQuery.data?.preferred === 'auto' ? 'chosen automatically' : 'from the saved preference',
          },
          { label: 'Bypass rules', value: 'tunnel only', hint: 'split-tunnel rules never apply to node tests' },
        ]}
      />

      {installed.length === 0 && (
        <Notice tone="warn" className="mb-5" icon={<TriangleAlert size={13} />}>
          No local proxy core is installed, so no node can be tested or tunnelled through. Open the Xray, sing-box or V2Ray tab and install one core
          — the whole path here depends on it.
        </Notice>
      )}

      <div className="space-y-7">
        <ProxyTunnelCard />
        <DiscoveryCard />
        <VpnHistoryCard />
      </div>
    </div>
  );
}
