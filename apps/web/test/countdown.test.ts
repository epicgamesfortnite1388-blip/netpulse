import { describe, expect, it } from 'vitest';

import { fmtCountdown } from '../src/lib/format';

/**
 * The wait shown after a throttled reset request is the user's only clue that
 * the form is not broken. It comes from `retryAfterSec` on the Worker's 429 and
 * must keep falling visibly: a rounded "1 minute" would sit unchanged while the
 * button stayed disabled, which reads as a hang.
 */
describe('fmtCountdown', () => {
  it('prints minutes and zero-padded seconds, so the change is visible every second', () => {
    expect(fmtCountdown(7)).toBe('0:07');
    expect(fmtCountdown(59)).toBe('0:59');
    expect(fmtCountdown(60)).toBe('1:00');
    expect(fmtCountdown(1730)).toBe('28:50');
    expect(fmtCountdown(3600)).toBe('60:00');
  });

  it('never rounds a remaining second down to zero early, and never goes negative', () => {
    expect(fmtCountdown(0.2)).toBe('0:01');
    expect(fmtCountdown(0)).toBe('0:00');
    expect(fmtCountdown(-5)).toBe('0:00');
  });
});
