export type ServerKind = 'vps' | 'diag' | 'speedtest';

export type ServerHealthStatus = 'online' | 'degraded' | 'offline';

export interface ServerRecord {
  id: string;
  name: string;
  kind: ServerKind;
  host: string;
  ipv4: string | null;
  ipv6: string | null;
  provider: string | null;
  region: string | null;
  country: string | null;
  city: string | null;
  protocol: string | null;
  port: number | null;
  capabilities: string[];
  tags: string[];
  enabled: boolean;
  createdAt: number;
}

export interface HealthSample {
  checkedAt: number;
  pingMs: number | null;
  jitterMs: number | null;
  packetLoss: number | null;
  downloadMbps: number | null;
  uploadMbps: number | null;
  status: ServerHealthStatus;
  healthScore: number | null;
}
