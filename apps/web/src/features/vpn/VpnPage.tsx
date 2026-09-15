import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, KeyRound, Play, RefreshCw, Shield, ShieldCheck, ShieldOff, ShieldX, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { PageHeader } from '@/components/ui/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/States';
import { useToast } from '@/components/Toaster';
import { api } from '@/lib/api';
import { usePersistentState } from '@/lib/usePersistentState';
import { armElevationBridge } from '@/lib/elevationBroker';

import { ProxyTunnelCard } from './ProxyTunnelCard';

import type { VpnStatus } from '@shared/models/vpn';

interface VpnProviderInfoDto {
  id: string;
  name: string;
  kind: string;
  capabilities: string[];
  available: boolean;
  protocols?: string[];
}

interface ProfileDto {
  id: string;
  providerId: string;
  name: string;
  protocol: string;
  endpoint: string | null;
  createdAt: number;
}

interface HealthDto {
  connected: boolean;
  providerId?: string | null;
  serverName?: string | null;
  protocol?: string | null;
  endpoint?: string | null;
  since?: number | null;
  rxBytes: number | null;
  txBytes: number | null;
  handshakeAgeSec: number | null;
  endpointLatencyMs: number | null;
  note?: string;
}

interface ConnectionRow {
  id: string;
  providerId: string;
  serverName: string | null;
  endpoint: string | null;
  protocol: string;
  status: string;
  connectedAt: number | null;
  disconnectedAt: number | null;
  error: string | null;
}

const PROVIDER_HINTS: Record<string, string> = {
  wireguard: 'Paste the [Interface]/[Peer] .conf text. The PrivateKey is moved into the encrypted vault.',
  openvpn: 'Paste the .ovpn text (remote + <ca> block). Secrets stay in the encrypted vault.',
  singbox: 'Paste a share link: vless://, vmess://, trojan:// or ss:// — or a sing-box outbound JSON. Runs unprivileged in proxy mode (127.0.0.1:2080).',
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

function VerificationBadge({ status }: { status: VpnStatus }) {
  const v = status.verification ?? 'not_verified';
  if (!status.connected) return null;
  if (v === 'verified') {
    return (
      <Badge tone="ok">
        <ShieldCheck size={11} /> verified
      </Badge>
    );
  }
  if (v === 'failed') {
    return (
      <Badge tone="danger">
        <ShieldX size={11} /> not routing
      </Badge>
    );
  }
  if (v === 'unavailable') {
    return <Badge tone="warn">unverified (IP check unavailable)</Badge>;
  }
  return <Badge tone="neutral">unverified</Badge>;
}

export default function VpnPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const statusQuery = useQuery({
    queryKey: ['vpn', 'status'],
    queryFn: () => api.get<VpnStatus>('/vpn/status'),
    refetchInterval: 4_000,
  });
  const providersQuery = useQuery({
    queryKey: ['vpn', 'providers'],
    queryFn: () => api.get<{ providers: VpnProviderInfoDto[] }>('/vpn/providers'),
  });
  const profilesQuery = useQuery({
    queryKey: ['vpn', 'profiles'],
    queryFn: () => api.get<{ profiles: ProfileDto[] }>('/vpn/profiles'),
  });
  const healthQuery = useQuery({
    queryKey: ['vpn', 'health'],
    queryFn: () => api.get<HealthDto>('/vpn/health'),
    refetchInterval: 5_000,
    enabled: statusQuery.data?.connected === true,
  });
  const connectionsQuery = useQuery({
    queryKey: ['vpn', 'connections'],
    queryFn: () => api.get<{ connections: ConnectionRow[] }>('/vpn/connections?limit=12'),
    refetchInterval: 15_000,
  });

  const [showImport, setShowImport] = useState(false);
  // Provider choice persists; the pasted config deliberately does NOT — it
  // routinely contains private keys, and sessionStorage persists to the
  // webview profile directory on disk.
  const [importProvider, setImportProvider] = usePersistentState<string>('vpn.importProvider', 'wireguard');
  const [importName, setImportName] = useState('');
  const [configText, setConfigText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);

  const disconnect = useMutation({
    mutationFn: () => api.post<{ status: VpnStatus }>('/vpn/disconnect'),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['vpn'] }),
    onError: (err) => toast('error', 'Disconnect failed', err instanceof Error ? err.message : undefined),
  });

  const connect = useMutation({
    mutationFn: async (profileId: string) => {
      // Desktop: drive the ONE UAC prompt through the Rust bridge. The bridge
      // call runs in parallel with the connect request (which long-polls until
      // the backend receives the bridge's outcome).
      const arm = armElevationBridge();
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
        toast('warn', 'Tunnel up, but not routing', data.status.verificationNote ?? 'Public IP did not change.');
      } else {
        toast('ok', `Connected via ${data.status.protocol ?? 'VPN'}`, data.status.verificationNote ?? undefined);
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
      api.post<{ profile: ProfileDto }>('/vpn/profiles', {
        providerId: importProvider,
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

  const status = statusQuery.data;
  const connected = status?.connected ?? false;
  const profiles = profilesQuery.data?.profiles ?? [];
  const activeProfileId = status?.serverId ?? null;

  return (
    <div>
      <PageHeader
        title="VPN"
        description="Import profiles and control tunnels through the backend's provider layer. WireGuard and OpenVPN drive the installed native clients; sing-box runs VLESS/VMess/Trojan/Shadowsocks links in unprivileged proxy mode. Private key material never leaves the encrypted vault."
        actions={
          connected ? (
            <Button variant="danger" onClick={() => disconnect.mutate()} loading={disconnect.isPending}>
              Disconnect
            </Button>
          ) : null
        }
      />

      {statusQuery.isError && <ErrorState error={statusQuery.error} retry={() => void statusQuery.refetch()} />}
      {statusQuery.isLoading && <LoadingState label="Reading VPN state" />}

      <ProxyTunnelCard />

      {status && (
        <Card className={`mb-6 ${connected ? 'border-ok/40' : ''}`}>
          <CardHeader
            title="Connection status"
            icon={connected ? <Shield size={15} /> : <ShieldOff size={15} />}
            actions={
              <div className="flex items-center gap-2">
                <VerificationBadge status={status} />
                <Badge tone={connected ? 'ok' : 'neutral'}>{connected ? 'Connected' : 'Disconnected'}</Badge>
              </div>
            }
          />
          <CardBody>
            {connected ? (
              <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm text-muted">
                <span>Profile: <span className="text-text">{status.serverName ?? '—'}</span></span>
                <span>Protocol: <span className="text-text">{status.protocol ?? '—'}</span></span>
                {status.endpoint && <span>Endpoint: <span className="text-text">{status.endpoint}</span></span>}
                {status.since != null && <span>Since: <span className="text-text">{new Date(status.since).toLocaleTimeString()}</span></span>}
                {status.verifiedPublicIp && <span>Tunnel IP: <span className="text-text">{status.verifiedPublicIp}</span></span>}
                {status.killSwitchActive && <Badge tone="ok">kill switch active</Badge>}
              </div>
            ) : (
              <p className="text-sm leading-relaxed text-muted">
                {status.supported
                  ? 'No tunnel is currently up. Import a profile below and connect to it.'
                  : 'No VPN engine was detected on this machine. Install WireGuard, OpenVPN or sing-box, then import a profile — the backend drives the installed client, it never fakes a connection.'}
              </p>
            )}
            {status.verificationNote && (
              <p className={`mt-3 rounded-lg border px-3 py-2 text-xs leading-relaxed ${status.verification === 'failed' ? 'border-danger/40 bg-danger/10 text-danger' : 'border-line bg-surface-2 text-muted'}`}>
                {status.verificationNote}
              </p>
            )}
          </CardBody>
        </Card>
      )}

      {connected && healthQuery.data && (
        <Card className="mb-6">
          <CardHeader title="Tunnel health" icon={<RefreshCw size={15} />} subtitle="Live metrics reported by the active engine" />
          <CardBody>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div>
                <p className="text-[11px] uppercase tracking-wide text-faint">Received</p>
                <p className="metric-num text-lg text-text">{formatBytes(healthQuery.data.rxBytes)}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wide text-faint">Sent</p>
                <p className="metric-num text-lg text-text">{formatBytes(healthQuery.data.txBytes)}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wide text-faint">Handshake age</p>
                <p className="metric-num text-lg text-text">{healthQuery.data.handshakeAgeSec != null ? `${healthQuery.data.handshakeAgeSec}s` : '—'}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wide text-faint">Endpoint latency</p>
                <p className="metric-num text-lg text-text">{healthQuery.data.endpointLatencyMs != null ? `${healthQuery.data.endpointLatencyMs.toFixed(1)} ms` : '—'}</p>
              </div>
            </div>
          </CardBody>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Profiles"
            actions={
              <Button variant="ghost" onClick={() => setShowImport((v) => !v)}>
                <Download size={13} />
                Import
              </Button>
            }
          />
          <CardBody>
            {showImport && (
              <div className="mb-4 space-y-3 rounded-xl border border-line bg-surface-2 p-3">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Provider">
                    <select
                      className="h-9 w-full rounded-lg border border-line bg-surface-2 px-2 text-sm"
                      value={importProvider}
                      onChange={(e) => setImportProvider(e.target.value)}
                    >
                      {providersQuery.data?.providers
                        .filter((p) => p.capabilities.includes('import-config'))
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                            {p.protocols?.length ? ` (${p.protocols.join('/')})` : ''}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <Field label="Name">
                    <input
                      className="h-9 w-full rounded-lg border border-line bg-surface-2 px-3 text-sm"
                      value={importName}
                      onChange={(e) => setImportName(e.target.value)}
                      placeholder="My tunnel"
                    />
                  </Field>
                </div>
                <Field label="Configuration" hint={PROVIDER_HINTS[importProvider]}>
                  <textarea
                    className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-xs"
                    rows={6}
                    value={configText}
                    onChange={(e) => setConfigText(e.target.value)}
                    placeholder={importProvider === 'singbox' ? 'vless://…, vmess://…, trojan://… or ss://…' : ''}
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
              <LoadingState label="Loading profiles" />
            ) : profiles.length ? (
              <ul className="space-y-2">
                {profiles.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-text">{p.name}</p>
                      <p className="truncate text-xs text-faint">
                        {p.protocol} · {p.endpoint ?? 'endpoint hidden'}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {activeProfileId === p.id && connected ? (
                        <Button variant="ghost" onClick={() => reconnect.mutate(p.id)} loading={reconnect.isPending}>
                          <RefreshCw size={12} />
                          Reconnect
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          onClick={() => connect.mutate(p.id)}
                          loading={connect.isPending && connect.variables === p.id}
                          disabled={connected}
                        >
                          <Play size={12} />
                          Connect
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        onClick={() => {
                          if (window.confirm(`Delete profile "${p.name}"? Its stored secrets will also be removed.`)) {
                            removeProfile.mutate(p.id);
                          }
                        }}
                        loading={removeProfile.isPending && removeProfile.variables === p.id}
                        aria-label={`Delete profile ${p.name}`}
                      >
                        <Trash2 size={12} />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                icon={<KeyRound size={18} />}
                title="No profiles"
                message="Import a WireGuard, OpenVPN or sing-box configuration to get started."
              />
            )}
          </CardBody>
        </Card>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Engines" subtitle="Detected VPN clients on this machine" />
            <CardBody>
              {providersQuery.isLoading && <LoadingState label="Detecting providers" />}
              {providersQuery.data && (
                <ul className="space-y-2">
                  {providersQuery.data.providers.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2">
                      <div className="min-w-0">
                        <p className="text-sm text-text">{p.name}</p>
                        <p className="truncate text-xs text-faint">{p.protocols?.length ? p.protocols.join(' · ') : p.capabilities.join(' · ') || 'status only'}</p>
                      </div>
                      <Badge tone={p.available ? 'ok' : 'neutral'}>{p.available ? 'available' : 'not installed'}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Recent connections" />
            <CardBody>
              {connectionsQuery.data?.connections.length ? (
                <ul className="space-y-1.5">
                  {connectionsQuery.data.connections.map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-2 text-xs">
                      <span className="min-w-0 truncate text-muted">
                        {c.serverName ?? c.providerId} · {c.protocol}
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
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
