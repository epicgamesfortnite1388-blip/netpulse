import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  role: text('role').notNull().default('admin'),
  createdAt: integer('created_at').notNull(),
});

export const servers = sqliteTable('servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['vps', 'diag', 'speedtest'] }).notNull(),
  host: text('host').notNull(),
  ipv4: text('ipv4'),
  ipv6: text('ipv6'),
  provider: text('provider'),
  region: text('region'),
  country: text('country'),
  city: text('city'),
  protocol: text('protocol'),
  port: integer('port'),
  capabilities: text('capabilities', { mode: 'json' }).$type<string[]>().notNull(),
  tags: text('tags', { mode: 'json' }).$type<string[]>().notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at').notNull(),
});

export const serverHealth = sqliteTable(
  'server_health',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    serverId: text('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    checkedAt: integer('checked_at').notNull(),
    pingMs: real('ping_ms'),
    jitterMs: real('jitter_ms'),
    packetLoss: real('packet_loss'),
    downloadMbps: real('download_mbps'),
    uploadMbps: real('upload_mbps'),
    status: text('status', { enum: ['online', 'degraded', 'offline'] }).notNull(),
    healthScore: real('health_score'),
  },
  (t) => [index('idx_server_health_server_ts').on(t.serverId, t.checkedAt)],
);

export const dnsProviders = sqliteTable('dns_providers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  ipv4: text('ipv4'),
  ipv6: text('ipv6'),
  dohUrl: text('doh_url'),
  dotHost: text('dot_host'),
  dnssec: integer('dnssec', { mode: 'boolean' }).notNull().default(false),
  kind: text('kind', { enum: ['public', 'custom'] }).notNull().default('custom'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at').notNull(),
});

export const vpnProviders = sqliteTable('vpn_providers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind', { enum: ['wireguard', 'openvpn', 'custom'] }).notNull(),
  config: text('config', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  createdAt: integer('created_at').notNull(),
});

export const vpnServers = sqliteTable('vpn_servers', {
  id: text('id').primaryKey(),
  serverId: text('server_id').references(() => servers.id, { onDelete: 'set null' }),
  providerId: text('provider_id')
    .notNull()
    .references(() => vpnProviders.id, { onDelete: 'cascade' }),
  endpoint: text('endpoint').notNull(),
  publicKey: text('public_key'),
  allowedIps: text('allowed_ips'),
  meta: text('meta', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  createdAt: integer('created_at').notNull(),
});

export const networkTests = sqliteTable(
  'network_tests',
  {
    id: text('id').primaryKey(),
    type: text('type').notNull(),
    status: text('status', { enum: ['running', 'done', 'error', 'cancelled'] }).notNull(),
    params: text('params', { mode: 'json' }).$type<Record<string, unknown>>(),
    summary: text('summary', { mode: 'json' }).$type<Record<string, unknown>>(),
    // Full test payload (same object published on the WS `test:done` message) so
    // a fresh visit or reload can render complete detail from the record alone.
    result: text('result', { mode: 'json' }).$type<Record<string, unknown>>(),
    error: text('error'),
    startedAt: integer('started_at').notNull(),
    finishedAt: integer('finished_at'),
  },
  (t) => [index('idx_network_tests_type_ts').on(t.type, t.startedAt)],
);

export const speedTests = sqliteTable('speed_tests', {
  id: text('id').primaryKey(),
  testId: text('test_id')
    .notNull()
    .references(() => networkTests.id, { onDelete: 'cascade' }),
  server: text('server'),
  downloadMbps: real('download_mbps'),
  uploadMbps: real('upload_mbps'),
  pingMin: real('ping_min'),
  pingAvg: real('ping_avg'),
  pingMax: real('ping_max'),
  pingMedian: real('ping_median'),
  jitterMs: real('jitter_ms'),
  packetLoss: real('packet_loss'),
  durationMs: integer('duration_ms'),
});

export const dnsBenchmarks = sqliteTable(
  'dns_benchmarks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    testId: text('test_id')
      .notNull()
      .references(() => networkTests.id, { onDelete: 'cascade' }),
    providerId: text('provider_id').notNull(),
    providerName: text('provider_name').notNull(),
    transport: text('transport', { enum: ['udp', 'doh', 'dot'] }).notNull(),
    queries: integer('queries').notNull(),
    ok: integer('ok').notNull(),
    timeouts: integer('timeouts').notNull(),
    errors: integer('errors').notNull(),
    latencyMinMs: real('latency_min_ms'),
    latencyAvgMs: real('latency_avg_ms'),
    latencyMedianMs: real('latency_median_ms'),
    latencyMaxMs: real('latency_max_ms'),
    latencyP95Ms: real('latency_p95_ms'),
    jitterMs: real('jitter_ms'),
    reliabilityPct: real('reliability_pct'),
    score: real('score'),
    dnssec: integer('dnssec', { mode: 'boolean' }),
    ipv6Ok: integer('ipv6_ok', { mode: 'boolean' }),
    vpnActive: integer('vpn_active', { mode: 'boolean' }).notNull().default(false),
    error: text('error'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('idx_dns_benchmarks_provider_ts').on(t.providerId, t.transport, t.createdAt),
    index('idx_dns_benchmarks_test').on(t.testId),
  ],
);

export const dnsTests = sqliteTable('dns_tests', {
  id: text('id').primaryKey(),
  testId: text('test_id')
    .notNull()
    .references(() => networkTests.id, { onDelete: 'cascade' }),
  providerId: text('provider_id').notNull(),
  providerName: text('provider_name').notNull(),
  latencyMs: real('latency_ms'),
  ok: integer('ok', { mode: 'boolean' }).notNull(),
  dnssec: integer('dnssec', { mode: 'boolean' }),
  transport: text('transport', { enum: ['udp', 'doh', 'dot'] }).notNull(),
});

export const routeTests = sqliteTable('route_tests', {
  id: text('id').primaryKey(),
  testId: text('test_id')
    .notNull()
    .references(() => networkTests.id, { onDelete: 'cascade' }),
  target: text('target').notNull(),
  resolvedIp: text('resolved_ip'),
  family: integer('family').notNull(),
  hopCount: integer('hop_count'),
  totalLatencyMs: real('total_latency_ms'),
  packetLoss: real('packet_loss'),
  score: real('score'),
  routeHash: text('route_hash'),
});

export const routeHops = sqliteTable(
  'route_hops',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    routeTestId: text('route_test_id')
      .notNull()
      .references(() => routeTests.id, { onDelete: 'cascade' }),
    hop: integer('hop').notNull(),
    ip: text('ip'),
    hostname: text('hostname'),
    latencyMs: real('latency_ms'),
    packetLoss: real('packet_loss'),
    asn: integer('asn'),
    org: text('org'),
    country: text('country'),
    status: text('status', { enum: ['ok', 'no_response', 'anonymous'] }).notNull(),
  },
  (t) => [index('idx_route_hops_test_hop').on(t.routeTestId, t.hop)],
);

export const endpointTests = sqliteTable('endpoint_tests', {
  id: text('id').primaryKey(),
  testId: text('test_id')
    .notNull()
    .references(() => networkTests.id, { onDelete: 'cascade' }),
  endpoint: text('endpoint').notNull(),
  hostname: text('hostname'),
  pingMs: real('ping_ms'),
  tcpMs: real('tcp_ms'),
  tlsMs: real('tls_ms'),
  httpMs: real('http_ms'),
  packetLoss: real('packet_loss'),
  score: real('score'),
  status: text('status').notNull(),
});

export const optimizationRuns = sqliteTable('optimization_runs', {
  id: text('id').primaryKey(),
  testId: text('test_id')
    .notNull()
    .references(() => networkTests.id, { onDelete: 'cascade' }),
  strategy: text('strategy').notNull(),
  weights: text('weights', { mode: 'json' }).$type<Record<string, number>>().notNull(),
  bestServerId: text('best_server_id'),
  result: text('result', { mode: 'json' }).$type<Record<string, unknown>>(),
});

export const optimizationResults = sqliteTable('optimization_results', {
  id: text('id').primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => optimizationRuns.id, { onDelete: 'cascade' }),
  serverId: text('server_id'),
  rank: integer('rank').notNull(),
  score: real('score').notNull(),
  metrics: text('metrics', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
});

export const ipLookups = sqliteTable('ip_lookups', {
  ip: text('ip').primaryKey(),
  family: integer('family').notNull(),
  data: text('data', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  fetchedAt: integer('fetched_at').notNull(),
});

export const networkEvents = sqliteTable(
  'network_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: integer('ts').notNull(),
    level: text('level', { enum: ['info', 'warn', 'error'] }).notNull(),
    category: text('category', { enum: ['network', 'vpn', 'dns', 'routing', 'system', 'gaming', 'connectivity', 'performance'] }).notNull(),
    message: text('message').notNull(),
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>(),
  },
  (t) => [index('idx_network_events_ts').on(t.ts), index('idx_network_events_level_cat').on(t.level, t.category)],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/* ------------------------- scanner / diagnostics ------------------------- */

export const cloudflareScans = sqliteTable('cloudflare_scans', {
  id: text('id').primaryKey(),
  status: text('status', { enum: ['running', 'completed', 'cancelled', 'error'] }).notNull(),
  config: text('config', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  startedAt: integer('started_at').notNull(),
  finishedAt: integer('finished_at'),
  discovered: integer('discovered').notNull().default(0),
  tested: integer('tested').notNull().default(0),
  alive: integer('alive').notNull().default(0),
  error: text('error'),
});

export const cloudflareCandidates = sqliteTable(
  'cloudflare_candidates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    scanId: text('scan_id')
      .notNull()
      .references(() => cloudflareScans.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    port: integer('port').notNull(),
    tcpMs: real('tcp_ms'),
    tlsMs: real('tls_ms'),
    httpMs: real('http_ms'),
    httpStatus: integer('http_status'),
    icmpAvgMs: real('icmp_avg_ms'),
    score: real('score'),
    status: text('status').notNull(),
    label: text('label').notNull(),
    favorite: integer('favorite', { mode: 'boolean' }).notNull().default(false),
    colo: text('colo'),
    loc: text('loc'),
    lossPct: real('loss_pct'),
    jitterMs: real('jitter_ms'),
    downloadMbps: real('download_mbps'),
    ttfbMs: real('ttfb_ms'),
    validated: integer('validated', { mode: 'boolean' }).notNull().default(false),
    clean: integer('clean', { mode: 'boolean' }),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_cf_candidates_scan_score').on(t.scanId, t.score), index('idx_cf_candidates_scan_clean').on(t.scanId, t.clean)],
);

export const mapObservations = sqliteTable(
  'map_observations',
  {
    id: text('id').primaryKey(),
    targetId: text('target_id').notNull(),
    targetType: text('target_type').notNull(),
    name: text('name').notNull(),
    family: integer('family'),
    ip: text('ip'),
    protocol: text('protocol'),
    port: integer('port'),
    vpnActive: integer('vpn_active', { mode: 'boolean' }).notNull().default(false),
    payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_map_observations_target_ts').on(t.targetId, t.createdAt)],
);

export const stabilitySamples = sqliteTable(
  'stability_samples',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    t: integer('t').notNull(),
    latencyMs: real('latency_ms'),
    jitterMs: real('jitter_ms'),
    lossPct: real('loss_pct'),
    dnsMs: real('dns_ms'),
    online: integer('online', { mode: 'boolean' }).notNull(),
  },
  (t) => [index('idx_stability_t').on(t.t)],
);

export const bufferbloatTests = sqliteTable('bufferbloat_tests', {
  id: text('id').primaryKey(),
  testId: text('test_id')
    .notNull()
    .references(() => networkTests.id, { onDelete: 'cascade' }),
  idleLatencyMs: real('idle_latency_ms'),
  downloadLoadMs: real('download_load_ms'),
  uploadLoadMs: real('upload_load_ms'),
  downloadIncreaseMs: real('download_increase_ms'),
  uploadIncreaseMs: real('upload_increase_ms'),
  grade: text('grade', { enum: ['A', 'B', 'C', 'D', 'F'] }),
});

export const routeComparisons = sqliteTable('route_comparisons', {
  id: text('id').primaryKey(),
  testId: text('test_id')
    .notNull()
    .references(() => networkTests.id, { onDelete: 'cascade' }),
  target: text('target').notNull(),
  routes: text('routes', { mode: 'json' }).$type<Record<string, unknown>[]>().notNull(),
  winner: text('winner'),
  reason: text('reason'),
});

export const vpnProfiles = sqliteTable(
  'vpn_profiles',
  {
    id: text('id').primaryKey(),
    providerId: text('provider_id').notNull(),
    name: text('name').notNull(),
    protocol: text('protocol').notNull(),
    endpoint: text('endpoint'),
    publicKeyFingerprint: text('public_key_fingerprint'),
    allowedIps: text('allowed_ips'),
    dnsServers: text('dns_servers'),
    secretRef: text('secret_ref').notNull(),
    configPath: text('config_path').notNull(),
    lastUsedAt: integer('last_used_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_vpn_profiles_created').on(t.createdAt)],
);

export const gamingSessionSamples = sqliteTable(
  'gaming_session_samples',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id').notNull(),
    gameId: text('game_id').notNull(),
    endpoint: text('endpoint'),
    ts: integer('ts').notNull(),
    latencyMs: real('latency_ms'),
    jitterMs: real('jitter_ms'),
    lossPct: real('loss_pct'),
    online: integer('online', { mode: 'boolean' }).notNull(),
    publicIp: text('public_ip'),
    vpnActive: integer('vpn_active', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [index('idx_gaming_session_samples_ts').on(t.sessionId, t.ts)],
);

export const gamingComparisons = sqliteTable(
  'gaming_comparisons',
  {
    id: text('id').primaryKey(),
    testId: text('test_id')
      .notNull()
      .references(() => networkTests.id, { onDelete: 'cascade' }),
    gameId: text('game_id').notNull(),
    mode: text('mode', { enum: ['direct', 'vpn'] }).notNull(),
    serverName: text('server_name'),
    latencyMs: real('latency_ms'),
    jitterMs: real('jitter_ms'),
    lossPct: real('loss_pct'),
    score: real('score'),
    notes: text('notes'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_gaming_comparisons_game_ts').on(t.gameId, t.createdAt)],
);

export const iranSessions = sqliteTable(
  'iran_sessions',
  {
    id: text('id').primaryKey(),
    payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_iran_sessions_created').on(t.createdAt)],
);

export const iranMeasurements = sqliteTable(
  'iran_measurements',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    targetId: text('target_id').notNull(),
    connectionId: text('connection_id').notNull(),
    connectionName: text('connection_name').notNull(),
    payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('idx_iran_measurements_session').on(t.sessionId), index('idx_iran_measurements_target_ts').on(t.targetId, t.createdAt)],
);

export const vpnConnections = sqliteTable('vpn_connections', {
  id: text('id').primaryKey(),
  providerId: text('provider_id').notNull(),
  serverId: text('server_id'),
  serverName: text('server_name'),
  endpoint: text('endpoint'),
  protocol: text('protocol').notNull(),
  status: text('status', { enum: ['connecting', 'connected', 'disconnected', 'error'] }).notNull(),
  connectedAt: integer('connected_at'),
  disconnectedAt: integer('disconnected_at'),
  rxBytes: integer('rx_bytes'),
  txBytes: integer('tx_bytes'),
  error: text('error'),
});

/* ------------------------- public nodes / config intelligence ------------------------- */

export const publicSources = sqliteTable('public_sources', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  homepage: text('homepage'),
  repositoryUrl: text('repository_url'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  type: text('type').notNull().default('custom'),
  urls: text('urls', { mode: 'json' }).$type<string[]>().notNull().default([]),
  formats: text('formats', { mode: 'json' }).$type<string[]>().notNull().default([]),
  intervalMinutes: integer('interval_minutes').notNull().default(60),
  lastFetch: integer('last_fetch'),
  lastSuccess: integer('last_success'),
  lastFailure: integer('last_failure'),
  status: text('status').notNull().default('idle'),
  discoveredConfigCount: integer('discovered_config_count').notNull().default(0),
  importedConfigCount: integer('imported_config_count').notNull().default(0),
  duplicateCount: integer('duplicate_count').notNull().default(0),
  invalidCount: integer('invalid_count').notNull().default(0),
  recentDiscovered: integer('recent_discovered').notNull().default(0),
  recentImported: integer('recent_imported').notNull().default(0),
  recentHealthy: integer('recent_healthy').notNull().default(0),
  health: text('health').notNull().default('unknown'),
  lastContentHash: text('last_content_hash'),
  notes: text('notes'),
  createdAt: integer('created_at').notNull(),
});

export const sourceFetches = sqliteTable('source_fetches', {
  id: text('id').primaryKey(),
  sourceId: text('source_id').notNull().references(() => publicSources.id, { onDelete: 'cascade' }),
  startedAt: integer('started_at').notNull(),
  finishedAt: integer('finished_at'),
  url: text('url'),
  status: text('status').notNull().default('running'),
  rawBytes: integer('raw_bytes'),
  configCount: integer('config_count').notNull().default(0),
  importedCount: integer('imported_count').notNull().default(0),
  duplicateCount: integer('duplicate_count').notNull().default(0),
  invalidCount: integer('invalid_count').notNull().default(0),
  error: text('error'),
  contentHash: text('content_hash'),
});

export const rawDocuments = sqliteTable('raw_documents', {
  id: text('id').primaryKey(),
  sourceId: text('source_id').notNull().references(() => publicSources.id, { onDelete: 'cascade' }),
  fetchId: text('fetch_id').notNull().references(() => sourceFetches.id, { onDelete: 'cascade' }),
  sourceUrl: text('source_url').notNull(),
  originalText: text('original_text').notNull(),
  originalHash: text('original_hash').notNull(),
  detectedFormat: text('detected_format').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  parsedAt: integer('parsed_at'),
  configCount: integer('config_count').notNull().default(0),
  error: text('error'),
  fetchedAt: integer('fetched_at').notNull(),
});

export const publicNodes = sqliteTable('public_nodes', {
  id: text('id').primaryKey(),
  canonicalFingerprint: text('canonical_fingerprint').notNull().unique(),
  protocol: text('protocol').notNull().default('unknown'),
  host: text('host').notNull(),
  ipv4: text('ipv4', { mode: 'json' }).$type<string[]>().notNull().default([]),
  ipv6: text('ipv6', { mode: 'json' }).$type<string[]>().notNull().default([]),
  port: integer('port').notNull().default(443),
  transport: text('transport').notNull().default('tcp'),
  security: text('security').notNull().default('none'),
  sni: text('sni'),
  alpn: text('alpn', { mode: 'json' }).$type<string[]>().notNull().default([]),
  fingerprint: text('fingerprint'),
  flow: text('flow'),
  alterId: integer('alter_id'),
  path: text('path'),
  hostHeader: text('host_header'),
  serviceName: text('service_name'),
  allowInsecure: integer('allow_insecure', { mode: 'boolean' }).notNull().default(false),
  realityPublicKey: text('reality_public_key'),
  realityShortId: text('reality_short_id'),
  realityServerName: text('reality_server_name'),
  encryption: text('encryption'),
  ssrProtocol: text('ssr_protocol'),
  remark: text('remark'),
  sourceIds: text('source_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
  sourceUrls: text('source_urls', { mode: 'json' }).$type<string[]>().notNull().default([]),
  sourceCount: integer('source_count').notNull().default(1),
  firstSeen: integer('first_seen').notNull(),
  lastSeen: integer('last_seen').notNull(),
  lastValidated: integer('last_validated'),
  status: text('status').notNull().default('discovered'),
  confidence: text('confidence').notNull().default('unknown'),
  country: text('country'),
  city: text('city'),
  asn: integer('asn'),
  isp: text('isp'),
  organization: text('organization'),
  lat: real('lat'),
  lon: real('lon'),
  geoSourceCount: integer('geo_source_count').notNull().default(0),
  tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
  favorite: integer('favorite', { mode: 'boolean' }).notNull().default(false),
  userNotes: text('user_notes'),
  lastProxyMs: real('last_proxy_ms'),
  geoLastAttempt: integer('geo_last_attempt'),
  lastTcpMs: real('last_tcp_ms'),
  lastTlsMs: real('last_tls_ms'),
  testCount: integer('test_count').notNull().default(0),
  successCount: integer('success_count').notNull().default(0),
  failureCount: integer('failure_count').notNull().default(0),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  recentTestCount: integer('recent_test_count').notNull().default(0),
  recentSuccessCount: integer('recent_success_count').notNull().default(0),
  recentFailureCount: integer('recent_failure_count').notNull().default(0),
  score: real('score').notNull().default(0),
  reliabilityPct: real('reliability_pct').notNull().default(0),
  medianProxyMs: real('median_proxy_ms'),
  medianTcpMs: real('median_tcp_ms'),
  medianTlsMs: real('median_tls_ms'),
  recentLossPct: real('recent_loss_pct').notNull().default(0),
  lastSuccessAt: integer('last_success_at'),
  lastFailureAt: integer('last_failure_at'),
  freshness: text('freshness').notNull().default('stale'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [
  index('idx_nodes_protocol').on(t.protocol),
  index('idx_nodes_country').on(t.country),
  index('idx_nodes_asn').on(t.asn),
  index('idx_nodes_status').on(t.status),
  index('idx_nodes_score').on(t.score),
  index('idx_nodes_last_validated').on(t.lastValidated),
  index('idx_nodes_freshness').on(t.freshness),
  index('idx_nodes_created').on(t.createdAt),
  index('idx_nodes_fingerprint').on(t.canonicalFingerprint),
  index('idx_nodes_host').on(t.host),
  index('idx_nodes_port').on(t.port),
]);
export const nodeAddresses = sqliteTable('node_addresses', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  nodeId: text('node_id').notNull().references(() => publicNodes.id, { onDelete: 'cascade' }),
  ip: text('ip').notNull(),
  family: integer('family').notNull(),
  firstSeen: integer('first_seen').notNull(),
  lastSeen: integer('last_seen').notNull(),
}, (t) => [index('idx_node_addresses_ip').on(t.ip), index('idx_node_addresses_node').on(t.nodeId, t.ip)]);
export const nodeSources = sqliteTable('node_sources', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  nodeId: text('node_id').notNull().references(() => publicNodes.id, { onDelete: 'cascade' }),
  sourceId: text('source_id').notNull().references(() => publicSources.id, { onDelete: 'cascade' }),
  sourceUrl: text('source_url').notNull(),
  sourceConfigRef: text('source_config_ref').notNull(),
  parserVersion: text('parser_version').notNull().default('1.0.0'),
  normalizedHash: text('normalized_hash').notNull(),
  discoveredAt: integer('discovered_at').notNull(),
}, (t) => [index('idx_node_sources_node').on(t.nodeId), index('idx_node_sources_source').on(t.sourceId)]);
export const nodeTests = sqliteTable('node_tests', {
  id: text('id').primaryKey(),
  nodeId: text('node_id').notNull().references(() => publicNodes.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  status: text('status').notNull().default('running'),
  startedAt: integer('started_at').notNull(),
  finishedAt: integer('finished_at'),
  latencyMs: real('latency_ms'),
  totalMs: real('total_ms'),
  tlsVersion: text('tls_version'),
  authorized: integer('authorized', { mode: 'boolean' }),
  httpStatus: integer('http_status'),
  responseSize: integer('response_size'),
  error: text('error'),
  family: integer('family'),
  probedIp: text('probed_ip'),
  testEndpoint: text('test_endpoint'),
  /** which local core produced a proxy result: xray | sing-box */
  engine: text('engine'),
}, (t) => [index('idx_node_tests_node').on(t.nodeId), index('idx_node_tests_type_ts').on(t.type, t.startedAt)]);
export const nodeHealth = sqliteTable('node_health', {
  id: text('id').primaryKey(),
  nodeId: text('node_id').notNull().references(() => publicNodes.id, { onDelete: 'cascade' }),
  testCount: integer('test_count').notNull().default(0),
  successCount: integer('success_count').notNull().default(0),
  failureCount: integer('failure_count').notNull().default(0),
  reliabilityPct: real('reliability_pct').notNull().default(0),
  medianLatencyMs: real('median_latency_ms'),
  p95LatencyMs: real('p95_latency_ms'),
  lossPct: real('loss_pct').notNull().default(0),
  latencyVariance: real('latency_variance'),
  lastSuccessAt: integer('last_success_at'),
  lastFailureAt: integer('last_failure_at'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  healthyForMs: integer('healthy_for_ms'),
  computedAt: integer('computed_at').notNull(),
}, (t) => [index('idx_node_health_node').on(t.nodeId)]);
export const scanJobs = sqliteTable('scan_jobs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind').notNull().default('test'),
  status: text('status').notNull().default('queued'),
  filter: text('filter', { mode: 'json' }).$type<Record<string, unknown>>(),
  nodeIds: text('node_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
  concurrency: integer('concurrency').notNull().default(10),
  maxPerMinute: integer('max_per_minute').notNull().default(600),
  progress: integer('progress').notNull().default(0),
  discovered: integer('discovered').notNull().default(0),
  tested: integer('tested').notNull().default(0),
  healthy: integer('healthy').notNull().default(0),
  degraded: integer('degraded').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  startedAt: integer('started_at'),
  finishedAt: integer('finished_at'),
  error: text('error'),
  createdAt: integer('created_at').notNull(),
}, (t) => [index('idx_scan_jobs_status').on(t.status)]);
export const testEndpoints = sqliteTable('test_endpoints', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  expectedStatus: integer('expected_status').notNull().default(200),
  timeoutMs: integer('timeout_ms').notNull().default(5000),
  maxBytes: integer('max_bytes').notNull().default(4096),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at').notNull(),
});
export const nodeEvents = sqliteTable('node_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind').notNull(),
  at: integer('at').notNull(),
  payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
}, (t) => [index('idx_node_events_kind_ts').on(t.kind, t.at)]);
