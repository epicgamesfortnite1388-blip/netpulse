import { defineConfig } from 'vitest/config';

/**
 * Test timeouts are raised well above defaults: several suites spin up real
 * Fastify servers in beforeAll hooks, and on loaded machines the default 10 s
 * hook budget produced flaky "Hook timed out" suite failures even though every
 * assertion passed. 60 s hooks / 30 s tests keep the suite deterministic.
 */
export default defineConfig({
  test: {
    hookTimeout: 60_000,
    testTimeout: 30_000,
    // Secret vaults default to Windows Credential Manager on win32. A test run
    // must not write entries into the developer's real credential store (or
    // leave them behind after the suite finishes), so tests pin the file store.
    // The keychain path is covered by its own tests, which exercise the store's
    // fallback rules without touching a real store.
    env: {
      NETPULSE_VAULT_KEY_STORE: 'file',
    },
    // Keep files in one worker so SQLite-backed suites never contend on the
    // same temp database directories. Vitest 4 removed `poolOptions`; the old
    // `threads.singleThread` is now `maxWorkers: 1` (module isolation between
    // files stays on, which the old setting also preserved). Without this the
    // real-socket suites (SOCKS/proxy listeners, spawned cores) time out under
    // the contention and fail different tests on every run.
    pool: 'threads',
    maxWorkers: 1,
  },
});
