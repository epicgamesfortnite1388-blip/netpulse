import type { Env as WorkerEnv } from '../src/auth';

/**
 * `@cloudflare/vitest-plugin` types the `cloudflare:test` `env` export as
 * `Cloudflare.Env`, the namespace `wrangler types` generates, instead of the
 * removed `ProvidedEnv` interface. Declare the Worker's own binding shape
 * there so `env.DB` and the test secrets are typed inside the runtime tests.
 *
 * This must be self-contained: `worker-configuration.d.ts` is gitignored, so
 * CI does not have it. Declaring the namespace globally merges with whatever
 * `wrangler types` produces on a developer machine without depending on it.
 */
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}

export {};
