import { useQuery } from '@tanstack/react-query';
import { MapPin, Network, Shield, ShieldOff, Wifi } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { StatusDot } from '@/components/ui/StatusDot';
import { api } from '@/lib/api';

import type { NetworkStatus } from '@shared/models/network';
import type { VpnStatus } from '@shared/models/vpn';

function Row({ label, value, mono = true }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-[13px] text-muted">{label}</span>
      <span className={`text-[13px] text-text ${mono ? 'metric-num' : ''} truncate`}>{value}</span>
    </div>
  );
}

export function ConnectionCard({ status }: { status: NetworkStatus | undefined }) {
  const ipv4 = status?.ipv4;
  const ipv6 = status?.ipv6;

  // live VPN state, same source as the VPN page
  const vpnQuery = useQuery({
    queryKey: ['vpn', 'status'],
    queryFn: () => api.get<VpnStatus>('/vpn/status'),
    refetchInterval: 6_000,
  });
  const vpn = vpnQuery.data;
  const vpnConnected = vpn?.connected === true;

  return (
    <Card>
      <CardHeader
        title="Connection"
        icon={<Wifi size={15} />}
        actions={
          <span className="flex items-center gap-2 text-xs text-muted">
            <StatusDot tone={status?.online ? 'ok' : status === undefined ? 'idle' : 'danger'} pulse={status?.online} />
            {status === undefined ? 'Checking…' : status.online ? 'Online' : 'Offline'}
          </span>
        }
      />
      <CardBody className="space-y-0.5">
        <Row
          label="Public IPv4"
          value={
            ipv4?.available ? (
              ipv4.ip ?? 'available'
            ) : (
              <span className="text-faint">unavailable</span>
            )
          }
        />
        <Row
          label="Public IPv6"
          value={
            ipv6?.available ? (
              <span className="inline-flex items-center gap-1.5">
                <Badge tone="ok">active</Badge>
                {ipv6.ip ? <span className="metric-num text-[12px]">{ipv6.ip}</span> : null}
              </span>
            ) : (
              <span className="text-faint">not available on this network</span>
            )
          }
        />
        <Row
          label="VPN"
          value={
            <span className="inline-flex items-center gap-1.5">
              {vpn === undefined ? (
                <span className="text-faint">checking…</span>
              ) : vpnConnected ? (
                <>
                  <StatusDot tone="ok" size={6} pulse />
                  <span>{vpn.serverName ?? 'Connected'}</span>
                  {vpn.verification === 'verified' && <Badge tone="ok">verified</Badge>}
                </>
              ) : (
                <>
                  <StatusDot tone={vpn?.supported ? 'idle' : 'offline'} size={6} />
                  Disconnected
                </>
              )}
            </span>
          }
        />
        <Row
          label="DNS status"
          value={<span className="text-faint">not measured yet</span>}
        />
      </CardBody>
      <div className="border-t border-line px-5 py-3 text-xs leading-relaxed text-muted">
        <div className="flex items-start gap-2">
          <MapPin size={13} className="mt-0.5 shrink-0 text-faint" />
          <span>
            Full ISP, ASN and geolocation detail is on the{' '}
            <a href="/ip" className="text-accent hover:underline">
              IP page
            </a>
            .
          </span>
        </div>
        <div className="mt-1.5 flex items-start gap-2">
          {vpnConnected ? <Shield size={13} className="mt-0.5 shrink-0 text-ok" /> : <ShieldOff size={13} className="mt-0.5 shrink-0 text-faint" />}
          <span>
            {vpnConnected ? (
              <>
                Tunnel via <span className="text-text">{vpn?.protocol ?? 'VPN'}</span> — manage it on the{' '}
                <a href="/vpn" className="text-accent hover:underline">VPN page</a>.
              </>
            ) : (
              <>
                No tunnel is up — import a profile on the{' '}
                <a href="/vpn" className="text-accent hover:underline">VPN page</a>.
              </>
            )}
          </span>
        </div>
        <div className="mt-1.5 flex items-start gap-2">
          <Network size={13} className="mt-0.5 shrink-0 text-faint" />
          <span>
            Route and hop detail lives on the{' '}
            <a href="/routes" className="text-accent hover:underline">Routes page</a>.
          </span>
        </div>
      </div>
    </Card>
  );
}

export function HealthBreakdown({ status }: { status: NetworkStatus | undefined }) {
  const components = status?.health.components ?? [];
  return (
    <Card
      fold={{
        id: 'health-components',
        defaultOpen: false,
        summary: `${components.filter((c) => c.measured).length} of ${components.length} components measured`,
      }}
    >
      <CardHeader title="Health components" subtitle="Only measured values contribute to the score" icon={<Shield size={15} />} />
      <CardBody>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
          {components.map((c) => (
            <div key={c.component} className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 text-[13px] text-muted">
                <StatusDot tone={c.measured ? 'ok' : 'idle'} size={6} />
                {c.label}
              </span>
              <span className={`metric-num text-[13px] ${c.measured ? 'text-text' : 'text-faint'}`}>
                {c.measured
                  ? c.component === 'connectivity'
                    ? c.value === 1
                      ? 'up'
                      : 'down'
                    : `${c.value ?? '—'}`
                  : '—'}
              </span>
            </div>
          ))}
        </div>
      </CardBody>
    </Card>
  );
}
