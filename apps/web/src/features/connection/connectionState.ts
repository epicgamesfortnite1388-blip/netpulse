/**
 * ONE owner for what the app is allowed to say about the connection.
 *
 * The brief requires eight distinct connection states, and forbids showing a
 * successful connection merely because a process is running. This module
 * derives those states from the two REAL backend carriers:
 *
 *   - GET /vpn/status          -> VpnStatus        (managed providers)
 *   - GET /vpn/tunnel/status   -> ProxyTunnelStatus (proxy / Aether tunnel)
 *
 * Nothing here invents a percentage, a latency, an exit IP or a verdict. A
 * tunnel that is up but whose exit was never observed is `unverified` — never
 * `connected`. A process that is running while the tunnel is `down` is `error`
 * or `reconnecting`, never a success.
 *
 * The same object feeds the dashboard dial, the global topbar chip and the
 * connection console, so those three surfaces can never disagree.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/lib/api';
import { useVpnStatus } from '@/features/vpn/useVpnData';

import type { ProxyTunnelStatus, VpnStatus, VpnVerification } from '@netpulse/shared';

export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'unverified'
  | 'failed'
  | 'reconnecting'
  | 'disconnecting'
  | 'error'
  | 'unknown';

export type ConnectionSource = 'proxy-tunnel' | 'provider' | 'none';

/** Semantic tone -> the CSS custom property that paints it (see identity.css). */
export type ConnectionTone =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'unverified'
  | 'failed'
  | 'reconnecting'
  | 'unknown';

export const TONE_VAR: Record<ConnectionTone, string> = {
  idle: 'var(--state-idle)',
  connecting: 'var(--state-connecting)',
  connected: 'var(--state-connected)',
  unverified: 'var(--state-unverified)',
  failed: 'var(--state-failed)',
  reconnecting: 'var(--state-reconnecting)',
  unknown: 'var(--state-unknown)',
};

export interface ConnectionPresentation {
  state: ConnectionState;
  /** Full, human sentence-case label. */
  label: string;
  /** Short uppercase label for the badge / dial centre. */
  short: string;
  /** Honest explanation of what is and is not known. */
  detail: string;
  tone: ConnectionTone;
  /** Arc fractions for the three dial rings, 0..1. Each is a real signal. */
  dial: { tunnel: number; traffic: number; guard: number };
  source: ConnectionSource;
  serverName: string | null;
  engine: string | null;
  protocol: string | null;
  since: number | null;
  exitIp: string | null;
  rxBytes: number | null;
  txBytes: number | null;
  latencyMs: number | null;
  verification: VpnVerification | null;
  /** Real, backend-supplied cautions — never generated for decoration. */
  warnings: string[];
  canConnect: boolean;
  canDisconnect: boolean;
}

const DISCONNECTED: ConnectionPresentation = {
  state: 'disconnected',
  label: 'Disconnected',
  short: 'Disconnected',
  detail: 'No tunnel is active. Your traffic is using the direct path.',
  tone: 'idle',
  dial: { tunnel: 0, traffic: 0, guard: 0 },
  source: 'none',
  serverName: null,
  engine: null,
  protocol: null,
  since: null,
  exitIp: null,
  rxBytes: null,
  txBytes: null,
  latencyMs: null,
  verification: null,
  warnings: [],
  canConnect: true,
  canDisconnect: false,
};

function presentation(
  partial: Partial<ConnectionPresentation> & Pick<ConnectionPresentation, 'state' | 'label' | 'short' | 'detail' | 'tone' | 'dial'>,
): ConnectionPresentation {
  return { ...DISCONNECTED, ...partial };
}

/** `VpnStatus` is the managed-provider carrier. */
function fromProvider(status: VpnStatus): ConnectionPresentation {
  const verification = status.verification ?? null;
  const exitIp = status.verifiedPublicIp ?? null;
  const warnings: string[] = [];
  if (status.tunBlockedBy) warnings.push(`TUN capture blocked: ${status.tunBlockedBy}`);
  if (status.tunError) warnings.push(status.tunError);
  if (status.verificationNote) warnings.push(status.verificationNote);

  const base = {
    source: 'provider' as const,
    serverName: status.serverName,
    engine: status.providerId,
    protocol: status.protocol,
    since: status.since,
    exitIp,
    rxBytes: status.rxBytes ?? null,
    txBytes: status.txBytes ?? null,
    latencyMs: status.endpointLatencyMs ?? null,
    verification,
    warnings,
    canConnect: false,
    canDisconnect: true,
  };

  if (verification === 'failed') {
    return presentation({
      ...base,
      state: 'failed',
      label: 'Traffic verification failed',
      short: 'Verify failed',
      detail: 'The tunnel is up, but the end-to-end traffic check did not confirm it. Do not treat this connection as private.',
      tone: 'failed',
      dial: { tunnel: 1, traffic: 0, guard: status.killSwitchActive ? 1 : 0 },
    });
  }
  if (verification === 'verified') {
    return presentation({
      ...base,
      state: 'connected',
      label: 'Connected',
      short: 'Connected',
      detail: 'The tunnel is up and traffic through it was verified end to end.',
      tone: 'connected',
      dial: { tunnel: 1, traffic: 1, guard: status.killSwitchActive ? 1 : 0.45 },
    });
  }
  // not_verified | unavailable | skipped | absent: the tunnel exists, the
  // traffic claim does not. This is the state most VPN clients wrongly paint
  // green.
  return presentation({
    ...base,
    state: 'unverified',
    label: 'Tunnel up — traffic unverified',
    short: 'Unverified',
    detail:
      verification === 'skipped'
        ? 'The tunnel is up. Traffic verification was skipped for this connection.'
        : 'The tunnel is up, but no end-to-end traffic check has confirmed that your traffic traverses it.',
    tone: 'unverified',
    dial: { tunnel: 1, traffic: 0, guard: status.killSwitchActive ? 1 : 0 },
  });
}

/** `ProxyTunnelStatus` is the proxy / Aether carrier. */
function fromTunnel(tunnel: ProxyTunnelStatus): ConnectionPresentation {
  const base = {
    source: 'proxy-tunnel' as const,
    serverName: tunnel.nodeName,
    engine: tunnel.engine,
    protocol: tunnel.chain ? 'nested' : null,
    since: tunnel.startedAt,
    exitIp: tunnel.exitIp,
    rxBytes: null,
    txBytes: null,
    latencyMs: null,
    verification: null,
    warnings: [] as string[],
  };

  switch (tunnel.state) {
    case 'starting': {
      const reconnecting = tunnel.reconnectAttempts > 0;
      return presentation({
        ...base,
        state: reconnecting ? 'reconnecting' : 'connecting',
        label: reconnecting ? 'Reconnecting' : 'Connecting',
        short: reconnecting ? 'Reconnecting' : 'Connecting',
        detail: reconnecting
          ? `Re-establishing the tunnel (attempt ${tunnel.reconnectAttempts} of ${tunnel.reconnectLimit}). Nothing is confirmed yet.`
          : 'The engine is starting. No traffic has been confirmed through the tunnel yet.',
        tone: reconnecting ? 'reconnecting' : 'connecting',
        dial: { tunnel: 0.35, traffic: 0, guard: 0 },
        canConnect: false,
        canDisconnect: true,
      });
    }
    case 'stopping':
      return presentation({
        ...base,
        state: 'disconnecting',
        label: 'Disconnecting',
        short: 'Disconnecting',
        detail: 'The tunnel is being torn down. Waiting for the backend to confirm it is down.',
        tone: 'connecting',
        dial: { tunnel: 0.6, traffic: 0, guard: 0 },
        canConnect: false,
        canDisconnect: false,
      });
    case 'down': {
      if (tunnel.error) {
        return presentation({
          ...base,
          state: 'error',
          label: 'Connection error',
          short: 'Error',
          detail: tunnel.error,
          tone: 'failed',
          dial: { tunnel: 0, traffic: 0, guard: 0 },
          warnings: [tunnel.error],
          canConnect: true,
          canDisconnect: false,
        });
      }
      return presentation({
        ...base,
        state: tunnel.reconnectAttempts > 0 ? 'reconnecting' : 'disconnected',
        label: tunnel.reconnectAttempts > 0 ? 'Reconnecting' : 'Disconnected',
        short: tunnel.reconnectAttempts > 0 ? 'Reconnecting' : 'Disconnected',
        detail: tunnel.reconnectAttempts > 0
          ? `The tunnel dropped and recovery is in progress (attempt ${tunnel.reconnectAttempts} of ${tunnel.reconnectLimit}).`
          : DISCONNECTED.detail,
        tone: tunnel.reconnectAttempts > 0 ? 'reconnecting' : 'idle',
        dial: { tunnel: 0, traffic: 0, guard: 0 },
        canConnect: true,
        canDisconnect: false,
      });
    }
    case 'active': {
      // An exit IP is only present when a trace was fetched THROUGH the tunnel.
      // This is the single condition that earns a green "Connected".
      const verified = Boolean(tunnel.verifiedAt && tunnel.exitIp);
      const unguarded = tunnel.tun === 'unguarded';
      const recovering = tunnel.tun === 'recovering';
      const warnings: string[] = [];
      if (unguarded) warnings.push('Traffic is captured, but the fail-closed hold could not be armed. A drop may fall back to the direct path.');
      if (recovering) warnings.push('TUN capture was lost; the watchdog is attempting one bounded re-arm. Nothing is captured right now.');
      if (tunnel.tunError) warnings.push(tunnel.tunError);
      if (!verified) warnings.push('No exit IP has been observed through this tunnel yet.');

      return presentation({
        ...base,
        state: verified && !unguarded && !recovering ? 'connected' : 'unverified',
        label: !verified
          ? 'Tunnel up — traffic unverified'
          : unguarded
            ? 'Capture unguarded'
            : recovering
              ? 'Recovering capture'
              : 'Connected',
        short: !verified ? 'Unverified' : unguarded ? 'Unguarded' : recovering ? 'Recovering' : 'Connected',
        detail: verified
          ? 'The tunnel is up and its exit IP was observed by a trace fetched through it.'
          : 'The tunnel process is up, but no trace through it has confirmed where your traffic exits.',
        tone: verified && !unguarded && !recovering ? 'connected' : 'unverified',
        dial: { tunnel: 1, traffic: verified ? 1 : 0, guard: unguarded ? 0.25 : tunnel.tun === 'active' ? 1 : 0.45 },
        warnings,
        canConnect: false,
        canDisconnect: true,
      });
    }
    case 'idle':
    default:
      return DISCONNECTED;
  }
}

/** Pure derivation — exported so its honesty rules are unit-testable. */
export function deriveConnection(args: {
  status?: VpnStatus | null;
  tunnel?: ProxyTunnelStatus | null;
  statusLoading?: boolean;
  tunnelLoading?: boolean;
  statusError?: boolean;
  tunnelError?: boolean;
}): ConnectionPresentation {
  const { status, tunnel, statusLoading, tunnelLoading, statusError, tunnelError } = args;
  const nothingKnown = !status && !tunnel;

  if (nothingKnown && (statusLoading || tunnelLoading)) {
    return presentation({
      state: 'unknown',
      label: 'Checking connection',
      short: 'Checking',
      detail: 'Waiting for the backend to report the tunnel state. No claim is made until it does.',
      tone: 'unknown',
      dial: { tunnel: 0, traffic: 0, guard: 0 },
      canConnect: false,
    });
  }
  if (nothingKnown && (statusError || tunnelError)) {
    return presentation({
      state: 'error',
      label: 'Connection status unavailable',
      short: 'Unknown',
      detail: 'The backend did not return connection state. The UI will not guess whether a tunnel is up.',
      tone: 'failed',
      dial: { tunnel: 0, traffic: 0, guard: 0 },
      canConnect: false,
    });
  }

  // A live tunnel transition always takes precedence over a stale provider
  // status: "starting" must never be painted green by an older payload.
  if (tunnel && tunnel.state !== 'idle') {
    const p = fromTunnel(tunnel);
    if (p.state !== 'disconnected' || !status?.connected) return p;
  }
  if (status?.connected) return fromProvider(status);
  if (tunnel && tunnel.state !== 'idle') return fromTunnel(tunnel);
  return DISCONNECTED;
}

/**
 * Live presentation. Shares the `['vpn','status']` and `['tunnel','status']`
 * cache keys with the existing VPN surfaces, so opening the dashboard reuses
 * data those pages already fetched and a connect/disconnect invalidates both.
 */
export function useConnection() {
  const statusQuery = useVpnStatus();
  const tunnelQuery = useQuery({
    queryKey: ['tunnel', 'status'],
    queryFn: () => api.get<{ tunnel: ProxyTunnelStatus }>('/vpn/tunnel/status'),
    refetchInterval: (q) => {
      // Guard BOTH levels: in web mode / backend failure the payload may be
      // present but lack `tunnel`. `data?.tunnel.state` only guarded `data`
      // and threw on a defined-but-empty object once this hook was mounted.
      const s = q.state.data?.tunnel?.state;
      return s === 'starting' || s === 'stopping' || s === 'down' ? 1_500 : 5_000;
    },
  });

  const presentation = deriveConnection({
    status: statusQuery.data,
    tunnel: tunnelQuery.data?.tunnel,
    statusLoading: statusQuery.isLoading,
    tunnelLoading: tunnelQuery.isLoading,
    statusError: statusQuery.isError,
    tunnelError: tunnelQuery.isError,
  });

  return { ...presentation, statusQuery, tunnelQuery };
}

/** Disconnect through whichever carrier actually owns the live tunnel.
 *  The two carriers answer with different payload shapes, so the mutation
 *  result is normalised to a single optional-field shape — nothing reads
 *  the payload, the invalidation below is what refreshes the UI. */
export function useDisconnect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (
      source: ConnectionSource,
    ): Promise<{ tunnel?: ProxyTunnelStatus; status?: VpnStatus }> => {
      if (source === 'proxy-tunnel') {
        return api.post<{ tunnel: ProxyTunnelStatus }>('/vpn/tunnel/stop');
      }
      return api.post<{ status: VpnStatus }>('/vpn/disconnect');
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tunnel'] });
      void qc.invalidateQueries({ queryKey: ['vpn'] });
    },
  });
}

/** Small event bus so any screen can open the existing Quick Connect overlay
 *  without threading shell state through every page. */
export const QUICK_CONNECT_EVENT = 'netpulse:quick-connect';
export function requestQuickConnect() {
  window.dispatchEvent(new CustomEvent(QUICK_CONNECT_EVENT));
}
