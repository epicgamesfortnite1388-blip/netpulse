import crypto from 'node:crypto';

import type {
  NodeConfidence,
  NodeEventKind,
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

import { fingerprintHash, buildFingerprint } from './nodeParsers';
import type { NodeSecretVault } from './nodeSecretVault';
import { fetchAndImportSource, hashContent, partitionConfigs, type FetchContext } from './nodeSourceRegistry';

import type { LinkExport } from './nodeLinkExport';
import type { RawDocumentsRepository, SourceFetchesRepository } from '../db/repositories';
import type { AppSettings, ProxyEngineId, PublicSource } from '@netpulse/shared';
import { geoStatusReasonFor } from './nodeGeoService';
import { applyTestOutcome, distributionOf } from './nodeScoring';
import { proxyProbeMany, runProbe, type ProbeDeps } from './nodeTestProbes';
import { isExportFormat, nodeLink, serializeExport } from './nodeExport';
import type { ExportRow } from './nodeExport';
import { toWebDTO } from './nodeView';
import type { NodeWebDTO } from './nodeView';
import { validateNodeHost, normalizeNodePort, resolveTarget } from '../util/targetGuard';
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

/* --------------------------- internal state -------------------------------- */

/**
 * One node's outcome from a bulk run. `result` is a completed measurement;
 * `error` is a failure that produced no measurement at all (unknown node id,
 * or a probe that threw). At most one is set.
 */
export interface NodeTestOutcome {
  nodeId: string;
  result?: NodeTestResult;
  error?: string;
}

export class NodesService {
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

  async discoverFromSource(sourceId: string): Promise<{
    status: 'completed' | 'failed';
    error: string | null;
    parsed: number;
    imported: number;
    duplicates: number;
    invalid: number;
  }> {
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
      status: result.status,
      error: result.error,
      imported: result.imported,
      duplicates: result.duplicates,
      invalid: result.invalid,
    });

    return {
      status: result.status,
      error: result.error,
      parsed: result.fetched,
      imported: result.imported,
      duplicates: result.duplicates,
      invalid: result.invalid,
    };
  }

  /* ----------------------------- import ----------------------------- */

  /**
   * Import configs the user supplied directly (pasted links, or one node
   * exported and re-added).
   *
   * Parsing happens through the same `partitionConfigs` the fetchers use, so a
   * pasted link is validated at exactly the same boundary as a downloaded one,
   * and storage runs through `importParsedConfigs` with NO source: a manual
   * config has no feed behind it, and inventing one would put a fiction in the
   * Sources page. Results stay split into imported / duplicates / invalid so the
   * UI can report what really happened rather than "added".
   *
   * A manual import may REPLACE a stored credential (`replaceExistingSecret`).
   * That is the only path allowed to, and it has to be: the fingerprint ignores
   * the credential, so a provider that rotates a password/UUID — or a control
   * plane that re-issues one to the same account — produces exactly the same
   * node, and the vault kept the retired value forever. Re-submitting the
   * provider's link is the user's own statement that this is the current
   * credential. A subscription feed is not: a public list carrying the same
   * host with a shared credential would otherwise silently overwrite a
   * per-user one, so sources keep the backfill-only rule.
   */
  async importManualConfigs(
    rawConfigs: string[],
  ): Promise<{ imported: number; duplicates: number; invalid: number; nodeIds: string[]; credentialsUpdated: number }> {
    const candidates = rawConfigs.map((c) => c.trim()).filter((c) => c.length > 0);
    if (candidates.length === 0) return { imported: 0, duplicates: 0, invalid: 0, nodeIds: [], credentialsUpdated: 0 };

    const { valid, invalid } = partitionConfigs(candidates);
    if (valid.length === 0) {
      this.recordEvent('node.manual-import', { submitted: candidates.length, imported: 0, duplicates: 0, invalid });
      return { imported: 0, duplicates: 0, invalid, nodeIds: [], credentialsUpdated: 0 };
    }

    const stored = await this.importParsedConfigs(null, valid, null, { replaceExistingSecret: true });
    const result = { ...stored, invalid: stored.invalid + invalid };
    this.recordEvent('node.manual-import', {
      submitted: candidates.length,
      imported: result.imported,
      duplicates: result.duplicates,
      invalid: result.invalid,
      // Reported so "imported 0, duplicates N" can be told apart from
      // "imported 0, duplicates N, and N credentials were stale and replaced".
      credentialsUpdated: result.credentialsUpdated,
    });
    return result;
  }

  async importParsedConfigs(
    sourceId: string | null,
    configs: Array<{ raw: string; parsed: { config: ParsedNodeConfig; secret: string } | null }>,
    sourceUrl: string | null,
    opts: {
      /**
       * Allow this import to replace a stored credential with the one it was
       * given. Off by default: only a manual/provider-supplied config is an
       * assertion about which credential the server accepts now (see
       * `importManualConfigs`).
       */
      replaceExistingSecret?: boolean;
    } = {},
  ): Promise<{ imported: number; duplicates: number; invalid: number; nodeIds: string[]; credentialsUpdated: number }> {
    const now = Date.now();
    // `created` counts what this call actually added; `touched` also carries the
    // ids of nodes it already knew. Both were the same array before, so a
    // re-import reported "imported: 1, duplicates: 1" — a double count that also
    // inflated the per-source imported totals shown in the UI.
    const created: string[] = [];
    const touched: string[] = [];
    let duplicates = 0;
    let invalid = 0;
    // How many already-known nodes had their stored credential replaced by the
    // one supplied here. This is the app's only evidence that a stored credential
    // was out of date, so it is counted rather than inferred.
    let credentialsUpdated = 0;

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

        // Record provenance. The id is left to the table's autoincrement: a
        // computed `id` was identical for every row in a batch (same lengths,
        // same timestamp), so the primary-key conflict silently discarded all
        // but the first row and attribution was lost.
        if (sourceId) {
          this.deps.sources.insert({
            nodeId: existing.id,
            sourceId,
            sourceUrl: sourceUrl ?? sourceId,
            sourceConfigRef: hashContent(item.raw),
            parserVersion: '1.0.0',
            normalizedHash: fpHash,
            discoveredAt: now,
          });
        }

        // Update node metadata
        this.deps.nodes.update(existing.id, {
          lastSeen: now,
          sourceIds: sourceId ? [...new Set([...existing.sourceIds, sourceId])] : existing.sourceIds,
          sourceUrls: sourceUrl ? [...new Set([...existing.sourceUrls, sourceUrl])] : existing.sourceUrls,
          sourceCount: sourceId ? (existing.sourceCount || 1) + 1 : existing.sourceCount || 1,
          status: 'discovered', // Reset to discovered if previously stale
          updatedAt: now,
        });

        // Backfill the secret vault: nodes imported before vaulting existed
        // (or whose vault entry was lost) arrive as duplicates forever and
        // could never regain their credentials — every proxy test then failed
        // auth honestly but permanently. If the source still supplies the
        // secret and the vault has none, store it.
        //
        // A stored credential that DIFFERS is the rotation case, and it is
        // decided separately: the fingerprint (which ignores the credential)
        // says "same node", but the server may no longer accept what is vaulted.
        // Without this branch a rotated credential could never be repaired from
        // the app — the node is a duplicate forever, so no import would ever
        // write the new secret.
        const vaulted = this.deps.nodeVault?.get(existing.id) ?? null;
        const incoming = item.parsed.secret || null;
        let secretReplaced = false;

        if (incoming && vaulted == null) {
          try {
            this.deps.nodeVault?.set(existing.id, incoming);
          } catch {
            // vault failure must not block the import; tests will report
          }
        } else if (incoming && vaulted !== incoming && opts.replaceExistingSecret) {
          try {
            this.deps.nodeVault?.set(existing.id, incoming);
            secretReplaced = true;
            credentialsUpdated++;
          } catch {
            // As above: a vault failure leaves the old credential in place and is
            // reported as "not replaced" rather than as a successful refresh.
          }
        }

        this.recordEvent('node.duplicate', {
          nodeId: existing.id,
          host: existing.host,
          sourceId,
          sourceUrl,
          secretBackfilled: Boolean(incoming) && vaulted == null,
          secretReplaced,
        });

        touched.push(existing.id);
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
        sourceIds: sourceId ? [sourceId] : [],
        sourceUrls: sourceUrl ? [sourceUrl] : [],
        sourceCount: sourceId ? 1 : 0,
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

      // Record provenance (id left to the table's autoincrement — see above).
      // A manual import has no source row to attribute, so none is written.
      if (sourceId) {
        this.deps.sources.insert({
          nodeId,
          sourceId,
          sourceUrl: sourceUrl ?? sourceId,
          sourceConfigRef: hashContent(item.raw),
          parserVersion: '1.0.0',
          normalizedHash: fpHash,
          discoveredAt: now,
        });
      }

      // Record address
      // Address rows take the autoincrement id for the same reason.
      for (const ip of node.ipv4) {
        this.deps.addresses.insert({ nodeId, ip, family: 4, firstSeen: now, lastSeen: now });
      }
      for (const ip of node.ipv6) {
        this.deps.addresses.insert({ nodeId, ip, family: 6, firstSeen: now, lastSeen: now });
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
      created.push(nodeId);
      touched.push(nodeId);
    }

    // NOTE: no DNS resolution in the import path. Free-config hostnames are
    // mostly nonexistent domains — thousands of resolver round-trips made a
    // single import take ~54 s. Nodes get ipv4/ipv6 when they are actually
    // TESTED (testNode → resolveTarget), which is the only consumer that
    // needs them. Import stays parse+store (sub-2 s for 8k configs).

    // Update source stats (only when the import really came from a source)
    const src = sourceId ? this.deps.sourceRepo.get(sourceId) : undefined;
    if (src && sourceId) {
      this.deps.sourceRepo.update(sourceId, {
        discoveredConfigCount: (src.discoveredConfigCount ?? 0) + configs.length,
        importedConfigCount: (src.importedConfigCount ?? 0) + created.length,
        duplicateCount: (src.duplicateCount ?? 0) + duplicates,
        invalidCount: (src.invalidCount ?? 0) + invalid,
      });
    }

    // nodeIds lists every node this call operated on — both newly created
    // AND duplicates already known to the DB — so callers (including the
    // packaged-app VPN lifecycle proof driver) can always pick up the node
    // it just imported or re-validated, even when it was a duplicate.
    //
    // Deduped on purpose: a NEW node is pushed into `created` (for the count)
    // and also into `touched` (meaning "operated on"), so the raw concat
    // returned each freshly imported id exactly twice. Any caller indexing
    // nodeIds[i] then read a different node than it imported — and the VPN
    // proof driver does exactly that. A duplicate lands only in `touched`,
    // so the union is still the complete set either way.
    return {
      imported: created.length,
      duplicates,
      invalid,
      nodeIds: [...new Set([...created, ...touched])],
      credentialsUpdated,
    };
  }

  /* ----------------------------- testing ----------------------------- */

  /**
   * The engine-facing view of a stored node row. ONE mapping, shared by the
   * single-node test and the bulk path, so a batched probe can never measure a
   * node with a field dropped that the single path would have sent.
   */
  private nodeForTest(nodeId: string): PublicNode {
    const nodeRow = this.deps.nodes.get(nodeId);
    if (!nodeRow) throw new Error(`node not found: ${nodeId}`);
    return {
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
      lastEngine: (['xray', 'sing-box', 'v2ray'].includes(nodeRow.lastEngine as string) ? nodeRow.lastEngine : null) as 'xray' | 'sing-box' | 'v2ray' | null,
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
  }

  async testNode(nodeId: string, type: NodeTestType, ip?: string): Promise<NodeTestResult> {
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

    const node = this.nodeForTest(nodeId);

    const { testId } = this.beginTest(node, type);

    try {
      if (type !== 'tcp' && type !== 'tls' && type !== 'proxy' && type !== 'icmp') {
        throw new Error(`unknown test type: ${type}`);
      }

      // The probe owns the network work; this service owns the row lifecycle
      // (inserted 'running' above, terminal state written below) — so a test's
      // record can never be left hanging by a probe that forgot to persist.
      // Retry once on failure to absorb intermittent per-port stalls (ISP
      // flakiness) before recording a dead core.
      let result = await runProbe(node, type, probedIpOverride, this.probeDeps(nodeId));
      if (result.status === 'failed' || result.status === 'error') {
        result = await runProbe(node, type, probedIpOverride, this.probeDeps(nodeId));
      }

      this.recordResult(testId, result);

      // Update node with test result
      await this.updateNodeAfterTest(nodeId, node, result, type);

      return result;

    } catch (err) {
      this.recordFailure(nodeId, testId, type, err);
      throw err;
    }
  }

  /**
   * Test many nodes at once.
   *
   * Proxy tests are the reason this exists: testNode spawns a core per node,
   * so a bulk run spends most of its time starting and stopping processes.
   * The batched path puts several nodes in ONE core (proxyProbeMany →
   * startMultiCore), which is where a scan of dozens of nodes gets its time
   * back. tcp/tls/icmp spawn nothing, so they keep a bounded worker pool.
   *
   * Index-aligned with `nodeIds`. A `null` entry means the run stopped before
   * that node was reached (cancellation) — no test row exists for it, which is
   * deliberate: a cancelled scan must not leave `running` rows behind.
   */
  async testNodes(
    nodeIds: readonly string[],
    type: NodeTestType,
    opts: {
      concurrency?: number;
      shouldStop?: () => boolean;
      /** One outcome per node as it settles — scan progress reads this. */
      onResult?: (outcome: NodeTestOutcome) => void;
    } = {},
  ): Promise<Array<NodeTestOutcome | null>> {
    const outcomes: Array<NodeTestOutcome | null> = new Array(nodeIds.length).fill(null);
    const nodes: Array<PublicNode | null> = nodeIds.map((id) => {
      try {
        return this.nodeForTest(id);
      } catch {
        return null;
      }
    });
    nodeIds.forEach((id, i) => {
      if (nodes[i]) return;
      const outcome: NodeTestOutcome = { nodeId: id, error: `node not found: ${id}` };
      outcomes[i] = outcome;
      opts.onResult?.(outcome);
    });
    const runnable = nodeIds.map((_, i) => i).filter((i) => nodes[i]);

    if (type === 'proxy') {
      // Rows are opened per shared core (onGroupStart), not for the whole
      // request: a cancelled batch then has no unstarted 'running' rows.
      const testIds = new Map<number, string>();
      let results: Array<NodeTestResult | null> = [];
      try {
        results = await proxyProbeMany(
          runnable.map((i) => nodes[i]!),
          {
            testEndpoints: this.deps.testEndpoints,
            proxyEnginePreference: () => this.proxyEnginePreference(),
          },
          {
            secretFor: (nodeId) => this.deps.nodeVault?.get(nodeId) ?? null,
            onGroupStart: (batch) => {
              for (const k of batch) {
                const i = runnable[k];
                if (i === undefined) continue;
                testIds.set(i, this.beginTest(nodes[i]!, type).testId);
              }
            },
            shouldStop: opts.shouldStop,
          },
        );
      } catch (err) {
        // The runner is contractually never-throwing, but a config-generation
        // bug must not leave rows 'running' or become an unexplained 500.
        const message = err instanceof Error ? err.message : String(err);
        for (const [i, testId] of testIds) {
          this.recordFailure(nodes[i]!.id, testId, type, err);
          const outcome: NodeTestOutcome = { nodeId: nodes[i]!.id, error: message };
          outcomes[i] = outcome;
          opts.onResult?.(outcome);
        }
        return outcomes;
      }

      for (let k = 0; k < runnable.length; k++) {
        const i = runnable[k]!;
        const node = nodes[i]!;
        const result = results[k];
        const testId = testIds.get(i);
        // No row = this node's group never started (cancelled).
        if (!result || !testId) continue;
        this.recordResult(testId, result);
        await this.updateNodeAfterTest(node.id, node, result, type);
        const outcome: NodeTestOutcome = { nodeId: node.id, result };
        outcomes[i] = outcome;
        opts.onResult?.(outcome);
      }
      return outcomes;
    }

    const concurrency = Math.max(1, Math.min(16, opts.concurrency ?? 8));
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < runnable.length) {
        if (opts.shouldStop?.()) return;
        const i = runnable[cursor++]!;
        const node = nodes[i]!;
        const { testId } = this.beginTest(node, type);
        try {
          // One retry before the failure is recorded, the same bound the
          // single-node path (testNode) applies: reports/adaptive/
          // RAW_PATH_IR_ISP.txt D1/D3 shows the ISP stalling one port
          // intermittently (:443 answered at 13:07Z, no answer at 13:15Z while
          // the other three answered), so a single timed-out attempt must not
          // be recorded as a dead node; a second failed attempt is what makes
          // the failure a finding.
          let result = await runProbe(node, type, undefined, this.probeDeps(node.id));
          if (result.status === 'failed' || result.status === 'error') {
            result = await runProbe(node, type, undefined, this.probeDeps(node.id));
          }
          this.recordResult(testId, result);
          await this.updateNodeAfterTest(node.id, node, result, type);
          const outcome: NodeTestOutcome = { nodeId: node.id, result };
          outcomes[i] = outcome;
          opts.onResult?.(outcome);
        } catch (err) {
          this.recordFailure(node.id, testId, type, err);
          const outcome: NodeTestOutcome = { nodeId: node.id, error: err instanceof Error ? err.message : String(err) };
          outcomes[i] = outcome;
          opts.onResult?.(outcome);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, runnable.length) }, worker));
    return outcomes;
  }

  /** Probe dependencies, built once and shared by the single and bulk paths. */
  private probeDeps(nodeId: string): ProbeDeps {
    return {
      testEndpoints: this.deps.testEndpoints,
      proxyEnginePreference: () => this.proxyEnginePreference(),
      controller: this.deps.controller,
      secret: this.deps.nodeVault?.get(nodeId) ?? null,
    };
  }

  /**
   * Open a test row in the 'running' state and announce the start.
   *
   * The row is what keeps `running` honest: whichever path ran the probe, the
   * terminal state is written by recordResult/recordFailure, so a threw probe
   * can never leave a row hanging.
   */
  private beginTest(node: PublicNode, type: NodeTestType): { testId: string; startedAt: number } {
    const testId = `test:${node.id}:${type}:${Date.now().toString(36)}`;
    const startedAt = Date.now();
    this.deps.tests.insert({
      id: testId,
      nodeId: node.id,
      type,
      status: 'running',
      startedAt,
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
    this.recordEvent('node.test.started', { testId, nodeId: node.id, type });
    return { testId, startedAt };
  }

  /** Persist the final row state for EVERY test type (see testNode's history). */
  private recordResult(testId: string, result: NodeTestResult): void {
    this.deps.tests.update(testId, {
      status: result.status,
      latencyMs: result.latencyMs,
      totalMs: result.totalMs,
      tlsVersion: result.tlsVersion,
      authorized: result.authorized,
      httpStatus: result.httpStatus,
      responseSize: result.responseSize,
      error: result.error,
      finishedAt: result.finishedAt,
      engine: result.engine ?? undefined,
    });
  }

  /** Terminate a test row that never produced a result, and announce it. */
  private recordFailure(nodeId: string, testId: string, type: NodeTestType, err: unknown): void {
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
  }

  /**
   * Which core to prefer for proxy tests. Reads the live setting each call
   * (cheap: settings are cached); 'auto' lets the runner pick xray first.
   */
  private proxyEnginePreference(): 'auto' | ProxyEngineId {
    try {
      const s = this.deps.settings?.get();
      return s?.proxyEngine?.preferred ?? 'auto';
    } catch {
      return 'auto';
    }
  }

  /**
   * Apply one test outcome to the node's aggregate and its health row.
   *
   * The math (counters, medians, status, freshness, score, loss) is
   * nodeScoring.applyTestOutcome — pure and unit-tested there. This method owns
   * only what needs a repository: the node update, the health upsert, and the
   * completion event.
   */
  private async updateNodeAfterTest(nodeId: string, node: PublicNode, result: NodeTestResult, type: NodeTestType): Promise<void> {
    const now = Date.now();
    const wasSuccess = result.status === 'done';
    const { patch, counters } = applyTestOutcome(node, type, result, now);

    this.deps.nodes.update(nodeId, patch);

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

    healthRow.testCount = counters.testCount;
    healthRow.successCount = counters.successCount;
    healthRow.failureCount = counters.failureCount;
    healthRow.reliabilityPct = counters.reliabilityPct;

    // Real distribution stats: median/p95 over the node's recent successful
    // latencies. A single measurement echoed into both fields (the old
    // behavior) misreported spread.
    const recent = this.deps.tests
      .listByNode(nodeId, 100)
      .filter((t) => t.status === 'done' && t.latencyMs != null)
      .map((t) => t.latencyMs as number);
    const distribution = distributionOf(recent);
    healthRow.medianLatencyMs = distribution.median;
    healthRow.p95LatencyMs = distribution.p95;

    healthRow.lossPct = counters.lossPct;
    healthRow.lastSuccessAt = wasSuccess ? now : healthRow.lastSuccessAt;
    healthRow.lastFailureAt = !wasSuccess ? now : healthRow.lastFailureAt;
    healthRow.consecutiveFailures = counters.consecutiveFailures;
    healthRow.computedAt = now;

    this.deps.health.upsert(healthRow);

    this.recordEvent('node.test.completed', {
      nodeId,
      type,
      status: result.status,
      latencyMs: result.latencyMs,
      totalMs: result.totalMs,
      error: result.error,
    });
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
    /** only nodes whose last proxy test ran through this core ('xray' | 'sing-box' | 'v2ray') */
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
      nodes: rows.map((r) => toWebDTO(r)),
      total,
    };
  }

  getNode(id: string): NodeWebDTO | null {
    const node = this.deps.nodes.get(id);
    if (!node) return null;
    return toWebDTO(node);
  }

  /* ----------------------------- search ----------------------------- */

  searchNodes(query: string, limit = 50): NodeWebDTO[] {
    // The repository owns the search predicate, so it runs in SQL over every
    // stored node instead of over whichever rows this call happened to load.
    const { rows } = this.deps.nodes.list({ limit, search: query });
    return rows.map((r) => toWebDTO(r));
  }

  /* ----------------------------- IP lookup ----------------------------- */

  getNodesByIp(ip: string): NodeWebDTO[] {
    // Look up nodes that have this IP in their address list
    const addresses = this.deps.addresses.listByIp(ip);
    const nodeIds = [...new Set(addresses.map((a) => a.nodeId))];

    if (nodeIds.length === 0) return [];

    const rows = this.deps.nodes.listByIds(nodeIds);
    return rows.map((r) => toWebDTO(r));
  }

  getNodesByAsn(asn: number): NodeWebDTO[] {
    const { rows } = this.deps.nodes.list({
      limit: 200,
      asn,
    });
    return rows.map((r) => toWebDTO(r));
  }

  getNodesByHostname(host: string): NodeWebDTO[] {
    return this.deps.nodes.findByHost(host, 100).map((r) => toWebDTO(r));
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
    // Selection happens in SQL, so the buckets describe the whole database. It
    // used to load the newest 2,000 rows and filter them in memory, which meant
    // the tester could only ever see nodes near the top of that window.
    return this.deps.nodes.pickForAutoTest(opts.bucket, Math.min(opts.limit, 50));
  }

  /**
   * Retire dead nodes: not seen in any source for 14 days AND failing
   * consecutively → status 'stale'. History is kept (retention service owns
   * deletion); only the lifecycle state moves. Returns how many retired.
   */
  retireStaleNodes(): number {
    const RETIRE_AFTER_MS = 14 * 86_400_000;
    return this.deps.nodes.retireStale(Date.now() - RETIRE_AFTER_MS, 3);
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

    // Address-presence filtering happens on the ROW, before the DTO is built:
    // the view layer no longer carries ipv4/ipv6 (see nodeView.ts), and it never
    // should — these are capability checks, not things the client needs to see.
    let candidates = rows;
    if (preset === 'best-ipv6') {
      candidates = candidates.filter((r) => r.ipv6.length > 0);
    } else if (preset === 'best-for-current-network') {
      if (options.ipv4) candidates = candidates.filter((r) => r.ipv4.length > 0);
      if (options.ipv6) candidates = candidates.filter((r) => r.ipv6.length > 0);
    }

    const filtered = candidates.map((r) => toWebDTO(r));

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
        // address-family filtering already applied above, on the row
        filtered.sort((a, b) => (b.score - a.score) * 100);
        break;

      case 'best-ipv6':
        // ipv6 filtering already applied above, on the row
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
    return serializeExport(rows, isExportFormat(format) ? format : 'uri', (id) => this.secretFor(id));
  }

  /**
   * One stored node's share link, or the serializer's reason it cannot be
   * rebuilt (no vaulted credential, SSR/WireGuard, a link that did not
   * round-trip). A bulk export needs a file-shaped string and turns a failure
   * into a `#` comment; a copy action has to tell the two apart, so it asks
   * here instead of parsing the comment back out.
   *
   * `null` means the node is not in the database.
   */
  shareLink(nodeId: string): LinkExport | null {
    const row = this.deps.nodes.get(nodeId);
    return row ? this.buildLink(row) : null;
  }

  private buildLink(node: ExportRow): LinkExport {
    return nodeLink(node, this.secretFor(node.id));
  }

  /** The vaulted credential a config format needs, or null when absent —
   *  a placeholder like `<uuid>` would produce a config that looks valid but
   *  cannot connect. */
  private secretFor(nodeId: string): string | null {
    return this.deps.nodeVault?.get(nodeId) ?? null;
  }

}
