import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { toShareLink } from '@netpulse/shared';

import { NodesService } from '../src/services/nodesService';
import { NodeSecretVault } from '../src/services/nodeSecretVault';

import type { PublicNodeRow } from '../src/db/repositories';
import type { RealtimeBus } from '../src/realtime/bus';
import type { Logger } from '../src/logger';

/**
 * Rotated-credential repair.
 *
 * A node's fingerprint deliberately ignores the credential, so when a provider
 * (or the app's own control plane) rotates a password/UUID, the new config is a
 * DUPLICATE of the stored node. Until this was handled, the duplicate branch
 * only wrote the vault when it was empty: the retired credential stayed in the
 * vault forever, every proxy test failed authentication honestly, and no amount
 * of re-importing could repair the node. Surfaces now offer a one-click refresh
 * built on exactly this path, so the rule below is load-bearing:
 *
 *  - a manual/provider-supplied import may replace a differing stored credential
 *    and must report that it did (`credentialsUpdated`);
 *  - a subscription feed may not (a public list carrying the same host with a
 *    shared credential would otherwise overwrite a per-user one);
 *  - an empty or missing incoming secret never clears anything, and a vault
 *    failure is reported as "not replaced", never as a successful refresh.
 */

function existingNode(id: string, host: string): PublicNodeRow {
  const now = Date.now();
  return {
    id,
    canonicalFingerprint: 'fp-test',
    protocol: 'shadowsocks',
    host,
    ipv4: [],
    ipv6: [],
    port: 443,
    transport: 'tcp',
    security: 'none',
    sni: null,
    alpn: [],
    fingerprint: null,
    flow: null,
    alterId: null,
    path: null,
    hostHeader: null,
    serviceName: null,
    allowInsecure: false,
    realityPublicKey: null,
    realityShortId: null,
    realityServerName: null,
    encryption: 'aes-256-gcm',
    ssrProtocol: null,
    remark: 'test node',
    sourceIds: ['src1'],
    sourceUrls: ['https://example.test/sub'],
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
  } as unknown as PublicNodeRow;
}

function makeService(overrides: { existing: PublicNodeRow | null; vault?: NodeSecretVault }) {
  const bus = { publish: vi.fn() } as unknown as RealtimeBus;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

  const service = new NodesService({
    nodes: {
      getByFingerprint: vi.fn(() => overrides.existing),
      insert: vi.fn(),
      update: vi.fn(),
    },
    sources: { insert: vi.fn() },
    tests: {},
    health: {},
    addresses: { insert: vi.fn() },
    sourceRepo: { get: () => null, update: vi.fn() },
    fetches: {},
    docs: {},
    scanJobs: {},
    testEndpoints: {},
    events: { insert: vi.fn() },
    bus,
    log,
    nodeVault: overrides.vault,
  } as never);

  return { service };
}

/** The Worker's VLESS/REALITY client config, field for field. */
const REALITY_CONFIG = {
  protocol: 'vless',
  server: '206.1.96.89',
  port: 443,
  security: 'reality',
  network: 'tcp',
  flow: 'xtls-rprx-vision',
  serverName: 'www.microsoft.com',
  fingerprint: 'chrome',
  publicKey: 'CAS1AR2c9NrFKDMP1JVMIHx1y4_nxY8HqlemAGclsgU',
  shortId: '674622f7',
  id: '6ebe8dee-16a2-4b02-895f-e7c614965b98',
};

const fpConfig = {
  protocol: 'shadowsocks',
  host: '198.51.100.7',
  port: 443,
  transport: 'tcp' as const,
  security: 'none' as const,
  encryption: 'aes-256-gcm',
};

const tmpDirs: string[] = [];
function freshVault(): NodeSecretVault {
  const dir = path.join(os.tmpdir(), `np-cred-refresh-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return new NodeSecretVault(path.join(dir, 'vault'));
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('rotated credential, manual re-import', () => {
  it('repairs a rotated credential through the manual import path and reports it', async () => {
    const vault = freshVault();
    vault.set('node:abc123', 'retired-secret');
    const { service } = makeService({ existing: existingNode('node:abc123', '198.51.100.7'), vault });

    // The exact link the one-click refresh in the VPN surfaces sends: the
    // control plane's current config, converted by the same `toShareLink`
    // helper the surfaces use.
    const conversion = toShareLink({
      id: 'vp_1',
      name: 'Xray VLESS Reality',
      protocol: 'xray-vless-reality',
      config: JSON.stringify(REALITY_CONFIG),
    });
    expect(conversion.ok).toBe(true);
    if (!conversion.ok) return;

    const result = await service.importManualConfigs([conversion.request.link]);

    expect(result.invalid).toBe(0);
    expect(result.duplicates).toBe(1);
    expect(result.credentialsUpdated).toBe(1);
    expect(vault.get('node:abc123')).toBe(REALITY_CONFIG.id);
  });

  it('replaces the stored secret when a manual import supplies a different one', async () => {
    const vault = freshVault();
    vault.set('node:abc123', 'retired-secret');
    const { service } = makeService({ existing: existingNode('node:abc123', '198.51.100.7'), vault });

    const result = await service.importParsedConfigs(
      null,
      [{ raw: 'ss://URI', parsed: { config: fpConfig, secret: 'rotated-secret' } }],
      null,
      { replaceExistingSecret: true },
    );

    expect(result.duplicates).toBe(1);
    expect(result.credentialsUpdated).toBe(1);
    expect(vault.get('node:abc123')).toBe('rotated-secret');
  });

  it('counts nothing when the supplied credential is the stored one', async () => {
    const vault = freshVault();
    vault.set('node:abc123', 'same-secret');
    const { service } = makeService({ existing: existingNode('node:abc123', '198.51.100.7'), vault });

    const result = await service.importParsedConfigs(
      null,
      [{ raw: 'ss://URI', parsed: { config: fpConfig, secret: 'same-secret' } }],
      null,
      { replaceExistingSecret: true },
    );

    expect(result.credentialsUpdated).toBe(0);
    expect(vault.get('node:abc123')).toBe('same-secret');
  });

  it('never clears a stored credential when the import supplies none', async () => {
    const vault = freshVault();
    vault.set('node:abc123', 'keep-me');
    const { service } = makeService({ existing: existingNode('node:abc123', '198.51.100.7'), vault });

    const result = await service.importParsedConfigs(
      null,
      [{ raw: 'ss://URI', parsed: { config: fpConfig, secret: '' } }],
      null,
      { replaceExistingSecret: true },
    );

    expect(result.credentialsUpdated).toBe(0);
    expect(vault.get('node:abc123')).toBe('keep-me');
  });

  it('reports a vault failure as not replaced rather than as a refresh', async () => {
    const throwing = {
      get: () => 'retired-secret',
      set: () => {
        throw new Error('EISDIR');
      },
      delete: () => undefined,
    } as unknown as NodeSecretVault;
    const { service } = makeService({ existing: existingNode('node:abc123', '198.51.100.7'), vault: throwing });

    const result = await service.importParsedConfigs(
      null,
      [{ raw: 'ss://URI', parsed: { config: fpConfig, secret: 'rotated-secret' } }],
      null,
      { replaceExistingSecret: true },
    );

    expect(result.duplicates).toBe(1);
    expect(result.credentialsUpdated).toBe(0);
  });
});

describe('rotated credential, subscription feed', () => {
  it('does not let a source overwrite a credential it did not issue', async () => {
    const vault = freshVault();
    vault.set('node:abc123', 'per-user-secret');
    const { service } = makeService({ existing: existingNode('node:abc123', '198.51.100.7'), vault });

    // No `replaceExistingSecret` — this is the feed path. A public list carrying
    // the same host with a shared credential must not clobber the per-user one.
    const result = await service.importParsedConfigs(
      'src1',
      [{ raw: 'ss://URI', parsed: { config: fpConfig, secret: 'shared-secret' } }],
      'https://example.test/sub',
    );

    expect(result.duplicates).toBe(1);
    expect(result.credentialsUpdated).toBe(0);
    expect(vault.get('node:abc123')).toBe('per-user-secret');
  });

  it('still backfills a pre-vault-era node the feed can repair', async () => {
    const vault = freshVault();
    const { service } = makeService({ existing: existingNode('node:abc123', '198.51.100.7'), vault });

    await service.importParsedConfigs(
      'src1',
      [{ raw: 'ss://URI', parsed: { config: fpConfig, secret: 'recovered' } }],
      'https://example.test/sub',
    );

    expect(vault.get('node:abc123')).toBe('recovered');
  });
});
