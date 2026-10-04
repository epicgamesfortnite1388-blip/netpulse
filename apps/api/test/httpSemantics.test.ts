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

/**
 * The error envelope has exactly one owner: `src/util/apiError.ts`.
 *
 * This existed as a *living* defect, not a hypothetical one. 39 route sites
 * wrote `{ error: 'not_found', message }` (error a string) and 9 wrote
 * `{ error: { code, message } }`; the desktop client read only the nested one,
 * so every message from the other 39 was dropped and the UI showed "Not Found /
 * http_404". Fixing the client to accept both would only have hidden it — the
 * next site would copy whichever neighbour it sat next to. So the shape is
 * defined once and this test refuses a second hand-written copy.
 */
describe('Error envelope: one owner', () => {
  const handWritten: string[] = [];

  it('no route or plugin hand-writes an error body', () => {
    const dirs = [join(__dirname, '../src/routes'), join(__dirname, '../src/plugins')];
    for (const dir of dirs) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.ts')) continue;
        const src = readFileSync(join(dir, f), 'utf8');
        src.split('\n').forEach((line, i) => {
          // `.send({ error: ... })` is the hand-written shape in any form.
          if (/\.send\(\s*\{\s*error\s*:/.test(line)) {
            handWritten.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
          }
        });
      }
    }
    expect(
      handWritten,
      `Error bodies must go through replyApiError()/replyValidationError() from src/util/apiError.ts:\n${handWritten.join('\n')}`,
    ).toEqual([]);
  });

  it('every error envelope sent without replyApiError still sets a status', () => {
    // `reply.send(apiErrorBody(...))` with no `.status()` answers 200 with an
    // error body — the exact thing this file exists to prevent. Migrating a
    // call site can drop the status silently, and did: the unknown-route
    // handler answered 200 until this test existed.
    const missingStatus: string[] = [];
    const dirs = [join(__dirname, '../src/routes'), join(__dirname, '../src/plugins')];
    for (const dir of dirs) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.ts')) continue;
        const src = readFileSync(join(dir, f), 'utf8');
        src.split('\n').forEach((line, i) => {
          if (!/\breply\s*\.\s*send\s*\(\s*apiErrorBody\s*\(/.test(line)) return;
          // Walk back over the continuation of a multi-line statement to see
          // whether a .status(...) is chained anywhere in it.
          const start = Math.max(0, i - 2);
          const stmt = src.split('\n').slice(start, i + 3).join(' ');
          if (!/\.status\s*\(/.test(stmt)) {
            missingStatus.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
          }
        });
      }
    }
    expect(
      missingStatus,
      `Error envelopes must carry an explicit status:\n${missingStatus.join('\n')}`,
    ).toEqual([]);
  });
});
