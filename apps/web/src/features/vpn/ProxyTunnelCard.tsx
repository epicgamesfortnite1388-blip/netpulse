import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranch, Globe, History, ListChecks, RefreshCw, Route, ShieldOff, StopCircle, Zap } from 'lucide-react';
import { useRef, useState } from 'react';

import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/States';
import { useToast } from '@/components/Toaster';
import { api } from '@/lib/api';

import { readPersistedState } from '@/lib/usePersistentState';

import type { GatewayMemoryEntry, ProxyTunnelStatus, QuickConnectResult, ScanProfileId } from '@netpulse/shared';

/**
 * One-click proxy tunnel (Aether-style): route this machine through any
 * tested public node using the app's local cores.
 *
 * Three things here are deliberate:
 *   - "Quick connect" retries the gateways this app has already PROVEN before
 *     scanning anything new. Memory only decides what to try first; every
 *     attempt is a real tunnel start, so the result is never a memory claim.
 *   - The status strip shows how much of the reconnect budget has been spent,
 *     so a dropped core reads as "reconnecting (2 of 3)" rather than a lie.
 *   - NESTED mode chains two local cores (entry → exit). Both hops' observed
 *     addresses are shown, together with the honest verdict on whether the exit
 *     differs from the entry edge — including when it does not.
 */

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

const STATE_TONE: Record<ProxyTunnelStatus['state'], 'ok' | 'warn' | 'danger' | 'neutral'> = {
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

function gatewayLabel(g: GatewayMemoryEntry): string {
  const where = [g.name || g.host, g.exitCountry ? `exit ${g.exitCountry}` : null].filter(Boolean).join(' · ');
  const state = g.successStreak > 0 ? `${g.successStreak}× proven` : 'last attempt failed';
  return `${where} — ${state}`;
}

export function ProxyTunnelCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const [selectedNodeId, setSelectedNodeId] = useState<string>('');
  /** NESTED mode: chain an entry hop and an exit hop so the exit differs from the edge. */
  const [nested, setNested] = useState(false);
  const [entryNodeId, setEntryNodeId] = useState<string>('');
  const [exitNodeId, setExitNodeId] = useState<string>('');
  /** Outcome of the last quick connect — every attempt it made, kept visible. */
  const [quickResult, setQuickResult] = useState<QuickConnectResult | null>(null);
  /**
   * Single-flight latch. Quick connect runs a discovery scan internally, so a
   * double click would otherwise start two chains and two probe pools. The
   * disabled button is the normal guard; this closes the pre-render gap.
   */
  const quickInFlight = useRef(false);

  const statusQuery = useQuery({
    queryKey: ['tunnel', 'status'],
    queryFn: () => api.get<{ tunnel: ProxyTunnelStatus }>('/vpn/tunnel/status'),
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

  const gatewaysQuery = useQuery({
    queryKey: ['tunnel', 'gateways'],
    queryFn: () => api.get<{ gateways: GatewayMemoryEntry[] }>('/vpn/tunnel/gateways'),
    staleTime: 15_000,
  });

  const start = useMutation({
    mutationFn: (body: {
      nodeId?: string;
      auto?: boolean;
      systemProxy: boolean;
      mode?: 'nested';
      entryNodeId?: string;
      exitNodeId?: string;
    }) => api.post<{ tunnel: ProxyTunnelStatus }>('/vpn/tunnel/start', body),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['tunnel'] });
      if (data.tunnel.state === 'active') {
        const chain = data.tunnel.chain;
        toast(
          'ok',
          chain ? 'Nested tunnel verified' : 'Tunnel verified',
          chain
            ? `Entry ${chain.entryExitIp ?? '?'} → exit ${chain.exitIp ?? '?'}${chain.exitDiffers ? ' (differs)' : ' (identical)'}`
            : `Exit ${data.tunnel.exitIp ?? '?'}${data.tunnel.exitCountry ? ` (${data.tunnel.exitCountry})` : ''} via ${data.tunnel.engine}`,
        );
      } else {
        toast('error', 'Tunnel failed', data.tunnel.error ?? 'The core started but traffic could not traverse the node.');
      }
    },
    onError: (err) => toast('error', 'Tunnel start failed', err instanceof Error ? err.message : undefined),
  });

  const quick = useMutation({
    mutationFn: async () => {
      if (quickInFlight.current) return null;
      quickInFlight.current = true;
      try {
        // The profile chosen in the discovery card decides how hard the scan
        // inside quick connect searches. Read at click time so the choice made
        // a moment ago in the sibling card is the one that applies.
        const profile = readPersistedState<ScanProfileId>('vpn.scanProfile', 'balanced');
        return await api.post<{ tunnel: ProxyTunnelStatus; quick: QuickConnectResult }>('/vpn/tunnel/quick', { systemProxy: true, profile });
      } finally {
        quickInFlight.current = false;
      }
    },
    onSuccess: (data) => {
      if (!data) return; // duplicate click dropped before the request
      void qc.invalidateQueries({ queryKey: ['tunnel'] });
      // Keep the attempt list visible: the summary alone never explains WHY a
      // candidate was rejected, which is the difference between a retry and a guess.
      setQuickResult(data.quick);
      if (data.quick.ok) toast('ok', 'Connected', data.quick.summary);
      else toast('error', 'Could not connect', data.quick.summary);
    },
    onError: (err) => {
      setQuickResult(null);
      toast('error', 'Quick connect failed', err instanceof Error ? err.message : undefined);
    },
  });

  const stop = useMutation({
    mutationFn: () => api.post<{ tunnel: ProxyTunnelStatus }>('/vpn/tunnel/stop'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tunnel'] });
      toast('ok', 'Tunnel stopped', 'System proxy restored.');
    },
    onError: (err) => toast('error', 'Stop failed', err instanceof Error ? err.message : undefined),
  });

  const reconnect = useMutation({
    mutationFn: () => api.post<{ tunnel: ProxyTunnelStatus }>('/vpn/tunnel/reconnect'),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ['tunnel'] });
      if (data.tunnel.state === 'active') toast('ok', 'Reconnected', `Exit ${data.tunnel.exitIp ?? '?'}`);
      else toast('error', 'Reconnect failed', data.tunnel.error ?? undefined);
    },
    onError: (err) => toast('error', 'Reconnect failed', err instanceof Error ? err.message : undefined),
  });

  const forgetGateway = useMutation({
    mutationFn: (nodeId: string) => api.delete<{ gateways: GatewayMemoryEntry[] }>(`/vpn/tunnel/gateways/${nodeId}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tunnel', 'gateways'] }),
  });

  const tunnel = statusQuery.data?.tunnel;
  const busy = start.isPending || stop.isPending || reconnect.isPending || quick.isPending || tunnel?.state === 'starting' || tunnel?.state === 'stopping';
  const candidates = candidatesQuery.data?.nodes ?? [];
  const gateways = gatewaysQuery.data?.gateways ?? [];
  const active = tunnel?.state === 'active';

  const nodeName =
    tunnel?.nodeName ??
    (tunnel?.nodeId
      ? candidates.find((n) => n.id === tunnel.nodeId)?.remark || candidates.find((n) => n.id === tunnel.nodeId)?.host || tunnel.nodeId
      : null);

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
              Node: <span className="text-text">{nodeName ?? '—'}</span>
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
            {tunnel.source === 'gateway-memory' && (
              <span>
                Chosen by: <span className="text-text">quick connect (remembered gateway)</span>
              </span>
            )}
            {tunnel.bypass && (
              <span className="flex items-center gap-1">
                <ShieldOff size={12} />
                Bypassing: <span className="text-text">{tunnel.bypass}</span>
              </span>
            )}
            {tunnel.state === 'down' && tunnel.reconnectAttempts > 0 && tunnel.reconnectAttempts < tunnel.reconnectLimit && (
              <span className="w-full text-xs text-warn">
                Reconnecting… (attempt {tunnel.reconnectAttempts} of {tunnel.reconnectLimit})
              </span>
            )}
            {tunnel.error && <span className="w-full text-xs text-danger">{tunnel.error}</span>}
            {tunnel.chain && (
              <div className="w-full rounded-xl border border-line bg-surface px-3 py-2">
                <div className="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-faint">
                  <GitBranch size={12} />
                  Nested chain — {tunnel.chain.hops.length} local cores
                </div>
                <ol className="space-y-1">
                  {tunnel.chain.hops.map((h, i) => (
                    <li key={h.nodeId} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs">
                      <Badge tone="neutral">{i === 0 ? 'entry' : 'exit'}</Badge>
                      <span className="min-w-0 truncate text-text">{h.name ?? `${h.host}:${h.port}`}</span>
                      <span className="text-muted">{h.engine}</span>
                      <span className="text-muted">
                        {h.host}:{h.port}
                      </span>
                      <span className="text-muted">
                        exit IP {h.exitIp ?? 'unverified'}
                        {h.exitCountry ? ` (${h.exitCountry})` : ''}
                      </span>
                    </li>
                  ))}
                </ol>
                <p className={`mt-1.5 text-xs leading-relaxed ${tunnel.chain.exitDiffers ? 'text-ok' : 'text-warn'}`}>{tunnel.chain.note}</p>
              </div>
            )}
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
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" onClick={() => quick.mutate()} loading={quick.isPending} disabled={busy}>
                <Zap size={12} />
                Quick connect
              </Button>
              <span className="text-xs text-faint">
                Retries the gateways this app has already proven{gateways.length > 0 ? ` (${gateways.length} remembered)` : ''}, then discovers a new one using the
                discovery profile selected below.
              </span>
            </div>

            {quickResult && (
              <div className="rounded-xl border border-line bg-surface-2 p-3">
                <div className="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-faint">
                  <ListChecks size={12} />
                  Quick connect attempts ({quickResult.attempts.length}) — {quickResult.profile} scan
                </div>
                <p className={`text-xs leading-relaxed ${quickResult.ok ? 'text-ok' : 'text-warn'}`}>{quickResult.summary}</p>
                {quickResult.attempts.length > 0 && (
                  <ul className="mt-2 space-y-1.5">
                    {quickResult.attempts.map((a, i) => (
                      <li key={`${a.nodeId}-${i}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs">
                        <Badge tone={a.ok ? 'ok' : 'danger'}>{a.ok ? 'connected' : 'failed'}</Badge>
                        <span className="text-faint">
                          {a.source === 'memory' ? 'remembered gateway' : a.source === 'discovery' ? 'discovered' : 'database'}
                        </span>
                        <span className="min-w-0 truncate text-text">{a.name ?? a.nodeId}</span>
                        <span className="text-muted">
                          {a.host}:{a.port}
                        </span>
                        {a.exitIp && <span className="text-muted">exit {a.exitIp}</span>}
                        <span className="text-faint">
                          {a.tookMs >= 1000 ? `${(a.tookMs / 1000).toFixed(1)} s` : `${a.tookMs} ms`}
                        </span>
                        {a.error && <span className="w-full break-words text-faint">{a.error}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <label className="flex items-center gap-2 text-xs text-muted">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-[var(--color-accent,#6366f1)]"
                checked={nested}
                onChange={(e) => setNested(e.target.checked)}
                disabled={busy}
              />
              <span className="flex items-center gap-1.5">
                <GitBranch size={12} />
                Nested mode — chain two local cores so the exit address differs from the entry edge
              </span>
            </label>

            {nested ? (
              <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
                <label className="block">
                  <span className="mb-1 block text-[11px] uppercase tracking-wide text-faint">Entry hop (traffic leaves here first)</span>
                  <select
                    className="h-9 w-full rounded-lg border border-line bg-surface-2 px-2 text-sm"
                    value={entryNodeId}
                    onChange={(e) => setEntryNodeId(e.target.value)}
                    disabled={busy}
                  >
                    <option value="">— pick the entry node —</option>
                    {candidates.map((n) => (
                      <option key={n.id} value={n.id} disabled={n.id === exitNodeId}>
                        {nodeLabel(n)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11px] uppercase tracking-wide text-faint">Exit hop (the address sites will see)</span>
                  <select
                    className="h-9 w-full rounded-lg border border-line bg-surface-2 px-2 text-sm"
                    value={exitNodeId}
                    onChange={(e) => setExitNodeId(e.target.value)}
                    disabled={busy}
                  >
                    <option value="">— pick the exit node —</option>
                    {candidates.map((n) => (
                      <option key={n.id} value={n.id} disabled={n.id === entryNodeId}>
                        {nodeLabel(n)}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex items-end">
                  <Button
                    variant="primary"
                    onClick={() => start.mutate({ mode: 'nested', entryNodeId, exitNodeId, systemProxy: true })}
                    loading={start.isPending}
                    disabled={busy || !entryNodeId || !exitNodeId || entryNodeId === exitNodeId}
                  >
                    Start nested tunnel
                  </Button>
                </div>
                <p className="text-xs leading-relaxed text-faint sm:col-span-3">
                  The exit core dials its node THROUGH the entry core, so traffic is local → entry → exit. Only TCP-family
                  nodes (vless / vmess / trojan / shadowsocks) can be the exit hop, and v2ray cannot: it ignores the
                  dial-through wiring. Both hops are verified separately and the two observed addresses are compared.
                </p>
              </div>
            ) : (
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
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
                  variant={selectedNodeId ? 'primary' : 'secondary'}
                  onClick={() =>
                    selectedNodeId
                      ? start.mutate({ nodeId: selectedNodeId, systemProxy: true })
                      : start.mutate({ auto: true, systemProxy: true })
                  }
                  loading={start.isPending}
                  disabled={busy}
                >
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
            )}

            {gateways.length > 0 && (
              <div className="rounded-xl border border-line bg-surface-2 p-3">
                <div className="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-faint">
                  <History size={12} />
                  Remembered gateways (verified, most useful first)
                </div>
                <ul className="space-y-1">
                  {gateways.slice(0, 5).map((g) => (
                    <li key={g.nodeId} className="flex items-center justify-between gap-2 text-xs text-muted">
                      <span className={g.successStreak > 0 ? 'text-text' : 'text-muted line-through decoration-faint'}>
                        {gatewayLabel(g)}
                      </span>
                      <button
                        type="button"
                        className="shrink-0 text-faint hover:text-danger"
                        title="Forget this gateway"
                        onClick={() => forgetGateway.mutate(g.nodeId)}
                      >
                        <ShieldOff size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <p className="flex items-start gap-1.5 text-xs leading-relaxed text-faint">
              <Globe size={12} className="mt-0.5 shrink-0" />
              Starts a local core with the node&apos;s real secret from the vault, verifies traffic actually exits
              through it, then hands the system proxy to 127.0.0.1 and restores the previous setting on stop.
              Split-tunnel bypass rules (Settings → Network) apply to the tunnel only, never to node tests.
            </p>
            {candidatesQuery.isLoading && <p className="text-xs text-faint">Loading tested nodes…</p>}
            {!candidatesQuery.isLoading && candidates.length === 0 && (
              <EmptyState
                icon={<Route size={16} />}
                title="No tested nodes yet"
                message="Run node tests in the Node Explorer first — only nodes with a recent successful proxy test can carry a tunnel. Quick connect can still discover one."
              />
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
