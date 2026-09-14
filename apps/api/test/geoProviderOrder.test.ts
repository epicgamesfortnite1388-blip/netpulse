import { describe, expect, it } from 'vitest';

import { geoProviderOrder } from '../src/providers/ipinfo/ipwhoIs';

/**
 * Failover-order contract for the user's geoProvider preference:
 * the preference picks who is queried first; the other provider always
 * remains as failover — a preference changes order, never coverage.
 */
describe('geoProviderOrder', () => {
  it('auto: ipwho.is first, geojs.io failover', () => {
    expect(geoProviderOrder('auto')).toEqual(['ipwho.is', 'geojs.io']);
  });

  it('ipwho.is preferred: ipwho.is first, geojs.io failover', () => {
    expect(geoProviderOrder('ipwho.is')).toEqual(['ipwho.is', 'geojs.io']);
  });

  it('geojs.io preferred: geojs.io first, ipwho.is failover', () => {
    expect(geoProviderOrder('geojs.io')).toEqual(['geojs.io', 'ipwho.is']);
  });

  it('both providers are always present — a preference never removes one', () => {
    for (const p of ['auto', 'ipwho.is', 'geojs.io'] as const) {
      const order = geoProviderOrder(p);
      expect(order).toHaveLength(2);
      expect(new Set(order)).toEqual(new Set(['ipwho.is', 'geojs.io']));
      expect(order[0]).toBe(p === 'geojs.io' ? 'geojs.io' : 'ipwho.is');
    }
  });
});
