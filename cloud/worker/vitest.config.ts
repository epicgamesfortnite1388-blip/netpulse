import { readFileSync } from 'node:fs';
import path from 'node:path';

import cfg from '@cloudflare/vitest-pool-workers/config';

import { defineWorkersConfig } from './test/defineConfig';

// The workers runtime virtualizes fs, so the migration SQL is injected as a
// compile-time constant instead of being read inside the runtime. All
// migrations run in filename order, exactly like `wrangler d1 migrations
// apply` would on a fresh database.
const migrationsDir = path.join(__dirname, 'migrations');
const migrationSql = [
  '0001_init.sql',
  '0002_profile_vaults.sql',
]
  .map((f) => readFileSync(path.join(migrationsDir, f), 'utf8'))
  .join('\n');

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
