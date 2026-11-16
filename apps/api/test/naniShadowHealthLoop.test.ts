import { afterEach, describe, expect, it, vi } from 'vitest';
import { NaniShadowHealthLoop } from '../src/services/naniShadowHealthLoop';

function fakeLog() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as any;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('NaniShadowHealthLoop', () => {
  it('runs exactly one shadow pass per tick', async () => {
    let calls = 0;
    const loop = new NaniShadowHealthLoop(async () => {
      calls += 1;
    }, fakeLog());
    await loop.runOnce();
    expect(calls).toBe(1);
    loop.stop();
  });

  it('does not overlap a pass that is still running', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loop = new NaniShadowHealthLoop(async () => {
      calls += 1;
      await gate;
    }, fakeLog());

    const first = loop.runOnce();
    await loop.runOnce();
    expect(calls).toBe(1);
    release();
    await first;
    loop.stop();
  });

  it('schedules ticks and stops cleanly', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const log = fakeLog();
    const loop = new NaniShadowHealthLoop(async () => {
      calls += 1;
    }, log, 1_000);

    loop.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(1);

    loop.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toBe(1);
    expect(log.info).toHaveBeenCalled();
  });

  it('swallows pass failures and stays alive', async () => {
    const log = fakeLog();
    const loop = new NaniShadowHealthLoop(async () => {
      throw new Error('probe exploded');
    }, log);

    await expect(loop.runOnce()).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(
      { error: 'probe exploded' },
      expect.stringContaining('no action taken'),
    );
    loop.stop();
  });
});
