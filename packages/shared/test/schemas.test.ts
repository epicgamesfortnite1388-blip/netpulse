import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, PingTestRequestSchema, SettingsSchema } from '../src/schemas/settings';
import { TargetSchema } from '../src/schemas/settings';

describe('TargetSchema', () => {
  it('accepts hostnames and IPs', () => {
    expect(TargetSchema.safeParse('1.1.1.1').success).toBe(true);
    expect(TargetSchema.safeParse('example.com').success).toBe(true);
    expect(TargetSchema.safeParse('2606:4700:4700::1111').success).toBe(true);
  });
  it('rejects injection attempts and malformed input', () => {
    expect(TargetSchema.safeParse('1.1.1.1 -n 99999').success).toBe(false);
    expect(TargetSchema.safeParse('a b').success).toBe(false);
    expect(TargetSchema.safeParse('$(reboot)').success).toBe(false);
    expect(TargetSchema.safeParse('').success).toBe(false);
    expect(TargetSchema.safeParse('x'.repeat(300)).success).toBe(false);
  });
});

describe('PingTestRequestSchema', () => {
  it('applies defaults', () => {
    const parsed = PingTestRequestSchema.parse({ target: '1.1.1.1' });
    expect(parsed.count).toBe(4);
    expect(parsed.timeoutMs).toBe(4000);
  });
  it('rejects out-of-range counts', () => {
    expect(PingTestRequestSchema.safeParse({ target: '1.1.1.1', count: 0 }).success).toBe(false);
    expect(PingTestRequestSchema.safeParse({ target: '1.1.1.1', count: 1000 }).success).toBe(false);
  });
});

describe('SettingsSchema', () => {
  it('accepts defaults', () => {
    expect(SettingsSchema.safeParse(DEFAULT_SETTINGS).success).toBe(true);
  });
  it('rejects weights that do not sum to 100', () => {
    const bad = {
      ...DEFAULT_SETTINGS,
      optimization: {
        ...DEFAULT_SETTINGS.optimization,
        weights: { ...DEFAULT_SETTINGS.optimization.weights, latency: 50 },
      },
    };
    expect(SettingsSchema.safeParse(bad).success).toBe(false);
  });
  it('rejects invalid theme', () => {
    const bad = { ...DEFAULT_SETTINGS, general: { ...DEFAULT_SETTINGS.general, theme: 'neon' } };
    expect(SettingsSchema.safeParse(bad).success).toBe(false);
  });
});
