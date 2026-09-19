import { useQuery } from '@tanstack/react-query';

import { api } from '@/lib/api';

import type { ProxyEngineStatus, VpnProviderInfo, VpnStatus } from '@netpulse/shared';

/**
 * Shared VPN data hooks.
 *
 * Every engine surface reads the same backend truth, so the queries live here
 * instead of being re-declared (and subtly re-configured) per card. Polling
 * intervals are the ones the previous single-page VPN view used: 4 s for live
 * tunnel status, 5 s for the kill switch, 15 s for connection history.
 */

/** A stored profile as exposed by GET /vpn/profiles (never contains secrets). */
export interface VpnProfileDto {
  id: string;
  providerId: string;
  name: string;
  protocol: string;
  endpoint: string | null;
  createdAt: number;
}

export interface VpnHealthDto {
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

export interface VpnConnectionRow {
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

/**
 * Live kill-switch enforcement state (not the preference): `blocking` is true
 * only while the sink proxy is really applied.
 */
export interface KillSwitchDto {
  enabled: boolean;
  armed: boolean;
  /** How the armed tunnel captures traffic: system-proxy handoff or TUN default route. */
  mode: 'proxy' | 'route' | null;
  blocking: boolean;
  bypassSummary: string | null;
  reason: string | null;
  note: string | null;
}

export interface AetherEngineDto {
  installed: boolean;
  version: string | null;
  path: string | null;
  available: boolean;
  /** System-wide (TUN) preference, applied at the next connect. */
  tun: boolean;
  note: string;
}

export const VPN_STATUS_KEY = ['vpn', 'status'] as const;
export const VPN_PROVIDERS_KEY = ['vpn', 'providers'] as const;
export const VPN_PROFILES_KEY = ['vpn', 'profiles'] as const;

export function useVpnStatus() {
  return useQuery({
    queryKey: VPN_STATUS_KEY,
    queryFn: () => api.get<VpnStatus>('/vpn/status'),
    refetchInterval: 4_000,
  });
}

export function useVpnProviders() {
  return useQuery({
    queryKey: VPN_PROVIDERS_KEY,
    queryFn: () => api.get<{ providers: VpnProviderInfo[] }>('/vpn/providers'),
    staleTime: 30_000,
  });
}

export function useVpnProfiles() {
  return useQuery({
    queryKey: VPN_PROFILES_KEY,
    queryFn: () => api.get<{ profiles: VpnProfileDto[] }>('/vpn/profiles'),
    staleTime: 15_000,
  });
}

/** Live tunnel metrics — only polled while a tunnel is actually up. */
export function useVpnHealth(enabled: boolean) {
  return useQuery({
    queryKey: ['vpn', 'health'],
    queryFn: () => api.get<VpnHealthDto>('/vpn/health'),
    refetchInterval: 5_000,
    enabled,
  });
}

export function useVpnConnections(limit = 12) {
  return useQuery({
    queryKey: ['vpn', 'connections', limit],
    queryFn: () => api.get<{ connections: VpnConnectionRow[] }>(`/vpn/connections?limit=${limit}`),
    refetchInterval: 15_000,
  });
}

export function useKillSwitch() {
  return useQuery({
    queryKey: ['vpn', 'killswitch'],
    queryFn: () => api.get<{ killSwitch: KillSwitchDto }>('/vpn/killswitch'),
    refetchInterval: 5_000,
  });
}

/** Availability/version of the local proxy cores (xray / sing-box / v2ray). */
export function useProxyEngines() {
  return useQuery({
    queryKey: ['nodes', 'engines'],
    queryFn: () => api.get<ProxyEngineStatus>('/nodes/engines'),
    staleTime: 60_000,
  });
}

export function useAetherEngine() {
  return useQuery({
    queryKey: ['vpn', 'aether', 'engine'],
    queryFn: () => api.get<AetherEngineDto>('/vpn/aether/engine'),
    staleTime: 30_000,
  });
}

/** Whether a given managed provider currently owns the live tunnel. */
export function providerIsActive(status: VpnStatus | undefined, providerId: string): boolean {
  return status?.connected === true && status.providerId === providerId;
}
