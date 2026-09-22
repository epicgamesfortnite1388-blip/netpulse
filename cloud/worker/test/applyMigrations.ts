import { env } from 'cloudflare:test';
import { beforeAll } from 'vitest';

// The workers pool virtualizes node:fs, so read the migration OUTSIDE the
// runtime via a virtual module: vitest `define` inlines it at transform time.
declare const MIGRATION_SQL: string;

beforeAll(async () => {
  // exec() chokes on leading comment lines; strip them and split on the
  // statement boundary so every statement runs individually.
  const statements = MIGRATION_SQL.split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) await env.DB.prepare(stmt).run();
});
