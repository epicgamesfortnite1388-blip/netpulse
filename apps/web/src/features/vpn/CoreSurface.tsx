import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Cpu, ExternalLink, Network, Package, Search, Star, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { useToast } from '@/components/Toaster';
import { api } from '@/lib/api';

import { PROXY_CORE_META } from './engineMeta';
import { DisclosureScope, DisclosureToolbar } from '@/components/ui/Disclosure';
import { CapabilityMatrix, Chip, EngineGlyph, EngineHero, MetricStrip, Notice, Section } from '@/components/ui/Surface';
import { useProxyEngines } from './useVpnData';

import type { CapabilityRow } from '@/components/ui/Surface';
import type { ReactNode } from 'react';
import type { ProxyEngineId } from '@netpulse/shared';

/**
 * A dedicated surface for one local proxy core.
 *
 * These cores do two jobs in this app: they test public nodes (the "Runtime"
 * column / proxy-depth scans) and they carry the proxy tunnel. So the surface is
 * honest about all three things a user needs: is the binary here, which
 * protocols can it really dial (documented, mapped to `engineSupports`), and
 * which core the app will pick by default.
 */

/** Every protocol any of the three cores can dial, so the matrix is comparable. */
const ALL_PROTOCOLS = ['vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria2', 'tuic'] as const;

const PROTOCOL_NOTES: Partial<Record<(typeof ALL_PROTOCOLS)[number], string>> = {
  hysteria2: 'UDP-based',
  tuic: 'UDP-based',
  shadowsocks: 'AEAD ciphers only on the v2ray family',
};

export function CoreSurface({ engine, children }: { engine: ProxyEngineId; children?: ReactNode }) {
  const qc = useQueryClient();
  const toast = useToast();

  const meta = PROXY_CORE_META[engine];
  const enginesQuery = useProxyEngines();

  const info = enginesQuery.data?.engines.find((e) => e.id === engine);
  const available = info?.available === true;
  const preferred = enginesQuery.data?.preferred ?? 'auto';
  const effective = enginesQuery.data?.effective ?? null;
  const isPreferred = preferred === engine;

  const prefer = useMutation({
    mutationFn: (value: ProxyEngineId | 'auto') => api.put<unknown>('/settings', { proxyEngine: { preferred: value } }),
    onSuccess: (_data, value) => {
      void qc.invalidateQueries({ queryKey: ['settings'] });
      void qc.invalidateQueries({ queryKey: ['nodes', 'engines'] });
      toast('ok', value === engine ? `${meta.label} is now the preferred core` : 'Preference cleared — auto picks the best available core');
    },
    onError: (err) => toast('error', 'Could not save the preference', err instanceof Error ? err.message : undefined),
  });

  const factRows: CapabilityRow[] = [
    { label: 'Can be the exit hop of a nested-mode chain', state: meta.chainExit ? 'yes' : 'no', note: meta.chainExit ? undefined : 'ignores the dial-through wiring' },
    { label: 'Runs unprivileged (no elevation)', state: 'yes' },
    { label: 'Binary verified before first run', state: 'yes', note: 'release SHA256 + `version` self-check' },
  ];

  return (
    <DisclosureScope name={`vpn:core-${engine}`} className="animate-fade-up">
      <EngineHero
        glyph={
          <EngineGlyph glyph={meta.glyph} size="lg">
            <Cpu size={24} />
          </EngineGlyph>
        }
        name={meta.label}
        tagline={meta.tagline}
        description={meta.description}
        badges={
          <>
            <Badge tone={available ? 'ok' : 'warn'}>{available ? 'installed' : 'not installed'}</Badge>
            {isPreferred && (
              <Badge tone="accent">
                <Star size={11} /> preferred
              </Badge>
            )}
            {effective === engine && !isPreferred && <Badge tone="neutral">in use now</Badge>}
          </>
        }
        actions={
          <>
            <Link
              to="/engines"
              className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-line bg-transparent px-4 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-text"
              title={`${available ? 'Update' : 'Install'} ${meta.label} in Engine Manager — downloads, verification and replacement all happen there`}
            >
              <Package size={13} />
              {available ? 'Update in Engine Manager' : 'Install in Engine Manager'}
            </Link>
            <Button
              variant={isPreferred ? 'secondary' : 'primary'}
              onClick={() => prefer.mutate(isPreferred ? 'auto' : engine)}
              loading={prefer.isPending}
              disabled={!available && !isPreferred}
              title={available ? 'Use this core for node tests and the proxy tunnel' : 'Install the core first'}
            >
              <Star size={12} />
              {isPreferred ? 'Clear preference' : 'Prefer this core'}
            </Button>
          </>
        }
        footer={
          <p className="text-xs leading-relaxed text-faint">
            {info?.version ? <span className="metric-num text-muted">{info.version}</span> : 'Version not reported until the core is installed.'}{' '}
            {info?.path && <span className="break-all">{info.path}</span>}
          </p>
        }
      />

      <MetricStrip
        className="mb-7"
        items={[
          { label: 'Binary', value: available ? 'present' : 'missing', tone: available ? 'ok' : 'warn', hint: 'PATH or the app cores folder' },
          { label: 'Protocols', value: meta.protocols.length, hint: `of ${ALL_PROTOCOLS.length} recognised families` },
          {
            label: 'Preferred core',
            value: preferred === 'auto' ? 'auto' : PROXY_CORE_META[preferred].label,
            hint: effective ? `next test runs on ${PROXY_CORE_META[effective].label}` : 'no core installed',
          },
          { label: 'Upstream', value: meta.repo.split('/').slice(-1)[0] ?? meta.repo, hint: meta.repo },
        ]}
      />

      <DisclosureToolbar className="mb-2" />

      {/* ----------------------------- what it does ---------------------------- */}
      <Section
        variant="flat"
        collapsible
        pinned
        id="roles"
        defaultOpen
        badge={<Badge tone={available ? 'ok' : 'warn'}>{available ? 'installed' : 'missing binary'}</Badge>}
        summary="Two roles: test public nodes, and carry the proxy tunnel"
        title="What this core does here"
        icon={<Network size={15} />}
        subtitle="Both roles are real measurements — nothing is simulated by this surface"
      >
        <div className="grid gap-y-4 sm:grid-cols-2 sm:gap-x-6">
          <div>
            <p className="flex items-center gap-1.5 text-sm text-text">
              <Search size={13} className="text-accent" /> Node testing
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              Spawns this core with an ephemeral loopback inbound, dials the node, and measures a real proxied request. The core used for each
              result is recorded, so history rows can be attributed to it.
            </p>
            <Link to="/nodes" className="mt-2 inline-flex items-center gap-1 text-xs text-accent hover:underline">
              Open Node Explorer
              <ExternalLink size={11} />
            </Link>
          </div>
          <div className="sm:border-l sm:border-line sm:pl-6">
            <p className="flex items-center gap-1.5 text-sm text-text">
              <Network size={13} className="text-accent" /> Proxy tunnel
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              Keeps this core alive as a long-lived tunnel and, once a request proves traffic traverses the node, reports it active. Its exit IP is
              read from the node&apos;s own view of the world.
            </p>
            <Link to="/vpn" className="mt-2 inline-flex items-center gap-1 text-xs text-accent hover:underline">
              Open the Proxy Tunnel tab
              <ExternalLink size={11} />
            </Link>
          </div>
        </div>
      </Section>

      {/* --------------------------- protocol coverage ------------------------- */}
      <Section
        variant="flat"
        collapsible
        id="protocols"
        defaultOpen={false}
        summary={`${meta.protocols.length} of ${ALL_PROTOCOLS.length} protocol families · execution facts and known limits`}
        title="Protocol coverage"
        subtitle="Documented engine support — the picker will not offer a combination that only fails at startup"
      >
        <div className="flex flex-wrap gap-1.5">
          {ALL_PROTOCOLS.map((p) => {
            const supported = meta.protocols.includes(p);
            return (
              <Chip
                key={p}
                state={supported ? 'on' : 'off'}
                title={supported ? `${p} — supported, verified against the core's own config schema` : `${p} — not supported by this core`}
              >
                {supported ? '✓' : '·'} {p}
                {PROTOCOL_NOTES[p] && <span className="text-faint">· {PROTOCOL_NOTES[p]}</span>}
              </Chip>
            );
          })}
        </div>

        <div className="mt-5 grid gap-y-4 sm:grid-cols-2 sm:gap-x-6">
          <div>
            <p className="mb-2 text-micro font-semibold uppercase tracking-[0.14em] text-faint">Execution facts</p>
            <CapabilityMatrix rows={factRows} />
          </div>
          <div className="sm:border-l sm:border-line sm:pl-6">
            <p className="mb-2 text-micro font-semibold uppercase tracking-[0.14em] text-faint">Known limits</p>
            {meta.limits.length === 0 ? (
              <p className="text-xs text-muted">No documented limits for this core.</p>
            ) : (
              <ul className="space-y-1.5">
                {meta.limits.map((l) => (
                  <li key={l} className="text-xs leading-relaxed text-muted">
                    {l}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Section>

      {!available && (
        <Notice tone="warn" icon={<TriangleAlert size={13} />}>
          This core is not installed, so it cannot test nodes or carry the tunnel. Install it above — the binary is downloaded from the core&apos;s
          official release and must pass its own <code>version</code> self-check before it is used.
        </Notice>
      )}

      {children}
    </DisclosureScope>
  );
}
