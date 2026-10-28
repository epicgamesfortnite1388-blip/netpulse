/**
 * Adaptive connectivity intelligence — shared, dependency-free core.
 *
 * Split this way on purpose: everything here is pure (no I/O, no clock reads, no
 * `node:crypto`, no network), so the policy can be unit-tested exhaustively, run
 * identically in the sidecar and in the browser, and reasoned about by reading
 * one file. Persistence, strategy discovery from installed cores, and signature
 * verification live in the sidecar (`apps/api/src/services/adaptive*`), which is
 * the only place that can actually change how the app connects.
 */
export * from './types';
export * from './policy';
export * from './classify';
export * from './manifest';
export * from './candidates';
