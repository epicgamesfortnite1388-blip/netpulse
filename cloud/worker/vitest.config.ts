import { readFileSync } from 'node:fs';
import path from 'node:path';

import cfg from '@cloudflare/vitest-pool-workers/config';

import { defineWorkersConfig } from './test/defineConfig';

// The workers runtime virtualizes fs, so the migration SQL is injected as a
// compile-time constant instead of being read inside the runtime.
const migrationSql = readFileSync(path.join(__dirname, 'migrations', '0001_init.sql'), 'utf8');

export default defineWorkersConfig({
  define: { MIGRATION_SQL: JSON.stringify(migrationSql) },
  test: {
    setupFiles: ['./test/applyMigrations.ts'],
    poolOptions: {
      workers: {
        wrangler: { configPath: path.join(__dirname, 'wrangler.toml') },
        miniflare: {
          // Local (per-test-run) D1 for the DB binding.
          d1Databases: { DB: 'test-d1' },
          bindings: {
            // Non-secret fixed test values — never real credentials.
            AUTH_SECRET: 'test-auth-secret',
            RESET_PEPPER: 'test-reset-pepper',
          },
        },
      },
    },
  },
});
