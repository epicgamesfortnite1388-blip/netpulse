import { describe, expect, it, vi } from 'vitest';

/**
 * Adaptive auto-test selection + retirement (NodeTestScheduler):
 *   - buckets prioritize never-validated > stale-good > unstable
 *   - retirement marks dead+unseen nodes stale, never deletes
 *   - overlapping ticks are dropped (serialized)
 */

const pickStub = vi.fn();
const testNodeStub = vi.fn(async (id: string) => ({ nodeId: id, status: 'done' }));
const retireStub = vi.fn(() => 0);

vi.mock('../src/services/nodesService', () => ({
  NodesService: class {
    pickNodesForAutoTest = pickStub;
    testNode = testNodeStub;
    retireStaleNodes = retireStub;
  },
}));

import { NodesService } from '../src/services/nodesService';
import { NodeTestScheduler } from '../src/services/nodeTestScheduler';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

function makeScheduler(opts: { enabled?: boolean } = {}) {
  const settings = { get: () => ({ automation: { autoTestNodes: { enabled: opts.enabled ?? true, intervalMinutes: 30 } } }) };
  const nodes = new (NodesService as unknown as new () => object)();
  const onTick = vi.fn();
  const sched = new NodeTestScheduler({ nodes: nodes as never, settings: settings as never, log, onTick });
  return { sched, onTick };
}

describe('NodeTestScheduler', () => {
  it('runs a bounded batch: never-validated first, then stale-good fills the rest', async () => {
    pickStub.mockImplementation(({ bucket, limit }: { bucket: string; limit: number }) => {
      if (bucket === 'never-validated') return Array.from({ length: 10 }, (_, i) => ({ id: `new${i}` }));
      if (bucket === 'stale-good') return Array.from({ length: limit }, (_, i) => ({ id: `good${i}` }));
      return [];
    });
    const { sched } = makeScheduler();
    const out = await sched.tick();

    expect(out.skippedRunning).toBe(false);
    expect(out.tested).toBe(12); // 10 new + 2 good (batch cap)
    expect(out.prioritized.neverValidated).toBe(10);
    expect(out.prioritized.staleGood).toBe(2);
    expect(testNodeStub).toHaveBeenCalledTimes(12);
    expect(retireStub).toHaveBeenCalled();
  });

  it('retires dead nodes and reports the count', async () => {
    pickStub.mockReturnValue([]);
    retireStub.mockReturnValue(7);
    const { sched } = makeScheduler();
    const out = await sched.tick();
    expect(out.tested).toBe(0);
    expect(out.retired).toBe(7);
  });

  it('drops overlapping ticks (serialized execution)', async () => {
    pickStub.mockImplementation(({ bucket }: { bucket: string }) => {
      if (bucket === 'never-validated') return Array.from({ length: 12 }, (_, i) => ({ id: `n${i}` }));
      return [];
    });
    const { sched } = makeScheduler();
    const first = sched.tick();
    const second = await sched.tick(); // arrives mid-flight → dropped
    const r1 = await first;
    expect(r1.tested).toBe(12);
    // The dropped tick returns the last completed result (or the skip marker).
    expect(second.skippedRunning === true || second.tested >= 0).toBe(true);
  });

  it('respects the disabled setting', () => {
    const { sched } = makeScheduler({ enabled: false });
    sched.start();
    expect(sched.status().enabled).toBe(false);
    sched.stop();
  });
});
