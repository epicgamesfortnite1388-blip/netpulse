import { env } from 'cloudflare:test';
import { beforeAll, beforeEach } from 'vitest';

// The workers runtime virtualizes node:fs, so read the migration OUTSIDE the
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

/**
 * Per-test database isolation.
 *
 * `@cloudflare/vitest-plugin` isolates storage per test FILE; the old
 * vitest-pool-workers release this suite was written against rolled state back
 * after every test. These tests rely on the latter: registration is limited to
 * 5/hour per IP and login to 20/15 min, and several tests deliberately exhaust
 * a limiter. Without this reset, later tests in the same file inherit the
 * previous test's counters and accounts — the first run after the upgrade
 * failed 42 tests with 429/409 for exactly that reason.
 *
 * Every file's own `beforeAll` only DELETEs state; none seeds fixtures outside
 * a test body, so resetting everything between tests is safe. `plans` is
 * re-seeded to the migration's row because admin tests patch it and expect the
 * fresh-migration defaults.
 */
const TABLES = [
  'admin_events',
  'np_events',
  'np_outbound_log',
  'np_entitlements',
  'np_links',
  'service_nonces',
  'profile_vaults',
  'vpn_credentials',
  'vpn_profiles',
  'user_settings',
  'user_history',
  'user_preferences',
  'devices',
  'rotated_refresh_hashes',
  'sessions',
  'password_reset_tokens',
  'audit_events',
  'plans',
  'users',
  'rate_limits',
] as const;

beforeEach(async () => {
  await env.DB.batch([
    // Children before parents: D1 enforces the foreign keys in these tables.
    ...TABLES.map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
    // Exactly the seed row migration 0004 inserts on a fresh database.
    env.DB.prepare(
      `INSERT OR IGNORE INTO plans
         (id, code, name, default_profiles, default_nodes, default_scan_profile, preferred_proxy_engine, updated_at)
       VALUES ('plan_pro', 'pro', 'Pro', '[]', '[]', 'balanced', 'auto', 0)`,
    ),
  ]);
});
