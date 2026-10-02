import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, KeyRound, Play, Plus, RefreshCw, ShieldCheck, ShieldOff, Square, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { EmptyState } from '@/components/ui/States';
import { useToast } from '@/components/Toaster';
import { api } from '@/lib/api';
import { armElevationBridge } from '@/lib/elevationBroker';
import { usePersistentState } from '@/lib/usePersistentState';

import { DisclosureScope, DisclosureToolbar } from '@/components/ui/Disclosure';
import { MANAGED_PROVIDER_META } from './engineMeta';
import { CapabilityMatrix, EngineGlyph, EngineHero, FieldPill, Section, StatTile } from '@/components/ui/Surface';
import { providerIsActive, useKillSwitch, useVpnConnections, useVpnHealth, useVpnProfiles, useVpnProviders, useVpnStatus } from './useVpnData';

import type { CapabilityRow } from '@/components/ui/Surface';
import type { ManagedProviderId } from './engineMeta';
import type { VpnStatus } from '@netpulse/shared';

/**
 * A dedicated surface for a config-driven tunnel provider.
 *
 * WireGuard, OpenVPN and the sing-box proxy-mode tunnel differ only in what you
 * paste and how the binary is obtained, so they share one layout: identity →
 * live status → connect controls → profiles → health → kill switch → history.
 * Provider differences (elevation, protocol list, import hint) come from
 * `MANAGED_PROVIDER_META` and the live `/vpn/providers` payload.
 */

const IMPORT_HINTS: Record<ManagedProviderId, string> = {
  wireguard: 'Paste the [Interface]/[Peer] .conf text. The PrivateKey is moved into the encrypted vault.',
  openvpn: 'Paste the .ovpn text (remote + <ca> block). Secrets stay in the encrypted vault.',
  singbox: 'Paste a share link: vless://, vmess://, trojan:// or ss:// — or a sing-box outbound JSON. Runs unprivileged in proxy mode (127.0.0.1:2080).',
  aether: 'Aether profiles are created on the Aether surface with a settings form — there is no config to paste.',
};

function formatBytes(n: number | null): string {
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

export function ProviderSurface({ providerId }: { providerId: ManagedProviderId }) {
  const qc = useQueryClient();
  const toast = useToast();
  const meta = MANAGED_PROVIDER_META[providerId];

  const statusQuery = useVpnStatus();
  const providersQuery = useVpnProviders();
  const profilesQuery = useVpnProfiles();
  const killSwitchQuery = useKillSwitch();

  const status = statusQuery.data;
  const provider = providersQuery.data?.providers.find((p) => p.id === providerId);
  const active = providerIsActive(status, providerId);
  const profiles = (profilesQuery.data?.profiles ?? []).filter((p) => p.providerId === providerId);
  const activeProfileId = status?.serverId ?? null;

  const healthQuery = useVpnHealth(active);
  const connectionsQuery = useVpnConnections(12);
  const providerConnections = (connectionsQuery.data?.connections ?? []).filter((c) => c.providerId === providerId);

  // Whether the import box is open is UI state, so it persists per engine: a
  // user part-way through fixing one provider should not lose the form by
  // switching tabs, and another surface (the Dashboard's "needs attention"
  // strip) deep-links here by pre-setting this key. The pasted config itself
  // stays in plain useState on purpose — stale credential text must never be
  // one click away from being re-imported.
  const [showImport, setShowImport] = usePersistentState<boolean>(`vpn.import.${providerId}`, false);
  const [importName, setImportName] = useState('');
  const [configText, setConfigText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);

  const connect = useMutation({
    mutationFn: async (profileId: string) => {
      // Only WireGuard is wired to the elevation broker. Passing an elevation
      // opId for any other provider would be rejected as unsupported, so the
      // desktop UAC flow is armed for WireGuard alone.
      const arm = providerId === 'wireguard' ? armElevationBridge() : null;
      if (arm) {
        const bridgePromise = arm.run();
        const res = await api.post<{ status: VpnStatus; outcome?: string }>('/vpn/connect', {
          profileId,
          elevation: { opId: arm.opId },
        });
        void bridgePromise.catch(() => undefined);
        return res;
      }
      return api.post<{ status: VpnStatus; outcome?: string }>('/vpn/connect', { profileId });
    },
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['vpn'] });
      if (data.status.verification === 'failed') {
        toast('warn', 'Tunnel up, but not routing', data.status.verificationNote ?? 'The public IP did not change.');
      } else {
        toast('ok', `Connected via ${data.status.protocol ?? meta.label}`, data.status.verificationNote ?? undefined);
      }
    },
    onError: (err) => {
      void qc.invalidateQueries({ queryKey: ['vpn'] });
      const code = err instanceof Error && 'code' in err ? String((err as { code?: unknown }).code) : '';
      const message = err instanceof Error ? err.message : String(err);
      if (code === 'elevation_declined') {
        toast('warn', 'Tunnel not installed', 'The elevation prompt was declined. Press Connect again and accept the Windows prompt.');
      } else if (code === 'elevation_failed' || code === 'tunnel_not_up' || code === 'elevation_required') {
        toast('error', 'Elevated connect failed', message);
      } else {
        toast('error', 'Connect failed', message);
      }
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

  const removeProfile = useMutation({
    mutationFn: (profileId: string) => api.delete<{ ok: boolean }>(`/vpn/profiles/${profileId}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['vpn', 'profiles'] });
      toast('ok', 'Profile deleted');
    },
    onError: (err) => toast('error', 'Delete failed', err instanceof Error ? err.message : undefined),
  });

  const importProfile = useMutation({
    mutationFn: () =>
      api.post<{ profile: { id: string; name: string } }>('/vpn/profiles', {
        providerId,
        name: importName || 'Imported profile',
        configText,
      }),
    onSuccess: (data) => {
      setConfigText('');
      setImportName('');
      setShowImport(false);
      setImportError(null);
      void qc.invalidateQueries({ queryKey: ['vpn', 'profiles'] });
      toast('ok', `Profile "${data.profile.name}" imported`);
    },
    onError: (err) => setImportError(err instanceof Error ? err.message : 'Import failed'),
  });

  const ks = killSwitchQuery.data?.killSwitch;
  const available = provider?.available === true;
  const proxyMode = provider?.capabilities.includes('proxy-mode') === true;
  const noneUp = status?.connected !== true;

  const capabilityRows: CapabilityRow[] = [
    { label: 'Import a configuration profile', state: provider?.capabilities.includes('import-config') ? 'yes' : 'no' },
    { label: 'Connect / disconnect', state: provider?.capabilities.includes('connect') ? 'yes' : 'no' },
    { label: 'Proxy mode (no system routes)', state: proxyMode ? 'yes' : 'no' },
    { label: 'Kill switch applies while it carries the tunnel', state: 'yes' },
    { label: 'Requires the OS client / a bundled core', state: available ? 'yes' : 'unknown', note: available ? 'detected on this machine' : 'not detected yet' },
  ];

  return (
    <DisclosureScope name={`vpn:${providerId}`} className="animate-fade-up">
      <EngineHero
        glyph={
          <EngineGlyph glyph={meta.glyph} size="lg">
            <ShieldCheck size={24} />
          </EngineGlyph>
        }
        name={meta.label}
        tagline={meta.tagline}
        description={meta.binaryNote}
        badges={
          <>
            <Badge tone={available ? 'ok' : 'neutral'}>{available ? 'available' : 'not detected'}</Badge>
            <Badge tone={active ? 'ok' : 'neutral'}>{active ? 'connected' : 'disconnected'}</Badge>
            {ks?.blocking && <Badge tone="danger">kill switch engaged</Badge>}
          </>
        }
        actions={
          active ? (
            <>
              <Button variant="danger" onClick={() => disconnect.mutate()} loading={disconnect.isPending}>
                <Square size={12} />
                Disconnect
              </Button>
              {activeProfileId && (
                <Button variant="ghost" onClick={() => reconnect.mutate(activeProfileId)} loading={reconnect.isPending}>
                  <RefreshCw size={12} />
                  Reconnect
                </Button>
              )}
            </>
          ) : profiles[0] ? (
            <Button variant="primary" onClick={() => connect.mutate(profiles[0]!.id)} loading={connect.isPending} disabled={!available || !noneUp}>
              <Play size={12} />
              Connect
            </Button>
          ) : (
            <Button variant="primary" onClick={() => setShowImport(true)} disabled={!available}>
              <Download size={13} />
              Import a profile
            </Button>
          )
        }
        footer={
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
            <FieldPill label="Capabilities" value={provider?.capabilities.join(' · ') ?? 'unknown'} />
            {provider?.protocols?.length ? <FieldPill label="Protocols" value={provider.protocols.join(' · ')} /> : null}
          </div>
        }
      />

      {!available && (
        <p className="mb-5 rounded-r-lg border-l-2 border-warn/60 bg-warn/5 px-3.5 py-2.5 text-xs leading-relaxed text-warn">
          {providerId === 'singbox'
            ? 'The managed sing-box tunnel is powered by the app-managed core binary. Install the core on the sing-box tab, then reopen this surface.'
            : `${meta.label} was not detected on this machine. Install the native client, then reopen this surface — the app drives the installed client and never fakes a connection.`}
        </p>
      )}

      {active && (
        <>
          <div className="mb-5 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Received" value={formatBytes(healthQuery.data?.rxBytes ?? status?.rxBytes ?? null)} hint="reported by the engine" />
            <StatTile label="Sent" value={formatBytes(healthQuery.data?.txBytes ?? status?.txBytes ?? null)} hint="reported by the engine" />
            <StatTile
              label="Handshake age"
              value={(healthQuery.data?.handshakeAgeSec ?? status?.handshakeAgeSec) != null ? `${healthQuery.data?.handshakeAgeSec ?? status?.handshakeAgeSec}s` : '—'}
              hint="seconds since the last successful handshake"
            />
            <StatTile
              label="Endpoint latency"
              value={
                (healthQuery.data?.endpointLatencyMs ?? status?.endpointLatencyMs) != null
                  ? `${(healthQuery.data?.endpointLatencyMs ?? status?.endpointLatencyMs)!.toFixed(1)} ms`
                  : '—'
              }
              hint="live measurement to the current endpoint"
            />
          </div>
          {status?.verificationNote && (
            <p
              className={`mb-5 rounded-r-lg border-l-2 px-3.5 py-2.5 text-xs leading-relaxed ${
                status.verification === 'failed' ? 'border-danger/60 bg-danger/5 text-danger' : 'border-accent/50 bg-accent-soft/50 text-muted'
              }`}
            >
              {status.verificationNote}
            </p>
          )}
        </>
      )}

      <DisclosureToolbar className="mb-2" />
      <Section
        collapsible
        pinned
        id="profiles"
        defaultOpen
        badge={<Badge tone={active ? 'ok' : profiles.length > 0 ? 'neutral' : 'warn'}>{active ? '1 active' : profiles.length > 0 ? `${profiles.length} saved` : 'none yet'}</Badge>}
        summary={profiles.length > 0 ? `${profiles.length} profile(s), secrets in the encrypted vault` : 'No profiles imported yet'}
        title="Profiles"
        icon={<KeyRound size={15} />}
        subtitle="Secrets are held in the encrypted vault — the endpoint shown here is a display summary only"
        actions={
          <Button variant="ghost" onClick={() => setShowImport((v) => !v)} disabled={!available || !provider?.capabilities.includes('import-config')}>
            <Plus size={12} />
            {showImport ? 'Close' : 'Import'}
          </Button>
        }
      >
        {showImport && (
          <div className="mb-4 space-y-3 rounded-lg bg-surface-2/70 p-3.5">
            <Field label="Name">
              <input
                className="h-9 w-full rounded-lg border border-line bg-surface-2 px-3 text-sm"
                value={importName}
                onChange={(e) => setImportName(e.target.value)}
                placeholder={`My ${meta.label} tunnel`}
              />
            </Field>
            <Field label="Configuration" hint={IMPORT_HINTS[providerId]}>
              <textarea
                className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-xs"
                rows={6}
                value={configText}
                onChange={(e) => setConfigText(e.target.value)}
                placeholder={providerId === 'singbox' ? 'vless://…, vmess://…, trojan://… or ss://…' : ''}
              />
            </Field>
            {importError && <p className="text-xs text-danger">{importError}</p>}
            <Button
              variant="primary"
              onClick={() => importProfile.mutate()}
              loading={importProfile.isPending}
              disabled={configText.trim().length === 0}
            >
              Import profile
            </Button>
          </div>
        )}

        {profilesQuery.isLoading ? (
          <p className="text-xs text-faint">Loading profiles…</p>
        ) : profiles.length > 0 ? (
          <ul className="space-y-2">
            {profiles.map((p) => {
              const isActive = active && activeProfileId === p.id;
              return (
                <li
                  key={p.id}
                  className={`flex flex-wrap items-center justify-between gap-3 rounded-lg px-3.5 py-2.5 ${
                    isActive ? 'bg-ok/5' : 'bg-surface-2/70'
                  }`}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-text">{p.name}</p>
                    <p className="truncate text-xs text-faint">
                      {p.protocol} · {p.endpoint ?? 'endpoint hidden'}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Badge tone={isActive ? 'ok' : 'neutral'}>{isActive ? 'active' : 'idle'}</Badge>
                    {isActive ? (
                      <Button variant="ghost" onClick={() => reconnect.mutate(p.id)} loading={reconnect.isPending}>
                        <RefreshCw size={12} />
                        Reconnect
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        onClick={() => connect.mutate(p.id)}
                        loading={connect.isPending && connect.variables === p.id}
                        disabled={!available || !noneUp}
                      >
                        <Play size={12} />
                        Connect
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      aria-label={`Delete profile ${p.name}`}
                      onClick={() => {
                        if (window.confirm(`Delete profile "${p.name}"? Its stored secrets will also be removed.`)) {
                          removeProfile.mutate(p.id);
                        }
                      }}
                      loading={removeProfile.isPending && removeProfile.variables === p.id}
                    >
                      <Trash2 size={12} />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState
            icon={<KeyRound size={18} />}
            title="No profiles"
            message={`Import a ${meta.label} configuration to get started — nothing is connected until you press Connect.`}
          />
        )}
      </Section>

      <div className="grid gap-5 lg:grid-cols-2">
        <Section
          collapsible
          id="capabilities"
          defaultOpen={false}
          summary={`${capabilityRows.filter((r) => r.state === 'yes').length} of ${capabilityRows.length} documented capabilities supported`}
          title="Capabilities"
          subtitle="Documented provider capabilities from the live provider registry"
        >
          <CapabilityMatrix rows={capabilityRows} />
          {meta.facts.length > 0 && (
            <div className="mt-3 space-y-1">
              {meta.facts.map((f) => (
                <p key={f} className="text-xs leading-relaxed text-faint">
                  · {f}
                </p>
              ))}
            </div>
          )}
        </Section>

        <Section
          collapsible
          id="kill-switch"
          defaultOpen={false}
          badge={<Badge tone={ks?.blocking ? 'danger' : ks?.armed ? 'warn' : ks?.enabled ? 'ok' : 'neutral'}>{ks?.blocking ? 'engaged' : ks?.armed ? 'armed' : ks?.enabled ? 'on' : 'off'}</Badge>}
          summary={ks?.blocking ? 'Traffic is being blocked right now' : 'Nothing is blocked right now'}
          title="Kill switch"
          icon={ks?.blocking ? <ShieldOff size={15} /> : <ShieldCheck size={15} />}
          subtitle="Live enforcement state — not the preference"
        >
          {ks ? (
            <div
              className={`rounded-lg px-3.5 py-3 text-xs leading-relaxed ${
                ks.blocking ? 'bg-danger/10 text-danger' : ks.enabled ? 'bg-ok/5 text-muted' : 'bg-surface-2/70 text-muted'
              }`}
            >
              <p className="text-sm font-medium text-text">
                {ks.blocking ? 'ENGAGED — traffic is being blocked' : ks.armed ? 'Armed' : ks.enabled ? 'On (idle)' : 'Off'}
              </p>
              {ks.reason && ks.blocking && <p className="mt-1">Reason: {ks.reason}</p>}
              {ks.note && <p className="mt-1">{ks.note}</p>}
              {ks.bypassSummary && <p className="mt-1 text-faint">Exempt from the block: {ks.bypassSummary}</p>}
              {ks.blocking && (
                <div className="mt-2.5">
                  <Button variant="danger" onClick={() => disconnect.mutate()} loading={disconnect.isPending}>
                    <Square size={11} />
                    Release kill switch
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-faint">Kill-switch state unavailable.</p>
          )}
        </Section>
      </div>

      <Section
        collapsible
        id="history"
        defaultOpen={false}
        summary={providerConnections.length > 0 ? `${providerConnections.length} recorded session(s)` : 'Nothing recorded yet'}
        title="Recent connections"
        subtitle={`Sessions recorded for ${meta.label}`}
      >
        {providerConnections.length > 0 ? (
          <ul className="space-y-1.5">
            {providerConnections.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate text-muted">
                  {c.serverName ?? c.providerId} · {c.protocol}
                  {c.endpoint ? <span className="text-faint"> · {c.endpoint}</span> : null}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <Badge tone={c.status === 'connected' ? 'ok' : c.status === 'error' ? 'danger' : 'neutral'}>{c.status}</Badge>
                  <span className="text-faint">{c.connectedAt ? new Date(c.connectedAt).toLocaleString() : '—'}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No connection history" message="Connect a tunnel to see session records here." />
        )}
      </Section>
    </DisclosureScope>
  );
}
