import { describe, expect, it, vi } from 'vitest';

import { NodesService } from '../src/services/nodesService';

import type { RealtimeBus } from '../src/realtime/bus';
import type { Logger } from '../src/logger';

/**
 * Import-provenance integrity.
 *
 * Both provenance writes used to compute their primary key from the operand
 * lengths plus a timestamp — values that are identical for every row in a
 * batch. The primary-key conflict then silently discarded all but the first
 * row, so a feed with 16,000 nodes left exactly one attribution behind. Node
 * `sourceIds` still worked, which is why nothing looked broken.
 */

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
const bus = { publish: vi.fn() } as unknown as RealtimeBus;

function vlessConfig(host: string) {
  return {
    protocol: 'vless' as const,
    host,
    port: 443,
    transport: 'tcp' as const,
    security: 'tls' as const,
    sni: 'cdn.example.org',
    alpn: [],
    flow: null,
    alterId: null,
    path: null,
    hostHeader: null,
    serviceName: null,
    allowInsecure: false,
    realityPublicKey: null,
    realityShortId: null,
    realityServerName: null,
    encryption: null,
    ssrProtocol: null,
    remark: `node-${host}`,
    extra: {},
  };
}

function makeService(existing?: { id: string }) {
  const provenanceRows: Array<Record<string, unknown>> = [];
  let inserted = 0;

  const service = new NodesService({
    nodes: {
      getByFingerprint: () =>
        existing
          ? ({ ...existing, sourceIds: [], sourceUrls: [], sourceCount: 1, host: 'a.example.net' } as never)
          : undefined,
      insert: vi.fn(() => {
        inserted++;
      }),
      update: vi.fn(),
    },
    sources: {
      insert: vi.fn((row: Record<string, unknown>) => {
        provenanceRows.push(row);
      }),
    },
    tests: {},
    health: {},
    addresses: {
      insert: vi.fn((row: Record<string, unknown>) => {
        addressRows.push(row);
      }),
    },
    sourceRepo: { get: () => null, update: vi.fn() },
    fetches: {},
    docs: {},
    scanJobs: {},
    testEndpoints: {},
    events: { insert: vi.fn() },
    bus,
    log,
  } as never);

  return { service, provenanceRows, insertedCount: () => inserted };
}

describe('import provenance', () => {
  it('writes one distinct attribution row per imported node', async () => {
    // All three configs are imported in a single call, i.e. the same timestamp.
    // Distinct hosts keep the fingerprints distinct.
    const { service, provenanceRows, insertedCount } = makeService();

    const configs = ['a.example.net', 'b.example.net', 'c.example.net'].map((host) => ({
      raw: `vless://${host}`,
      parsed: { config: vlessConfig(host) as never, secret: 'secret' },
    }));

    const result = await service.importParsedConfigs('mahdibland', configs, 'https://example.test/sub');

    expect(result.imported).toBe(3);
    expect(insertedCount()).toBe(3);
    expect(provenanceRows).toHaveLength(3);

    // Every row must carry a key the table can accept: no caller-computed id
    // (that is what collided), and a nodeId of its own.
    for (const row of provenanceRows) {
      expect(row.id).toBeUndefined();
      expect(row.sourceId).toBe('mahdibland');
      expect(row.sourceUrl).toBe('https://example.test/sub');
      expect(typeof row.sourceConfigRef).toBe('string');
      expect(row.parserVersion).toBe('1.0.0');
    }
    expect(new Set(provenanceRows.map((r) => r.nodeId)).size).toBe(3);
  });

  it('attributes a re-seen node to the feed that served it again, once per node', async () => {
    // The duplicate branch had the same colliding key, so a feed whose whole
    // content was already known recorded a single attribution for the batch.
    const { service, provenanceRows, insertedCount } = makeService({ id: 'node:existing' });

    const configs = ['a.example.net', 'b.example.net'].map((host) => ({
      raw: `vless://${host}`,
      parsed: { config: vlessConfig(host) as never, secret: 'secret' },
    }));

    const result = await service.importParsedConfigs('ermaozi', configs, 'https://example.test/sub');

    // Disjoint accounting: `imported` counts only rows this call created,
    // `duplicates` counts re-seen nodes, and the two never overlap (the old
    // "imported includes duplicates" shape double-counted in every UI total).
    expect(result.imported).toBe(0);
    expect(result.duplicates).toBe(2);
    expect(result.imported - result.duplicates).toBe(-2);
    expect(insertedCount()).toBe(0);
    expect(provenanceRows).toHaveLength(2);
    for (const row of provenanceRows) {
      expect(row.id).toBeUndefined();
      expect(row.nodeId).toBe('node:existing');
      expect(row.sourceId).toBe('ermaozi');
    }
  });
});
