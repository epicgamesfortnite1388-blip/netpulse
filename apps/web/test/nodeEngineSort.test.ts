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
