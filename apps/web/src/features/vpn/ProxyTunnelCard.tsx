import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, RefreshCw, Route, StopCircle, Zap } from 'lucide-react';
import { useState } from 'react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/States';
import { useToast } from '@/components/Toaster';
import { api } from '@/lib/api';

/**
 * One-click proxy tunnel (Aether-style): route this machine through any
 * tested public node using the app's local cores. The backend refuses to
 * report `active` until an HTTPS trace has provably traversed the node, and
 * the exit IP shown here is read from that trace — never assumed.
 */

interface TunnelStatusDto {
  state: 'idle' | 'starting' | 'active' | 'down' | 'stopping';
  nodeId: string | null;
  engine: 'xray' | 'sing-box' | 'v2ray' | null;
  inboundPort: number | null;
  systemProxy: boolean;
  exitIp: string | null;
  exitCountry: string | null;
  verifiedAt: number | null;
  startedAt: number | null;
  error: string | null;
}

interface PickableNodeDto {
  id: string;
  host: string;
  port: number;
  protocol: string;
  country: string | null;
  city: string | null;
  remark: string | null;
  medianProxyMs: number | null;
  status: string;
}

const STATE_TONE: Record<TunnelStatusDto['state'], 'ok' | 'warn' | 'danger' | 'neutral'> = {
  idle: 'neutral',
  starting: 'warn',
  active: 'ok',
  down: 'danger',
  stopping: 'warn',
};

function nodeLabel(n: PickableNodeDto): string {
  const where = [n.city, n.country].filter(Boolean).join(', ');
  const ms = n.medianProxyMs != null ? `${n.medianProxyMs} ms` : null;
  return [n.remark || n.host, where, ms].filter(Boolean).join(' · ');
}

export function ProxyTunnelCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const [selectedNodeId, setSelectedNodeId] = useState<string>('');

  const statusQuery = useQuery({
    queryKey: ['tunnel', 'status'],
    queryFn: () => api.get<{ tunnel: TunnelStatusDto }>('/vpn/tunnel/status'),
    refetchInterval: (q) => {
      const s = q.state.data?.tunnel.state;
      // Poll faster while a transition is in flight; settle when idle/active.
      return s === 'starting' || s === 'stopping' || s === 'down' ? 1_500 : 5_000;
    },
  });

  const candidatesQuery = useQuery({
    queryKey: ['tunnel', 'candidates'],
    queryFn: () =>
      api.get<{ nodes: PickableNodeDto[] }>('/nodes?limit=40&sortField=proxyLatency&sortDir=asc&maxLatency=5000'),
    staleTime: 30_000,
  });

  const start = useMutation({
    mutationFn: (body: { nodeId?: string; auto?: boolean; systemProxy: boolean }) =>
      api.post<{ tunnel: TunnelStatusDto }>('/vpn/tunnel/start', body),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['tunnel'] });
      if (data.tunnel.state === 'active') {
        toast('ok', 'Tunnel verified', `Exit ${data.tunnel.exitIp ?? '?'}${data.tunnel.exitCountry ? ` (${data.tunnel.exitCountry})` : ''} via ${data.tunnel.engine}`);
      } else {
        toast('error', 'Tunnel failed', data.tunnel.error ?? 'The core started but traffic could not traverse the node.');
      }
    },
    onError: (err) => toast('error', 'Tunnel start failed', err instanceof Error ? err.message : undefined),
  });

  const stop = useMutation({
    mutationFn: () => api.post<{ tunnel: TunnelStatusDto }>('/vpn/tunnel/stop'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tunnel'] });
      toast('ok', 'Tunnel stopped', 'System proxy restored.');
    },
    onError: (err) => toast('error', 'Stop failed', err instanceof Error ? err.message : undefined),
  });

  const reconnect = useMutation({
    mutationFn: () => api.post<{ tunnel: TunnelStatusDto }>('/vpn/tunnel/reconnect'),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['tunnel'] });
      if (data.tunnel.state === 'active') toast('ok', 'Reconnected', `Exit ${data.tunnel.exitIp ?? '?'}`);
      else toast('error', 'Reconnect failed', data.tunnel.error ?? undefined);
    },
    onError: (err) => toast('error', 'Reconnect failed', err instanceof Error ? err.message : undefined),
  });

  const tunnel = statusQuery.data?.tunnel;
  const busy = start.isPending || stop.isPending || reconnect.isPending || tunnel?.state === 'starting' || tunnel?.state === 'stopping';
  const candidates = candidatesQuery.data?.nodes ?? [];
  const active = tunnel?.state === 'active';

  return (
    <Card className="mb-6">
      <CardHeader
        title="Proxy tunnel"
        icon={<Route size={15} />}
        subtitle="Route this machine through a tested public node via the local xray / sing-box / v2ray core — reported active only after a verified exit IP"
        actions={<Badge tone={STATE_TONE[tunnel?.state ?? 'idle']}>{tunnel?.state ?? 'idle'}</Badge>}
      />
      <CardBody>
        {tunnel && tunnel.state !== 'idle' && (
          <div className="mb-4 flex flex-wrap gap-x-8 gap-y-2 rounded-xl border border-line bg-surface-2 px-3 py-2.5 text-sm text-muted">
            <span>
              Node: <span className="text-text">{tunnel.nodeId ? (candidates.find((n) => n.id === tunnel.nodeId)?.remark || candidates.find((n) => n.id === tunnel.nodeId)?.host || tunnel.nodeId) : '—'}</span>
            </span>
            <span>
              Engine: <span className="text-text">{tunnel.engine ?? '—'}</span>
            </span>
            <span>
              Exit IP: <span className="text-text">{tunnel.exitIp ?? 'unverified'}</span>
              {tunnel.exitCountry ? <span className="text-faint"> ({tunnel.exitCountry})</span> : null}
            </span>
            <span>
              System proxy: <span className="text-text">{tunnel.systemProxy ? `on (127.0.0.1:${tunnel.inboundPort ?? '?'})` : 'off'}</span>
            </span>
            {tunnel.verifiedAt != null && (
              <span>
                Verified: <span className="text-text">{new Date(tunnel.verifiedAt).toLocaleTimeString()}</span>
              </span>
            )}
            {tunnel.error && <span className="w-full text-xs text-danger">{tunnel.error}</span>}
          </div>
        )}

        {active ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="danger" onClick={() => stop.mutate()} loading={stop.isPending}>
              <StopCircle size={13} />
              Stop tunnel
            </Button>
            <Button variant="ghost" onClick={() => reconnect.mutate()} loading={reconnect.isPending}>
              <RefreshCw size={12} />
              Reconnect
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
              <label className="block">
                <span className="mb-1 block text-[11px] uppercase tracking-wide text-faint">Node (tested-healthy first)</span>
                <select
                  className="h-9 w-full rounded-lg border border-line bg-surface-2 px-2 text-sm"
                  value={selectedNodeId}
                  onChange={(e) => setSelectedNodeId(e.target.value)}
                  disabled={busy}
                >
                  <option value="">— pick a tested node —</option>
                  {candidates.map((n) => (
                    <option key={n.id} value={n.id}>
                      {nodeLabel(n)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex items-end gap-2">
                <Button
                  variant="primary"
                  onClick={() =>
                    selectedNodeId
                      ? start.mutate({ nodeId: selectedNodeId, systemProxy: true })
                      : start.mutate({ auto: true, systemProxy: true })
                  }
                  loading={start.isPending}
                  disabled={busy}
                >
                  <Zap size={12} />
                  {selectedNodeId ? 'Start tunnel' : 'Auto-pick & start'}
                </Button>
                {tunnel?.state === 'down' && tunnel.nodeId && (
                  <Button variant="ghost" onClick={() => reconnect.mutate()} loading={reconnect.isPending}>
                    <RefreshCw size={12} />
                    Retry
                  </Button>
                )}
              </div>
            </div>
            <p className="flex items-start gap-1.5 text-xs leading-relaxed text-faint">
              <Globe size={12} className="mt-0.5 shrink-0" />
              Starts a local core with the node&apos;s real secret from the vault, verifies traffic actually exits
              through it, then hands the system proxy to 127.0.0.1 and restores the previous setting on stop.
              Auto-pick ranks by measured reliability, then latency.
            </p>
            {candidatesQuery.isLoading && <p className="text-xs text-faint">Loading tested nodes…</p>}
            {!candidatesQuery.isLoading && candidates.length === 0 && (
              <EmptyState
                icon={<Route size={16} />}
                title="No tested nodes yet"
                message="Run node tests in the Node Explorer first — only nodes with a recent successful proxy test can carry a tunnel."
              />
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
