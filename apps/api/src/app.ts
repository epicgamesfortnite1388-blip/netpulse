import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { LogController as FastifyLogController, type FastifyBaseLogger } from 'fastify';
import pino from 'pino';

import { normalizeBypass } from '@netpulse/shared';

import { createAuth, ensureDaemonToken } from './auth';
import { loadConfig } from './config';
import { openDb } from './db/client';
import { RetentionService, RETENTION_INTERVAL_MS } from './db/retention';
import { enrichNodeGeoBatch, scrubAnycastGeo, setGeoPreferenceSource } from './services/nodeGeoService';
import { defaultGeoOverridePath, geoOverrideError, setGeoOverrideFile } from './services/geoGuard';
import { NodeTestScheduler } from './services/nodeTestScheduler';
import { GatewayMemoryService } from './services/gatewayMemory';
import { VpnHistoryService } from './services/vpnHistory';
import { NodeDiscoveryService } from './services/nodeDiscovery';
import { createRepositories } from './db/repositories';
import { registerHealthRoutes } from './routes/health';
import { registerErrorHandler } from './plugins/errorHandler';
import { createPlatformController } from './providers/platform';
import { ProviderRegistry } from './providers/registry';
import type { ReputationProvider } from './providers/reputation/types';
import { RealtimeBus } from './realtime/bus';
import { registerWsRoute } from './realtime/wsRoute';
import { registerAuthRoutes } from './routes/auth';
import type { AppContext } from './routes/context';
import { registerDiagnosticRoutes } from './routes/diagnostics';
import { registerDnsRoutes } from './routes/dns';
import { registerGamingRoutes } from './routes/gaming';
import { registerEndpointRoutes } from './routes/endpoints';
import { registerEventRoutes } from './routes/events';
import { registerHistoryRoutes } from './routes/history';
import { registerIpRoutes } from './routes/ip';
import { registerIranRoutes } from './routes/iran';
import { registerMapRoutes } from './routes/map';
import { registerMetaRoutes } from './routes/meta';
import { registerNetworkRoutes } from './routes/network';
import { registerOptimizerRoutes } from './routes/optimizer';
import { registerPingRoutes } from './routes/ping';
import { registerRouteRoutes } from './routes/routes';
import { registerServerRoutes } from './routes/servers';
import { registerSettingsRoutes } from './routes/settings';
import { registerSpeedRoutes } from './routes/speed';
import { registerStabilityRoutes } from './routes/stability';
import { registerVpnRoutes } from './routes/vpn';
import { registerTunnelRoutes } from './routes/tunnel';
import { registerWebrtcRoutes } from './routes/webrtc';
import { registerNodesRoutes } from './routes/nodes';
import { registerUpdateFeedRoutes } from './routes/updateFeed';

import { DiagnosticsService } from './services/diagnosticsService';
import { DnsService } from './services/dnsService';
import { GamingService } from './services/gamingService';
import { EndpointService } from './services/endpointService';
import { EventService } from './services/eventService';
import { HealthMonitorService } from './services/healthMonitor';
import { IpInfoService } from './services/ipInfoService';
import { IranService } from './services/iranService';
import { MapService } from './services/mapService';
import { OptimizerService } from './services/optimizerService';
import { PingService } from './services/pingService';
import { RouteService } from './services/routeService';
import { ScheduleService } from './services/scheduleService';
import { VpnSelfTestService } from './services/vpnSelfTestService';
import { SelectionService } from './services/selectionService';
import { NodesService } from './services/nodesService';
import { NodeSecretVault } from './services/nodeSecretVault';
import { ProxyTunnelService, fetchThroughHttpProxy } from './services/proxyTunnel';
import { getSystemProxy, setSystemProxy } from './services/systemProxy';
import { KillSwitchService } from './services/killSwitch';
import { SourceRefreshScheduler, seedKnownSources } from './services/nodeSourceRegistry';
import { SettingsService } from './services/settingsService';
import { SpeedService } from './services/speedService';
import { StabilityService } from './services/stabilityService';
import { createVpnRegistry } from './vpn/vpnService';
import { ElevationBroker } from './vpn/elevationBroker';
import { VpnDropWatchdog } from './vpn/vpnWatchdog';
import type { VpnProviderHooks } from './vpn/vpnService';

import type { IcmpPingOptions, PlatformNetworkController, TracerouteOptions } from './providers/platform/types';
import type { AppConfig } from './config';

export interface BuildOptions {
  configOverrides?: Partial<AppConfig>;
  controller?: PlatformNetworkController;
  /**
   * Desktop mode: use this in-memory daemon token instead of generating and
   * persisting one to disk. The Tauri supervisor generates it (CSPRNG), hands
   * it to the webview via typed IPC and to this process via stdin/env.
   */
  daemonToken?: string;
}

const PUBLIC_API_PATHS = new Set([
  '/api/v1/meta',
  '/api/v1/auth/session',
  // The Tauri updater process polls these; it is not the webview and cannot
  // hold the per-launch bearer secret. Serves only release metadata whose
  // signature the CLIENT verifies against the compiled-in pubkey.
  '/api/v1/update-feed/latest.json',
  '/api/v1/update-feed/artifact',
]);
/**
 * Paths that skip the cookie/bearer auth hook because they authenticate
 * differently: the WS upgrade authenticates with a single-use ticket inside
 * registerWsRoute (browser WS handshakes can neither send Bearer headers nor
 * SameSite=strict cookies).
 */
const WS_AUTH_PATHS = new Set(['/api/v1/ws']);

/**
 * Safe Mode network controller: every probe fails fast with a typed 503 so
 * route handlers never hang on sockets/processes while the user repairs the
 * installation. `detectVpnBinaries` reports honestly instead of probing.
 */
function createNullController(): PlatformNetworkController {
  const refused = () =>
    Object.assign(new Error('Safe Mode is active: networking is disabled until you exit Safe Mode in Settings.'), {
      statusCode: 503,
      code: 'safe_mode_network_disabled',
    });
  return {
    id: 'safe-mode-null',
    icmpPing: async (_ip: string, opts: IcmpPingOptions) => {
      void opts;
      throw refused();
    },
    tcpProbe: async () => {
      throw refused();
    },
    systemDnsServers: async () => {
      throw refused();
    },
    traceroute: async (_ip: string, _opts: TracerouteOptions) => {
      void _ip;
      void _opts;
      throw refused();
    },
    mtuProbe: async () => {
      throw refused();
    },
    detectVpnBinaries: async () => ({ wireguard: false, openvpn: false, singbox: false }),
  };
}

export async function buildApp(opts: BuildOptions = {}) {
  const config = loadConfig(process.env, process.cwd(), opts.configOverrides);

  // -- Stage journal: one structured line per boot stage, written to stderr so
  // the desktop log captures it via the supervisor's stderr pipe. In Safe Mode
  // the sidecar refuses ALL network initialization before anything else runs.
  // Safe Mode always yields a functioning GUI + Settings — network-heavy
  // construction below (IP reputation, VPN binaries, schedulers) is skipped.
  const safeMode = config.safeMode === true;
  process.stderr.write(`[netpulse] boot stage=config:ok safeMode=${safeMode} dataDir=${config.dataDir}\n`);

  // Desktop mode: ephemeral in-memory token (never persisted). Web/dev mode:
  // token file in the data dir so a local browser can authenticate.
  const daemonToken = opts.daemonToken ?? ensureDaemonToken(config.tokenFile);

  const auth = createAuth({
    daemonToken,
    sessionTtlMs: config.sessionTtlMs,
    allowedOrigins: [
      ...config.corsOrigins,
      `http://localhost:${config.port}`,
      `http://127.0.0.1:${config.port}`,
    ],
    // Desktop mode: the Tauri shell sets NETPULSE_DESKTOP=1 on the sidecar and
    // injects the per-launch secret. There, cookies leave the trust chain
    // entirely — see AuthOptions.desktopMode.
    desktopMode: process.env['NETPULSE_DESKTOP'] === '1',
  });

  const db = openDb(config);
  process.stderr.write('[netpulse] boot stage=db:ok\n');
  const repos = createRepositories(db);

  // Seed built-in public sources into the DB (idempotent, never overwrites
  // user state). Without this, built-in Fetch/Disable looked up DB rows that
  // never existed and every fetch 502'd with "source not found".
  seedKnownSources(repos.publicSources);

  // VPN providers persist profiles durably and record events/connections;
  // the public-IP probe lets them verify that tunnels actually route traffic.
  const vpnHooks: VpnProviderHooks = {
    saveProfile: (providerId, profile) => repos.vpnProfiles.insert({
      id: profile.id,
      providerId,
      name: profile.name,
      protocol: profile.protocol,
      endpoint: profile.endpoint,
      publicKeyFingerprint: profile.publicKeyFingerprint,
      allowedIps: profile.allowedIps ? profile.allowedIps.join(',') : null,
      dnsServers: profile.dns ? profile.dns.join(',') : null,
      secretRef: profile.secretRef,
      configPath: profile.configPath,
      lastUsedAt: null,
      createdAt: profile.createdAt,
    }),
    recordConnection: (row) => repos.vpnConnections.insert(row),
    updateConnection: (id, patch) => repos.vpnConnections.update(id, patch),
    publicIpProbe: async () => {
      const info = await ipInfo.lookup(4, { force: true });
      return info.ip;
    },
    event: (level, message, data) => events.record(level, 'vpn', message, data),
  };

  // Kill switch — one owner for "what happens to the OS proxy when a
  // proxy-mode tunnel drops": fail closed when the user enabled it, restore
  // their own proxy when they did not. The bypass getter is the SAME rule set
  // the split-tunnel feature applies, so "non-bypassed" means exactly what the
  // user configured (and what Aether receives as [direct] routes).
  const killSwitch = new KillSwitchService({
    setSystemProxy: (p) => setSystemProxy(p),
    getSystemProxy: () => getSystemProxy(),
    enabled: () => { try { return settings.get().vpn?.killSwitch === true; } catch { return false; } },
    bypass: () => {
      try {
        const b = settings.get().vpn?.bypass;
        return b?.enabled ? normalizeBypass(b) : null;
      } catch {
        return null;
      }
    },
    event: (level, message) => events.record(level, 'vpn', message),
    publish: (kind, payload) => bus.publish('vpn', { type: kind, ...payload }),
    // Persisted so a crash while fail-closed cannot strand the machine with a
    // dead sink proxy and no process left to explain it.
    loadHold: () => repos.settings.get('killswitch.hold') as { previousProxy: string | null; label: string; blocking: boolean } | null,
    saveHold: (record) => {
      if (record) repos.settings.put('killswitch.hold', record as unknown as Record<string, unknown>);
      else repos.settings.put('killswitch.hold', {});
    },
  });
  // Boot recovery runs once the service exists (never blocks startup on a
  // registry read that may legitimately fail).
  void killSwitch.recoverAfterRestart().catch(() => undefined);
  // The Aether provider reads the same live rule set and preference, so both
  // proxy-mode engines answer to one kill switch and one bypass list.
  vpnHooks.aether = {
    killSwitch,
    bypass: () => {
      try {
        const b = settings.get().vpn?.bypass;
        return b?.enabled ? normalizeBypass(b) : null;
      } catch {
        return null;
      }
    },
    killSwitchEnabled: () => { try { return settings.get().vpn?.killSwitch === true; } catch { return false; } },
  };

  const log = pino({
    level: config.isTest ? 'silent' : config.logLevel,
    // Redact secrets from any structured log line: bearer tokens, cookies,
    // session tokens, and connection material must never reach log files
    // or the desktop log viewer.
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers.set-cookie',
        'password',
        'token',
        'secret',
        'privateKey',
        'private_key',
        'presharedKey',
        'preshared_key',
        '*.password',
        '*.token',
        '*.secret',
        '*.privateKey',
        '*.private_key',
        '*.presharedKey',
        '*.preshared_key',
      ],
      censor: '[REDACTED]',
    },
  });
  const bus = new RealtimeBus();
  // Per-action elevation broker: the UI + Rust bridge drive ONE UAC prompt per
  // WireGuard connect; descriptors are nonce-bound, single-use and expire.
  const elevationBroker = new ElevationBroker({ appDataDir: config.dataDir, bus, log });
  const controller = opts.controller ?? (safeMode ? createNullController() : createPlatformController());
  const reputationProviders = new ProviderRegistry<ReputationProvider>();
  const vpn = createVpnRegistry(path.join(config.dataDir, 'secrets'), path.join(config.dataDir, 'vpn-profiles'), vpnHooks);

  // Drop watchdog: bounded reconnect with backoff when a managed tunnel
  // disappears unexpectedly (engine crash, sleep/resume, adapter change).
  // Skipped in Safe Mode (no network at all) and under tests (no timers).
  const vpnWatchdog = new VpnDropWatchdog(vpn, {
    log,
    bus,
    event: (level, message, data) => events.record(level, 'vpn', message, data),
  });
  if (!config.isTest && !safeMode) vpnWatchdog.start();

  // Bounded data-retention sweeper (interval set below, next to the other
  // schedulers; timer handle is cleared in onClose).
  const retention = new RetentionService(db, log);
  let retentionTimer: NodeJS.Timeout | null = null;

  // IP-evidence geolocation for imported nodes — periodic, bounded, and
  // entirely disabled in tests/Safe Mode like every other network worker.
  let geoTimer: NodeJS.Timeout | null = null;

  const events = new EventService(repos.events);
  const settings = new SettingsService(repos.settings);
  // Geo lookups read the user's provider preference live (cheap: cached settings).
  setGeoPreferenceSource(() => settings.get().geoProvider?.preferred ?? 'auto');
  const ipInfo = new IpInfoService({ reputationProviders });
  const ping = new PingService({ controller, tests: repos.tests, events, settings, bus, log });
  const route = new RouteService({ controller, tests: repos.tests, comparisons: repos.routeComparisons, events, settings, bus, vpn, log });
  const dns = new DnsService({ controller, tests: repos.tests, benchmarks: repos.dnsBenchmarks, events, settings, bus, vpn, log });
  const speed = new SpeedService({ controller, tests: repos.tests, events, bus, db, log });
  const endpoint = new EndpointService({ controller, tests: repos.tests, scans: repos.scans, events, settings, bus, log });
  const gaming = new GamingService({ controller, tests: repos.tests, gaming: repos.gaming, events, ipInfo, bus, vpn, log });
  const diagnostics = new DiagnosticsService({ controller, tests: repos.tests, bufferbloat: repos.bufferbloat, events, settings, bus, log, ipInfo, dns, speed, route });
  const stability = new StabilityService({ controller, stability: repos.stability, events, bus, log });
  const optimizer = new OptimizerService({ controller, tests: repos.tests, events, settings, bus, log });
  const selection = new SelectionService({ controller, tests: repos.tests, events, settings, bus, log });
  const healthMonitor = new HealthMonitorService({ controller, servers: repos.servers, health: repos.serverHealth, events, log });
  const vpnSelfTest = new VpnSelfTestService({ vpn, controller, settings, events, bus, log });
  const schedule = new ScheduleService({ settings, dns, gaming, vpnSelfTest, events, bus, log });
  const iran = new IranService({
    route,
    ipInfo,
    vpn,
    events,
    bus,
    sessions: repos.iranSessions,
    measurements: repos.iranMeasurements,
    log,
  });
  const map = new MapService({
    controller,
    route,
    ipInfo,
    vpn,
    scans: repos.scans,
    servers: repos.servers,
    observations: repos.mapObservations,
    events,
    bus,
    log,
    // Geo-verified public nodes (IP-evidence geolocation only — the geo
    // worker writes coordinates; name/TLD/remark never produce a pin).
    verifiedNodes: () => {
      try {
        const rows = repos.publicNodes.list({ minScore: 0, limit: 200 }).rows.filter((n) => n.lat != null && n.lon != null);
        return rows.slice(0, 12).map((n) => ({
          id: n.id,
          label: n.remark ? `${n.remark.slice(0, 40)} · ${n.country ?? 'Unknown'}` : `Node ${n.host}`,
          host: n.host,
          port: n.port,
          protocol: n.transport === 'ws' ? 'tcp' : 'tcp',
          region: n.city ? `${n.city}, ${n.country ?? ''}`.trim().replace(/,\s*$/, '') : n.country,
          source: n.sourceUrls?.[0] ? `Source ${n.sourceUrls[0].slice(0, 60)}` : 'Public node source',
        }));
      } catch {
        return [];
      }
    },
  });
  const nodeVault = new NodeSecretVault(path.join(config.dataDir, 'secrets', 'vault'));

  const nodesService = new NodesService({
    nodes: repos.publicNodes,
    sources: repos.nodeSources,
    tests: repos.nodeTests,
    health: repos.nodeHealth,
    addresses: repos.nodeAddresses,
    sourceRepo: repos.publicSources,
    fetches: repos.sourceFetches,
    docs: repos.rawDocuments,
    scanJobs: repos.scanJobs,
    testEndpoints: repos.testEndpoints,
    events: repos.nodeEvents,
    controller,
    bus,
    log,
    // Encrypted at-rest vault for node credentials; proxy tests dial with the
    // node's REAL uuid/password (without this, vless/vmess/trojan/ss tests
    // can only ever fail authentication).
    nodeVault,
    settings,
  });

  // Gateway memory — the gateways this app has personally verified, kept
  // across restarts so a reconnect can retry what last worked before scanning.
  const gatewayMemory = new GatewayMemoryService({ store: repos.settings, log });

  // Proxy tunnel — one long-lived local core (xray/sing-box/v2ray) the system
  // can be routed through. Verified exit IP, crash detection with bounded
  // auto-reconnect, system-proxy handoff with restore.
  const proxyTunnel = new ProxyTunnelService({
    nodeVault,
    fetchThroughPort: (port, url, timeoutMs) => fetchThroughHttpProxy(port, url, timeoutMs),
    setSystemProxy: (p) => setSystemProxy(p),
    getSystemProxy: () => getSystemProxy(),
    publish: (kind, payload) => bus.publish('nodes', { type: kind, ...payload }),
    killSwitch,
    // Same live preference the Aether provider reads: a route-mode hold the
    // user asked for must never be skipped without the status saying so.
    killSwitchEnabled: () => {
      try {
        return settings.get().vpn?.killSwitch === true;
      } catch {
        return false;
      }
    },
    log: { info: (m) => log.info(m), warn: (m) => log.warn(m), error: (m) => log.error(m) },
    // Memory is written from the verified path only, so an entry always means
    // "this node provably carried traffic", never "this node looked fine".
    onVerifiedGateway: (input) => {
      gatewayMemory.remember(input);
    },
    onGatewayFailed: (nodeId) => {
      gatewayMemory.markFailed(nodeId);
    },
  });

  // Discovery — bounded, profile-driven search for a node worth connecting
  // to. Depth comes from the profile (turbo=TCP handshake … ironclad=real
  // proxied request); the report states which was actually proven.
  const nodeDiscovery = new NodeDiscoveryService({
    pickCandidates: ({ limit, protocol }) => {
      const { rows } = repos.publicNodes.list({
        limit,
        sortField: 'score',
        sortDir: 'desc',
        ...(protocol ? { protocol } : {}),
      });
      return rows
        .filter((r) => r.status !== 'stale')
        .map((r) => ({
          id: r.id,
          name: r.remark ?? null,
          host: r.host,
          port: r.port,
          protocol: r.protocol,
        }));
    },
    probe: async (nodeId, depth, _timeoutMs) => {
      try {
        const result = await nodesService.testNode(nodeId, depth);
        const ok = result.status === 'done';
        return {
          ok,
          latencyMs: result.latencyMs ?? result.totalMs ?? null,
          failure: ok ? null : (result.error ?? `test finished as ${result.status}`),
        };
      } catch (err) {
        return { ok: false, latencyMs: null, failure: err instanceof Error ? err.message : String(err) };
      }
    },
    log,
    // Progress travels on its own topic so the discovery surface can subscribe
    // without receiving every unrelated node event. The frame carries the real
    // per-candidate counts; the UI renders an indeterminate bar until one
    // arrives rather than inventing a percentage.
    onProgress: (p) =>
      bus.publish('discovery', {
        type: 'discovery:progress',
        task: 'discovery',
        pct: p.total > 0 ? Math.round((p.done / p.total) * 100) : 0,
        message: `${p.done} of ${p.total} candidates (${p.profile})`,
        done: p.done,
        total: p.total,
        profile: p.profile,
      }),
  });

  // Adaptive node tester — bounded TCP-probe batches on a settings-driven
  // cadence (never-validated first, then stale-good, then unstable; retires
  // dead+unseen nodes). Disabled in tests/Safe Mode like all network workers.
  const nodeTestScheduler = new NodeTestScheduler({ nodes: nodesService, settings, log });

  // VPN history — persists discovery/quick-connect runs and aggregates them
  // (with gateway memory) into the dashboard report. Recording failures are
  // warn-only by design: history must never break a connect.
  const vpnHistory = new VpnHistoryService({ events: repos.nodeEvents, gatewayMemory, log });

  // Source refresh scheduler — periodically re-fetches enabled public sources.
  const sourceScheduler = new SourceRefreshScheduler([], async (source) => {
    log.info({ sourceId: source.id }, 'scheduled source refresh');
    try {
      await nodesService.discoverFromSource(source.id);
    } catch (err) {
      log.warn({ sourceId: source.id, error: err instanceof Error ? err.message : String(err) }, 'scheduled source refresh failed');
    }
  }, log);
  sourceScheduler.start({ enabled: false, intervalMinutes: 60, onSourceFetched: undefined });

  const services = {
    events,
    settings,
    ipInfo,
    ping,
    route,
    dns,
    speed,
    endpoint,
    gaming,
    diagnostics,
    stability,
    optimizer,
    selection,
    healthMonitor,
    schedule,
    vpnSelfTest,
    tunnel: proxyTunnel,
    killSwitch,
    gatewayMemory,
    discovery: nodeDiscovery,
    vpnHistory,
    elevationBroker,
    map,
    iran,
    nodes: nodesService,
    // Encrypted at-rest vault for node credentials — the engine-intake routes
    // rebuild a node's share link from it when promoting a node into a profile.
    nodeVault,
    sourceScheduler,
  };
  await vpn.initAll();

  // CRASH RECOVERY: rows still marked connected/connecting are stale — this
  // process was restarted, so no tunnel it tracks can be trusted to exist.
  // The desktop supervisor also guarantees child processes died with it.
  // Mark them interrupted BEFORE hydrating state; providers may re-verify
  // actual system state (interfaces/routes) lazily on their own status calls.
  const staleCount = repos.vpnConnections.markAllInterrupted('application restarted while tunnel was active');
  // Same recovery for background tests: rows still `running` when the previous
  // process died can never complete (the optimizer/dns/ping runs are in-process
  // promises). Finalize them so the UI poll fallback doesn't spin forever.
  const staleTests = repos.tests.markStaleRunningInterrupted();
  // Same recovery for per-node test history (proxy/tcp/tls rows): finalize
  // rows that were mid-flight when the previous process died.
  const staleNodeTests = repos.nodeTests.markRunningInterrupted();
  if (staleNodeTests > 0) {
    log.warn({ staleNodeTests }, 'recovered from unclean shutdown: interrupted node tests finalized');
  }
  if (staleTests > 0) {
    log.warn({ staleTests }, 'recovered from unclean shutdown: interrupted background tests finalized');
  }
  // Clean-exit flag: written false at every boot and flipped true only by the
  // graceful shutdown hook. If the flag is already false at boot, the previous
  // process died without running its shutdown path (crash, SIGKILL, power loss).
  // A missing flag means the first-ever boot — nothing to warn about.
  const runtimeKey = 'app.runtime.__lastCleanExit';
  const lastCleanExit = repos.settings.get(runtimeKey)?.clean === true;
  repos.settings.put(runtimeKey, { clean: false });
  if (staleCount > 0) {
    log.warn({ staleCount }, 'recovered from unclean shutdown: stale VPN connection records reset');
    events.record('warn', 'vpn', `Recovered from unclean shutdown — ${staleCount} stale tunnel record(s) reset. Verify tunnel state before reconnecting.`);
  } else if (!lastCleanExit) {
    log.warn('previous session did not shut down cleanly (crash or forced kill)');
    events.record('info', 'system', 'Recovered from an unclean shutdown — no VPN tunnels were active, so no state needed repair.');
  }

  // hydrate profiles persisted in SQLite from previous runs
  for (const row of repos.vpnProfiles.list()) {
    vpn.addProfile(row.providerId, {
      id: row.id,
      name: row.name,
      protocol: row.protocol,
      endpoint: row.endpoint,
      publicKeyFingerprint: row.publicKeyFingerprint,
      allowedIps: row.allowedIps ? row.allowedIps.split(',') : null,
      dns: row.dnsServers ? row.dnsServers.split(',') : null,
      secretRef: row.secretRef,
      configPath: row.configPath,
      createdAt: row.createdAt,
    });
  }

  const ctx: AppContext = {
    config,
    auth,
    db,
    repos,
    bus,
    elevationBroker,
    controller,
    reputationProviders,
    vpn,
    services,
    log,
  };

  const app = Fastify({
    // surface request-scoped errors: without a logger, unhandled failures are invisible
    loggerInstance: log as unknown as FastifyBaseLogger,
    trustProxy: false,
    bodyLimit: 1024 * 1024,
    genReqId: () => crypto.randomUUID(),
    // Silence per-request "incoming/completed" logging without the deprecated
    // top-level disableRequestLogging option (FSTDEP023; removed in fastify@6).
    logController: new FastifyLogController({ disableRequestLogging: true }),
  });

  // Bodyless requests carrying a JSON content-type (DELETE, POST actions like
  // /vpn/disconnect) must not 400 with the internal FST_ERR_CTP_EMPTY_JSON_BODY
  // code: standard REST clients send the header without a body and these routes
  // never read one. Map an empty body to undefined; real JSON still parses and
  // malformed JSON still 400s.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (body === '' || body == null) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      // Fastify treats a parser error with statusCode as a client error;
      // a raw SyntaxError would surface as a 500.
      const e = err as Error & { statusCode?: number };
      e.statusCode = 400;
      done(e, undefined);
    }
  });

  // The error/not-found handlers MUST be attached before any plugin or route
  // registration: setErrorHandler only propagates to contexts registered
  // afterwards, and attaching it late silently left validation errors to
  // Fastify's default serializer in production.
  const spaIndex = path.join(config.webDist, 'index.html');
  const hasSpa = fs.existsSync(spaIndex);
  registerErrorHandler(app, { spaIndex: hasSpa ? spaIndex : undefined });

  await app.register(helmet, { hsts: false });
  // NOTE: @fastify/cors defaults to methods GET,HEAD,POST only. The desktop
  // webview origin (tauri.localhost) is cross-origin to the loopback sidecar,
  // so without an explicit allowlist every PUT/PATCH/DELETE died at the
  // OPTIONS preflight with "Failed to fetch" — e.g. saving settings.
  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  app.addHook('onRequest', async (req) => {
    const urlPath = req.url.split('?')[0] ?? '';
    if (!urlPath.startsWith('/api/')) return;
    if (PUBLIC_API_PATHS.has(urlPath)) return;
    if (WS_AUTH_PATHS.has(urlPath)) return; // ticket-authenticated in wsRoute
    ctx.auth.requireAuth({
      headers: req.headers as Record<string, unknown>,
      cookies: req.cookies as Record<string, string | undefined>,
      method: req.method,
      ip: req.ip,
    });
  });

  registerWsRoute(app, bus);
  registerMetaRoutes(app, ctx);
  registerHealthRoutes(app, ctx);
  registerAuthRoutes(app, ctx);
  registerNetworkRoutes(app, ctx);
  registerIpRoutes(app, ctx);
  registerMapRoutes(app, ctx);
  registerPingRoutes(app, ctx);
  registerSpeedRoutes(app, ctx);
  registerDnsRoutes(app, ctx);
  registerGamingRoutes(app, ctx);
  registerIranRoutes(app, ctx);
  registerRouteRoutes(app, ctx);
  registerEndpointRoutes(app, ctx);
  registerOptimizerRoutes(app, ctx);
  registerDiagnosticRoutes(app, ctx);
  registerStabilityRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);
  registerEventRoutes(app, ctx);
  registerServerRoutes(app, ctx);
  registerHistoryRoutes(app, ctx);
  registerVpnRoutes(app, ctx);
  registerTunnelRoutes(app, ctx);
  registerWebrtcRoutes(app, ctx);
  registerNodesRoutes(app, ctx);
  // Local update feed (public — the updater is not the webview; see route docs).
  registerUpdateFeedRoutes(app, ctx);


  if (hasSpa) {
    await app.register(fastifyStatic, { root: config.webDist });
  }

  // Recurring benchmarks: start in production, stay inert under tests so no
  // timers or network runs leak into the suite. The onClose hook guarantees
  // timers are cleared on shutdown regardless of how the app exits.
  // Safe Mode: all network-backed background work stays off — benchmarks,
  // monitors and source refreshes would just log errors against the null
  // controller and mask the reason the user is in Safe Mode.
  if (!config.isTest && !safeMode) {
    schedule.start();
    // Bounded data retention: drain measurement/event tables past their
    // windows on a long interval so months of sessions cannot balloon the
    // database. A sweep at boot catches rows left by skipped sessions.
    try {
      retention.sweep();
      retentionTimer = setInterval(() => retention.sweep(), RETENTION_INTERVAL_MS);
      retentionTimer.unref();
    } catch (err) {
      log.warn({ err }, 'initial retention sweep failed (continuing)');
    }
    nodeTestScheduler.start();
    // User geo overrides: <dataDir>/geo-overrides.json is hot-reloaded by the
    // guard; register its path before the scrub so user corrections apply to
    // this boot immediately.
    setGeoOverrideFile(defaultGeoOverridePath(config.dataDir));
    // One-time boot scrub: anycast hosts (1.1.1.1 etc.) and edge-fabric ASNs
    // must never carry the fabricated GeoIP cities an earlier lookup wrote.
    try {
      const scrubbed = scrubAnycastGeo(repos.publicNodes);
      if (scrubbed > 0) log.info({ scrubbed }, 'anycast geo scrub complete');
      const overrideErr = geoOverrideError();
      if (overrideErr) log.warn({ err: overrideErr }, 'geo-overrides.json is malformed — overrides from it are ignored until fixed');
    } catch (err) {
      log.warn({ err }, 'anycast geo scrub failed (continuing)');
    }
    // Geo enrichment: a first pass shortly after boot, then every 5 minutes.
    // Batches of 40 (deduped by host + IP-cached) keep DNS + ipwho.is traffic
    // gentle while still backfilling a 2k-node store in a few hours; steady-
    // state refresh is bounded by the 7/30-day attempt windows in the repo.
    try {
      const geoTick = async () => {
        const rows = repos.publicNodes.listForGeoEnrichment(40);
        if (rows.length > 0) await enrichNodeGeoBatch(repos.publicNodes, rows, log);
      };
      const first = setTimeout(() => void geoTick(), 15_000);
      first.unref();
      geoTimer = setInterval(() => void geoTick(), 5 * 60_000);
      geoTimer.unref();
    } catch (err) {
      log.warn({ err }, 'geo enrichment scheduler failed to start (continuing)');
    }
    process.stderr.write('[netpulse] boot stage=schedulers:ok\n');
  } else if (safeMode) {
    process.stderr.write('[netpulse] boot stage=schedulers:skipped (safe mode)\n');
  }
  app.addHook('onClose', async () => {
    vpnWatchdog.stop();
    nodeTestScheduler.stop();
    if (retentionTimer) clearInterval(retentionTimer);
    if (geoTimer) clearInterval(geoTimer);
    // A deliberate shutdown must not leave managed tunnels behind: disconnect
    // every provider that reports a live tunnel (rollback of routes/DNS is
    // performed by the tunnel service / engine itself on removal).
    schedule.stop();
    // Stop user-started monitors so no interval survives the app.
    services.healthMonitor.stop();
    services.stability.stop();
    // Kill the proxy tunnel core + restore any system-proxy handoff so a
    // desktop quit never strands the machine routed through a dead port.
    try { await services.tunnel.stop(); } catch { /* shutdown best effort */ }
    // Best-effort: disconnect any tunnel this process owns so a desktop quit
    // never strands a managed proxy/tunnel process. Provider disconnects run
    // live system probes (interface/route checks) that can each take seconds;
    // without a budget the whole shutdown stretched past 7 s — delaying app
    // quit and racing any supervisor kill window. 2.5 s cap: if a probe is
    // still running by then it is abandoned (the boot-time stale-tunnel sweep
    // re-verifies real system state on the next start anyway).
    await Promise.race([
      Promise.all(
        vpn.all().map((p) => p.disconnect().catch(() => undefined)),
      ),
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 2_500);
        t.unref?.();
      }),
    ]);
    // Mark this session as having exited cleanly (see boot-time crash recovery).
    try {
      ctx.repos.settings.put('app.runtime.__lastCleanExit', { clean: true });
    } catch {
      /* database may already be closing — recovery is best-effort */
    }
  });

  process.stderr.write('[netpulse] boot stage=routes:ok\n');

  return { app, ctx, daemonToken };
}
