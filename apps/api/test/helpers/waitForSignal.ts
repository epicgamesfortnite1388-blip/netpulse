import { vi } from 'vitest';

/**
 * `vi.waitFor` with a timeout that matches this suite's stated budget.
 *
 * `vitest.config.ts` already documents the problem this exists to solve:
 * "on loaded machines the default 10 s hook budget produced flaky failures even
 * though every assertion passed", so hooks get 60 s and tests 30 s. But
 * `testTimeout` does NOT apply to `vi.waitFor`, which carries its own hard-coded
 * **1000 ms** default. Every test in this suite that waits for a real completion
 * signal (a sweep finishing, a gateway port answering, a child tearing down)
 * therefore raced a one-second budget that has nothing to do with how long the
 * work actually takes — and the sweep tests, whose real work is a few hundred
 * milliseconds of ICMP probes, blew past it whenever the machine was busy.
 * Those runs failed at 1008-1027 ms with `expected false to be true`: the
 * predicate had not been satisfied *yet*, which is not the same as never.
 *
 * This is not a longer sleep and it does not paper over a stuck sweep. The wait
 * still polls the same real predicate and still fails if the signal never
 * arrives; only the deadline before it declares failure moved, to a value
 * consistent with the 30 s the surrounding test already gets. Kept below that
 * bound so a genuine hang still surfaces as a `waitFor` timeout with the real
 * predicate in the message, rather than as an opaque test timeout.
 */
export const SIGNAL_TIMEOUT_MS = 10_000;

/** Wait for a real completion signal, with the suite's signal deadline. */
export function waitForSignal(assertion: () => void): Promise<void> {
  return vi.waitFor(assertion, { timeout: SIGNAL_TIMEOUT_MS });
}
