import type { IpFamily, MtuProbeResult, PingResult, RouteHop, TcpProbeResult, TraceResult } from '@netpulse/shared';

export interface IcmpPingOptions {
  count: number;
  timeoutMs: number;
  family?: IpFamily;
  /** called with (completed, total) as reply lines arrive — for WS progress */
  onProgress?: (completed: number, total: number) => void;
}

export interface TracerouteOptions {
  maxHops: number;
  /** per-probe timeout in ms */
  timeoutMs: number;
  family: IpFamily;
  /** called as each hop line is parsed — for WS progress */
  onHop?: (hop: RouteHop) => void;
}

/**
 * The only boundary allowed to touch OS networking tools.
 * Implementations spawn system binaries with argument arrays
 * (never shell strings) and must enforce timeouts.
 */
export interface PlatformNetworkController {
  readonly id: string;
  /** target must be a resolved IP literal, never a hostname */
  icmpPing(ip: string, opts: IcmpPingOptions): Promise<PingResult>;
  tcpProbe(host: string, port: number, timeoutMs: number, family?: IpFamily): Promise<TcpProbeResult>;
  systemDnsServers(): Promise<string[]>;
  traceroute(ip: string, opts: TracerouteOptions): Promise<TraceResult>;
  /** binary-search the unfragmented payload size (DF bit); mtu = payload + 28 */
  mtuProbe(ip: string, opts: { timeoutMs: number; family?: IpFamily }): Promise<MtuProbeResult>;
  /** best-effort detection of locally installed VPN binaries */
  detectVpnBinaries(): Promise<Record<string, boolean>>;
}
