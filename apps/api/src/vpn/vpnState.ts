import type { VpnRegistry } from './vpnService';

export interface VpnStateSummary {
  connected: boolean;
  providerId: string | null;
  serverName: string | null;
  protocol: string | null;
}

export const NO_VPN: VpnStateSummary = { connected: false, providerId: null, serverName: null, protocol: null };

/**
 * Detect whether a tunnel is currently connected by asking every provider.
 * Used by the DNS Lab and Gaming engines so measurements are labeled
 * "through VPN" — their probes use ordinary sockets, so when a tunnel owns
 * the default route the numbers already reflect the tunnel path; this state
 * makes that fact explicit instead of silently mixed.
 */
export async function detectVpnState(vpn: VpnRegistry, timeoutMs = 2_000): Promise<VpnStateSummary> {
  const statuses = await Promise.all(
    vpn.all().map((p) =>
      Promise.race([
        p.status().catch(() => null),
        new Promise<null>((resolve) => {
          const t = setTimeout(() => resolve(null), timeoutMs);
          t.unref?.();
        }),
      ]),
    ),
  );
  const active = statuses.find((s) => s?.connected);
  if (!active) return NO_VPN;
  return {
    connected: true,
    providerId: active.providerId ?? null,
    serverName: active.serverName ?? null,
    protocol: active.protocol ?? null,
  };
}