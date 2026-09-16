import { describe, expect, it } from 'vitest';

import { engineLabel } from '../src/components/EngineBadge';

/**
 * Runtime badges name a core the app can actually test with.
 *
 * The sort-by-runtime contract that used to live in this file moved to the API
 * (`apps/api/test/nodeListQuery.test.ts`): the node list is now ordered in SQL,
 * so the grouping is asserted where it is implemented instead of against a
 * browser-side copy of the same rules.
 */

describe('engine badge', () => {
  it('labels the cores the app can run', () => {
    expect(engineLabel('xray')).toBe('xray');
    expect(engineLabel('sing-box')).toBe('sing-box');
    expect(engineLabel('v2ray')).toBe('v2ray');
  });

  it('has no label for an unknown engine, so a value cannot be invented', () => {
    expect(engineLabel('legacy-unknown')).toBeNull();
    expect(engineLabel(null)).toBeNull();
  });
});
