import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * HTTP-semantics meta-test: a route must not return an error body with an OK
 * status. `return { error: 'not_found' }` (HTTP 200 + error JSON) defeats the
 * frontend's throw-on-non-2xx contract — a detail page then renders the error
 * object as data and crashes on missing fields (the NodeDetailPage crash).
 */
const routesDir = join(__dirname, '../src/routes');

const offenders: string[] = [];

describe('HTTP semantics: no 200-wrapped error bodies', () => {
  it('no route returns { error: ... } without an explicit error status', () => {
    for (const f of readdirSync(routesDir)) {
      if (!f.endsWith('.ts')) continue;
      const src = readFileSync(join(routesDir, f), 'utf8');
      // Match a line returning an object literal that starts with an error key.
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        if (/return\s*\{\s*error:/.test(line) && !/status\(/.test(line)) {
          offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
        }
      });
    }
    expect(
      offenders,
      `Found routes returning error bodies with implicit 200 status — use reply.status(4xx).send() instead:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
