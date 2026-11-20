import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DETAIL_LEVEL,
  DETAIL_LEVELS,
  DETAIL_LEVEL_META,
  clampLevel,
  deepestLevel,
  detailKey,
  isVisible,
  nextLevelWithContent,
  offeredLevels,
  resolveDetailLevel,
  suppressedCount,
} from '../src/lib/detailLevel';

import type { DetailLevel } from '../src/lib/detailLevel';

/**
 * Phase 6 policy. These are the rules a reviewer should be able to check without
 * rendering anything: what a level means, that raising it only ever adds
 * content, that a stored choice cannot produce an invalid level, and that the
 * control can always tell the reader how much is hidden.
 */

describe('detail levels', () => {
  it('defines exactly four levels with unique ids and labels', () => {
    expect(DETAIL_LEVELS).toEqual([1, 2, 3, 4]);
    const ids = DETAIL_LEVELS.map((l) => DETAIL_LEVEL_META[l].id);
    const labels = DETAIL_LEVELS.map((l) => DETAIL_LEVEL_META[l].label);
    expect(new Set(ids).size).toBe(4);
    expect(new Set(labels).size).toBe(4);
    for (const level of DETAIL_LEVELS) {
      expect(DETAIL_LEVEL_META[level].level).toBe(level);
      expect(DETAIL_LEVEL_META[level].summary.length).toBeGreaterThan(10);
    }
  });

  it('defaults to Essential, because a first-time reader meets the verdict first', () => {
    expect(DEFAULT_DETAIL_LEVEL).toBe(1);
  });
});

describe('gating', () => {
  it('shows a block at its required level and every level above it', () => {
    for (const current of DETAIL_LEVELS) {
      expect(isVisible(1, current)).toBe(true);
    }
    expect(isVisible(2, 1)).toBe(false);
    expect(isVisible(2, 2)).toBe(true);
    expect(isVisible(3, 2)).toBe(false);
    expect(isVisible(4, 4)).toBe(true);
  });

  /**
   * The property that makes the control predictable: raising the level is
   * monotonic. If it were not, a reader could raise detail and LOSE a panel,
   * which would make the control feel like a set of tabs rather than a depth.
   */
  it('is monotonic — raising the level never removes anything', () => {
    const requirements: DetailLevel[] = [1, 2, 3, 4];
    for (let i = 0; i < DETAIL_LEVELS.length - 1; i++) {
      const lower = DETAIL_LEVELS[i];
      const higher = DETAIL_LEVELS[i + 1];
      for (const required of requirements) {
        if (isVisible(required, lower)) {
          expect(isVisible(required, higher)).toBe(true);
        }
      }
    }
  });
});

describe('stored choice', () => {
  it('accepts a valid stored level', () => {
    expect(resolveDetailLevel(3, 1)).toBe(3);
    expect(resolveDetailLevel('4', 1)).toBe(4);
  });

  it('falls back to the page default rather than guessing', () => {
    expect(resolveDetailLevel(undefined, 2)).toBe(2);
    expect(resolveDetailLevel(null, 2)).toBe(2);
    expect(resolveDetailLevel('expert', 2)).toBe(2);
    expect(resolveDetailLevel({}, 2)).toBe(2);
    expect(resolveDetailLevel(true, 2)).toBe(2);
  });

  it('clamps out-of-range numbers into the defined levels', () => {
    expect(clampLevel(0)).toBeNull();
    expect(clampLevel(5)).toBeNull();
    expect(clampLevel(-1)).toBeNull();
    expect(clampLevel(NaN)).toBeNull();
    expect(clampLevel(Infinity)).toBeNull();
    expect(clampLevel(2.4)).toBe(2);
    expect(clampLevel(3.6)).toBe(4);
  });

  it('namespaces the storage key per page', () => {
    expect(detailKey('dashboard')).toBe('detail:dashboard');
    expect(detailKey('diagnostics')).not.toBe(detailKey('dashboard'));
  });
});

describe('disclosure affordance', () => {
  it('counts what is suppressed at the current level', () => {
    const requirements: DetailLevel[] = [1, 2, 2, 3, 4];
    expect(suppressedCount(requirements, 1)).toBe(4);
    expect(suppressedCount(requirements, 2)).toBe(2);
    expect(suppressedCount(requirements, 4)).toBe(0);
  });

  it('names the shallowest level that would reveal something', () => {
    expect(nextLevelWithContent([1, 2, 3, 4], 1)).toBe(2);
    expect(nextLevelWithContent([1, 3], 1)).toBe(3);
    expect(nextLevelWithContent([1, 4], 2)).toBe(4);
  });

  it('reports nothing hidden when everything is visible', () => {
    expect(nextLevelWithContent([1, 2], 4)).toBeNull();
    expect(suppressedCount([1, 2], 4)).toBe(0);
  });

  it('treats an empty page as fully disclosed', () => {
    expect(nextLevelWithContent([], 1)).toBeNull();
    expect(suppressedCount([], 1)).toBe(0);
  });
});

describe('the control offers only levels the page can reach', () => {
  it('reports the deepest requirement, and 1 for a page with none', () => {
    expect(deepestLevel([])).toBe(1);
    expect(deepestLevel([1])).toBe(1);
    expect(deepestLevel([1, 2, 2])).toBe(2);
    expect(deepestLevel([2, 4, 3])).toBe(4);
  });

  it('trims the offer to the deepest level in use', () => {
    // The VPN page stops at Context. Offering Advanced and Expert there would
    // put two options in front of the reader that change nothing when clicked.
    expect(offeredLevels([1, 2])).toEqual([1, 2]);
    expect(offeredLevels([1, 2, 3, 4])).toEqual([1, 2, 3, 4]);
    expect(offeredLevels([1, 4])).toEqual([1, 2, 3, 4]);
  });

  it('never offers nothing, even when the page declares no gates', () => {
    expect(offeredLevels([])).toEqual([1]);
  });

  it('keeps the offer a contiguous prefix of the four levels', () => {
    for (const requirements of [[], [1], [2], [3], [4], [1, 3], [2, 4]] as DetailLevel[][]) {
      const offered = offeredLevels(requirements);
      expect(offered[0]).toBe(1);
      offered.forEach((level, i) => expect(level).toBe(i + 1));
    }
  });
});
