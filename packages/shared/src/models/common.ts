export type IpFamily = 4 | 6;

export type TestType =
  | 'speed'
  | 'ping'
  | 'dns'
  | 'dns_leak'
  | 'route'
  | 'route_compare'
  | 'endpoint'
  | 'scan'
  | 'optimization'
  | 'bufferbloat'
  | 'mtu'
  | 'cgnat'
  | 'diagnostic'
  | 'webrtc'
  | 'gaming';

export type TestStatus = 'running' | 'done' | 'error' | 'cancelled';

export type EventLevel = 'info' | 'warn' | 'error';

export type EventCategory = 'network' | 'vpn' | 'dns' | 'routing' | 'system' | 'gaming' | 'connectivity' | 'performance';

export interface ApiErrorBody {
  code: string;
  message: string;
  hint?: string;
}

export interface TestRecord<TSummary = unknown> {
  id: string;
  type: TestType;
  status: TestStatus;
  startedAt: number;
  finishedAt: number | null;
  summary: TSummary | null;
  error: string | null;
}

export interface EventRecord {
  id: number;
  ts: number;
  level: EventLevel;
  category: EventCategory;
  message: string;
  data?: unknown;
}
