import { readFileSync } from 'node:fs';
import path from 'node:path';

import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

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
  '0005_vpn_credentials.sql',
]
  .map((f) => readFileSync(path.join(migrationsDir, f), 'utf8'))
  .join('\n');

/**
 * Workers-runtime tests, on the current `@cloudflare/vitest-plugin` integration.
 *
 * The old `defineWorkersConfig` helper (and the `poolOptions.workers` shape it
 * configured) was removed when the integration moved to a Vite plugin. The
 * options are the same ones the old config carried: the wrangler file supplies
 * the Worker entry point and compatibility date, while `miniflare` pins the
 * per-test-run D1 and the fixed, non-secret bindings.
 */
export default defineConfig({
  define: { MIGRATION_SQL: JSON.stringify(migrationSql) },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: path.join(__dirname, 'wrangler.toml') },
      miniflare: {
        // Local (per-test-run) D1 for the DB binding. Never production D1.
        d1Databases: { DB: 'test-d1' },
        bindings: {
          // Non-secret fixed test values — never real credentials.
          AUTH_SECRET: 'test-auth-secret',
          RESET_PEPPER: 'test-reset-pepper',
          NETPULSE_SERVICE_SECRET: 'test-np-service-secret',
          TELEGRAM_BOT_BASE_URL: 'https://bot.test',
          OPS_TOKEN: 'test-ops-token-0123456789abcdef',
          VPS_SYNC_SECRET: 'test-vps-sync-secret-0123456789',
          // Fixed, non-secret values so provisioning tests exercise the real
          // config generator without production credentials.
          VPN_REALITY_UUID: '11111111-1111-4111-8111-111111111111',
          VPN_VMESS_UUID: '22222222-2222-4222-8222-222222222222',
          VPN_VLESS_WS_UUID: '33333333-3333-4333-8333-333333333333',
          VPN_TROJAN_PASSWORD: 'test-trojan-password',
          VPN_SS2022_PASSWORD: 'dGVzdC1zczIwMjItcGFzcw==',
          VPN_HYSTERIA_PASSWORD: 'test-hysteria-password',
          VPN_HYSTERIA_OBFS_PASSWORD: 'test-hysteria-obfs',
        },
      },
    }),
  ],
  test: {
    setupFiles: ['./test/applyMigrations.ts'],
  },
});
