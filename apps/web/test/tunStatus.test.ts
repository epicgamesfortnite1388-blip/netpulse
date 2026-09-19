import { describe, expect, it } from 'vitest';

import { killSwitchClaim, tunClaim, tunRemedy, watchdogClaim } from '../src/features/vpn/tunStatus';

/**
 * The claim contract for TUN mode, which both surfaces (the tunnel card and the
 * Aether surface) read instead of their own ternaries:
 *
 *   - `active` is the ONLY state allowed the success tone.
 *   - `unguarded` — a verified capture whose kill-switch hold could not be
 *     armed — must read as the alarm state: traffic really is flowing, but the
 *     guarantee is missing, so it must not be skippable as a footnote.
 *   - a kill-switch line may say "armed" only when a hold exists, never because
 *     the preference is enabled.
 */

describe('tunClaim', () => {
  it('treats only a verified, guarded capture as ok', () => {
    const claim = tunClaim({ tun: 'active' });
    expect(claim).toEqual({
      tone: 'ok',
      label: 'active — all system traffic captured',
      sentence: expect.stringMatching(/kill switch holds the drop/),
    });
  });

  it('reads an unarmed hold as the alarm state, and says the capture is up', () => {
    const claim = tunClaim({ tun: 'unguarded', tunError: 'x', tunBlockedBy: 'kill-switch' });
    expect(claim?.tone).toBe('danger');
    expect(claim?.label).toBe('CAPTURING — kill switch not armed');
    // Both halves of the truth are in the sentence: traffic rides the tunnel,
    // and a drop would fall back to the direct path.
    expect(claim?.sentence).toMatch(/traffic does ride the tunnel/);
    expect(claim?.sentence).toMatch(/fall back to the direct path/);
  });

  it('never lets `unguarded` borrow the active wording', () => {
    const active = tunClaim({ tun: 'active' });
    const unguarded = tunClaim({ tun: 'unguarded' });
    expect(unguarded?.label).not.toBe(active?.label);
    expect(unguarded?.tone).not.toBe(active?.tone);
  });

  it('keeps a merely requested capture out of both ok and danger', () => {
    expect(tunClaim({ tun: 'requested' })?.tone).toBe('warn');
    expect(tunClaim({ tun: null, tunError: 'x', tunBlockedBy: 'relay' })).toBeNull();
    expect(tunClaim({})).toBeNull();
  });

  it('reads a watchdog rebuild as the alarm state, never as capture', () => {
    const claim = tunClaim({ tun: 'recovering' });
    expect(claim?.tone).toBe('danger');
    expect(claim?.label).toBe('LOST — re-establishing the capture');
    // Both facts, in order of importance: the drop was handled fail-closed
    // first, and nothing is captured while the rebuild runs.
    expect(claim?.sentence).toMatch(/handed to the kill switch first/);
    expect(claim?.sentence).toMatch(/nothing is captured until it proves out again/);
    expect(claim?.tone).not.toBe('ok');
  });
});

describe('watchdogClaim', () => {
  const base = { rearming: false, autoAttempts: 0, maxAutoAttempts: 1, lastError: null };

  it('says nothing when the watchdog has not run', () => {
    expect(watchdogClaim(null, 'active')).toBeNull();
    expect(watchdogClaim(undefined, 'active')).toBeNull();
    expect(watchdogClaim(base, 'active')).toBeNull();
  });

  it('names the attempt in flight while it runs', () => {
    const claim = watchdogClaim({ ...base, rearming: true, autoAttempts: 1 }, 'recovering');
    expect(claim?.tone).toBe('warn');
    expect(claim?.text).toMatch(/Automatic re-arm 1 of 1 in progress/);
    expect(claim?.text).toMatch(/capture is down/);
  });

  it('reports a failed rebuild with its real reason, as a hole in protection', () => {
    const claim = watchdogClaim({ ...base, autoAttempts: 1, lastError: 'relay proof timed out' }, null);
    expect(claim?.tone).toBe('danger');
    expect(claim?.text).toMatch(/did not restore the capture: relay proof timed out/);
  });

  it('records a successful rebuild without overclaiming it', () => {
    const healed = watchdogClaim({ ...base, autoAttempts: 1 }, 'active');
    expect(healed?.tone).toBe('ok');
    expect(healed?.text).toMatch(/Recovered automatically/);
    expect(healed?.text).toMatch(/rebuilt by re-arm 1 of 1/);
    // A budget that says the capture is up but NOT verified must not read as ok.
    expect(watchdogClaim({ ...base, autoAttempts: 1 }, 'requested')?.tone).toBe('warn');
  });
});

describe('killSwitchClaim', () => {
  it('does not call an enabled preference "armed"', () => {
    const claim = killSwitchClaim({ enabled: true, armed: false, blocking: false });
    expect(claim?.tone).toBe('danger');
    expect(claim?.text).toMatch(/ENABLED BUT NOT ARMED/);
    expect(claim?.text).toMatch(/fall back to the direct path/);
  });

  it('claims the hold when one exists, and the block when one is engaged', () => {
    expect(killSwitchClaim({ enabled: true, armed: true, blocking: false })).toEqual({
      tone: 'ok',
      text: expect.stringMatching(/armed in route mode/),
    });
    expect(killSwitchClaim({ enabled: true, armed: true, blocking: true })?.tone).toBe('danger');
    expect(killSwitchClaim({ enabled: false, armed: false, blocking: false })?.tone).toBe('warn');
  });

  it('renders nothing when the kill-switch state is unknown', () => {
    expect(killSwitchClaim(null)).toBeNull();
    expect(killSwitchClaim(undefined)).toBeNull();
  });
});

describe('tunRemedy', () => {
  it('gives an action per code, and says the capture is up for the hold', () => {
    expect(tunRemedy('core')).toMatch(/Install sing-box/);
    expect(tunRemedy('admin')).toMatch(/administrator rights/);
    expect(tunRemedy('relay')).toMatch(/did not relay/);
    expect(tunRemedy('kill-switch')).toMatch(/capture itself is up/);
    expect(tunRemedy(null)).toBeNull();
    expect(tunRemedy(undefined)).toBeNull();
  });
});
