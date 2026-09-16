export interface VpnProviderInfo {
  id: string;
  name: string;
  kind: 'wireguard' | 'openvpn' | 'singbox' | 'aether' | 'custom';
  /** capability flags, e.g. 'connect', 'import-config', 'kill-switch' */
  capabilities: string[];
  /** false until the native platform layer confirms the engine exists */
  available: boolean;
  /** protocols this provider can drive, e.g. ['vless','vmess','trojan','shadowsocks'] */
  protocols?: string[];
}

export type VpnVerification =
  | 'not_verified'
  | 'verified'
  | 'failed'
  | 'unavailable'
  | 'skipped';

export interface VpnStatus {
  connected: boolean;
  serverId: string | null;
  serverName: string | null;
  protocol: string | null;
  since: number | null;
  supported: boolean;
  killSwitchActive: boolean;
  /** which provider reported this status (null when no tunnel is up) */
  providerId: string | null;
  /** public IP measured after connect, when verification ran */
  verifiedPublicIp?: string | null;
  /** public IP before the tunnel came up, when known */
  previousPublicIp?: string | null;
  /** how the connection was confirmed */
  verification?: VpnVerification;
  /** human explanation of the verification outcome */
  verificationNote?: string | null;
  /** cumulative tunnel traffic in bytes, when the engine reports it */
  rxBytes?: number | null;
  txBytes?: number | null;
  /** seconds since the last successful handshake, when known */
  handshakeAgeSec?: number | null;
  /** current VPN endpoint host:port */
  endpoint?: string | null;
  /** live latency to the VPN endpoint, when measured */
  endpointLatencyMs?: number | null;
}

export interface VpnServerInfo {
  id: string;
  name: string;
  providerId: string;
  country: string | null;
  city: string | null;
  endpoint: string;
  port: number | null;
  protocol: string;
}

/** A stored VPN connection profile (config imported by the user). */
export interface VpnProfile {
  id: string;
  providerId: string;
  name: string;
  kind: 'wireguard' | 'openvpn' | 'sing-box' | 'aether' | 'custom';
  /** endpoint summary for display only — never includes secrets/keys */
  endpoint: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

export interface VpnConnectionRecord {
  id: string;
  profileId: string | null;
  profileName: string | null;
  protocol: string | null;
  connectedAt: number;
  disconnectedAt: number | null;
  verifiedPublicIp: string | null;
  previousPublicIp: string | null;
  closeReason: 'user' | 'error' | 'restart' | null;
}

export interface VpnBinarySupport {
  /** kind of provider this applies to */
  kind: string;
  /** absolute path of the detected binary, null when not installed */
  binaryPath: string | null;
  available: boolean;
  note: string | null;
}
