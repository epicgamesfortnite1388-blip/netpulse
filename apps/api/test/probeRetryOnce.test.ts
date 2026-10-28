/**
 * One bounded retry before a bulk proxy scan records a node as failed.
 *
 * Motivation (measured, not theoretical): reports/adaptive/RAW_PATH_IR_ISP.txt
 * D1/D3 shows the Iranian ISP path stalling a SINGLE port intermittently —
 * 206.1.96.89:443 answered at 13:07Z and gave no answer at 13:15Z while :2053,
 * :2087 and :8443 all answered. The single-node tester already retries; the
 * batched path (proxyProbeMany → NodesService.testNodes) used to record the
 * first timeout as a dead node, which is what these tests pin down.
 *
 * The three invariants:
 *   • a transient failure is retried exactly once and the success is reported;
 *   • a deterministic/environment failure is NOT retried (no doubled scan);
 *   • the retry opens no new test rows (onGroupStart is not called again).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type StubResult = {
  status: 'done' | 'failed';
  engine: 'xray' | null;
  latencyMs: number | null;
  totalMs: number;
  tlsVersion: string | null;
  httpStatus: number | null;
  failureKind: 'engine_unavailable' | 'engine_start_failed' | 'handshake_failed' | 'target_failed' | null;
  error: string | null;
};

const h = vi.hoisted(() => ({
  calls: [] as Array<{ hosts: string[]; hasOnGroupStart: boolean }>,
  batches: [] as Array<Array<Partial<StubResult>>>,
}));

vi.mock('../src/services/proxyEngineRunner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/proxyEngineRunner')>();
  return {
    ...actual,
    proxyProbeManyWithEngine: async (
      entries: ReadonlyArray<{ config: { host: string } }>,
      opts?: { onGroupStart?: (indexes: readonly number[]) => void },
    ): Promise<StubResult[]> => {
      h.calls.push({
        hosts: entries.map((e) => e.config.host),
        hasOnGroupStart: typeof opts?.onGroupStart === 'function',
      });
      const batch = h.batches.shift() ?? [];
      return entries.map((_, i): StubResult => ({
        status: 'failed',
        engine: null,
        latencyMs: null,
        totalMs: 1,
        tlsVersion: null,
        httpStatus: null,
        failureKind: 'handshake_failed',
        error: 'probe timed out',
        ...(batch[i] ?? {}),
      }));
    },
  };
});

import { proxyProbeMany } from '../src/services/nodeTestProbes';

import type { PublicNode } from '@netpulse/shared';

function node(id: string): PublicNode {
  return {
    id,
    protocol: 'vless',
    host: id,
    port: 443,
    transport: 'ws',
    security: 'tls',
    sni: null,
    alpn: [],
    fingerprint: null,
    flow: null,
    alterId: null,
    path: '/',
    hostHeader: null,
    serviceName: null,
    allowInsecure: false,
    encryption: null,
    ssrProtocol: null,
    realityPublicKey: null,
    realityShortId: null,
    realityServerName: null,
    remark: null,
  } as unknown as PublicNode;
}

const done = (latencyMs: number): Partial<StubResult> => ({
  status: 'done',
  engine: 'xray',
  latencyMs,
  httpStatus: 200,
  tlsVersion: 'TLSv1.3',
  failureKind: null,
  error: null,
});

beforeEach(() => {
  h.calls = [];
  h.batches = [];
});

describe('proxyProbeMany retry-once before recording failure', () => {
  it('retries a stalled probe once, and only that node, reporting the success', async () => {
    h.batches = [
      [{}, done(41)], // node-a stalls, node-b answers
      [done(18)], // node-a answers on the retry
    ];
    const res = await proxyProbeMany([node('node-a'), node('node-b')], {}, {
      secretFor: () => 'secret',
      onGroupStart: () => {},
    });

    expect(h.calls).toHaveLength(2);
    // Only the stalled node is retried — a healthy sibling is never re-probed.
    expect(h.calls[1]?.hosts).toEqual(['node-a']);
    expect(res.map((r) => r?.status)).toEqual(['done', 'done']);
    expect(res[0]?.latencyMs).toBe(18);
    // Rows are opened once: the first pass announces the group, the retry pass
    // must not (a second announcement would open a duplicate test row and
    // leave the first one stuck in 'running').
    expect(h.calls[0]?.hasOnGroupStart).toBe(true);
    expect(h.calls[1]?.hasOnGroupStart).toBe(false);
  });

  it('does not retry a deterministic failure (an unavailable core cannot change mid-scan)', async () => {
    h.batches = [
      [{ failureKind: 'engine_unavailable', error: 'no proxy core installed' }, done(30)],
    ];

    const res = await proxyProbeMany([node('node-a'), node('node-b')], {}, { secretFor: () => null });

    expect(h.calls).toHaveLength(1);
    expect(res[0]?.status).toBe('failed');
    expect(res[0]?.error).toBe('no proxy core installed');
    expect(res[1]?.status).toBe('done');
  });

  it('stops at one retry, and keeps the FIRST failure when the retry also fails', async () => {
    h.batches = [
      [{ error: 'probe timed out' }],
      [{ error: 'core exited during the retry' }],
    ];

    const res = await proxyProbeMany([node('node-a')], {}, { secretFor: () => 'secret' });

    expect(h.calls).toHaveLength(2);
    expect(res[0]?.status).toBe('failed');
    // The node's own attempt is what gets recorded, not a retry-pass mishap.
    expect(res[0]?.error).toBe('probe timed out');
  });

  it('does not start a retry after the caller cancelled the scan', async () => {
    h.batches = [[{}]];

    const res = await proxyProbeMany([node('node-a')], {}, {
      secretFor: () => 'secret',
      shouldStop: () => true,
    });

    expect(h.calls).toHaveLength(1);
    expect(res[0]?.status).toBe('failed');
  });
});
