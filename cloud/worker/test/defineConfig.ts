/** Interop-proof re-export: the package is CJS and vite's config bundler may
 *  hand it to us as a namespace or a default object depending on resolution. */
import * as cfgNs from '@cloudflare/vitest-pool-workers/config';

type Fn = <T>(config: T) => T;
const cfg = cfgNs as unknown as { defineWorkersConfig?: Fn } & Fn;
const resolved = (cfg.defineWorkersConfig ?? cfg) as Fn;

export const defineWorkersConfig: Fn = resolved;
