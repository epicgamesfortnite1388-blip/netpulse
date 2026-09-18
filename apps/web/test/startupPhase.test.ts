import { describe, expect, it } from 'vitest';

import { phaseForFailedProbe, STARTUP_GRACE_MS } from '../src/lib/startupPhase';

/**
 * The banner contract: a failing health probe during the app's boot window must
 * not be reported as "backend unreachable" — the backend is starting, and the
 * desktop shell had not even handed the UI its transport yet.
 */
describe('phaseForFailedProbe', () => {
  it('stays in the starting phase through the boot window', () => {
    expect(phaseForFailedProbe(0)).toBe('starting');
    expect(phaseForFailedProbe(1_500)).toBe('starting');
    expect(phaseForFailedProbe(STARTUP_GRACE_MS - 1)).toBe('starting');
  });

  it('reports recovery once the boot window has passed', () => {
    expect(phaseForFailedProbe(STARTUP_GRACE_MS)).toBe('recovery');
    expect(phaseForFailedProbe(5 * 60_000)).toBe('recovery');
  });

  it('keeps the grace window long enough to cover a slow first boot', () => {
    // A cold first launch runs migrations and an integrity check on the real
    // database before the port opens; the window must outlast that.
    expect(STARTUP_GRACE_MS).toBeGreaterThanOrEqual(15_000);
  });

  it('accepts an explicit window (used by the hook and by tests)', () => {
    expect(phaseForFailedProbe(999, 1_000)).toBe('starting');
    expect(phaseForFailedProbe(1_000, 1_000)).toBe('recovery');
  });
});
