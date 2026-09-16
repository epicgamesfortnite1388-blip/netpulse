import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Globe, Play, RefreshCw, ShieldCheck, Square } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { useToast } from '@/components/Toaster';
import { api } from '@/lib/api';

import type { VpnStatus } from '@shared/models/vpn';

/**
 * The dedicated Aether profile card — a separate engine surface on the VPN
 * page. One profile is managed here (settings-based, no config to paste), the
 * binary is installed/updated from the official GitHub releases through the
 * backend's checksum-verified pipeline, and connect/disconnect drive the real
 * binary with the SOCKS5 port as ground truth.
 */

interface AetherEngineDto {
  installed: boolean;
  version: string | null;
  path: string | null;
  available: boolean;
  note: string;
}

interface AetherProfileDto {
  id: string;
  providerId: string;
  name: string;
  protocol: string;
  endpoint: string | null;
  createdAt: number;
}

interface KillSwitchDto {
  enabled: boolean;
  armed: boolean;
  blocking: boolean;
  bypassSummary: string | null;
  reason: string | null;
  note: string | null;
}

interface AetherSettings {
  protocol: 'masque' | 'wg' | 'gool' | 'mim';
  scanMode: 'turbo' | 'balanced' | 'thorough' | 'stealth' | 'ironclad';
  transport: 'h3' | 'h2';
  ipVersion: 'v4' | 'v6' | 'both';
  noize: 'default' | 'off' | 'light' | 'firewall' | 'balanced' | 'gfw' | 'aggressive';
  quickReconnect: boolean;
}

const PROTOCOLS: Array<{ value: AetherSettings['protocol']; label: string; hint: string }> = [
  { value: 'masque', label: 'MASQUE (HTTP/3)', hint: 'Disguises traffic as normal HTTPS over QUIC — the default' },
  { value: 'wg', label: 'WireGuard (WARP)', hint: 'Classic WireGuard — lighter and faster' },
  { value: 'gool', label: 'WARP-in-WARP (gool)', hint: 'Two nested WireGuard tunnels — extra security at a speed cost' },
  { value: 'mim', label: 'MASQUE-in-MASQUE', hint: 'Two nested MASQUE hops — changes the exit address' },
];

const SCAN_MODES: Array<{ value: AetherSettings['scanMode']; label: string }> = [
  { value: 'turbo', label: 'Turbo — first answer wins' },
  { value: 'balanced', label: 'Balanced — fastest of a few (default)' },
  { value: 'thorough', label: 'Thorough — sweep whole ranges' },
  { value: 'stealth', label: 'Stealth — few probes in flight' },
  { value: 'ironclad', label: 'Ironclad — real tunnel per candidate (slowest)' },
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

export function AetherCard() {
  const qc = useQueryClient();
  const toast = useToast();

  const engineQuery = useQuery({
    queryKey: ['vpn', 'aether', 'engine'],
    queryFn: () => api.get<AetherEngineDto>('/vpn/aether/engine'),
  });
  const profilesQuery = useQuery({
    queryKey: ['vpn', 'profiles'],
    queryFn: () => api.get<{ profiles: AetherProfileDto[] }>('/vpn/profiles'),
  });
  const statusQuery = useQuery({
    queryKey: ['vpn', 'status'],
    queryFn: () => api.get<VpnStatus>('/vpn/status'),
    refetchInterval: 4_000,
  });
  const killSwitchQuery = useQuery({
    queryKey: ['vpn', 'killswitch'],
    queryFn: () => api.get<{ killSwitch: KillSwitchDto }>('/vpn/killswitch'),
    refetchInterval: 5_000,
  });

  const profile = (profilesQuery.data?.profiles ?? []).find((p) => p.providerId === 'aether') ?? null;
  const status = statusQuery.data;
  const active = status?.connected === true && status.providerId === 'aether';

  const install = useMutation({
    mutationFn: () => api.post<{ ok: boolean; status: string; version: string | null; error: string | null; checksumVerified: boolean }>('/vpn/aether/engine/install'),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['vpn', 'aether'] });
      if (data.ok) {
        toast('ok', `Aether ${data.status} (v${data.version ?? '?'})`, data.checksumVerified ? 'SHA256 verified against the release digest.' : undefined);
      } else {
        toast('error', 'Aether install failed', data.error ?? undefined);
      }
    },
    onError: (err) => toast('error', 'Aether install failed', err instanceof Error ? err.message : undefined),
  });

  const createProfile = useMutation({
    mutationFn: (settings: AetherSettings) =>
      api.post<{ profile: AetherProfileDto }>('/vpn/profiles', {
        providerId: 'aether',
        name: `Aether (${settings.protocol}/${settings.scanMode})`,
        configText: JSON.stringify(settings),
      }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['vpn', 'profiles'] });
      toast('ok', `Profile "${data.profile.name}" ready`);
    },
    onError: (err) => toast('error', 'Profile creation failed', err instanceof Error ? err.message : undefined),
  });

  const connect = useMutation({
    mutationFn: (profileId: string) => api.post<{ status: VpnStatus }>('/vpn/connect', { profileId }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['vpn'] });
      if (data.status.verification === 'verified') {
        toast('ok', 'Aether tunnel verified', data.status.verificationNote ?? undefined);
      } else {
        toast('warn', 'Aether tunnel up (unverified exit)', data.status.verificationNote ?? undefined);
      }
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

  const engine = engineQuery.data;
  const ks = killSwitchQuery.data?.killSwitch;
  const installed = engine?.installed === true && engine.version != null;

  return (
    <Card className="mb-6">
      <CardHeader
        title="Aether"
        subtitle="Censorship-circumvention tunnel (MASQUE / WARP) served as a local SOCKS5 proxy"
        icon={<Globe size={15} />}
        actions={
          <div className="flex items-center gap-2">
            {engine && <Badge tone={installed ? 'ok' : 'warn'}>{installed ? `v${engine.version}` : 'not installed'}</Badge>}
            <Button variant="ghost" onClick={() => install.mutate()} loading={install.isPending} title="Download the verified binary from official GitHub releases">
              <Download size={12} />
              Install / Update
            </Button>
          </div>
        }
      />
      <CardBody>
        {engineQuery.isError && <p className="mb-3 text-xs text-danger">Engine status unavailable: {engineQuery.error instanceof Error ? engineQuery.error.message : 'unknown error'}</p>}
        {engine && !installed && <p className="mb-3 text-xs text-muted">{engine.note}</p>}

        {profile ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-line px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm text-text">{profile.name}</p>
              <p className="truncate text-xs text-faint">{profile.endpoint ?? 'aether SOCKS5'}</p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {active ? (
                <>
                  <Badge tone="ok">
                    <ShieldCheck size={11} /> tunnel up
                  </Badge>
                  {status?.verifiedPublicIp && <span className="text-xs text-faint">exit {status.verifiedPublicIp}</span>}
                  <Button variant="danger" onClick={() => disconnect.mutate()} loading={disconnect.isPending}>
                    <Square size={12} />
                    Disconnect
                  </Button>
                </>
              ) : (
                <Button variant="primary" onClick={() => connect.mutate(profile.id)} loading={connect.isPending} disabled={!installed || statusQuery.data?.connected === true}>
                  <Play size={12} />
                  Connect
                </Button>
              )}
              {!active && (
                <Button variant="ghost" onClick={() => connect.mutate(profile.id)} loading={false} disabled title="Reconnect runs while connected">
                  <RefreshCw size={12} />
                </Button>
              )}
            </div>
          </div>
        ) : (
          <AetherProfileCreator onCreate={(s) => createProfile.mutate(s)} creating={createProfile.isPending} disabled={!installed} />
        )}

        {status?.providerId === 'aether' && status.verificationNote && (
          <p className={`mt-3 rounded-lg border px-3 py-2 text-xs leading-relaxed ${status.verification === 'failed' ? 'border-danger/40 bg-danger/10 text-danger' : 'border-line bg-surface-2 text-muted'}`}>
            {status.verificationNote}
          </p>
        )}

        {/* Kill switch: the live enforcement state, not the preference. */}
        {ks && ks.enabled && (
          <div
            className={`mt-3 rounded-lg border px-3 py-2 text-xs leading-relaxed ${
              ks.blocking ? 'border-danger/50 bg-danger/10 text-danger' : 'border-line bg-surface-2 text-muted'
            }`}
          >
            <span className="mr-2 font-medium text-text">
              {ks.blocking ? 'Kill switch ENGAGED' : ks.armed ? 'Kill switch armed' : 'Kill switch on'}
            </span>
            {ks.reason && ks.blocking ? `(${ks.reason}) ` : ''}
            {ks.note}
            {ks.blocking && (
              <div className="mt-2">
                <Button variant="danger" onClick={() => disconnect.mutate()} loading={disconnect.isPending}>
                  <Square size={11} />
                  Release kill switch
                </Button>
              </div>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function AetherProfileCreator(props: { onCreate: (s: AetherSettings) => void; creating: boolean; disabled: boolean }) {
  const [settings, setSettings] = useState<AetherSettings>({
    protocol: 'masque',
    scanMode: 'balanced',
    transport: 'h3',
    ipVersion: 'v4',
    noize: 'default',
    quickReconnect: true,
  });

  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-muted">
        One Aether profile holds its tunnel settings. Aether scans for a working route out of a filtered network and serves it on{' '}
        <code className="text-text">socks5://127.0.0.1:1819</code> — no server config to paste.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Protocol">
          <select
            className="h-9 w-full rounded-lg border border-line bg-surface-2 px-2 text-sm"
            value={settings.protocol}
            onChange={(e) => setSettings((s) => ({ ...s, protocol: e.target.value as AetherSettings['protocol'] }))}
          >
            {PROTOCOLS.map((p) => (
              <option key={p.value} value={p.value} title={p.hint}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Scan mode" hint="Trades route-discovery speed against how much probe traffic is generated">
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
        <Field label="Obfuscation">
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
      <Button variant="primary" onClick={() => props.onCreate(settings)} loading={props.creating} disabled={props.disabled}>
        Create profile
      </Button>
      {props.disabled && <p className="text-xs text-faint">Install Aether first — the binary comes checksum-verified from the official releases.</p>}
    </div>
  );
}
