import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Card entrances — the shell's motion handed one level down.
 *
 * `page-enter` already moves the routed page, so the stagger only has to make
 * the cards inside it resolve in reading order. That is a pure CSS contract,
 * which is exactly the kind of thing that rots silently: the page keeps
 * rendering, the class keeps being applied, and nothing moves. These tests pin
 * the properties that make it work, and that make it safe.
 */

const ROOT = join(import.meta.dirname, '..');
const TOKENS = readFileSync(join(ROOT, 'src', 'styles', 'tokens.css'), 'utf8');

function rule(selector: string): string {
  // The declarations of one simple rule, e.g. `.stagger > * { ... }`.
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = TOKENS.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  expect(found, `no CSS rule for \`${selector}\``).not.toBeNull();
  return found![1]!;
}

describe('stagger container', () => {
  it('animates its direct children into place, not the page again', () => {
    const body = rule('.stagger > *');
    expect(body).toMatch(/animation:\s*card-in\b/);
    // The same envelope as rest: the shell's duration and curve, so a card can
    // never travel at a different speed than the page it sits on.
    expect(body).toMatch(/var\(--dur-move\)/);
    expect(body).toMatch(/var\(--ease-fluid\)/);
    // `backwards` only: a retained transform (even `none`) turns the card into
    // a containing block for `position: fixed` descendants.
    expect(body).toMatch(/\bbackwards\b/);
    expect(body).not.toMatch(/\bboth\b/);
  });

  it('keeps the keyframe an enter-only rise, with no lingering transform', () => {
    const keyframe = TOKENS.match(/@keyframes card-in\s*\{([\s\S]*?)\n\}/);
    expect(keyframe).not.toBeNull();
    const from = keyframe![1]!.match(/from\s*\{([^}]*)\}/)![1]!;
    const to = keyframe![1]!.match(/to\s*\{([^}]*)\}/)![1]!;
    expect(from).toMatch(/opacity:\s*0/);
    expect(from).toMatch(/translate3d\(/);
    // Ends at the element's own styles, so nothing is left applied.
    expect(to).toMatch(/transform:\s*none/);
  });

  it('derives the delay from the child index and caps it at eight', () => {
    const body = rule('.stagger > *');
    expect(body).toMatch(/animation-delay:\s*calc\(var\(--stagger-base\) \+ var\(--stagger-i\) \* var\(--stagger-step\)\)/);

    // Every child past the eighth waits in the last slot instead of queueing.
    expect(body).toMatch(/--stagger-i:\s*7\s*;/);
    const indexed = [...TOKENS.matchAll(/\.stagger > :nth-child\((\d+)\)\s*\{\s*--stagger-i:\s*(\d+)\s*;/g)];
    expect(indexed.map((m) => Number(m[1]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(indexed.map((m) => Number(m[2]))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('collapses to no movement under prefers-reduced-motion', () => {
    const reduced = TOKENS.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/);
    expect(reduced).not.toBeNull();
    expect(reduced![1]).toMatch(/\.stagger > \*\s*\{[\s\S]*?animation:\s*none/);
  });
});

describe('opt-in', () => {
  /**
   * The pages that ask for a stagger. A refactor that drops the class from one
   * of them would otherwise be invisible: the page still renders, just flat.
   */
  const surfaces = [
    ['dashboard', 'src/features/dashboard/DashboardPage.tsx'],
    ['vpn overview', 'src/features/vpn/OverviewSurface.tsx'],
    ['vpn core', 'src/features/vpn/CoreSurface.tsx'],
    ['vpn provider', 'src/features/vpn/ProviderSurface.tsx'],
    ['vpn aether', 'src/features/vpn/AetherSurface.tsx'],
    ['vpn tunnel', 'src/features/vpn/TunnelSurface.tsx'],
    ['vpn whitedns', 'src/features/vpn/WhitednsSurface.tsx'],
    ['node explorer', 'src/features/nodes/NodeExplorerPage.tsx'],
    ['node detail', 'src/features/nodes/NodeDetailPage.tsx'],
    ['system health', 'src/features/health/SystemHealthPage.tsx'],
  ] as const;

  for (const [name, file] of surfaces) {
    it(`${name} staggers its cards`, () => {
      const src = readFileSync(join(ROOT, file), 'utf8');
      expect(src, `${file} no longer uses \`stagger\``).toMatch(/\bstagger\b/);
    });
  }

  it('never stacks a stagger on the routed page wrapper itself', () => {
    // The page wrapper owns `page-enter`; staggering it would animate the page
    // twice and multiply the two delays.
    const shell = readFileSync(join(ROOT, 'src', 'app', 'AppShell.tsx'), 'utf8');
    expect(shell).not.toMatch(/className="[^"]*\bstagger\b[^"]*page-enter/);
    expect(shell).not.toMatch(/page-enter[^"]*\bstagger\b/);
  });
});
