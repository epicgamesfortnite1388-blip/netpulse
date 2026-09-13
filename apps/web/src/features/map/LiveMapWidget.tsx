import { useQuery } from '@tanstack/react-query';
import { Expand, Globe, MapPin, Shield } from 'lucide-react';
import { useNavigate } from 'react-router';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';

import type { MapLocalInfo, MapObservation } from '@netpulse/shared';

export function LiveMapWidget() {
  const navigate = useNavigate();
  const localQuery = useQuery({
    queryKey: ['map', 'local', 'widget'],
    queryFn: () => api.get<MapLocalInfo>('/map/local'),
    refetchInterval: 20_000,
  });
  const obsQuery = useQuery({
    queryKey: ['map', 'observations', 'widget'],
    queryFn: () => api.get<{ observations: MapObservation[]; total: number }>('/map/observations?limit=6'),
    refetchInterval: 20_000,
  });

  const local = localQuery.data;
  const obs = obsQuery.data?.observations ?? [];
  const latency = (o: MapObservation) => o.measurements.find((m) => m.method === 'tcp' || m.method === 'dns')?.latencyMs ?? null;

  return (
    <Card>
      <CardHeader
        title="Live map"
        subtitle="Where your traffic is going right now"
        icon={<Globe size={15} className="text-accent" />}
        actions={
          <Button variant="primary" size="sm" onClick={() => navigate('/map')}>
            <Expand size={13} />
            Open live map
          </Button>
        }
      />
      <CardBody>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted">
          <span className="flex items-center gap-1.5">
            <MapPin size={12} className="text-accent" />
            {local?.city ? `${local.city}${local.countryCode ? ` (${local.countryCode})` : ''}` : 'approximate location'}
          </span>
          <span className="flex items-center gap-1.5">
            <Shield size={12} className={local?.vpn.connected ? 'text-warn' : 'text-faint'} />
            VPN {local?.vpn.connected ? 'connected' : 'disconnected'}
          </span>
          {obs.length > 0 && (
            <Badge tone="accent">
              {obs.length} measured {obs.length === 1 ? 'target' : 'targets'}
            </Badge>
          )}
        </div>
        {obs.length > 0 ? (
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {obs.slice(0, 6).map((o) => {
              const ms = latency(o);
              return (
                <button
                  key={o.id}
                  className="rounded-lg border border-line/50 bg-surface-2/40 px-3 py-2 text-left hover:border-accent/40"
                  onClick={() => navigate(`/map?target=${encodeURIComponent(o.target.id)}`)}
                >
                  <div className="truncate text-[12px] text-muted">{o.target.name}</div>
                  <div className={`mt-0.5 font-mono text-sm ${ms != null ? 'text-text' : 'text-faint'}`}>{ms != null ? `${Math.round(ms)} ms` : o.statusLabel}</div>
                  <div className="text-[10px] text-faint">{timeAgo(o.createdAt)}</div>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="mt-3 text-xs text-faint">No measurements yet — open the live map and measure a target.</p>
        )}
        <p className="mt-3 text-[10px] text-faint">Latency values are the latest measured medians per target (method and port are shown in the map inspector).</p>
      </CardBody>
    </Card>
  );
}