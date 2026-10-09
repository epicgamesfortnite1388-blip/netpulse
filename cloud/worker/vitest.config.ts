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
  '0003_telegram_integration.sql',
  '0004_admin_plans.sql',
]
  .map((f) => readFileSync(path.join(migrationsDir, f), 'utf8'))
  .join('\n');

export default defineWorkersConfig({
  define: { MIGRATION_SQL: JSON.stringify(migrationSql) },
  test: {
    setupFiles: ['./test/applyMigrations.ts'],
    poolOptions: {
      workers: {
        // Run every test file in ONE workerd instance rather than one per file.
        //
        // On this Windows host the workers runtime intermittently fails to start
        // with `workerd/server/fallback-service.c++:158: Fallback service failed
        // to fetch module; ... ConnectEx(): #1225 The remote computer refused the
        // network connection` -- the runtime's fallback service tries to connect
        // back to the parent and nothing is listening yet. It is not caused by
        // any test: the same suite passed 56/56 minutes earlier and fails 3/3
        // just as reproducibly, and switching pool (`--pool=forks`) changes
        // nothing, so it is the runtime's own startup rather than vitest's
        // scheduling.
        //
        // Collapsing to a single worker removes most of the concurrent starts and
        // with them the race: measured over repeated runs, failures went from
        // every attempt to roughly one in three. That is a mitigation, not a
        // cure -- the underlying runtime bug is upstream. Storage isolation is
        // unchanged (vitest-pool-workers still resets between tests), and all 56
        // tests pass either way, so nothing depends on per-file workers.
        singleWorker: true,
        wrangler: { configPath: path.join(__dirname, 'wrangler.toml') },
        miniflare: {
          // Local (per-test-run) D1 for the DB binding.
          d1Databases: { DB: 'test-d1' },
          bindings: {
            // Non-secret fixed test values — never real credentials.
            AUTH_SECRET: 'test-auth-secret',
            RESET_PEPPER: 'test-reset-pepper',
            NETPULSE_SERVICE_SECRET: 'test-np-service-secret',
            TELEGRAM_BOT_BASE_URL: 'https://bot.test',
            OPS_TOKEN: 'test-ops-token-0123456789abcdef',
          },
        },
      },
    },
  },
});
