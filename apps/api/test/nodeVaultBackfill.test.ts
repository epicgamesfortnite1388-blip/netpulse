import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { NodesService } from '../src/services/nodesService';
import { NodeSecretVault } from '../src/services/nodeSecretVault';

import type { PublicNodeRow } from '../src/db/repositories';
import type { RealtimeBus } from '../src/realtime/bus';
import type { Logger } from '../src/logger';

/**
 * Vault-backfill regression (data integrity for proxy testing):
 * nodes imported before the encrypted vault existed arrive as duplicates on
 * every re-import, and the duplicate branch used to skip the vault write —
 * so their credentials could never be recovered and every proxy test failed
 * with `missing password`. The duplicate branch must store the secret when
 * the vault has none, and must never overwrite an existing one.
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

function makeService(overrides: {
  existing: PublicNodeRow | null;
  vault?: NodeSecretVault;
}) {
  const update = vi.fn();
  const events = { insert: vi.fn() };
  const bus = { publish: vi.fn() } as unknown as RealtimeBus;
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

  const nodes = {
    getByFingerprint: vi.fn(() => overrides.existing),
    insert: vi.fn(),
    update,
  };

  const service = new NodesService({
    nodes,
    sources: { insert: vi.fn() },
    tests: {},
    health: {},
    addresses: { insert: vi.fn() },
    sourceRepo: { get: () => null, update: vi.fn() },
    fetches: {},
    docs: {},
    scanJobs: {},
    testEndpoints: {},
    events,
    bus,
    log,
    nodeVault: overrides.vault,
  } as never);

  return { service, nodes, update };
}

const fpConfig = {
  protocol: 'shadowsocks',
  host: '198.51.100.7',
  port: 443,
  transport: 'tcp' as const,
  security: 'none' as const,
  encryption: 'aes-256-gcm',
};

const tmpDirs: string[] = [];
function freshVaultDir(): string {
  const dir = path.join(os.tmpdir(), `np-vault-backfill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('duplicate-import vault backfill', () => {
  it('stores the secret for a pre-vault-era duplicate that has none', async () => {
    const dir = freshVaultDir();
    const vault = new NodeSecretVault(path.join(dir, 'vault'));
    const existing = existingNode('node:abc123', '198.51.100.7');
    const { service } = makeService({ existing, vault });

    const result = await service.importParsedConfigs('src1', [{ raw: 'ss://URI', parsed: { config: fpConfig, secret: 'hunter2' } }], 'https://example.test/sub');

    expect(result.duplicates).toBe(1);
    expect(vault.get('node:abc123')).toBe('hunter2');
  });

  it('never overwrites an existing vault entry', async () => {
    const dir = freshVaultDir();
    const vault = new NodeSecretVault(path.join(dir, 'vault'));
    vault.set('node:abc123', 'original-secret');
    const existing = existingNode('node:abc123', '198.51.100.7');
    const { service } = makeService({ existing, vault });

    await service.importParsedConfigs('src1', [{ raw: 'ss://URI', parsed: { config: fpConfig, secret: 'new-secret' } }], 'https://example.test/sub');

    expect(vault.get('node:abc123')).toBe('original-secret');
  });

  it('does not write when the source supplies no secret', async () => {
    const dir = freshVaultDir();
    const vault = new NodeSecretVault(path.join(dir, 'vault'));
    const existing = existingNode('node:abc123', '198.51.100.7');
    const { service } = makeService({ existing, vault });

    await service.importParsedConfigs('src1', [{ raw: 'ss://URI', parsed: { config: fpConfig, secret: '' } }], 'https://example.test/sub');

    expect(vault.get('node:abc123')).toBeNull();
  });

  it('vault failure does not break the duplicate import', async () => {
    // Simulate an unwritable vault location by pointing set at a directory path
    const throwing = {
      get: () => null,
      set: () => {
        throw new Error('EISDIR');
      },
      delete: () => undefined,
    } as unknown as NodeSecretVault;
    const existing = existingNode('node:abc123', '198.51.100.7');
    const { service } = makeService({ existing, vault: throwing });

    const result = await service.importParsedConfigs('src1', [{ raw: 'ss://URI', parsed: { config: fpConfig, secret: 'pw' } }], 'https://example.test/sub');

    expect(result.duplicates).toBe(1);
  });
});
