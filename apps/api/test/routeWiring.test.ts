import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Route-wiring meta-tests.
 *
 * Every path the web client fetches must exist in the backend route table,
 * otherwise a feature is dead in production. These tests parse the frontend
 * source for api.get/post/put/patch/delete calls (literal + template strings)
 * and compare the path prefixes with the literal route registrations in
 * apps/api/src/routes/*.ts.
 */

const WEB_SRC = join(__dirname, '../../web/src');
const API_ROUTES = join(__dirname, '../src/routes');
const WS_ROUTE = join(__dirname, '../src/realtime/wsRoute.ts');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** Extract literal HTTP paths from frontend source. */
function frontendPaths(): { path: string; file: string }[] {
  const files = walk(WEB_SRC);
  const found: { path: string; file: string }[] = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    // api.get('/x') etc., including generic forms api.get<T>('/x')
    const re = /api\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*(['"`])(\/[^'"`]*)\2/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      found.push({ path: m[3] as string, file: f });
    }
  }
  return found;
}

/** Extract registered route patterns from the backend. */
function backendRoutes(): string[] {
  const files = walk(API_ROUTES);
  files.push(WS_ROUTE);
  const routes = new Set<string>();
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const re = /app\.(get|post|put|patch|delete)\(\s*['"`](\/[^'"`]*)['"`]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      routes.add(m[2] as string);
    }
  }
  return [...routes];
}

/** Strip query strings and interpolate ${...} template segments to ':param'. */
function normalize(p: string): string {
  const noQuery = p.split('?')[0] as string;
  return noQuery.replace(/\$\{[^}]*\}/g, ':param');
}

/** Does a registered route pattern match a normalized frontend path? */
function matches(route: string, path: string): boolean {
  const routeParts = route.split('/');
  const pathParts = path.split('/');
  if (routeParts.length !== pathParts.length) return false;
  return routeParts.every((rp, i) => {
    if (rp.startsWith(':')) return pathParts[i] !== '';
    return rp === pathParts[i];
  });
}

describe('frontend/backend route wiring', () => {
  const routes = backendRoutes().map((r) => r.replace(/^\/api\/v1/, ''));
  const used = frontendPaths();

  it('backend exposes a non-trivial route table', () => {
    expect(routes.length).toBeGreaterThan(60);
  });

  it('frontend actually issues a non-trivial number of distinct API calls', () => {
    const distinct = new Set(used.map((u) => normalize(u.path)));
    expect(distinct.size).toBeGreaterThan(40);
  });

  it('every frontend fetch path has a registered backend route', () => {
    const missing: string[] = [];
    for (const { path, file } of used) {
      const norm = normalize(path);
      const short = norm; // frontend paths omit /api/v1 prefix
      const hit = routes.some((route) => matches(route, short));
      if (!hit) missing.push(`${path} (${file.split(/[\\/]/).pop()})`);
    }
    expect(missing).toEqual([]);
  });
});
