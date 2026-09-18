/**
 * Startup-phase policy for the backend health probe.
 *
 * Kept free of React and transport imports so the rule the banner depends on is
 * readable (and testable) on its own: a failed probe during the startup window
 * is NOT evidence that the backend is unreachable.
 */

/**
 * How long the backend may legitimately still be starting before a failing
 * health probe is reported as "unreachable". The desktop shell only resolves
 * the UI's transport once the sidecar answers (its `bootstrap` IPC command
 * waits for the port to accept connections), so a probe failure inside this
 * window means the backend is booting, not gone. Past it, the recovery banner
 * is the honest answer.
 */
export const STARTUP_GRACE_MS = 20_000;

/**
 * The phase a failed health probe reports, given how long this UI session has
 * been up: `starting` while the app is still within its boot window (the UI
 * keeps showing "Starting…" and retrying fast), `recovery` afterwards.
 */
export function phaseForFailedProbe(
  elapsedSinceBootMs: number,
  graceMs: number = STARTUP_GRACE_MS,
): 'starting' | 'recovery' {
  return elapsedSinceBootMs < graceMs ? 'starting' : 'recovery';
}
