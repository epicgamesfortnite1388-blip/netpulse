import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Nothing in the webview may offer the raw configuration.
 *
 * This is deliberately the weaker half of the guarantee and exists only to
 * catch a careless re-add. The routes that produced a share link, a bulk export
 * and a profile bundle now answer 410 Gone, so a button added here would fail at
 * runtime rather than leak — but shipping a button whose every click is an error
 * is a product defect on its own, and the affordances are easy to reintroduce by
 * muscle memory from the old pages.
 *
 * The load-bearing half is `apps/api/test/rawConfigRetirement.test.ts`, which
 * drives the routes over HTTP and scans the response bodies. Hiding a button is
 * not a fix; this file is the reminder of that, not the boundary itself.
 */

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');

/** Every source file under `src`, as paths relative to it (so failures read cleanly). */
function walk(dir: string, exts: string[]): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, exts);
    return exts.some((ext) => entry.name.endsWith(ext)) ? [relative(SRC, full).split(sep).join('/')] : [];
  });
}

const FILES = walk(SRC, ['.ts', '.tsx']);

/**
 * No webview file is allowed to name a retired route. There used to be one
 * exemption, for `lib/cloud/syncEngine.ts`, which read a profile's config back
 * through `/bundle` to encrypt it for cloud backup. That flow is gone: cloud
 * backup and restore now run entirely on the API, which seals the config and
 * imports it without rendering it here, so the exemption went with it.
 *
 * A backup feature that is finished still costs nothing to keep honest — the
 * test above is what makes "the browser never holds a config" a property of the
 * webview rather than a habit.
 */

/**
 * Comments are stripped before matching, because the modules that removed these
 * features explain the removal in prose — and that prose names the very routes it
 * retired. A scan that flagged the explanation would push someone toward deleting
 * the reason the code is shaped this way.
 */
function code(relativePath: string): string {
  return readFileSync(join(SRC, relativePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function offendersMatching(patterns: RegExp[], candidates: string[]): string[] {
  return candidates.filter((file) => {
    const source = code(file);
    return patterns.some((pattern) => pattern.test(source));
  });
}

/** Every file that still names a retired route. None may. */
function retiredRouteCallers(): string[] {
  const routes = [/\/nodes\/[^'"`\s]*\/link/, /\/nodes\/export/, /\/vpn\/profiles\/[^'"`\s]*\/bundle/];
  return offendersMatching(routes, FILES);
}

describe('the webview offers no raw configuration', () => {
  it.each([
    ['the share-link copy', /copyShareLink/],
    ['the bulk export', /downloadExport/],
  ])('has no %s', (_label, pattern) => {
    expect(offendersMatching([pattern], FILES)).toEqual([]);
  });

  it('calls no retired route anywhere, cloud sync included', () => {
    expect(retiredRouteCallers()).toEqual([]);
  });

  it('has no copy/export affordance left on the node pages', () => {
    const candidates = FILES.filter((f) => /Node(Detail|Explorer)Page\.tsx$/.test(f));
    const offenders = offendersMatching(
      [/Copy share link|Export JSON|Export page|Download configuration|shape preview|Shape preview/i],
      candidates,
    );
    expect(offenders).toEqual([]);
  });

  it('never renders a share-link URI scheme on the node pages', () => {
    // The node detail page used to show a "shape preview" of the link with the
    // secret replaced by <password> — still a map of the endpoint and its exact
    // query string. Scoped to the nodes feature on purpose: the VPN intake
    // forms legitimately show `vless://…` as a placeholder, because pasting a
    // configuration you own is how a profile gets imported in the first place.
    const candidates = FILES.filter((f) => f.includes('features/nodes'));
    expect(offendersMatching([/\b(vless|vmess|trojan|hysteria2|tuic):\/\//i], candidates)).toEqual([]);
  });
});