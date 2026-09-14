import { describe, expect, it } from 'vitest';

import { applySort } from '../src/features/nodes/NodeExplorerPage';

import type { PublicNode } from '@netpulse/shared';

/**
 * Runtime sort contract: nodes group by the core that last tested them —
 * xray block, then sing-box block, never-tested last — regardless of sort
 * direction, so the runtime groups stay readable when the user flips order.
 */

function node(id: string, lastEngine: string | null, score = 0): PublicNode {
  return { id, lastEngine, score } as unknown as PublicNode;
}

describe('applySort by engine', () => {
  const input = [
    node('none-1', null, 99),
    node('sb-1', 'sing-box', 50),
    node('xray-1', 'xray', 10),
    node('none-2', null, 0),
    node('xray-2', 'xray', 20),
  ];

  it('groups xray, then sing-box, then untested (asc), best score first within a group', () => {
    const ids = applySort(input, { field: 'engine', dir: 'asc' }).map((n) => n.id);
    expect(ids).toEqual(['xray-2', 'xray-1', 'sb-1', 'none-1', 'none-2']);
  });

  it('keeps never-tested last when descending', () => {
    const ids = applySort(input, { field: 'engine', dir: 'desc' }).map((n) => n.id);
    // desc reverses within groups but untested still sink to the end
    expect(ids.slice(-2).sort()).toEqual(['none-1', 'none-2']);
    expect(ids.slice(0, 3).sort()).toEqual(['sb-1', 'xray-1', 'xray-2']);
  });

  it('places a higher-scored node first within its runtime group (asc)', () => {
    const ids = applySort(input, { field: 'engine', dir: 'asc' }).map((n) => n.id);
    expect(ids.indexOf('xray-2')).toBeLessThan(ids.indexOf('xray-1'));
  });
});

describe('v2ray engine UI surface', () => {
  it('ranks v2ray between sing-box and untested in the runtime sort', async () => {
    const { applySort } = await import('../src/features/nodes/NodeExplorerPage');
    const input = [
      { id: 'none', lastEngine: null, score: 0 },
      { id: 'v2', lastEngine: 'v2ray', score: 5 },
      { id: 'sb', lastEngine: 'sing-box', score: 7 },
      { id: 'xr', lastEngine: 'xray', score: 3 },
    ] as never[];
    const ids = applySort(input as never, { field: 'engine', dir: 'asc' as never }).map((n: { id: string }) => n.id);
    expect(ids).toEqual(['xr', 'sb', 'v2', 'none']);
  });

  it('EngineBadge renders v2ray with its own style', async () => {
    const { engineLabel } = await import('../src/components/EngineBadge');
    expect(engineLabel('v2ray')).toBe('v2ray');
    expect(engineLabel('legacy-unknown')).toBeNull();
  });
});
