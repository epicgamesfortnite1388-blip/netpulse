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
    // Keep files in one pool so SQLite-backed suites never contend on the
    // same temp database directories.
    poolOptions: {
      threads: { singleThread: true },
    },
  },
});
