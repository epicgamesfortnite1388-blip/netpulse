import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

import type {
  NodeConfidence,
  NodeEventKind,
  NodeFilter,
  NodeFreshness,
  NodeProtocol,
  NodeSecurity,
  NodeSort,
  NodeStatus,
  NodeTestResult,
  NodeTestType,
  NodeTransport,
  ParsedNodeConfig,
  PublicNode,
} from '@netpulse/shared';

// Web DTO type — what the frontend receives
interface NodeWebDTO {
  id: string;
  canonicalFingerprint: string;
  protocol: NodeProtocol;
  protocolLabel: string;
  host: string;
  ipv4: string[];
  ipv6: string[];
  port: number;
  transport: string;
  transportLabel: string;
  security: string;
  securityLabel: string;
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
  sourceCount: number;
  sourceIds: string[];
  sourceUrls: string[];
  country: string | null;
  city: string | null;
  asn: number | null;
  isp: string | null;
  organization: string | null;
  lat: number | null;
  lon: number | null;
  geoSourceCount: number;
  /** why the node has (or lacks) a location — surfaced on the detail page */
  geoStatusReason: 'known' | 'anycast' | 'edge_fabric' | 'lookup_failed' | 'pending';
  userNotes: string | null;
  score: number;
  reliabilityPct: number;
  medianProxyMs: number | null;
  medianTcpMs: number | null;
  medianTlsMs: number | null;
  recentLossPct: number;
  lastValidated: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  freshness: string;
  status: string;
  confidence: string;
  tags: string[];
  favorite: boolean;
  lastProxyMs: number | null;
  lastEngine: 'xray' | 'sing-box' | null;
  lastTcpMs: number | null;
  lastTlsMs: number | null;
  testCount: number;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  recentTestCount: number;
  recentSuccessCount: number;
  recentFailureCount: number;
  firstSeen: number;
  lastSeen: number;
  createdAt: number;
  updatedAt: number;
}

import { fingerprintHash, buildFingerprint, PROTOCOL_LABELS, TRANSPORT_LABELS, SECURITY_LABELS } from './nodeParsers';
import { proxyProbeWithEngine } from './proxyEngineRunner';
import type { NodeSecretVault } from './nodeSecretVault';
import { fetchAndImportSource, hashContent, type FetchContext } from './nodeSourceRegistry';
import type { PublicNodeRow, RawDocumentsRepository, SourceFetchesRepository } from '../db/repositories';
import type { AppSettings, PublicSource } from '@netpulse/shared';
import { geoStatusReasonFor } from './nodeGeoService';
import { validateNodeHost, normalizeNodePort, familyOfIp, resolveTarget } from '../util/targetGuard';
import type { Logger } from '../logger';
import type { RealtimeBus } from '../realtime/bus';
import type {
  PublicNodesRepository,
  NodeSourcesRepository,
  NodeTestsRepository,
  NodeHealthRepository,
  NodeAddressesRepository,
  PublicSourcesRepository,
  ScanJobsRepository,
  TestEndpointsRepository,
  NodeEventsRepository,
} from '../db/repositories';
import type { VpnRegistry } from '../vpn/vpnService';
import type { PlatformNetworkController } from '../providers/platform/types';

const TEST_TIMEOUT_MS = 8_000;
const DEFAULT_TEST_ENDPOINT = 'https://httpbin.org/ip';

/* --------------------------- internal state -------------------------------- */

export class NodesService {
  private readonly runningTests = new Map<string, Set<() => void>>();
  private readonly jobTasks = new Map<string, { cancel: () => void }>();

  constructor(
    private readonly deps: {
      nodes: PublicNodesRepository;
      sources: NodeSourcesRepository;
      tests: NodeTestsRepository;
      health: NodeHealthRepository;
      addresses: NodeAddressesRepository;
      sourceRepo: PublicSourcesRepository;
      fetches: SourceFetchesRepository;
      docs: RawDocumentsRepository;
      scanJobs: ScanJobsRepository;
      testEndpoints: TestEndpointsRepository;
      events: NodeEventsRepository;
      controller?: PlatformNetworkController;
      bus: RealtimeBus;
      log: Logger;
      vpn?: VpnRegistry;
      /** Encrypted at-rest vault for node connection secrets (uuid/password). */
      nodeVault?: NodeSecretVault;
      /** Settings service (cached reads) — proxy core preference. */
      settings?: { get: () => AppSettings };
    },
  ) {}

  /* ----------------------------- events ----------------------------- */

  private recordEvent(kind: NodeEventKind, payload: Record<string, unknown>): void {
    this.deps.events.insert({ kind, at: Date.now(), payload });
    this.deps.bus.publish('nodes', { type: 'node:event', kind, payload });
  }

  /* ----------------------------- discovery ----------------------------- */

  async discoverFromSource(sourceId: string): Promise<{ parsed: number; imported: number; duplicates: number; invalid: number }> {
    const source = this.deps.sourceRepo.get(sourceId) as unknown as PublicSource | undefined;
    if (!source) throw new Error(`source not found: ${sourceId}`);

    this.recordEvent('source.fetch.started', { sourceId, sourceName: source.name });

    const ctx: FetchContext = {
      sourceId,
      fetchId: '',
      logger: this.deps.log,
      sourcesRepo: this.deps.sourceRepo,
      fetchesRepo: this.deps.fetches,
      docsRepo: this.deps.docs,
      onDiscovery: (count) => this.recordEvent('node.discovered', { sourceId, count }),
      onImport: (count) => this.recordEvent('node.imported', { sourceId, count }),
      onDuplicate: (count) => this.recordEvent('node.duplicate', { sourceId, count }),
      onInvalid: (count) => this.recordEvent('source.changed', { sourceId, invalidCount: count }),
      onStatus: (status) => this.recordEvent('source.changed', { sourceId, status }),
      onImportConfigs: async (sourceUrl, configs) => {
        const r = await this.importParsedConfigs(sourceId, configs, sourceUrl);
        return { imported: r.imported, duplicates: r.duplicates, invalid: r.invalid };
      },
    };

    const result = await fetchAndImportSource(source, ctx);

    this.recordEvent('source.fetch.completed', {
      sourceId,
      imported: result.imported,
      duplicates: result.duplicates,
      invalid: result.invalid,
    });

    return { parsed: result.fetched, imported: result.imported, duplicates: result.duplicates, invalid: result.invalid };
  }

  /* ----------------------------- import ----------------------------- */

  async importParsedConfigs(
    sourceId: string,
    configs: Array<{ raw: string; parsed: { config: ParsedNodeConfig; secret: string } | null }>,
    sourceUrl: string,
  ): Promise<{ imported: number; duplicates: number; invalid: number; nodeIds: string[] }> {
    const now = Date.now();
    const imported: string[] = [];
    let duplicates = 0;
    let invalid = 0;

    for (const item of configs) {
      if (!item.parsed) {
        invalid++;
        continue;
      }

      const { config } = item.parsed;

      // Build fingerprint
      const fp = buildFingerprint(config);
      const fpHash = fingerprintHash(fp);

      // Check for existing node with this fingerprint
      const existing = this.deps.nodes.getByFingerprint(fpHash);

      if (existing) {
        // Update existing node
        duplicates++;

        // Record provenance
        this.deps.sources.insert({
          id: existing.id.length + sourceId.length + now,
          nodeId: existing.id,
          sourceId,
          sourceUrl,
          sourceConfigRef: hashContent(item.raw),
          parserVersion: '1.0.0',
          normalizedHash: fpHash,
          discoveredAt: now,
        });

        // Update node metadata
        this.deps.nodes.update(existing.id, {
          lastSeen: now,
          sourceIds: [...new Set([...existing.sourceIds, sourceId])],
          sourceUrls: [...new Set([...existing.sourceUrls, sourceUrl])],
          sourceCount: (existing.sourceCount || 1) + 1,
          status: 'discovered', // Reset to discovered if previously stale
          updatedAt: now,
        });

        // Backfill the secret vault: nodes imported before vaulting existed
        // (or whose vault entry was lost) arrive as duplicates forever and
        // could never regain their credentials — every proxy test then failed
        // auth honestly but permanently. If the source still supplies the
        // secret and the vault has none, store it.
        if (item.parsed.secret && this.deps.nodeVault?.get(existing.id) == null) {
          try {
            this.deps.nodeVault?.set(existing.id, item.parsed.secret);
          } catch {
            // vault failure must not block the import; tests will report
          }
        }

        this.recordEvent('node.duplicate', {
          nodeId: existing.id,
          host: existing.host,
          sourceId,
          sourceUrl,
          secretBackfilled: Boolean(item.parsed.secret),
        });

        imported.push(existing.id);
        continue;
      }

      // Create new node
      const nodeId = `node:${crypto.randomUUID().slice(0, 12)}`;

      const host = validateNodeHost(config.host);
      const port = normalizeNodePort(config.protocol, config.security, config.port);

      // Build node — DNS/geo resolution is DEFERRED (batch-resolved after the
      // insert loop with bounded concurrency; a serial `await dns.lookup` per
      // node made an 8k-config import hold the HTTP request open for ~50 s).
      const node: PublicNode = {
        id: nodeId,
        canonicalFingerprint: fpHash,
        protocol: config.protocol,
        host,
        ipv4: [],
        ipv6: [],
        port,
        transport: config.transport,
        security: config.security,
        sni: config.sni ?? null,
        alpn: config.alpn || [],
        fingerprint: null,
        flow: config.flow || null,
        alterId: config.alterId || null,
        path: config.path || null,
        hostHeader: config.hostHeader || null,
        serviceName: config.serviceName || null,
        allowInsecure: config.allowInsecure || false,
        realityPublicKey: config.realityPublicKey || null,
        realityShortId: config.realityShortId || null,
        realityServerName: config.realityServerName || null,
        encryption: config.encryption || null,
        ssrProtocol: config.ssrProtocol || null,
        remark: config.remark || null,
        sourceIds: [sourceId],
        sourceUrls: [sourceUrl],
        sourceCount: 1,
        firstSeen: now,
        lastSeen: now,
        lastValidated: null,
        status: 'discovered',
        confidence: 'unknown',
        country: null,
        city: null,
        asn: null,
        isp: null,
        organization: null,
        lat: null,
        lon: null,
        geoSourceCount: 0,
        geoStatusReason: 'pending',
        tags: [],
        favorite: false,
        userNotes: null,
        lastProxyMs: null,
        lastEngine: null,
        lastTcpMs: null,
        lastTlsMs: null,
        testCount: 0,
        successCount: 0,
        failureCount: 0,
        consecutiveFailures: 0,
        recentTestCount: 0,
        recentSuccessCount: 0,
        recentFailureCount: 0,
        score: 0,
        reliabilityPct: 0,
        medianProxyMs: null,
        medianTcpMs: null,
        medianTlsMs: null,
        recentLossPct: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
        freshness: 'stale',
        geoLastAttempt: null,
        createdAt: now,
        updatedAt: now,
      };

      this.deps.nodes.insert(node);

      // Record provenance
      this.deps.sources.insert({
        id: nodeId.length + sourceId.length + now,
        nodeId,
        sourceId,
        sourceUrl,
        sourceConfigRef: hashContent(item.raw),
        parserVersion: '1.0.0',
        normalizedHash: fpHash,
        discoveredAt: now,
      });

      // Record address
      for (const ip of node.ipv4) {
        this.deps.addresses.insert({ id: now, nodeId, ip, family: 4, firstSeen: now, lastSeen: now });
      }
      for (const ip of node.ipv6) {
        this.deps.addresses.insert({ id: now, nodeId, ip, family: 6, firstSeen: now, lastSeen: now });
      }

      this.recordEvent('node.discovered', { nodeId, host, protocol: node.protocol, port, sourceId, sourceUrl });
      // Persist the connection secret in the encrypted vault (never the DB).
      // Proxy tests need it to authenticate — before this, every imported
      // credential was discarded and vless/vmess/trojan/ss tests were
      // guaranteed auth failures.
      if (item.parsed.secret) {
        try {
          this.deps.nodeVault?.set(nodeId, item.parsed.secret);
        } catch {
          // vault failure must not block the import; tests will report
          // authentication failures honestly
        }
      }
      imported.push(nodeId);
    }

    // NOTE: no DNS resolution in the import path. Free-config hostnames are
    // mostly nonexistent domains — thousands of resolver round-trips made a
    // single import take ~54 s. Nodes get ipv4/ipv6 when they are actually
    // TESTED (testNode → resolveTarget), which is the only consumer that
    // needs them. Import stays parse+store (sub-2 s for 8k configs).

    // Update source stats
    const src = this.deps.sourceRepo.get(sourceId);
    if (src) {
      this.deps.sourceRepo.update(sourceId, {
        discoveredConfigCount: (src.discoveredConfigCount ?? 0) + configs.length,
        importedConfigCount: (src.importedConfigCount ?? 0) + imported.length,
        duplicateCount: (src.duplicateCount ?? 0) + duplicates,
        invalidCount: (src.invalidCount ?? 0) + invalid,
      });
    }

    return { imported: imported.length, duplicates, invalid, nodeIds: imported };
  }

  /* ----------------------------- testing ----------------------------- */

  async testNode(nodeId: string, type: NodeTestType, ip?: string): Promise<NodeTestResult> {
    const nodeRow = this.deps.nodes.get(nodeId);
    if (!nodeRow) throw new Error(`node not found: ${nodeId}`);

    // SSRF guard for the caller-supplied IP override: without this, a request
    // could point a node test at loopback/private/link-local addresses (e.g.
    // the sidecar itself or a metadata service). resolveTarget rejects those
    // literals before any socket is opened; the validated literal is what the
    // probe variants below actually connect to.
    let probedIpOverride: string | undefined;
    if (ip !== undefined) {
      const validated = await resolveTarget(ip);
      probedIpOverride = validated.ips[0];
    }

    const node: PublicNode = {
      id: nodeRow.id,
      canonicalFingerprint: nodeRow.canonicalFingerprint,
      protocol: nodeRow.protocol as NodeProtocol,
      host: nodeRow.host,
      ipv4: nodeRow.ipv4,
      ipv6: nodeRow.ipv6,
      port: nodeRow.port,
      transport: nodeRow.transport as NodeTransport,
      security: nodeRow.security as NodeSecurity,
      sni: nodeRow.sni,
      alpn: nodeRow.alpn,
      fingerprint: null,
      flow: nodeRow.flow,
      alterId: nodeRow.alterId,
      path: nodeRow.path,
      hostHeader: nodeRow.hostHeader,
      serviceName: nodeRow.serviceName,
      allowInsecure: nodeRow.allowInsecure,
      realityPublicKey: nodeRow.realityPublicKey,
      realityShortId: nodeRow.realityShortId,
      realityServerName: nodeRow.realityServerName,
      encryption: nodeRow.encryption,
      ssrProtocol: nodeRow.ssrProtocol,
      remark: nodeRow.remark ?? null,
      geoSourceCount: nodeRow.geoSourceCount ?? 0,
      userNotes: nodeRow.userNotes ?? null,
      sourceIds: nodeRow.sourceIds,
      sourceUrls: nodeRow.sourceUrls,
      sourceCount: nodeRow.sourceCount,
      firstSeen: nodeRow.firstSeen,
      lastSeen: nodeRow.lastSeen,
      lastValidated: nodeRow.lastValidated,
      lastSuccessAt: nodeRow.lastSuccessAt,
      lastFailureAt: nodeRow.lastFailureAt,
      status: nodeRow.status as NodeStatus,
      confidence: nodeRow.confidence as NodeConfidence,
      country: nodeRow.country,
      city: nodeRow.city,
      asn: nodeRow.asn,
      isp: nodeRow.isp,
      organization: nodeRow.organization,
      lat: nodeRow.lat,
      lon: nodeRow.lon,
      geoStatusReason: geoStatusReasonFor({
        host: nodeRow.host,
        lat: nodeRow.lat,
        asn: nodeRow.asn,
        geoLastAttempt: nodeRow.geoLastAttempt,
      }),
      score: nodeRow.score,
      reliabilityPct: nodeRow.reliabilityPct,
      medianProxyMs: nodeRow.medianProxyMs,
      medianTcpMs: nodeRow.medianTcpMs,
      medianTlsMs: nodeRow.medianTlsMs,
      recentLossPct: nodeRow.recentLossPct,
      freshness: nodeRow.freshness as NodeFreshness,
      tags: nodeRow.tags,
      favorite: nodeRow.favorite ? true : false,
      lastProxyMs: nodeRow.lastProxyMs,
      lastEngine: (nodeRow.lastEngine as 'xray' | 'sing-box' | null) ?? null,
      geoLastAttempt: nodeRow.geoLastAttempt ?? null,
      lastTcpMs: nodeRow.lastTcpMs,
      lastTlsMs: nodeRow.lastTlsMs,
      testCount: nodeRow.testCount,
      successCount: nodeRow.successCount,
      failureCount: nodeRow.failureCount,
      consecutiveFailures: nodeRow.consecutiveFailures,
      recentTestCount: nodeRow.recentTestCount,
      recentSuccessCount: nodeRow.recentSuccessCount,
      recentFailureCount: nodeRow.recentFailureCount,
      createdAt: nodeRow.createdAt,
      updatedAt: nodeRow.updatedAt,
    };

    const testId = `test:${nodeId}:${type}:${Date.now().toString(36)}`;
    const startTime = Date.now();

    // Create test record
    this.deps.tests.insert({
      id: testId,
      nodeId,
      type,
      status: 'running',
      startedAt: startTime,
      finishedAt: null,
      latencyMs: null,
      totalMs: null,
      tlsVersion: null,
      authorized: null,
      httpStatus: null,
      responseSize: null,
      error: null,
      engine: null,
      family: null,
      probedIp: null,
      testEndpoint: null,
    });

    this.recordEvent('node.test.started', { testId, nodeId, type });

    try {
      let result: NodeTestResult;

      switch (type) {
        case 'tcp':
          result = await this.tcpTest(node, testId, probedIpOverride);
          break;
        case 'tls':
          result = await this.tlsTest(node, testId, probedIpOverride);
          break;
        case 'proxy':
          result = await this.proxyTest(node, testId, probedIpOverride);
          break;
        case 'icmp':
          result = await this.icmpTest(node, testId, probedIpOverride);
          break;
        default:
          throw new Error(`unknown test type: ${type}`);
      }

      // Persist engine attribution on the test row, then update the node.
      if (result.engine) {
        this.deps.tests.update(testId, { engine: result.engine });
      }

      // Update node with test result
      await this.updateNodeAfterTest(nodeId, node, result, type);

      return result;

    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.deps.tests.update(testId, {
        status: 'failed',
        latencyMs: null,
        totalMs: null,
        tlsVersion: null,
        authorized: null,
        httpStatus: null,
        responseSize: null,
        error,
        finishedAt: Date.now(),
      });

      this.recordEvent('node.test.failed', { testId, nodeId, type, error });

      throw err;
    }
  }

  private async tcpTest(node: PublicNode, testId: string, ip?: string): Promise<NodeTestResult> {
    const host = ip || node.host;
    const port = node.port;

    const start = Date.now();
    return new Promise((resolve, _reject) => {
      const socket = net.createConnection({ host, port, timeout: TEST_TIMEOUT_MS });
      let resolved = false;

      const finish = (ok: boolean, latency?: number, error?: string) => {
        if (resolved) return;
        resolved = true;
        socket.destroy();
        const latencyMs = latency ?? Math.round((Date.now() - start) / 100) / 10;
        this.deps.tests.update(testId, {
          status: ok ? 'done' : 'failed',
          latencyMs,
          totalMs: latencyMs,
          error: error ?? null,
          finishedAt: Date.now(),
        });
        resolve({
          nodeId: node.id,
          type: 'tcp',
          status: ok ? 'done' : 'failed',
          startedAt: start,
          finishedAt: Date.now(),
          latencyMs,
          totalMs: latencyMs,
          tlsVersion: null,
          authorized: null,
          httpStatus: null,
          responseSize: null,
          error: error ?? null,
          family: net.isIP(host) as 4 | 6 | null,
          probedIp: host,
          testEndpoint: null,
          engine: null,
        });
      };

      socket.on('connect', () => finish(true));
      socket.on('timeout', () => finish(false, undefined, 'timeout'));
      socket.on('error', (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('ECONNREFUSED')) {
          finish(false, undefined, 'connection refused');
        } else if (msg.includes('ENETUNREACH')) {
          finish(false, undefined, 'network unreachable');
        } else {
          finish(false, undefined, msg);
        }
      });
    });
  }

  private async tlsTest(node: PublicNode, testId: string, ip?: string): Promise<NodeTestResult> {
    const host = ip || node.host;
    const port = node.port;
    const sni = node.sni || host;

    const start = Date.now();
    return new Promise((resolve, _reject) => {
      const socket = net.createConnection({ host, port, timeout: TEST_TIMEOUT_MS });
      let resolved = false;

      const finish = (ok: boolean, latency?: number, tlsVersion?: string, authorized?: boolean, error?: string) => {
        if (resolved) return;
        resolved = true;
        try { socket.destroy(); } catch { /* already closed */ }
        const latencyMs = latency ?? Math.round((Date.now() - start) / 100) / 10;
        this.deps.tests.update(testId, {
          status: ok ? 'done' : 'failed',
          latencyMs,
          totalMs: latencyMs,
          tlsVersion: tlsVersion ?? null,
          authorized: authorized ?? null,
          error: error ?? null,
          finishedAt: Date.now(),
        });
        resolve({
          nodeId: node.id,
          type: 'tls',
          status: ok ? 'done' : 'failed',
          startedAt: start,
          finishedAt: Date.now(),
          latencyMs,
          totalMs: latencyMs,
          tlsVersion: tlsVersion ?? null,
          authorized: authorized ?? null,
          httpStatus: null,
          responseSize: null,
          error: error ?? null,
          family: net.isIP(host) as 4 | 6 | null,
          probedIp: host,
          testEndpoint: null,
          engine: null,
        });
      };

      socket.on('error', (err) => {
        if (resolved) return;
        finish(false, undefined, undefined, undefined, err instanceof Error ? err.message : String(err));
      });

      // Upgrade to TLS after TCP connect
      socket.on('connect', () => {
        try {
          const tlsSocket = tls.connect({
            socket,
            servername: sni,
            rejectUnauthorized: false,
            timeout: TEST_TIMEOUT_MS,
          });

          tlsSocket.on('secureConnect', () => {
            const tlsVersion = tlsSocket.getProtocol();
            const authorized = tlsSocket.authorized;
            finish(true, undefined, tlsVersion ?? undefined, authorized);
          });

          tlsSocket.on('error', (err: Error) => {
            if (resolved) return;
            const msg = err instanceof Error ? err.message : String(err);
            // TLS errors are still "tls failure" not full failure
            finish(false, undefined, undefined, false, msg);
          });

          tlsSocket.on('timeout', () => {
            if (resolved) return;
            finish(false, undefined, undefined, false, 'tls timeout');
          });
        } catch (err) {
          finish(false, undefined, undefined, undefined, err instanceof Error ? err.message : String(err));
        }
      });
    });
  }

  private async proxyTest(node: PublicNode, testId: string, ip?: string): Promise<NodeTestResult> {
    // REAL proxy test: tunnel traffic through the node with a local core
    // (xray or sing-box — see proxyEngineRunner.ts) on an ephemeral port.
    // No fake 200s — latency is measured only when traffic provably traversed
    // the proxy, and the node's REAL secret comes from the at-rest vault.
    const testEndpoint = await this.getTestEndpoint();
    const start = Date.now();
    const secret = this.deps.nodeVault?.get(node.id) ?? null;

    const probeResult = await proxyProbeWithEngine(
      {
        protocol: node.protocol,
        host: node.host,
        port: node.port,
        transport: node.transport as ParsedNodeConfig['transport'],
        security: node.security as ParsedNodeConfig['security'],
        sni: node.sni,
        alpn: node.alpn,
        fingerprint: node.fingerprint,
        flow: node.flow,
        alterId: node.alterId,
        path: node.path,
        hostHeader: node.hostHeader,
        serviceName: node.serviceName,
        allowInsecure: node.allowInsecure,
        encryption: node.encryption,
        ssrProtocol: node.ssrProtocol,
        // Reality material MUST reach the engine config — without the public
        // key xray rejects the outbound at startup (exit 23) and the probe
        // blames the node for what is a dropped field.
        realityPublicKey: node.realityPublicKey,
        realityShortId: node.realityShortId,
        realityServerName: node.realityServerName,
        vmessSecurity: node.encryption,
        extra: (node as unknown as { extra?: Record<string, unknown> | null }).extra ?? null,
        remark: node.remark,
      },
      {
        secret,
        testUrl: testEndpoint.url,
        preferred: this.proxyEnginePreference(),
      },
    );

    if (probeResult.status !== 'done') {
      return {
        nodeId: node.id,
        type: 'proxy',
        status: 'failed',
        startedAt: start,
        finishedAt: Date.now(),
        latencyMs: probeResult.latencyMs,
        totalMs: probeResult.totalMs,
        tlsVersion: null,
        authorized: null,
        httpStatus: probeResult.httpStatus,
        responseSize: null,
        error: probeResult.error ?? 'proxy test failed',
        family: null,
        probedIp: ip ?? node.host,
        testEndpoint: testEndpoint.url,
        engine: probeResult.engine,
      };
    }

    return {
      nodeId: node.id,
      type: 'proxy',
      status: 'done',
      startedAt: start,
      finishedAt: Date.now(),
      latencyMs: probeResult.latencyMs,
      totalMs: probeResult.totalMs,
      tlsVersion: probeResult.tlsVersion,
      authorized: null,
      httpStatus: probeResult.httpStatus,
      responseSize: null,
      error: null,
      family: null,
      probedIp: ip ?? node.host,
      testEndpoint: testEndpoint.url,
      engine: probeResult.engine,
    };
  }

  private async icmpTest(node: PublicNode, testId: string, ip?: string): Promise<NodeTestResult> {
    // Real ICMP via the platform controller (OS ping). Without a controller
    // (unit-test seams) the result is an honest 'unavailable' failure — never
    // a fabricated measurement.
    const start = Date.now();
    const controller = this.deps.controller;
    if (!controller) {
      return {
        nodeId: node.id,
        type: 'icmp',
        status: 'failed',
        startedAt: start,
        finishedAt: Date.now(),
        latencyMs: null,
        totalMs: null,
        tlsVersion: null,
        authorized: null,
        httpStatus: null,
        responseSize: null,        error: 'ICMP ping not available on this platform',
        family: null,
        probedIp: ip || node.host,
        testEndpoint: null,
        engine: null,
      };
    }

    const targetIp = ip || node.ipv4[0] || node.host;
    try {
      const ping = await controller.icmpPing(targetIp, { count: 4, timeoutMs: 2000 });
      const avg = ping.avg ?? ping.median ?? null;
      const done = ping.received > 0;
      return {
        nodeId: node.id,
        type: 'icmp',
        status: done ? 'done' : 'failed',
        startedAt: start,
        finishedAt: Date.now(),
        latencyMs: avg,
        totalMs: Date.now() - start,
        tlsVersion: null,
        authorized: null,
        httpStatus: null,
        responseSize: null,
        error: done ? null : `ICMP: ${ping.lossPct}% packet loss (${ping.received}/${ping.sent})`,
        family: familyOfIp(targetIp),
        probedIp: targetIp,
        testEndpoint: null,
        engine: null,
      };
    } catch (err) {
      return {
        nodeId: node.id,
        type: 'icmp',
        status: 'failed',
        startedAt: start,
        finishedAt: Date.now(),
        latencyMs: null,
        totalMs: Date.now() - start,
        tlsVersion: null,
        authorized: null,
        httpStatus: null,
        responseSize: null,
        error: `ICMP failed: ${err instanceof Error ? err.message : String(err)}`,
        family: familyOfIp(targetIp),
        probedIp: targetIp,
        testEndpoint: null,
        engine: null,
      };
    }
  }

  private async getTestEndpoint(): Promise<{ url: string; expectedStatus: number; timeoutMs: number; maxBytes: number }> {
    const endpoints = this.deps.testEndpoints.list();
    const enabled = endpoints.find((e) => e.enabled);
    if (enabled) {
      return {
        url: enabled.url,
        expectedStatus: enabled.expectedStatus,
        timeoutMs: enabled.timeoutMs,
        maxBytes: enabled.maxBytes,
      };
    }
    return {
      url: DEFAULT_TEST_ENDPOINT,
      expectedStatus: 200,
      timeoutMs: 5000,
      maxBytes: 4096,
    };
  }

  /**
   * Which core to prefer for proxy tests. Reads the live setting each call
   * (cheap: settings are cached); 'auto' lets the runner pick xray first.
   */
  private proxyEnginePreference(): 'auto' | 'sing-box' | 'xray' {
    try {
      const s = this.deps.settings?.get();
      return s?.proxyEngine?.preferred ?? 'auto';
    } catch {
      return 'auto';
    }
  }

  private async updateNodeAfterTest(nodeId: string, node: PublicNode, result: NodeTestResult, type: NodeTestType): Promise<void> {
    const now = Date.now();

    const wasSuccess = result.status === 'done';
    const prevSuccess = node.successCount;
    const prevFailure = node.failureCount;
    const prevConsecutive = node.consecutiveFailures;

    const newSuccess = wasSuccess ? prevSuccess + 1 : prevSuccess;
    const newFailure = wasSuccess ? prevFailure : prevFailure + 1;
    const newConsecutive = wasSuccess ? 0 : prevConsecutive + 1;

    // Update recent counts (24h window) — recent counters are simple bumps here;
    // a rolling-window recount happens in the periodic health refresh.
    const newRecentTest = node.recentTestCount + 1;
    const newRecentSuccess = wasSuccess ? node.recentSuccessCount + 1 : node.recentSuccessCount;
    const newRecentFailure = wasSuccess ? node.recentFailureCount : node.recentFailureCount + 1;

    // Calculate new median latencies

    let medianProxy = node.medianProxyMs;
    let medianTcp = node.medianTcpMs;
    let medianTls = node.medianTlsMs;
    const totalTests = node.testCount + 1;

    if (result.latencyMs != null) {
      if (type === 'proxy') {
        medianProxy = this.updateMedian(node.medianProxyMs, result.latencyMs, node.testCount, totalTests, wasSuccess);
      } else if (type === 'tcp') {
        medianTcp = this.updateMedian(node.medianTcpMs, result.latencyMs, node.testCount, totalTests, wasSuccess);
      } else if (type === 'tls') {
        medianTls = this.updateMedian(node.medianTlsMs, result.latencyMs, node.testCount, totalTests, wasSuccess);
      }
    }

    // Calculate packet loss (failed tests / total tests)
    const successRate = totalTests > 0 ? (newSuccess / totalTests) * 100 : 0;
    const lossPct = totalTests > 0 ? ((totalTests - newSuccess) / totalTests) * 100 : 0;

    // Update status based on recent performance
    let newStatus: NodeStatus = node.status;
    let newConfidence: string = node.confidence;

    if (wasSuccess) {
      newStatus = 'healthy';
      newConfidence = 'high';
    } else if (newConsecutive >= 5) {
      newStatus = 'failed';
      newConfidence = 'high';
    } else if (newConsecutive >= 3) {
      newStatus = 'degraded';
      newConfidence = 'medium';
    } else if (newConsecutive >= 1) {
      newStatus = 'degraded';
      newConfidence = 'low';
    }

    // Update freshness
    const freshness = this.calculateFreshness(now, node.lastValidated);

    // Update node
    this.deps.nodes.update(nodeId, {
      lastValidated: now,
      status: newStatus,
      confidence: newConfidence,
      lastProxyMs: type === 'proxy' ? result.latencyMs : node.lastProxyMs,
      lastEngine: type === 'proxy' ? (result.engine as 'xray' | 'sing-box' | null) : node.lastEngine,
      lastTcpMs: type === 'tcp' ? result.latencyMs : node.lastTcpMs,
      lastTlsMs: type === 'tls' ? result.latencyMs : node.lastTlsMs,
      testCount: totalTests,
      successCount: newSuccess,
      failureCount: newFailure,
      consecutiveFailures: newConsecutive,
      recentTestCount: newRecentTest,
      recentSuccessCount: newRecentSuccess,
      recentFailureCount: newRecentFailure,
      reliabilityPct: successRate,
      medianProxyMs: medianProxy,
      medianTcpMs: medianTcp,
      medianTlsMs: medianTls,
      recentLossPct: lossPct,
      lastSuccessAt: wasSuccess ? now : node.lastSuccessAt,
      lastFailureAt: !wasSuccess ? now : node.lastFailureAt,
      freshness,
      score: this.calculateScore(node, {
        medianProxyMs: medianProxy,
        medianTcpMs: medianTcp,
        medianTlsMs: medianTls,
        reliabilityPct: successRate,
        recentLossPct: lossPct,
        recentTestCount: newRecentTest,
        recentSuccessCount: newRecentSuccess,
        consecutiveFailures: newConsecutive,
      }),
      updatedAt: now,
    });

    // Update health record
    const healthRow = this.deps.health.get(nodeId) ?? {
      id: nodeId,
      nodeId,
      testCount: 0,
      successCount: 0,
      failureCount: 0,
      reliabilityPct: 0,
      medianLatencyMs: null,
      p95LatencyMs: null,
      lossPct: 0,
      latencyVariance: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      consecutiveFailures: 0,
      healthyForMs: null,
      computedAt: now,
    };

    healthRow.testCount = totalTests;
    healthRow.successCount = newSuccess;
    healthRow.failureCount = newFailure;
    healthRow.reliabilityPct = successRate;
    // Real distribution stats: median/p95 computed from the node's recent
    // successful test latencies — the previous code stored the LAST single
    // measurement in both fields, which silently misreported spread.
    {
      const recent = this.deps.tests.listByNode(nodeId, 100).filter((t) => t.status === 'done' && t.latencyMs != null).map((t) => t.latencyMs as number);
      if (recent.length > 0) {
        const sorted = [...recent].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        const median = sorted.length % 2 === 0 ? Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2) : (sorted[mid] ?? 0);
        const p95Idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
        healthRow.medianLatencyMs = median;
        healthRow.p95LatencyMs = sorted[p95Idx] ?? median;
      }
    }
    healthRow.lossPct = lossPct;
    healthRow.lastSuccessAt = wasSuccess ? now : healthRow.lastSuccessAt;
    healthRow.lastFailureAt = !wasSuccess ? now : healthRow.lastFailureAt;
    healthRow.consecutiveFailures = newConsecutive;
    healthRow.computedAt = now;

    this.deps.health.upsert(healthRow);

    this.recordEvent('node.test.completed', {
      testId: result.nodeId,
      nodeId,
      type,
      status: result.status,
      latencyMs: result.latencyMs,
      totalMs: result.totalMs,
      error: result.error,
    });
  }

  private updateMedian(
    currentMedian: number | null,
    newValue: number,
    oldCount: number,
    newCount: number,
    wasSuccess: boolean,
  ): number | null {
    if (!wasSuccess) return currentMedian;

    if (currentMedian == null) return newValue;

    // Simple incremental median approximation
    // For a proper median, we'd store all samples
    const weight = oldCount > 0 ? oldCount / newCount : 0;
    return currentMedian * weight + newValue * (1 - weight);
  }

  private calculateFreshness(now: number, lastValidated: number | null): string {
    if (lastValidated == null) return 'stale';

    const age = now - lastValidated;
    const oneHour = 60 * 60 * 1000;
    const sixHours = 6 * oneHour;
    const oneDay = 24 * oneHour;

    if (age < oneHour) return 'fresh';
    if (age < sixHours) return 'recent';
    if (age < oneDay) return 'aging';
    return 'stale';
  }

  private calculateScore(node: PublicNode, stats: {
    medianProxyMs: number | null;
    medianTcpMs: number | null;
    medianTlsMs: number | null;
    reliabilityPct: number;
    recentLossPct: number;
    recentTestCount: number;
    recentSuccessCount: number;
    consecutiveFailures: number;
  }): number {
    if (stats.recentTestCount === 0) return 0;

    // Score components (0-100 each)
    const latencyScore = this.latencyToScore(stats.medianProxyMs, stats.medianTcpMs);
    const reliabilityScore = stats.reliabilityPct;
    const lossScore = Math.max(0, 100 - stats.recentLossPct * 20);
    const stabilityScore = Math.max(0, 100 - stats.consecutiveFailures * 20);
    const volumeScore = Math.min(100, (stats.recentTestCount / 100) * 100);

    // Weighted average
    const total = latencyScore * 0.35 +
                 reliabilityScore * 0.30 +
                 lossScore * 0.15 +
                 stabilityScore * 0.10 +
                 volumeScore * 0.10;

    return Math.round(total);
  }

  private latencyToScore(proxyMs: number | null, tcpMs: number | null): number {
    const ms = proxyMs ?? tcpMs;
    if (ms == null) return 50;

    if (ms < 50) return 100;
    if (ms < 100) return 90;
    if (ms < 150) return 80;
    if (ms < 200) return 70;
    if (ms < 300) return 50;
    if (ms < 500) return 30;
    return 10;
  }

  /* ----------------------------- listing ----------------------------- */

  listNodes(options: {
    limit?: number;
    offset?: number;
    protocol?: NodeProtocol;
    country?: string;
    asn?: number;
    status?: NodeStatus;
    transport?: string;
    security?: NodeSecurity;
    freshness?: string;
    favorite?: boolean;
    search?: string;
    minScore?: number;
    maxLatency?: number;
    minReliability?: number;
    /** only nodes whose last proxy test ran through this core ('xray' | 'sing-box') */
    engine?: string;
    sort?: NodeSort;
  } = {}): { nodes: NodeWebDTO[]; total: number } {
    const { rows, total } = this.deps.nodes.list({
      limit: options.limit ?? 100,
      offset: options.offset ?? 0,
      protocol: options.protocol?.toString(),
      country: options.country,
      asn: options.asn,
      status: options.status?.toString(),
      transport: options.transport,
      security: options.security?.toString(),
      freshness: options.freshness,
      favorite: options.favorite,
      search: options.search,
      minScore: options.minScore,
      maxLatency: options.maxLatency,
      minReliability: options.minReliability,
      engine: options.engine,
      sortField: options.sort?.field,
      sortDir: options.sort?.dir,
    });

    return {
      nodes: rows.map((r) => this.toWebDTO(r)),
      total,
    };
  }

  getNode(id: string): NodeWebDTO | null {
    const node = this.deps.nodes.get(id);
    if (!node) return null;
    return this.toWebDTO(node);
  }

  getNodeByFingerprint(fingerprint: string): NodeWebDTO | null {
    const node = this.deps.nodes.getByFingerprint(fingerprint);
    if (!node) return null;
    return this.toWebDTO(node);
  }

  /* ----------------------------- search ----------------------------- */

  searchNodes(query: string, limit = 50): NodeWebDTO[] {
    // Search across host, IP, fingerprint, protocol, remark
    const q = query.toLowerCase();
    const { rows } = this.deps.nodes.list({
      limit,
      protocol: undefined,
      search: undefined,
    });

    // Client-side filtering for complex search
    const results = rows.filter((n) => {
      return n.host.toLowerCase().includes(q) ||
             n.ipv4.some((ip) => ip.includes(q)) ||
             n.ipv6.some((ip) => ip.includes(q)) ||
             n.canonicalFingerprint.includes(q) ||
             n.protocol.toLowerCase().includes(q) ||
             n.remark?.toLowerCase().includes(q) ||
             n.asn?.toString().includes(q) ||
             (n.country && n.country.toLowerCase().includes(q));
    });

    return results.map((r) => this.toWebDTO(r));
  }

  /* ----------------------------- IP lookup ----------------------------- */

  getNodesByIp(ip: string): NodeWebDTO[] {
    // Look up nodes that have this IP in their address list
    const addresses = this.deps.addresses.listByIp(ip);
    const nodeIds = [...new Set(addresses.map((a) => a.nodeId))];

    if (nodeIds.length === 0) return [];

    const rows = this.deps.nodes.listByIds(nodeIds);
    return rows.map((r) => this.toWebDTO(r));
  }

  getNodesByAsn(asn: number): NodeWebDTO[] {
    const { rows } = this.deps.nodes.list({
      limit: 200,
      asn,
    });
    return rows.map((r) => this.toWebDTO(r));
  }

  getNodesByHostname(host: string): NodeWebDTO[] {
    const hostLower = host.toLowerCase();
    const { rows } = this.deps.nodes.list({
      limit: 100,
      search: undefined,
    });

    return rows
      .filter((n) => n.host.toLowerCase() === hostLower || n.host.toLowerCase().includes(hostLower))
      .map((r) => this.toWebDTO(r));
  }

  /* ----------------------------- filters ----------------------------- */

  applyFilters(nodes: NodeWebDTO[], filters: NodeFilter[]): NodeWebDTO[] {
    return nodes.filter((n) => {
      for (const f of filters) {
        let value: unknown;
        switch (f.field) {
          case 'protocol':
            value = n.protocol;
            break;
          case 'country':
            value = n.country;
            break;
          case 'city':
            value = n.city;
            break;
          case 'asn':
            value = n.asn;
            break;
          case 'isp':
            value = n.isp;
            break;
          case 'transport':
            value = n.transport;
            break;
          case 'security':
            value = n.security;
            break;
          case 'tls':
            value = n.security === 'tls' || n.security === 'reality' ? true : false;
            break;
          case 'reality':
            value = n.security === 'reality' ? true : false;
            break;
          case 'ipv4':
            value = n.ipv4.length > 0;
            break;
          case 'ipv6':
            value = n.ipv6.length > 0;
            break;
          case 'sourceCount':
            value = n.sourceCount;
            break;
          case 'status':
            value = n.status;
            break;
          case 'freshness':
            value = n.freshness;
            break;
          case 'score':
            value = n.score;
            break;
          case 'medianProxyMs':
            value = n.medianProxyMs;
            break;
          case 'medianTcpMs':
            value = n.medianTcpMs;
            break;
          case 'medianTlsMs':
            value = n.medianTlsMs;
            break;
          case 'recentLossPct':
            value = n.recentLossPct;
            break;
          case 'reliabilityPct':
            value = n.reliabilityPct;
            break;
          case 'lastTested':
            value = n.lastValidated;
            break;
          default:
            continue;
        }

        if (!this.filterMatches(value, f)) return false;
      }
      return true;
    });
  }

  private filterMatches(value: unknown, filter: NodeFilter): boolean {
    const { op, value: fv } = filter;

    if (op === 'eq') {
      return value === fv;
    }
    if (op === 'neq') {
      return value !== fv;
    }
    if (op === 'gt') {
      return Number(value) > Number(fv);
    }
    if (op === 'gte') {
      return Number(value) >= Number(fv);
    }
    if (op === 'lt') {
      return Number(value) < Number(fv);
    }
    if (op === 'lte') {
      return Number(value) <= Number(fv);
    }
    if (op === 'contains') {
      if (typeof value === 'string') {
        return value.toLowerCase().includes(String(fv).toLowerCase());
      }
      if (Array.isArray(value)) {
        return value.some((v) => String(v).toLowerCase().includes(String(fv).toLowerCase()));
      }
      return false;
    }
    if (op === 'in') {
      if (Array.isArray(fv)) {
        return (fv as unknown[]).includes(value);
      }
      return false;
    }
    if (op === 'not-in') {
      if (Array.isArray(fv)) {
        return !(fv as unknown[]).includes(value);
      }
      return true;
    }

    return true;
  }

  /* ----------------------------- sorting ----------------------------- */

  sortNodes(nodes: NodeWebDTO[], sort: NodeSort): NodeWebDTO[] {
    const { field, dir } = sort;
    const multiplier = dir === 'asc' ? 1 : -1;

    return [...nodes].sort((a, b) => {
      let av: number | string | null = 0;
      let bv: number | string | null = 0;

      switch (field) {
        case 'proxyLatency':
          av = a.medianProxyMs ?? Infinity;
          bv = b.medianProxyMs ?? Infinity;
          break;
        case 'tcpLatency':
          av = a.medianTcpMs ?? Infinity;
          bv = b.medianTcpMs ?? Infinity;
          break;
        case 'tlsLatency':
          av = a.medianTlsMs ?? Infinity;
          bv = b.medianTlsMs ?? Infinity;
          break;
        case 'packetLoss':
          av = a.recentLossPct;
          bv = b.recentLossPct;
          break;
        case 'reliability':
          av = a.reliabilityPct;
          bv = b.reliabilityPct;
          break;
        case 'score':
          av = a.score;
          bv = b.score;
          break;
        case 'country':
          av = a.country ?? '';
          bv = b.country ?? '';
          break;
        case 'city':
          av = a.city ?? '';
          bv = b.city ?? '';
          break;
        case 'asn':
          av = a.asn ?? 0;
          bv = b.asn ?? 0;
          break;
        case 'isp':
          av = a.isp ?? '';
          bv = b.isp ?? '';
          break;
        case 'protocol':
          av = a.protocol;
          bv = b.protocol;
          break;
        case 'port':
          av = a.port;
          bv = b.port;
          break;
        case 'transport':
          av = a.transport;
          bv = b.transport;
          break;
        case 'tls':
          av = a.security;
          bv = b.security;
          break;
        case 'reality':
          av = a.security === 'reality' ? 1 : 0;
          bv = b.security === 'reality' ? 1 : 0;
          break;
        case 'ipv4':
          av = a.ipv4.length;
          bv = b.ipv4.length;
          break;
        case 'ipv6':
          av = a.ipv6.length;
          bv = b.ipv6.length;
          break;
        case 'source':
          av = a.sourceCount;
          bv = b.sourceCount;
          break;
        case 'sourceCount':
          av = a.sourceCount;
          bv = b.sourceCount;
          break;
        case 'firstSeen':
          av = a.firstSeen;
          bv = b.firstSeen;
          break;
        case 'lastSeen':
          av = a.lastSeen;
          bv = b.lastSeen;
          break;
        case 'stability':
          av = a.reliabilityPct;
          bv = b.reliabilityPct;
          break;
        default:
          av = a.lastSeen;
          bv = b.lastSeen;
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

  /* ------------------------- adaptive auto-test selection ------------------------- */

  /**
   * Pick nodes for the autonomous tester, bucket by priority:
   *   never-validated — imported but never probed (status 'discovered'), newest first
   *   stale-good      — previously healthy, measurement oldest (keep rankings honest)
   *   unstable        — degraded with recent failures (flapping → retest)
   * Cheap bounded lists; the scheduler runs a handful of TCP probes per tick.
   */
  pickNodesForAutoTest(opts: { bucket: 'never-validated' | 'stale-good' | 'unstable'; limit: number }): Array<{ id: string }> {
    const limit = Math.min(opts.limit, 50);
    const all = this.deps.nodes.list({ limit: 2000 }).rows as unknown as PublicNodeRow[]; // in-memory filter over indexed columns
    const now = Date.now();
    let rows: PublicNodeRow[];
    switch (opts.bucket) {
      case 'never-validated':
        rows = all.filter((n) => n.lastValidated == null).sort((a, b) => b.firstSeen - a.firstSeen);
        break;
      case 'stale-good': {
        const healthy = all.filter((n) => n.lastValidated != null && (n.status === 'healthy' || n.score >= 60));
        healthy.sort((a, b) => (a.lastValidated ?? 0) - (b.lastValidated ?? 0));
        rows = healthy;
        break;
      }
      case 'unstable': {
        const flapping = all.filter((n) => n.consecutiveFailures > 0 && n.consecutiveFailures < 10 && now - (n.lastFailureAt ?? 0) < 7 * 86_400_000);
        flapping.sort((a, b) => (b.lastFailureAt ?? 0) - (a.lastFailureAt ?? 0));
        rows = flapping;
        break;
      }
    }
    return rows.slice(0, limit).map((n) => ({ id: n.id }));
  }

  /**
   * Retire dead nodes: not seen in any source for 14 days AND failing
   * consecutively → status 'stale'. History is kept (retention service owns
   * deletion); only the lifecycle state moves. Returns how many retired.
   */
  retireStaleNodes(): number {
    const all = this.deps.nodes.list({ limit: 5000 }).rows;
    const now = Date.now();
    const RETIRE_AFTER_MS = 14 * 86_400_000;
    let n = 0;
    for (const row of all) {
      if (row.status === 'stale') continue;
      const unseenFor = now - row.lastSeen;
      if (unseenFor > RETIRE_AFTER_MS && row.consecutiveFailures >= 3) {
        this.deps.nodes.updateStatus(row.id, 'stale');
        n += 1;
      }
    }
    return n;
  }

  /* ----------------------------- recommendations ----------------------------- */

  recommendNodes(options: {
    preset: string;
    country?: string;
    asn?: number;
    ipv4?: boolean;
    ipv6?: boolean;
    vpnActive?: boolean;
    directReliable?: boolean;
    targetService?: string;
    limit?: number;
  }): NodeWebDTO[] {
    const { preset, limit = 10 } = options;

    // Get all nodes with basic filters
    const { rows } = this.deps.nodes.list({
      limit: 500,
      protocol: undefined,
      country: options.country,
      asn: options.asn,
      status: 'healthy',
      freshness: 'fresh',
      minScore: 50,
      sortField: 'score',
      sortDir: 'desc',
    });

    let filtered = rows.map((r) => this.toWebDTO(r));

    // Apply preset-specific filtering
    switch (preset) {
      case 'fastest':
        filtered.sort((a, b) => {
          const aMs = a.medianProxyMs ?? a.medianTcpMs ?? Infinity;
          const bMs = b.medianProxyMs ?? b.medianTcpMs ?? Infinity;
          return (aMs - bMs) * 1000;
        });
        break;

      case 'most-stable':
        filtered.sort((a, b) => (b.reliabilityPct - a.reliabilityPct) * 100);
        break;

      case 'lowest-loss':
        filtered.sort((a, b) => (a.recentLossPct - b.recentLossPct) * 100);
        break;

      case 'best-for-gaming':
        // Gaming: low latency + low loss + stability
        filtered.sort((a, b) => {
          const aScore = (a.medianProxyMs ?? a.medianTcpMs ?? 999) * 0.5 +
                        a.recentLossPct * 2 +
                        (100 - a.reliabilityPct) * 0.5;
          const bScore = (b.medianProxyMs ?? b.medianTcpMs ?? 999) * 0.5 +
                        b.recentLossPct * 2 +
                        (100 - b.reliabilityPct) * 0.5;
          return aScore - bScore;
        });
        break;

      case 'best-for-video':
        // Video: low loss + decent latency
        filtered.sort((a, b) => {
          const aScore = a.recentLossPct * 3 + (a.medianProxyMs ?? a.medianTcpMs ?? 999) * 0.2;
          const bScore = b.recentLossPct * 3 + (b.medianProxyMs ?? b.medianTcpMs ?? 999) * 0.2;
          return aScore - bScore;
        });
        break;

      case 'best-for-current-network':
        // Prefer nodes that match user's current network characteristics
        if (options.ipv4) {
          filtered = filtered.filter((n) => n.ipv4.length > 0);
        }
        if (options.ipv6) {
          filtered = filtered.filter((n) => n.ipv6.length > 0);
        }
        filtered.sort((a, b) => (b.score - a.score) * 100);
        break;

      case 'best-ipv6':
        filtered = filtered.filter((n) => n.ipv6.length > 0);
        filtered.sort((a, b) => (b.score - a.score) * 100);
        break;

      case 'best-route':
        // Prefer nodes with good geographic proximity
        filtered.sort((a, b) => {
          if (a.country && b.country) {
            const aDistance = this.geoDistance(a.lat, a.lon, options.country);
            const bDistance = this.geoDistance(b.lat, b.lon, options.country);
            if (aDistance != null && bDistance != null) {
              return aDistance - bDistance;
            }
          }
          return (b.score - a.score) * 100;
        });
        break;

      case 'best-recently-verified':
        filtered.sort((a, b) => ((a.lastValidated ?? 0) - (b.lastValidated ?? 0)) * 1000);
        break;

      case 'most-sources':
        filtered.sort((a, b) => (b.sourceCount - a.sourceCount) * 100);
        break;

      case 'newest':
        filtered.sort((a, b) => ((a.firstSeen ?? 0) - (b.firstSeen ?? 0)) * 1000);
        break;

      default:
        filtered.sort((a, b) => (b.score - a.score) * 100);
    }

    return filtered.slice(0, limit);
  }

  private geoDistance(lat1: number | null, lon1: number | null, countryCode: string | undefined): number | null {
    if (lat1 == null || lon1 == null) return null;

    // Approximate country centroids (simplified)
    const centroids: Record<string, { lat: number; lon: number }> = {
      DE: { lat: 51.1657, lon: 10.4515 },  // Germany
      FR: { lat: 46.6034, lon: 1.8883 },   // France
      NL: { lat: 52.1326, lon: 5.2913 },   // Netherlands
      UK: { lat: 55.3781, lon: -3.4360 },  // United Kingdom
      US: { lat: 37.0902, lon: -95.7129 }, // United States
      SG: { lat: 1.3521, lon: 103.8198 },  // Singapore
      JP: { lat: 36.2048, lon: 138.2529 }, // Japan
      IR: { lat: 32.4279, lon: 53.6880 },  // Iran
      TR: { lat: 38.9637, lon: 35.2433 },  // Turkey
      RU: { lat: 61.5240, lon: 105.3188 }, // Russia
      CN: { lat: 35.8617, lon: 104.1954 }, // China
      AU: { lat: -25.2744, lon: 133.7751 }, // Australia
      BR: { lat: -14.2350, lon: -51.9253 }, // Brazil
      IN: { lat: 20.5937, lon: 78.9629 },  // India
      KE: { lat: -0.0236, lon: 37.9062 },  // Kenya
      ZA: { lat: -30.5595, lon: 22.9375 }, // South Africa
      TW: { lat: 23.6978, lon: 120.9605 }, // Taiwan
      HK: { lat: 22.3193, lon: 114.1694 }, // Hong Kong
    };

    const target = centroids[countryCode || ''];
    if (!target) return null;

    const R = 6371; // Earth radius in km
    const dLat = (target.lat - lat1) * Math.PI / 180;
    const dLon = (target.lon - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(target.lat * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /* ----------------------------- favorites ----------------------------- */

  setFavorite(nodeId: string, favorite: boolean, tags?: string[]): void {
    const nodeRow = this.deps.nodes.get(nodeId);
    if (!nodeRow) throw new Error(`node not found: ${nodeId}`);

    const existingTags = nodeRow.tags || [];
    const newTags = favorite ? [...new Set([...existingTags, ...(tags || [])])] : existingTags.filter((t) => t !== 'favorite');

    this.deps.nodes.setFavorite(nodeId, favorite, newTags.length > 0 ? newTags : undefined);

    this.recordEvent('node.status.changed', {
      nodeId,
      status: favorite ? 'favorite' : 'unfavorited',
    });
  }

  setTags(nodeId: string, tags: string[]): void {
    this.deps.nodes.setTags(nodeId, tags);
    this.recordEvent('node.status.changed', { nodeId, tags });
  }

  /* ----------------------------- export ----------------------------- */

  exportNodes(nodeIds: string[], format: string): string {
    const rows = this.deps.nodes.listByIds(nodeIds);

    switch (format) {
      case 'uri':
        return rows.map((n) => this.toUri(n)).join('\n');

      case 'plaintext':
        return rows.map((n) => this.toUri(n)).join('\n');

      case 'base64':
        const uris = rows.map((n) => this.toUri(n)).join('\n');
        return Buffer.from(uris, 'utf8').toString('base64');

      case 'json':
        return JSON.stringify(rows.map((n) => this.toExportJSON(n)), null, 2);

      case 'clash':
        return this.toClashConfig(rows);

      case 'singbox':
        return this.toSingboxConfig(rows);

      default:
        return rows.map((n) => this.toUri(n)).join('\n');
    }
  }

  private toUri(node: {
    protocol: NodeProtocol;
    host: string;
    port: number;
    security: string;
    transport: string;
    sni: string | null;
    path: string | null;
    hostHeader: string | null;
    flow: string | null;
    alpn: string[];
    remark: string | null;
    encryption: string | null;
    ssrProtocol: string | null;
  }): string {
    // Build a share-link URI from node config
    // Note: This does NOT include secrets — those must be provided separately
    switch (node.protocol) {
      case 'vless':
        return `vless://<password>@${node.host}:${node.port}?security=${node.security}&type=${node.transport}${node.sni ? `&sni=${node.sni}` : ''}${node.path ? `&path=${node.path}` : ''}${node.hostHeader ? `&host=${node.hostHeader}` : ''}${node.flow ? `&flow=${node.flow}` : ''}#${node.remark || node.host}`;

      case 'vmess':
        // VMess URIs are base64-encoded JSON; we can't reconstruct without the UUID
        return `vmess://<uuid-needed>@${node.host}:${node.port}?security=${node.security}&type=${node.transport}${node.sni ? `&sni=${node.sni}` : ''}#${node.remark || node.host}`;

      case 'trojan':
        return `trojan://<password>@${node.host}:${node.port}?sni=${node.sni}&type=${node.transport}${node.path ? `&path=${node.path}` : ''}#${node.remark || node.host}`;

      case 'shadowsocks':
        return `ss://<method>:<password>@${node.host}:${node.port}#${node.remark || node.host}`;

      case 'shadowsocksr':
        return `ssr://<base64-encoded-config>#${node.remark || node.host}`;

      case 'hysteria2':
        return `hysteria2://<password>@${node.host}:${node.port}?sni=${node.sni}#${node.remark || node.host}`;

      case 'tuic':
        return `tuic://<password>@${node.host}:${node.port}?sni=${node.sni}&alpn=${node.alpn?.[0] || 'h3'}#${node.remark || node.host}`;

      case 'wireguard':
        return `wireguard://<private-key>@${node.host}:${node.port}?ip=0.0.0.0/0&dns=1.1.1.1#${node.remark || node.host}`;

      default:
        return `${node.protocol}://${node.host}:${node.port}`;
    }
  }

  private toExportJSON(node: {
    id: string;
    host: string;
    port: number;
    protocol: NodeProtocol;
    transport: string;
    security: string;
    sni: string | null;
    alpn: string[];
    path: string | null;
    hostHeader: string | null;
    serviceName: string | null;
    flow: string | null;
    allowInsecure: boolean;
    remark: string | null;
    sourceCount: number;
    country: string | null;
    city: string | null;
    asn: number | null;
    isp: string | null;
    score: number;
    reliabilityPct: number;
    medianProxyMs: number | null;
    medianTcpMs: number | null;
    medianTlsMs: number | null;
    recentLossPct: number;
    lastValidated: number | null;
    freshness: string;
  }): Record<string, unknown> {
    // Return a config that can be imported by a client
    return {
      id: node.id,
      host: node.host,
      port: node.port,
      protocol: node.protocol,
      transport: node.transport,
      security: node.security,
      sni: node.sni,
      alpn: node.alpn,
      path: node.path,
      hostHeader: node.hostHeader,
      serviceName: node.serviceName,
      flow: node.flow,
      allowInsecure: node.allowInsecure,
      remark: node.remark,
      sourceCount: node.sourceCount,
      country: node.country,
      city: node.city,
      asn: node.asn,
      isp: node.isp,
      score: node.score,
      reliabilityPct: node.reliabilityPct,
      medianProxyMs: node.medianProxyMs,
      medianTcpMs: node.medianTcpMs,
      medianTlsMs: node.medianTlsMs,
      recentLossPct: node.recentLossPct,
      lastValidated: node.lastValidated,
      freshness: node.freshness,
      // Note: secrets are NOT included
    };
  }

  private toClashConfig(nodes: Array<{
    protocol: NodeProtocol;
    host: string;
    port: number;
    security: string;
    transport: string;
    sni: string | null;
    path: string | null;
    remark: string | null;
    alterId: number | null;
    encryption: string | null;
    flow: string | null;
    alpn: string[];
  }>): string {
    const proxies: string[] = nodes.map((n) => {
      switch (n.protocol) {
        case 'vless':
          return `  - name: ${n.remark || n.host}\n    type: vless\n    server: ${n.host}\n    port: ${n.port}\n    uuid: <uuid>\n    tls: ${n.security === 'tls' || n.security === 'reality'}\n    ${n.sni ? `sni: ${n.sni}` : ''}\n    ${n.transport !== 'tcp' ? `transport: ${n.transport}` : ''}`;
        case 'vmess':
          return `  - name: ${n.remark || n.host}\n    type: vmess\n    server: ${n.host}\n    port: ${n.port}\n    uuid: <uuid>\n    alterId: ${n.alterId ?? 0}\n    tls: ${n.security === 'tls'}\n    ${n.sni ? `sni: ${n.sni}` : ''}\n    ${n.transport !== 'tcp' ? `transport: ${n.transport}` : ''}`;
        case 'trojan':
          return `  - name: ${n.remark || n.host}\n    type: trojan\n    server: ${n.host}\n    port: ${n.port}\n    password: <password>\n    tls: true\n    ${n.sni ? `sni: ${n.sni}` : ''}`;
        case 'shadowsocks':
          return `  - name: ${n.remark || n.host}\n    type: shadowsocks\n    server: ${n.host}\n    port: ${n.port}\n    password: <password>\n    cipher: ${n.encryption || 'aes-256-gcm'}`;
        default:
          return `  - name: ${n.remark || n.host}\n    type: ${n.protocol}\n    server: ${n.host}\n    port: ${n.port}`;
      }
    });

    return `proxies:\n${proxies.join('\n')}\n`;
  }

  private toSingboxConfig(nodes: Array<{
    id: string;
    protocol: NodeProtocol;
    host: string;
    port: number;
    security: string;
    transport: string;
    sni: string | null;
    path: string | null;
    remark: string | null;
    alterId: number | null;
    encryption: string | null;
    flow: string | null;
    alpn: string[];
  }>): string {
    // Generate sing-box outbound configs
    const outbounds = nodes.map((n) => {
      switch (n.protocol) {
        case 'vless':
          return `  - name: ${n.remark || n.id}\n    type: vless\n    server: ${n.host}\n    port: ${n.port}\n    uuid: <uuid>\n    tls:\n      enabled: true\n      server_name: ${n.sni || n.host}\n      ${n.transport !== 'tcp' ? `transport: ${n.transport}` : ''}\n      ${n.flow ? `flow: ${n.flow}` : ''}`;
        case 'vmess':
          return `  - name: ${n.remark || n.id}\n    type: vmess\n    server: ${n.host}\n    port: ${n.port}\n    uuid: <uuid>\n    alter_id: ${n.alterId ?? 0}\n    security: auto\n    tls:\n      enabled: true\n      server_name: ${n.sni || n.host}\n      ${n.transport !== 'tcp' ? `transport: ${n.transport}` : ''}`;
        case 'trojan':
          return `  - name: ${n.remark || n.id}\n    type: trojan\n    server: ${n.host}\n    port: ${n.port}\n    password: <password>\n    tls:\n      enabled: true\n      server_name: ${n.sni || n.host}`;
        case 'shadowsocks':
          return `  - name: ${n.remark || n.id}\n    type: shadowsocks\n    server: ${n.host}\n    port: ${n.port}\n    password: <password>\n    cipher: ${n.encryption || 'aes-256-gcm'}`;
        default:
          return `  - name: ${n.remark || n.id}\n    type: ${n.protocol}\n    server: ${n.host}\n    port: ${n.port}`;
      }
    });

    return `outbounds:\n${outbounds.join('\n')}\n`;
  }

  /* ----------------------------- toWebDTO ----------------------------- */

  private toWebDTO(node: {
    id: string;
    canonicalFingerprint: string;
    fingerprint: string | null;
    protocol: string;
    host: string;
    ipv4: string[];
    ipv6: string[];
    port: number;
    transport: string;
    security: string;
    sni: string | null;
    alpn: string[];
    flow: string | null;
    alterId: number | null;
    encryption: string | null;
    ssrProtocol: string | null;
    path: string | null;
    hostHeader: string | null;
    serviceName: string | null;
    allowInsecure: boolean;
    realityPublicKey: string | null;
    realityShortId: string | null;
    realityServerName: string | null;
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
    /** last geolocation attempt (epoch ms) — needed to derive geoStatusReason */
    geoLastAttempt: number | null;
    isp: string | null;
    organization: string | null;
    lat: number | null;
    lon: number | null;
    geoSourceCount: number;
    userNotes: string | null;
    score: number;
    reliabilityPct: number;
    medianProxyMs: number | null;
    medianTcpMs: number | null;
    medianTlsMs: number | null;
    recentLossPct: number;
    lastSuccessAt: number | null;
    lastFailureAt: number | null;
    freshness: string;
    tags: string[];
    favorite: boolean;
    lastProxyMs: number | null;
    /** raw DB value; coerced to the DTO union below */
    lastEngine: string | null;
    lastTcpMs: number | null;
    lastTlsMs: number | null;
    testCount: number;
    successCount: number;
    failureCount: number;
    consecutiveFailures: number;
    recentTestCount: number;
    recentSuccessCount: number;
    recentFailureCount: number;
    createdAt: number;
    updatedAt: number;
  }): NodeWebDTO {
    const proto = node.protocol as NodeProtocol;
    return {
      id: node.id,
      canonicalFingerprint: node.canonicalFingerprint,
      fingerprint: node.fingerprint,
      protocol: proto,
      protocolLabel: PROTOCOL_LABELS[proto] || proto,
      host: node.host,
      ipv4: node.ipv4,
      ipv6: node.ipv6,
      port: node.port,
      transport: node.transport,
      transportLabel: TRANSPORT_LABELS[node.transport as keyof typeof TRANSPORT_LABELS] || node.transport,
      security: node.security,
      securityLabel: SECURITY_LABELS[node.security as keyof typeof SECURITY_LABELS] || node.security,
      sni: node.sni,
      alpn: node.alpn,
      flow: node.flow,
      alterId: node.alterId,
      path: node.path,
      hostHeader: node.hostHeader,
      serviceName: node.serviceName,
      allowInsecure: node.allowInsecure,
      realityPublicKey: node.realityPublicKey,
      realityShortId: node.realityShortId,
      realityServerName: node.realityServerName,
      encryption: node.encryption,
      ssrProtocol: node.ssrProtocol,
      remark: node.remark,
      sourceIds: node.sourceIds,
      sourceUrls: node.sourceUrls,
      sourceCount: node.sourceCount,
      firstSeen: node.firstSeen,
      lastSeen: node.lastSeen,
      lastValidated: node.lastValidated,
      status: node.status,
      confidence: node.confidence,
      country: node.country,
      city: node.city,
      asn: node.asn,
      isp: node.isp,
      organization: node.organization,
      lat: node.lat,
      lon: node.lon,
      geoSourceCount: node.geoSourceCount,
      geoStatusReason: geoStatusReasonFor({
        host: node.host,
        lat: node.lat,
        asn: node.asn,
        geoLastAttempt: node.geoLastAttempt,
      }),
      tags: node.tags,
      favorite: node.favorite,
      userNotes: node.userNotes,
      lastProxyMs: node.lastProxyMs,
      lastEngine: node.lastEngine === 'xray' || node.lastEngine === 'sing-box' ? node.lastEngine : null,
      lastTcpMs: node.lastTcpMs,
      lastTlsMs: node.lastTlsMs,
      testCount: node.testCount,
      successCount: node.successCount,
      failureCount: node.failureCount,
      consecutiveFailures: node.consecutiveFailures,
      recentTestCount: node.recentTestCount,
      recentSuccessCount: node.recentSuccessCount,
      recentFailureCount: node.recentFailureCount,
      score: node.score,
      reliabilityPct: node.reliabilityPct,
      medianProxyMs: node.medianProxyMs,
      medianTcpMs: node.medianTcpMs,
      medianTlsMs: node.medianTlsMs,
      recentLossPct: node.recentLossPct,
      lastSuccessAt: node.lastSuccessAt,
      lastFailureAt: node.lastFailureAt,
      freshness: node.freshness,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
    };
  }
}
