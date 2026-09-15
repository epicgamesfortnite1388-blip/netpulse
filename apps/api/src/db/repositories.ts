import { and, asc, count, desc, eq, gte, inArray, isNull, isNotNull, lt, lte, or, type SQL } from 'drizzle-orm';

import type { EventCategory, EventLevel, NodeProtocol, TestStatus, TestType } from '@netpulse/shared';

import type { DbHandle } from './client';
import {
  bufferbloatTests,
  cloudflareCandidates,
  cloudflareScans,
  dnsBenchmarks,
  gamingComparisons,
  gamingSessionSamples,
  iranMeasurements,
  iranSessions,
  networkEvents,
  networkTests,
  nodeAddresses,
  nodeEvents,
  nodeHealth,
  nodeSources,
  nodeTests,
  mapObservations,
  publicNodes,
  publicSources,
  rawDocuments,
  routeComparisons,
  scanJobs,
  serverHealth,
  settings,
  sourceFetches,
  stabilitySamples,
  servers,
  testEndpoints,
  vpnConnections,
  vpnProfiles,
} from './schema';

export class SettingsRepository {
  constructor(private readonly handle: DbHandle) {}

  get(key: string): Record<string, unknown> | null {
    const row = this.handle.db.select().from(settings).where(eq(settings.key, key)).get();
    return (row?.value as Record<string, unknown>) ?? null;
  }

  put(key: string, value: Record<string, unknown>): void {
    this.handle.db
      .insert(settings)
      .values({ key, value, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: Date.now() } })
      .run();
  }
}

export interface EventQuery {
  level?: EventLevel;
  category?: EventCategory;
  limit?: number;
  beforeTs?: number;
}

export class EventsRepository {
  constructor(private readonly handle: DbHandle) {}

  insert(
    level: EventLevel,
    category: EventCategory,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    this.handle.db
      .insert(networkEvents)
      .values({ ts: Date.now(), level, category, message, data: data ?? null })
      .run();
  }

  list(
    query: EventQuery = {},
  ): { id: number; ts: number; level: EventLevel; category: EventCategory; message: string; data: Record<string, unknown> | null }[] {
    const conditions = [];
    if (query.level) conditions.push(eq(networkEvents.level, query.level));
    if (query.category) conditions.push(eq(networkEvents.category, query.category));
    if (query.beforeTs) conditions.push(lt(networkEvents.ts, query.beforeTs));
    const rows = this.handle.db
      .select()
      .from(networkEvents)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(networkEvents.ts))
      .limit(Math.min(query.limit ?? 100, 500))
      .all();
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      level: r.level,
      category: r.category,
      message: r.message,
      data: r.data,
    }));
  }
}

/** Full test record, including the complete result payload (detail view). */
export interface TestRow {
  id: string;
  type: TestType;
  status: TestStatus;
  params: Record<string, unknown> | null;
  summary: Record<string, unknown> | null;
  /** Full result payload, identical to the WS `test:done` message. */
  result: Record<string, unknown> | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

/** Lightweight list row — no full payload, to keep history queries small. */
export type TestSummaryRow = Omit<TestRow, 'result'>;

export class TestsRepository {
  constructor(private readonly handle: DbHandle) {}

  create(id: string, type: TestType, params: Record<string, unknown>): void {
    this.handle.db
      .insert(networkTests)
      .values({ id, type, status: 'running', params, startedAt: Date.now() })
      .run();
  }

  finish(
    id: string,
    result: { status: TestStatus; summary?: Record<string, unknown>; result?: unknown; error?: string },
  ): void {
    this.handle.db
      .update(networkTests)
      .set({
        status: result.status,
        summary: result.summary ?? null,
        result: result.result == null ? null : (result.result as Record<string, unknown>),
        error: result.error ?? null,
        finishedAt: Date.now(),
      })
      .where(eq(networkTests.id, id))
      .run();
  }

  /** Crash recovery: rows left `running` by a previous process (crash, kill,
   * respawn mid-run) can never complete — finalize them so history and the
   * UI poll fallback don't wait on them forever. */
  markStaleRunningInterrupted(): number {
    const res = this.handle.db
      .update(networkTests)
      .set({ status: 'error' satisfies TestStatus, error: 'test interrupted: application restarted while the test was running', finishedAt: Date.now() })
      .where(eq(networkTests.status, 'running'))
      .run();
    return res.changes;
  }

  list(opts: { type?: TestType; limit?: number; beforeTs?: number } = {}): TestSummaryRow[] {
    const conditions = [];
    if (opts.type) conditions.push(eq(networkTests.type, opts.type));
    if (opts.beforeTs) conditions.push(lt(networkTests.startedAt, opts.beforeTs));
    // keep the list light: full payloads are served by get()/detail only
    return this.handle.db
      .select({
        id: networkTests.id,
        type: networkTests.type,
        status: networkTests.status,
        params: networkTests.params,
        summary: networkTests.summary,
        error: networkTests.error,
        startedAt: networkTests.startedAt,
        finishedAt: networkTests.finishedAt,
      })
      .from(networkTests)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(networkTests.startedAt))
      .limit(Math.min(opts.limit ?? 50, 500))
      .all() as TestSummaryRow[];
  }

  get(id: string): TestRow | undefined {
    return this.handle.db.select().from(networkTests).where(eq(networkTests.id, id)).get() as
      | TestRow
      | undefined;
  }
}

export interface ServerInput {
  name: string;
  kind: 'vps' | 'diag' | 'speedtest';
  host: string;
  ipv4?: string | null;
  ipv6?: string | null;
  provider?: string | null;
  region?: string | null;
  country?: string | null;
  city?: string | null;
  protocol?: string | null;
  port?: number | null;
  capabilities: string[];
  tags: string[];
  enabled: boolean;
}

export class ServersRepository {
  constructor(private readonly handle: DbHandle) {}

  list() {
    return this.handle.db.select().from(servers).orderBy(servers.createdAt).all();
  }

  get(id: string) {
    return this.handle.db.select().from(servers).where(eq(servers.id, id)).get();
  }

  create(id: string, input: ServerInput) {
    this.handle.db.insert(servers).values({ id, ...input, createdAt: Date.now() }).run();
    return this.get(id);
  }

  update(id: string, patch: Partial<ServerInput>) {
    this.handle.db.update(servers).set(patch).where(eq(servers.id, id)).run();
    return this.get(id);
  }

  remove(id: string): boolean {
    const res = this.handle.db.delete(servers).where(eq(servers.id, id)).run();
    return res.changes > 0;
  }
}

export interface ServerHealthInput {
  serverId: string;
  checkedAt: number;
  pingMs: number | null;
  jitterMs: number | null;
  packetLoss: number | null;
  status: 'online' | 'degraded' | 'offline';
  healthScore: number | null;
}

export class ServerHealthRepository {
  constructor(private readonly handle: DbHandle) {}

  insert(input: ServerHealthInput): void {
    this.handle.db.insert(serverHealth).values(input).run();
  }

  latestForServer(serverId: string, limit = 50) {
    return this.handle.db
      .select()
      .from(serverHealth)
      .where(eq(serverHealth.serverId, serverId))
      .orderBy(desc(serverHealth.checkedAt))
      .limit(Math.min(limit, 500))
      .all();
  }
}

/* ------------------------------- scans ----------------------------------- */

export interface ScanCandidateInput {
  scanId: string;
  endpoint: string;
  port: number;
  tcpMs: number | null;
  tlsMs: number | null;
  httpMs: number | null;
  httpStatus: number | null;
  icmpAvgMs: number | null;
  score: number | null;
  status: string;
  label: string;
  colo?: string | null;
  loc?: string | null;
}

export interface CandidateValidationUpdate {
  lossPct: number | null;
  jitterMs: number | null;
  downloadMbps: number | null;
  ttfbMs: number | null;
  validated: boolean;
  clean: boolean | null;
  status: string;
  label: string;
  score: number | null;
  colo: string | null;
  loc: string | null;
}

export class ScanRepository {
  constructor(private readonly handle: DbHandle) {}

  createScan(id: string, config: Record<string, unknown>): void {
    this.handle.db
      .insert(cloudflareScans)
      .values({ id, status: 'running', config, startedAt: Date.now() })
      .run();
  }

  finishScan(
    id: string,
    result: { status: 'completed' | 'cancelled' | 'error'; discovered: number; tested: number; alive: number; error?: string },
  ): void {
    this.handle.db
      .update(cloudflareScans)
      .set({ status: result.status, finishedAt: Date.now(), discovered: result.discovered, tested: result.tested, alive: result.alive, error: result.error ?? null })
      .where(eq(cloudflareScans.id, id))
      .run();
  }

  getScan(id: string) {
    return this.handle.db.select().from(cloudflareScans).where(eq(cloudflareScans.id, id)).get();
  }

  listScans(limit = 20) {
    return this.handle.db.select().from(cloudflareScans).orderBy(desc(cloudflareScans.startedAt)).limit(Math.min(limit, 100)).all();
  }

  addCandidate(input: ScanCandidateInput): number {
    const res = this.handle.db
      .insert(cloudflareCandidates)
      .values({ ...input, favorite: false, createdAt: Date.now() })
      .run();
    return Number(res.lastInsertRowid);
  }

  candidates(scanId: string) {
    return this.handle.db
      .select()
      .from(cloudflareCandidates)
      .where(eq(cloudflareCandidates.scanId, scanId))
      .all();
  }

  updateCandidateValidation(candidateId: number, update: CandidateValidationUpdate): void {
    this.handle.db
      .update(cloudflareCandidates)
      .set(update)
      .where(eq(cloudflareCandidates.id, candidateId))
      .run();
  }

  setFavorite(candidateId: number, favorite: boolean): void {
    this.handle.db
      .update(cloudflareCandidates)
      .set({ favorite })
      .where(eq(cloudflareCandidates.id, candidateId))
      .run();
  }
}

/* ---------------------------- map observations --------------------------- */

export interface MapObservationRow {
  id: string;
  targetId: string;
  targetType: string;
  name: string;
  family: number | null;
  ip: string | null;
  protocol: string | null;
  port: number | null;
  vpnActive: boolean;
  payload: unknown;
  createdAt: number;
}

export class MapObservationsRepository {
  constructor(private readonly handle: DbHandle) {}

  insert(input: MapObservationRow): void {
    this.handle.db.insert(mapObservations).values(input).run();
  }

  latestForTarget(targetId: string, limit = 1) {
    return this.handle.db
      .select()
      .from(mapObservations)
      .where(eq(mapObservations.targetId, targetId))
      .orderBy(desc(mapObservations.createdAt))
      .limit(Math.min(limit, 50))
      .all();
  }

  list(options: { targetId?: string; limit?: number }) {
    const limit = Math.min(options.limit ?? 50, 200);
    const q = this.handle.db.select().from(mapObservations);
    const rows = options.targetId
      ? q.where(eq(mapObservations.targetId, options.targetId)).orderBy(desc(mapObservations.createdAt)).limit(limit).all()
      : q.orderBy(desc(mapObservations.createdAt)).limit(limit).all();
    return rows;
  }

  get(id: string) {
    return this.handle.db.select().from(mapObservations).where(eq(mapObservations.id, id)).get();
  }

  clear(): number {
    const res = this.handle.db.delete(mapObservations).run();
    return res.changes;
  }
}

/* ------------------------------ stability -------------------------------- */

export interface DnsBenchmarkRowDb {
  id: number;
  testId: string;
  providerId: string;
  providerName: string;
  transport: 'udp' | 'doh' | 'dot';
  queries: number;
  ok: number;
  timeouts: number;
  errors: number;
  latencyMinMs: number | null;
  latencyAvgMs: number | null;
  latencyMedianMs: number | null;
  latencyMaxMs: number | null;
  latencyP95Ms: number | null;
  jitterMs: number | null;
  reliabilityPct: number | null;
  score: number | null;
  dnssec: boolean | null;
  ipv6Ok: boolean | null;
  vpnActive: boolean;
  error: string | null;
  createdAt: number;
}

export interface DnsBenchmarkInsert {
  testId: string;
  providerId: string;
  providerName: string;
  transport: 'udp' | 'doh' | 'dot';
  queries: number;
  ok: number;
  timeouts: number;
  errors: number;
  latencyMinMs: number | null;
  latencyAvgMs: number | null;
  latencyMedianMs: number | null;
  latencyMaxMs: number | null;
  latencyP95Ms: number | null;
  jitterMs: number | null;
  reliabilityPct: number | null;
  score: number | null;
  dnssec: boolean | null;
  ipv6Ok: boolean | null;
  vpnActive: boolean;
  error: string | null;
}

export class DnsBenchmarksRepository {
  constructor(private readonly handle: DbHandle) {}

  insertRows(rows: DnsBenchmarkInsert[]): void {
    if (rows.length === 0) return;
    const now = Date.now();
    this.handle.db
      .insert(dnsBenchmarks)
      .values(rows.map((r) => ({ ...r, createdAt: now })))
      .run();
  }

  history(opts: { providerId?: string; transport?: 'udp' | 'doh' | 'dot'; sinceTs?: number; limit?: number } = {}): DnsBenchmarkRowDb[] {
    const conditions = [];
    if (opts.providerId) conditions.push(eq(dnsBenchmarks.providerId, opts.providerId));
    if (opts.transport) conditions.push(eq(dnsBenchmarks.transport, opts.transport));
    if (opts.sinceTs) conditions.push(gte(dnsBenchmarks.createdAt, opts.sinceTs));
    return this.handle.db
      .select()
      .from(dnsBenchmarks)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(asc(dnsBenchmarks.createdAt), asc(dnsBenchmarks.id))
      .limit(Math.min(opts.limit ?? 2000, 5000))
      .all() as DnsBenchmarkRowDb[];
  }

  /** Most recent batch of rows for the latest benchmark test of a given transport. */
  latestBatch(opts: { transport?: 'udp' | 'doh' | 'dot' } = {}): DnsBenchmarkRowDb[] {
    const latest = this.handle.db
      .select({ id: dnsBenchmarks.id, testId: dnsBenchmarks.testId })
      .from(dnsBenchmarks)
      .where(opts.transport ? eq(dnsBenchmarks.transport, opts.transport) : undefined)
      .orderBy(desc(dnsBenchmarks.createdAt))
      .limit(1)
      .get();
    if (!latest) return [];
    const conditions = [eq(dnsBenchmarks.testId, latest.testId)];
    if (opts.transport) conditions.push(eq(dnsBenchmarks.transport, opts.transport));
    return this.handle.db
      .select()
      .from(dnsBenchmarks)
      .where(and(...conditions))
      .orderBy(asc(dnsBenchmarks.providerId), asc(dnsBenchmarks.transport))
      .all() as DnsBenchmarkRowDb[];
  }
}

export class GamingRepository {
  constructor(private readonly handle: DbHandle) {}

  insertSessionSample(sample: { sessionId: string; gameId: string; endpoint: string | null; ts: number; latencyMs: number | null; jitterMs: number | null; lossPct: number | null; online: boolean; publicIp: string | null; vpnActive: boolean }): void {
    this.handle.db.insert(gamingSessionSamples).values(sample).run();
  }

  sessionSamples(sessionId: string, limit = 2000) {
    return this.handle.db
      .select()
      .from(gamingSessionSamples)
      .where(eq(gamingSessionSamples.sessionId, sessionId))
      .orderBy(asc(gamingSessionSamples.ts))
      .limit(Math.min(limit, 5000))
      .all();
  }

  insertComparison(row: { id: string; testId: string; gameId: string; mode: 'direct' | 'vpn'; serverName: string | null; latencyMs: number | null; jitterMs: number | null; lossPct: number | null; score: number | null; notes: string | null }): void {
    this.handle.db.insert(gamingComparisons).values({ ...row, createdAt: Date.now() }).run();
  }

  latestForMode(gameId: string, mode: 'direct' | 'vpn'): {
    id: string; testId: string; gameId: string; mode: string; serverName: string | null; latencyMs: number | null; jitterMs: number | null; lossPct: number | null; score: number | null; notes: string | null; createdAt: number;
  } | undefined {
    return this.handle.db
      .select()
      .from(gamingComparisons)
      .where(and(eq(gamingComparisons.gameId, gameId), eq(gamingComparisons.mode, mode)))
      .orderBy(desc(gamingComparisons.createdAt))
      .limit(1)
      .get();
  }
}

export class StabilityRepository {
  constructor(private readonly handle: DbHandle) {}

  insertSample(sample: { t: number; latencyMs: number | null; jitterMs: number | null; lossPct: number | null; dnsMs: number | null; online: boolean }): void {
    this.handle.db.insert(stabilitySamples).values(sample).run();
  }

  recent(limit = 600) {
    return this.handle.db.select().from(stabilitySamples).orderBy(desc(stabilitySamples.t)).limit(Math.min(limit, 2000)).all();
  }

  prune(olderThanTs: number): void {
    this.handle.db.delete(stabilitySamples).where(lt(stabilitySamples.t, olderThanTs)).run();
  }
}

export class BufferbloatRepository {
  constructor(private readonly handle: DbHandle) {}

  insert(row: { id: string; testId: string; idleLatencyMs: number | null; downloadLoadMs: number | null; uploadLoadMs: number | null; downloadIncreaseMs: number | null; uploadIncreaseMs: number | null; grade: string | null }): void {
    this.handle.db.insert(bufferbloatTests).values(row as never).run();
  }
}

export class RouteComparisonRepository {
  constructor(private readonly handle: DbHandle) {}

  insert(row: { id: string; testId: string; target: string; routes: Record<string, unknown>[]; winner: string | null; reason: string | null }): void {
    this.handle.db.insert(routeComparisons).values(row).run();
  }
}

export interface IranSessionRow {
  id: string;
  payload: unknown;
  createdAt: number;
}

export interface IranMeasurementRow {
  id: string;
  sessionId: string;
  targetId: string;
  connectionId: string;
  connectionName: string;
  payload: unknown;
  createdAt: number;
}

export class IranSessionsRepository {
  constructor(private readonly handle: DbHandle) {}

  create(id: string, payload: unknown): void {
    this.handle.db.insert(iranSessions).values({ id, payload, createdAt: Date.now() }).run();
  }

  /** Session state lives inside the JSON payload — merge a patch into it. */
  update(id: string, patch: Record<string, unknown>): void {
    const row = this.handle.db.select().from(iranSessions).where(eq(iranSessions.id, id)).get();
    if (!row) return;
    const payload = (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload ?? {}) as Record<string, unknown>;
    const next = { ...payload, ...patch };
    this.handle.db.update(iranSessions).set({ payload: next }).where(eq(iranSessions.id, id)).run();
  }

  finish(id: string, payload: Record<string, unknown>): void {
    this.update(id, payload);
  }

  get(id: string): IranSessionRow | undefined {
    return this.handle.db.select().from(iranSessions).where(eq(iranSessions.id, id)).get();
  }

  list(limit = 20): IranSessionRow[] {
    return this.handle.db.select().from(iranSessions).orderBy(desc(iranSessions.createdAt)).limit(Math.min(limit, 200)).all();
  }

  clear(): number {
    const res = this.handle.db.delete(iranSessions).run();
    return res.changes;
  }
}

export class IranMeasurementsRepository {
  constructor(private readonly handle: DbHandle) {}

  insert(row: IranMeasurementRow): void {
    this.handle.db.insert(iranMeasurements).values(row).run();
  }

  listBySession(sessionId: string): IranMeasurementRow[] {
    return this.handle.db
      .select()
      .from(iranMeasurements)
      .where(eq(iranMeasurements.sessionId, sessionId))
      .orderBy(asc(iranMeasurements.createdAt))
      .limit(2_000)
      .all();
  }

  listByTarget(targetId: string, limit = 100): IranMeasurementRow[] {
    return this.handle.db
      .select()
      .from(iranMeasurements)
      .where(eq(iranMeasurements.targetId, targetId))
      .orderBy(desc(iranMeasurements.createdAt))
      .limit(Math.min(limit, 500))
      .all();
  }

  clear(): number {
    const res = this.handle.db.delete(iranMeasurements).run();
    return res.changes;
  }
}

export interface VpnProfileRow {
  id: string;
  providerId: string;
  name: string;
  protocol: string;
  endpoint: string | null;
  publicKeyFingerprint: string | null;
  allowedIps: string | null;
  dnsServers: string | null;
  secretRef: string;
  configPath: string;
  lastUsedAt: number | null;
  createdAt: number;
}

export class VpnProfileRepository {
  constructor(private readonly handle: DbHandle) {}

  list(): VpnProfileRow[] {
    return this.handle.db.select().from(vpnProfiles).orderBy(desc(vpnProfiles.createdAt)).all();
  }

  get(id: string): VpnProfileRow | undefined {
    return this.handle.db.select().from(vpnProfiles).where(eq(vpnProfiles.id, id)).get();
  }

  insert(row: VpnProfileRow): void {
    this.handle.db.insert(vpnProfiles).values(row).run();
  }

  touch(id: string): void {
    this.handle.db
      .update(vpnProfiles)
      .set({ lastUsedAt: Date.now() })
      .where(eq(vpnProfiles.id, id))
      .run();
  }

  remove(id: string): boolean {
    const res = this.handle.db.delete(vpnProfiles).where(eq(vpnProfiles.id, id)).run();
    return res.changes > 0;
  }
}

export class VpnConnectionRepository {
  constructor(private readonly handle: DbHandle) {}

  insert(row: { id: string; providerId: string; serverId: string | null; serverName: string | null; endpoint: string | null; protocol: string; status: 'connecting' | 'connected' | 'disconnected' | 'error'; connectedAt: number | null; error?: string | null }): void {
    this.handle.db.insert(vpnConnections).values({ ...row, error: row.error ?? null }).run();
  }

  update(id: string, patch: { status?: 'connecting' | 'connected' | 'disconnected' | 'error'; connectedAt?: number | null; disconnectedAt?: number | null; rxBytes?: number | null; txBytes?: number | null; error?: string | null }): void {
    this.handle.db.update(vpnConnections).set(patch).where(eq(vpnConnections.id, id)).run();
  }

  latest(limit = 20) {
    return this.handle.db.select().from(vpnConnections).orderBy(desc(vpnConnections.connectedAt)).limit(Math.min(limit, 100)).all();
  }

  active(): { id: string; providerId: string; serverId: string | null; serverName: string | null; endpoint: string | null; protocol: string; status: string; connectedAt: number | null } | undefined {
    return this.handle.db
      .select()
      .from(vpnConnections)
      .where(eq(vpnConnections.status, 'connected'))
      .orderBy(desc(vpnConnections.connectedAt))
      .limit(1)
      .get();
  }

  /** Rows stuck in connecting/connected — used for crash recovery. */
  unresolved(): { id: string; status: string; serverName: string | null; connectedAt: number | null }[] {
    return this.handle.db
      .select({ id: vpnConnections.id, status: vpnConnections.status, serverName: vpnConnections.serverName, connectedAt: vpnConnections.connectedAt })
      .from(vpnConnections)
      .where(or(eq(vpnConnections.status, 'connected'), eq(vpnConnections.status, 'connecting')))
      .all();
  }

  /** Mark all unresolved rows as interrupted (crash recovery). */
  markAllInterrupted(reason: string): number {
    const res = this.handle.db
      .update(vpnConnections)
      .set({ status: 'error', error: reason, disconnectedAt: Date.now() })
      .where(or(eq(vpnConnections.status, 'connected'), eq(vpnConnections.status, 'connecting')))
      .run();
    return res.changes;
  }
}

/* --------------------------- public nodes --------------------------- */

export interface PublicSourceRow {
  id: string;
  name: string;
  homepage: string | null;
  repositoryUrl: string | null;
  enabled: boolean;
  type: string;
  urls: string[];
  formats: string[];
  intervalMinutes: number;
  lastFetch: number | null;
  lastSuccess: number | null;
  lastFailure: number | null;
  status: string;
  discoveredConfigCount: number;
  importedConfigCount: number;
  duplicateCount: number;
  invalidCount: number;
  recentDiscovered: number;
  recentImported: number;
  recentHealthy: number;
  health: string;
  lastContentHash: string | null;
  notes: string | null;
  createdAt: number;
}

export class PublicSourcesRepository {
  constructor(private readonly handle: DbHandle) {}

  list(): PublicSourceRow[] {
    return this.handle.db.select().from(publicSources).orderBy(desc(publicSources.createdAt)).all();
  }

  get(id: string): PublicSourceRow | undefined {
    return this.handle.db.select().from(publicSources).where(eq(publicSources.id, id)).get();
  }

  insert(row: PublicSourceRow): void {
    this.handle.db.insert(publicSources).values(row).run();
  }

  update(id: string, patch: Partial<Omit<PublicSourceRow, 'id'>>): void {
    this.handle.db.update(publicSources).set(patch as Partial<PublicSourceRow>).where(eq(publicSources.id, id)).run();
  }

  upsertSourceCount(id: string, patch: {
    discovered?: number;
    imported?: number;
    duplicate?: number;
    invalid?: number;
    recentDiscovered?: number;
    recentImported?: number;
    recentHealthy?: number;
    health?: string;
    lastSuccess?: number;
    lastFailure?: number;
    lastFetch?: number;
    status?: string;
    lastContentHash?: string;
  }): void {
    this.handle.db.update(publicSources).set(patch as Partial<PublicSourceRow>).where(eq(publicSources.id, id)).run();
  }

  remove(id: string): boolean {
    const res = this.handle.db.delete(publicSources).where(eq(publicSources.id, id)).run();
    return res.changes > 0;
  }
}

export interface SourceFetchRow {
  id: string;
  sourceId: string;
  startedAt: number;
  finishedAt: number | null;
  url: string | null;
  status: string;
  rawBytes: number | null;
  configCount: number;
  importedCount: number;
  duplicateCount: number;
  invalidCount: number;
  error: string | null;
  contentHash: string | null;
}

export class SourceFetchesRepository {
  constructor(private readonly handle: DbHandle) {}

  create(row: SourceFetchRow): void {
    this.handle.db.insert(sourceFetches).values(row).run();
  }

  get(id: string): SourceFetchRow | undefined {
    return this.handle.db.select().from(sourceFetches).where(eq(sourceFetches.id, id)).get();
  }

  listBySource(sourceId: string, limit = 50) {
    return this.handle.db
      .select()
      .from(sourceFetches)
      .where(eq(sourceFetches.sourceId, sourceId))
      .orderBy(desc(sourceFetches.startedAt))
      .limit(Math.min(limit, 200))
      .all();
  }

  finish(id: string, patch: { finishedAt?: number; status?: string; configCount?: number; importedCount?: number; duplicateCount?: number; invalidCount?: number; error?: string | null; contentHash?: string | null; rawBytes?: number | null }): void {
    this.handle.db.update(sourceFetches).set(patch as Partial<SourceFetchRow>).where(eq(sourceFetches.id, id)).run();
  }
}

export interface RawDocumentRow {
  id: string;
  sourceId: string;
  fetchId: string;
  sourceUrl: string;
  originalText: string;
  originalHash: string;
  detectedFormat: string;
  sizeBytes: number;
  parsedAt: number | null;
  configCount: number;
  error: string | null;
  fetchedAt: number;
}

export class RawDocumentsRepository {
  constructor(private readonly handle: DbHandle) {}

  insert(row: RawDocumentRow): void {
    this.handle.db.insert(rawDocuments).values(row).run();
  }

  get(id: string): RawDocumentRow | undefined {
    return this.handle.db.select().from(rawDocuments).where(eq(rawDocuments.id, id)).get();
  }

  listByFetch(fetchId: string) {
    return this.handle.db.select().from(rawDocuments).where(eq(rawDocuments.fetchId, fetchId)).all();
  }

  markParsed(id: string, parsedAt: number, configCount: number, error?: string | null): void {
    this.handle.db.update(rawDocuments).set({ parsedAt, configCount, error: error ?? null }).where(eq(rawDocuments.id, id)).run();
  }
}

export interface PublicNodeRow {
  id: string;
  canonicalFingerprint: string;
  protocol: NodeProtocol;
  host: string;
  ipv4: string[];
  ipv6: string[];
  port: number;
  transport: string;
  security: string;
  sni: string | null;
  alpn: string[];
  fingerprint: string | null;
  flow: string | null;
  alterId: number | null;
  path: string | null;
  hostHeader: string | null;
  serviceName: string | null;
  allowInsecure: boolean;
  realityPublicKey: string | null;
  realityShortId: string | null;
  realityServerName: string | null;
  encryption: string | null;
  ssrProtocol: string | null;
  remark: string | null;
  sourceIds: string[];
  sourceUrls: string[];
  sourceCount: number;
  firstSeen: number;
  lastSeen: number;
  lastValidated: number | null;
  status: string;
  confidence: string;
  country: string | null;
  city: string | null;
  asn: number | null;
  isp: string | null;
  organization: string | null;
  lat: number | null;
  lon: number | null;
  geoSourceCount: number;
  tags: string[];
  favorite: boolean;
  userNotes: string | null;
  lastProxyMs: number | null;
  /** xray | sing-box — core of the most recent proxy test (denormalized from node_tests) */
  lastEngine: string | null;
  geoLastAttempt: number | null;
  lastTcpMs: number | null;
  lastTlsMs: number | null;
  testCount: number;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  recentTestCount: number;
  recentSuccessCount: number;
  recentFailureCount: number;
  score: number;
  reliabilityPct: number;
  medianProxyMs: number | null;
  medianTcpMs: number | null;
  medianTlsMs: number | null;
  recentLossPct: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  freshness: string;
  createdAt: number;
  updatedAt: number;
}

export class PublicNodesRepository {
  constructor(private readonly handle: DbHandle) {}

  get(id: string): PublicNodeRow | undefined {
    return this.handle.db.select().from(publicNodes).where(eq(publicNodes.id, id)).get() as PublicNodeRow | undefined;
  }

  getByFingerprint(fingerprint: string): PublicNodeRow | undefined {
    return this.handle.db.select().from(publicNodes).where(eq(publicNodes.canonicalFingerprint, fingerprint)).get() as PublicNodeRow | undefined;
  }

  listByIds(ids: string[]): PublicNodeRow[] {
    if (ids.length === 0) return [];
    return this.handle.db
      .select()
      .from(publicNodes)
      .where(inArray(publicNodes.id, ids))
      .all() as PublicNodeRow[];
  }

  insert(row: PublicNodeRow): void {
    this.handle.db.insert(publicNodes).values(row).run();
  }

  /** Atomic upsert: insert new node or bump counters on existing fingerprint match. */
  insertOrUpdate(row: PublicNodeRow, existing?: PublicNodeRow): void {
    if (!existing) {
      this.handle.db.insert(publicNodes).values(row).onConflictDoNothing().run();
      return;
    }
    this.handle.db
      .update(publicNodes)
      .set({
        lastSeen: row.lastSeen,
        lastValidated: row.lastValidated ?? undefined,
        status: row.status,
        confidence: row.confidence,
        country: row.country ?? undefined,
        city: row.city ?? undefined,
        asn: row.asn ?? undefined,
        isp: row.isp ?? undefined,
        organization: row.organization ?? undefined,
        lat: row.lat ?? undefined,
        lon: row.lon ?? undefined,
        geoSourceCount: row.geoSourceCount,
        sourceCount: row.sourceCount,
        sourceIds: row.sourceIds,
        sourceUrls: row.sourceUrls,
        score: row.score,
        reliabilityPct: row.reliabilityPct,
        medianProxyMs: row.medianProxyMs ?? undefined,
        medianTcpMs: row.medianTcpMs ?? undefined,
        medianTlsMs: row.medianTlsMs ?? undefined,
        recentTestCount: row.recentTestCount,
        recentSuccessCount: row.recentSuccessCount,
        recentFailureCount: row.recentFailureCount,
        recentLossPct: row.recentLossPct,
        lastProxyMs: row.lastProxyMs ?? undefined,
        lastTcpMs: row.lastTcpMs ?? undefined,
        lastTlsMs: row.lastTlsMs ?? undefined,
        testCount: row.testCount,
        successCount: row.successCount,
        failureCount: row.failureCount,
        consecutiveFailures: row.consecutiveFailures,
        lastSuccessAt: row.lastSuccessAt ?? undefined,
        lastFailureAt: row.lastFailureAt ?? undefined,
        freshness: row.freshness,
        updatedAt: Date.now(),
      } as Partial<PublicNodeRow>)
      .where(eq(publicNodes.canonicalFingerprint, existing.canonicalFingerprint))
      .run();
  }

  update(id: string, patch: Partial<Omit<PublicNodeRow, 'id' | 'canonicalFingerprint'>>): void {
    this.handle.db.update(publicNodes).set(patch as Partial<PublicNodeRow>).where(eq(publicNodes.id, id)).run();
  }

  updateStatus(id: string, status: string, confidence?: string): void {
    this.handle.db.update(publicNodes).set({ status, confidence: confidence ?? undefined, updatedAt: Date.now() }).where(eq(publicNodes.id, id)).run();
  }

  updateGeo(id: string, geo: { country?: string | null; city?: string | null; asn?: number | null; isp?: string | null; organization?: string | null; lat?: number | null; lon?: number | null; confidence?: string; geoSourceCount?: number; geoLastAttempt?: number }): void {
    this.handle.db.update(publicNodes).set({ ...geo, updatedAt: Date.now() }).where(eq(publicNodes.id, id)).run();
  }

  /** Mark a geo lookup as attempted (even when it resolved nothing) so the
   *  geo worker never hammers the same dead host in a tight loop. */
  markGeoAttempt(id: string, at: number): void {
    this.handle.db.update(publicNodes).set({ geoLastAttempt: at }).where(eq(publicNodes.id, id)).run();
  }

  /** Nodes whose IP-based geolocation should (re-)run: never attempted,
   *  resolved-but-stale (>30 days), or failed/unresolved (>7 days). */
  listForGeoEnrichment(limit: number): PublicNodeRow[] {
    const now = Date.now();
    return this.handle.db
      .select()
      .from(publicNodes)
      .where(
        or(
          isNull(publicNodes.geoLastAttempt),
          // resolved geo older than 30 days
          and(isNotNull(publicNodes.lat), isNotNull(publicNodes.lon), lt(publicNodes.geoLastAttempt, now - 30 * 86_400_000)),
          // unresolved older than 7 days
          and(or(isNull(publicNodes.lat), isNull(publicNodes.lon)), lt(publicNodes.geoLastAttempt, now - 7 * 86_400_000)),
        ),
      )
      .orderBy(desc(publicNodes.lastSeen))
      .limit(Math.min(limit, 200))
      .all() as PublicNodeRow[];
  }

  updateTestStats(id: string, patch: { testCount?: number; successCount?: number; failureCount?: number; consecutiveFailures?: number; recentTestCount?: number; recentSuccessCount?: number; recentFailureCount?: number; reliabilityPct?: number; medianProxyMs?: number | null; medianTcpMs?: number | null; medianTlsMs?: number | null; recentLossPct?: number; lastProxyMs?: number | null; lastTcpMs?: number | null; lastTlsMs?: number | null; lastSuccessAt?: number | null; lastFailureAt?: number | null; lastValidated?: number; status?: string; freshness?: string; score?: number }): void {
    this.handle.db.update(publicNodes).set({ ...patch, updatedAt: Date.now() } as Partial<PublicNodeRow>).where(eq(publicNodes.id, id)).run();
  }

  setFavorite(id: string, favorite: boolean, tags?: string[]): void {
    this.handle.db.update(publicNodes).set({ favorite, tags: tags ?? undefined, updatedAt: Date.now() }).where(eq(publicNodes.id, id)).run();
  }

  setTags(id: string, tags: string[]): void {
    this.handle.db.update(publicNodes).set({ tags, updatedAt: Date.now() }).where(eq(publicNodes.id, id)).run();
  }

  /** Return counts grouped by status. */
  statusCounts(): { discovered: number; healthy: number; degraded: number; failed: number; stale: number } {
    const rows = this.handle.db
      .select({ status: publicNodes.status, n: count() })
      .from(publicNodes)
      .groupBy(publicNodes.status)
      .all();
    const map: Record<string, number> = Object.fromEntries(rows.map((r) => [r.status, r.n]));
    return {
      discovered: map['discovered'] ?? map['parsed'] ?? map['validated'] ?? map['tcp-tested'] ?? map['proxy-tested'] ?? 0,
      healthy: map['healthy'] ?? 0,
      degraded: map['degraded'] ?? 0,
      failed: map['failed'] ?? 0,
      stale: map['stale'] ?? 0,
    };
  }

  /** Paginated, filterable list. Returns { rows, total }. */
  list(opts: {
    limit?: number;
    offset?: number;
    protocol?: string;
    country?: string;
    asn?: number;
    status?: string;
    transport?: string;
    security?: string;
    freshness?: string;
    favorite?: boolean;
    search?: string;
    minScore?: number;
    maxLatency?: number;
    minReliability?: number;
    /** only nodes whose last proxy test ran through this core ('xray' | 'sing-box') */
    engine?: string;
    sortField?: string;
    sortDir?: 'asc' | 'desc';
  } = {}): { rows: PublicNodeRow[]; total: number } {
    const limit = Math.min(opts.limit ?? 100, 500);
    const offset = opts.offset ?? 0;

    // Build conditions array for Drizzle
    const conditions: SQL[] = [];
    if (opts.protocol) conditions.push(eq(publicNodes.protocol, opts.protocol));
    if (opts.country) conditions.push(eq(publicNodes.country, opts.country));
    if (opts.asn != null) conditions.push(eq(publicNodes.asn, opts.asn));
    if (opts.status) conditions.push(eq(publicNodes.status, opts.status));
    if (opts.transport) conditions.push(eq(publicNodes.transport, opts.transport));
    if (opts.security) conditions.push(eq(publicNodes.security, opts.security));
    if (opts.freshness) conditions.push(eq(publicNodes.freshness, opts.freshness));
    if (opts.favorite != null) conditions.push(eq(publicNodes.favorite, opts.favorite));
    if (opts.minScore != null) conditions.push(gte(publicNodes.score, opts.minScore));
    if (opts.maxLatency != null) conditions.push(lte(publicNodes.medianProxyMs, opts.maxLatency));
    if (opts.minReliability != null) conditions.push(gte(publicNodes.reliabilityPct, opts.minReliability));
    if (opts.engine) conditions.push(eq(publicNodes.lastEngine, opts.engine));

    // Fetch all matching rows (with a reasonable cap for client-side search)
    const qb = this.handle.db.select().from(publicNodes);
    const allRows = (conditions.length > 0
      ? qb.where(and(...conditions)).orderBy(desc(publicNodes.lastSeen)).limit(2000).all()
      : qb.orderBy(desc(publicNodes.lastSeen)).limit(2000).all()) as PublicNodeRow[];

    // Apply search filter client-side
    let filteredRows = allRows;
    if (opts.search) {
      const s = opts.search.toLowerCase();
      filteredRows = allRows.filter((r) =>
        r.host.toLowerCase().includes(s) ||
        r.ipv4.some((ip) => ip.includes(s)) ||
        r.ipv6.some((ip) => ip.includes(s)) ||
        r.canonicalFingerprint.includes(s) ||
        r.protocol.includes(s) ||
        r.remark?.toLowerCase().includes(s),
      );
    }

    // Sort
    const sorted = this.sortNodes(filteredRows, opts.sortField, opts.sortDir);

    const total = filteredRows.length;
    const rows = sorted.slice(offset, offset + limit);

    return { rows, total };
  }

  private sortNodes(rows: PublicNodeRow[], field?: string, dir?: 'asc' | 'desc'): PublicNodeRow[] {
    const f = field ?? 'lastSeen';
    const d = dir ?? 'desc';
    const multiplier = d === 'asc' ? 1 : -1;

    return rows.sort((a, b) => {
      let av: number | string | null = 0;
      let bv: number | string | null = 0;

      switch (f) {
        case 'proxyLatency':
          av = a.medianProxyMs ?? Infinity; bv = b.medianProxyMs ?? Infinity; break;
        case 'tcpLatency':
          av = a.medianTcpMs ?? Infinity; bv = b.medianTcpMs ?? Infinity; break;
        case 'tlsLatency':
          av = a.medianTlsMs ?? Infinity; bv = b.medianTlsMs ?? Infinity; break;
        case 'packetLoss':
          av = a.recentLossPct; bv = b.recentLossPct; break;
        case 'reliability':
          av = a.reliabilityPct; bv = b.reliabilityPct; break;
        case 'score':
          av = a.score; bv = b.score; break;
        case 'country':
          av = a.country ?? ''; bv = b.country ?? ''; break;
        case 'city':
          av = a.city ?? ''; bv = b.city ?? ''; break;
        case 'asn':
          av = a.asn ?? 0; bv = b.asn ?? 0; break;
        case 'isp':
          av = a.isp ?? ''; bv = b.isp ?? ''; break;
        case 'protocol':
          av = a.protocol; bv = b.protocol; break;
        case 'port':
          av = a.port; bv = b.port; break;
        case 'transport':
          av = a.transport; bv = b.transport; break;
        case 'tls':
          av = a.security; bv = b.security; break;
        case 'reality':
          av = a.security === 'reality' ? 1 : 0; bv = b.security === 'reality' ? 1 : 0; break;
        case 'ipv4':
          av = a.ipv4.length; bv = b.ipv4.length; break;
        case 'ipv6':
          av = a.ipv6.length; bv = b.ipv6.length; break;
        case 'source':
          av = a.sourceCount; bv = b.sourceCount; break;
        case 'sourceCount':
          av = a.sourceCount; bv = b.sourceCount; break;
        case 'firstSeen':
          av = a.firstSeen; bv = b.firstSeen; break;
        case 'lastSeen':
          av = a.lastSeen; bv = b.lastSeen; break;
        case 'stability':
          av = a.reliabilityPct; bv = b.reliabilityPct; break;
        default:
          av = a.lastSeen; bv = b.lastSeen;
      }

      if (av == null && bv == null) return 0;
      if (av == null) return 1 * multiplier;
      if (bv == null) return -1 * multiplier;
      if (typeof av === 'string' && typeof bv === 'string') {
        return av.localeCompare(bv) * multiplier;
      }
      return ((av as number) - (bv as number)) * multiplier;
    });
  }

  clear(): number {
    const res = this.handle.db.delete(publicNodes).run();
    return res.changes;
  }
}

export interface NodeAddressRow {
  id: number;
  nodeId: string;
  ip: string;
  family: 4 | 6;
  firstSeen: number;
  lastSeen: number;
}

export class NodeAddressesRepository {
  constructor(private readonly handle: DbHandle) {}

  insert(row: NodeAddressRow): void {
    this.handle.db.insert(nodeAddresses).values(row).onConflictDoNothing().run();
  }

  listByNode(nodeId: string) {
    return this.handle.db.select().from(nodeAddresses).where(eq(nodeAddresses.nodeId, nodeId)).all();
  }

  listByIp(ip: string) {
    return this.handle.db.select().from(nodeAddresses).where(eq(nodeAddresses.ip, ip)).all();
  }

  updateSeen(nodeId: string, ip: string, family: 4 | 6, now: number): void {
    this.handle.db
      .update(nodeAddresses)
      .set({ lastSeen: now } as Partial<NodeAddressRow>)
      .where(and(eq(nodeAddresses.nodeId, nodeId), eq(nodeAddresses.ip, ip)))
      .run();
  }
}

export interface NodeSourceRow {
  id: number;
  nodeId: string;
  sourceId: string;
  sourceUrl: string;
  sourceConfigRef: string;
  parserVersion: string;
  normalizedHash: string;
  discoveredAt: number;
}

export class NodeSourcesRepository {
  constructor(private readonly handle: DbHandle) {}

  insert(row: NodeSourceRow): void {
    this.handle.db.insert(nodeSources).values(row).onConflictDoNothing().run();
  }

  listByNode(nodeId: string) {
    return this.handle.db.select().from(nodeSources).where(eq(nodeSources.nodeId, nodeId)).all();
  }

  listBySource(sourceId: string) {
    return this.handle.db.select().from(nodeSources).where(eq(nodeSources.sourceId, sourceId)).all();
  }
}

export interface NodeTestRow {
  id: string;
  nodeId: string;
  type: string;
  status: string;
  startedAt: number;
  finishedAt: number | null;
  latencyMs: number | null;
  totalMs: number | null;
  tlsVersion: string | null;
  authorized: boolean | null;
  httpStatus: number | null;
  responseSize: number | null;
  error: string | null;
  family: number | null;
  probedIp: string | null;
  testEndpoint: string | null;
  engine: string | null;
}

export class NodeTestsRepository {
  constructor(private readonly handle: DbHandle) {}

  insert(row: NodeTestRow): void {
    this.handle.db.insert(nodeTests).values(row).run();
  }

  get(id: string): NodeTestRow | undefined {
    return this.handle.db.select().from(nodeTests).where(eq(nodeTests.id, id)).get();
  }

  listByNode(nodeId: string, limit = 200) {
    return this.handle.db
      .select()
      .from(nodeTests)
      .where(eq(nodeTests.nodeId, nodeId))
      .orderBy(desc(nodeTests.startedAt))
      .limit(Math.min(limit, 1000))
      .all();
  }

  update(id: string, patch: Partial<Omit<NodeTestRow, 'id' | 'nodeId' | 'type' | 'startedAt'>>): void {
    this.handle.db.update(nodeTests).set(patch as Partial<NodeTestRow>).where(eq(nodeTests.id, id)).run();
  }

  /** Finalize node_tests rows still `running` after a crash/force-kill. The
   *  in-process promises died with the old process, so these can never
   *  complete — left alone they poison history and engine attribution. */
  markRunningInterrupted(): number {
    const res = this.handle.db
      .update(nodeTests)
      .set({ status: 'failed', error: 'test interrupted: application restarted while the test was running', finishedAt: Date.now() })
      .where(eq(nodeTests.status, 'running'))
      .run();
    return res.changes;
  }

  recentForNode(nodeId: string, since: number) {
    return this.handle.db
      .select()
      .from(nodeTests)
      .where(and(eq(nodeTests.nodeId, nodeId), gte(nodeTests.startedAt, since)))
      .orderBy(desc(nodeTests.startedAt))
      .all();
  }

  countByNodeSince(nodeId: string, since: number, successOnly = false) {
    const q = this.handle.db
      .select({ n: count() })
      .from(nodeTests)
      .where(and(eq(nodeTests.nodeId, nodeId), gte(nodeTests.startedAt, since)));
    if (successOnly) {
      // Drizzle QI: re-build with extra clause appended
      return this.handle.db
        .select({ n: count() })
        .from(nodeTests)
        .where(and(eq(nodeTests.nodeId, nodeId), gte(nodeTests.startedAt, since), or(eq(nodeTests.status, 'done'), eq(nodeTests.status, 'healthy'))))
        .get();
    }
    return q.get();
  }
}

export interface NodeHealthRow {
  id: string;
  nodeId: string;
  testCount: number;
  successCount: number;
  failureCount: number;
  reliabilityPct: number;
  medianLatencyMs: number | null;
  p95LatencyMs: number | null;
  lossPct: number;
  latencyVariance: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  consecutiveFailures: number;
  healthyForMs: number | null;
  computedAt: number;
}

export class NodeHealthRepository {
  constructor(private readonly handle: DbHandle) {}

  get(nodeId: string): NodeHealthRow | undefined {
    return this.handle.db.select().from(nodeHealth).where(eq(nodeHealth.nodeId, nodeId)).get();
  }

  upsert(row: NodeHealthRow): void {
    this.handle.db
      .insert(nodeHealth)
      .values(row)
      .onConflictDoUpdate({ target: nodeHealth.nodeId, set: row })
      .run();
  }
}

export interface ScanJobRow {
  id: string;
  name: string;
  kind: string;
  status: string;
  filter: Record<string, unknown> | null;
  nodeIds: string[];
  concurrency: number;
  maxPerMinute: number;
  progress: number;
  discovered: number;
  tested: number;
  healthy: number;
  degraded: number;
  failed: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  createdAt: number;
}

export class ScanJobsRepository {
  constructor(private readonly handle: DbHandle) {}

  create(row: ScanJobRow): void {
    this.handle.db.insert(scanJobs).values(row).run();
  }

  get(id: string): ScanJobRow | undefined {
    return this.handle.db.select().from(scanJobs).where(eq(scanJobs.id, id)).get();
  }

  list(limit = 20) {
    return this.handle.db
      .select()
      .from(scanJobs)
      .orderBy(desc(scanJobs.createdAt))
      .limit(Math.min(limit, 100))
      .all();
  }

  update(id: string, patch: Partial<Omit<ScanJobRow, 'id' | 'createdAt'>>): void {
    this.handle.db.update(scanJobs).set(patch as Partial<ScanJobRow>).where(eq(scanJobs.id, id)).run();
  }

  /** Bump progress counters on a running job. */
  bumpProgress(id: string, patch: { progress?: number; tested?: number; healthy?: number; degraded?: number; failed?: number; discovered?: number }): void {
    this.handle.db.update(scanJobs).set(patch as Partial<ScanJobRow>).where(eq(scanJobs.id, id)).run();
  }

  finish(id: string, status: 'completed' | 'cancelled' | 'error', error?: string): void {
    this.handle.db.update(scanJobs).set({ status, finishedAt: Date.now(), error: error ?? null }).where(eq(scanJobs.id, id)).run();
  }

  clear(): number {
    const res = this.handle.db.delete(scanJobs).run();
    return res.changes;
  }
}

export interface TestEndpointRow {
  id: string;
  name: string;
  url: string;
  expectedStatus: number;
  timeoutMs: number;
  maxBytes: number;
  enabled: boolean;
  createdAt: number;
}

export class TestEndpointsRepository {
  constructor(private readonly handle: DbHandle) {}

  list(): TestEndpointRow[] {
    return this.handle.db.select().from(testEndpoints).where(eq(testEndpoints.enabled, true)).all();
  }

  get(id: string): TestEndpointRow | undefined {
    return this.handle.db.select().from(testEndpoints).where(eq(testEndpoints.id, id)).get();
  }

  insert(row: TestEndpointRow): void {
    this.handle.db.insert(testEndpoints).values(row).run();
  }

  update(id: string, patch: Partial<Omit<TestEndpointRow, 'id' | 'createdAt'>>): void {
    this.handle.db.update(testEndpoints).set(patch as Partial<TestEndpointRow>).where(eq(testEndpoints.id, id)).run();
  }

  remove(id: string): boolean {
    const res = this.handle.db.delete(testEndpoints).where(eq(testEndpoints.id, id)).run();
    return res.changes > 0;
  }
}

export interface NodeEventRow {
  id: number;
  kind: string;
  at: number;
  payload: Record<string, unknown>;
}

export class NodeEventsRepository {
  constructor(private readonly handle: DbHandle) {}

  insert(row: { kind: string; at: number; payload: Record<string, unknown> }): void {
    this.handle.db.insert(nodeEvents).values(row).run();
  }

  recent(kind?: string, limit = 200) {
    if (kind) {
      return this.handle.db
        .select()
        .from(nodeEvents)
        .where(eq(nodeEvents.kind, kind))
        .orderBy(desc(nodeEvents.at))
        .limit(Math.min(limit, 1000))
        .all();
    }
    return this.handle.db
      .select()
      .from(nodeEvents)
      .orderBy(desc(nodeEvents.at))
      .limit(Math.min(limit, 1000))
      .all();
  }
}

/** Union of every repository type used by the app context. */
export type AppRepositories = ReturnType<typeof createRepositories>;

/**
 * Single factory for the full repository set. Used both at boot (app.ts) and
 * by Reset App State (meta.ts) so the two can never drift apart.
 */
export function createRepositories(handle: DbHandle) {
  return {
    settings: new SettingsRepository(handle),
    events: new EventsRepository(handle),
    tests: new TestsRepository(handle),
    dnsBenchmarks: new DnsBenchmarksRepository(handle),
    servers: new ServersRepository(handle),
    serverHealth: new ServerHealthRepository(handle),
    scans: new ScanRepository(handle),
    stability: new StabilityRepository(handle),
    bufferbloat: new BufferbloatRepository(handle),
    gaming: new GamingRepository(handle),
    iranSessions: new IranSessionsRepository(handle),
    iranMeasurements: new IranMeasurementsRepository(handle),
    mapObservations: new MapObservationsRepository(handle),
    publicSources: new PublicSourcesRepository(handle),
    sourceFetches: new SourceFetchesRepository(handle),
    rawDocuments: new RawDocumentsRepository(handle),
    publicNodes: new PublicNodesRepository(handle),
    nodeSources: new NodeSourcesRepository(handle),
    nodeTests: new NodeTestsRepository(handle),
    nodeHealth: new NodeHealthRepository(handle),
    nodeAddresses: new NodeAddressesRepository(handle),
    nodeEvents: new NodeEventsRepository(handle),
    scanJobs: new ScanJobsRepository(handle),
    testEndpoints: new TestEndpointsRepository(handle),
    routeComparisons: new RouteComparisonRepository(handle),
    vpnConnections: new VpnConnectionRepository(handle),
    vpnProfiles: new VpnProfileRepository(handle),
  };
}
