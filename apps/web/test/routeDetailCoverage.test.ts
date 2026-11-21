import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Route-level progressive-disclosure coverage.
 *
 * Four-level disclosure was originally on 4 of 27 routes. The scope was
 * extended to every routed page, and this test is the invariant that keeps it
 * there. It parses the REAL router — not a hand-maintained list — so adding a
 * route without disclosure fails the suite instead of silently reducing
 * coverage again.
 *
 * Source-level assertions are checked against a comment-stripped copy, because
 * a file that merely *mentions* `DetailLevelProvider` in a comment must not
 * pass (the same trap Kim found in the earlier h1 contract).
 */

const ROOT = join(import.meta.dirname, '..');
const ROUTER_PATH = join(ROOT, 'src', 'app', 'router.tsx');
const ROUTER = readFileSync(ROUTER_PATH, 'utf8');

/** Strip // and /* *\/ comments so keywords in prose cannot satisfy a check. */
function sourceCode(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

const ROUTE_SOURCE = sourceCode(ROUTER);

/**
 * Every `lazy(() => import('...'))` target in the router is a routed page.
 * NotFoundPage is imported eagerly and is intentionally ungated: a page with
 * nothing to disclose must not show a dead control.
 */
function routedPages(): Array<{ name: string; relative: string }> {
  const pages: Array<{ name: string; relative: string }> = [];
  const pattern = /const\s+(\w+)\s*=\s*lazy\(\(\)\s*=>\s*import\(['"]([^'"]+)['"]\)\)/g;
  for (const match of ROUTE_SOURCE.matchAll(pattern)) {
    const name = match[1]!;
    const spec = match[2]!;
    const relative = spec.startsWith('@/')
      ? `src/${spec.slice(2)}.tsx`
      : `src/app/${spec.replace(/^\.\//, '')}.tsx`;
    pages.push({ name, relative });
  }
  return pages;
}

const PAGES = routedPages();

describe('route-level four-level disclosure coverage', () => {
  it('parses the router and finds every lazily routed page', () => {
    // 26 lazy page components: index + 25 named routes. The catch-all
    // NotFoundPage is eager and handled separately.
    expect(PAGES.length).toBeGreaterThanOrEqual(25);
    const names = new Set(PAGES.map((p) => p.name));
    for (const required of [
      'DashboardPage',
      'VpnPage',
      'NaniPage',
      'DiagnosticsPage',
      'MissionControlPage',
      'LiveMapPage',
      'SettingsPage',
    ]) {
      expect(names.has(required), `router no longer defines ${required}`).toBe(true);
    }
  });

  it.each(PAGES)('$name declares a four-level provider and a detail control', ({ name, relative }) => {
    const path = join(ROOT, relative);
    let src: string;
    try {
      src = sourceCode(readFileSync(path, 'utf8'));
    } catch {
      throw new Error(`routed page ${name} has no source at ${relative}`);
    }
    expect(src.includes('<DetailLevelProvider'), `${name} has no DetailLevelProvider`).toBe(true);
    expect(src.includes('scope='), `${name} has no disclosure scope`).toBe(true);
    expect(src.includes('<DetailLevelControl'), `${name} has no DetailLevelControl`).toBe(true);
    // A page keeps its control reachable in one of three ways: an explicit
    // depth (Diagnostics), declared structural requirements (NANI's tabs), or
    // gates mounted in the page/component tree (Dashboard, VPN — where depth
    // follows the active surface so no level is a dead click). All three are
    // deliberate; the invariant is that at least one exists.
    const derivesFromGates = /<DetailGate|<Section[\s\S]{0,200}\bdetail=|\bdetail=\{/.test(src);
    expect(
      src.includes('depth=') || src.includes('declares=') || derivesFromGates,
      `${name} declares neither depth nor declares and has no gates; its control can never appear`,
    ).toBe(true);
  });

  it('keeps NotFoundPage ungated — a page with nothing to disclose has no dead control', () => {
    const src = sourceCode(readFileSync(join(ROOT, 'src', 'app', 'NotFoundPage.tsx'), 'utf8'));
    expect(src.includes('<DetailLevelProvider')).toBe(false);
    expect(src.includes('<DetailLevelControl')).toBe(false);
  });

  it('has no duplicate disclosure scopes — stored detail choices stay per page', () => {
    const scopes = PAGES.map(({ relative }) => {
      const src = sourceCode(readFileSync(join(ROOT, relative), 'utf8'));
      return src.match(/scope\s*=\s*["']([^"']+)["']/)?.[1] ?? null;
    }).filter((s): s is string => s !== null);
    const duplicates = scopes.filter((s, i) => scopes.indexOf(s) !== i);
    expect(duplicates, `duplicate disclosure scopes: ${duplicates.join(', ')}`).toEqual([]);
  });
});
