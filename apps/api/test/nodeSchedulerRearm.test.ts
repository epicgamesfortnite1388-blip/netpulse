import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NodeTestScheduler } from '../src/services/nodeTestScheduler';

import type { Logger } from '../src/logger';
import type { NodesService } from '../src/services/nodesService';
import type { AppSettings } from '@netpulse/shared';

/**
 * Settings-change wiring: a PUT /settings that touches automation must stop
 * the armed timer and re-arm with the new cadence (same contract as
 * ScheduleService). Regression for the Automation settings UI pass.
 */
describe('NodeTestScheduler settings re-arm', () => {
  let onChangeFn: (() => void) | null = null;
  let scheduler: NodeTestScheduler;
  let settings: AppSettings;

  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

  beforeEach(() => {
    vi.useFakeTimers();
    onChangeFn = null;
    settings = {
      automation: { autoTestNodes: { enabled: true, intervalMinutes: 30 } },
    } as unknown as AppSettings;
    const nodes = {
      pickNodesForAutoTest: vi.fn().mockReturnValue([]),
      retireStaleNodes: vi.fn().mockReturnValue({ retired: 0 }),
    } as unknown as NodesService;
    scheduler = new NodeTestScheduler({
      nodes,
      settings: {
        get: () => settings,
        setOnChange: (fn: () => void) => {
          onChangeFn = fn;
        },
      },
      log,
    });
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  it('registers a change listener at construction', () => {
    expect(onChangeFn).toBeTypeOf('function');
  });

  it('re-arms with the new cadence when settings change at runtime', () => {
    scheduler.start();
    const spy = vi.spyOn(scheduler as unknown as { tick: () => Promise<void> }, 'tick');

    // Re-arm from 30 min to 45 min. start() also schedules a one-shot
    // first tick at 45 s (boot-crowding avoidance) — it must survive the
    // reconfigure exactly once.
    settings.automation = { autoTestNodes: { enabled: true, intervalMinutes: 45 } };
    onChangeFn?.();

    vi.advanceTimersByTime(45_000);
    expect(spy).toHaveBeenCalledTimes(1); // the first-tick

    // Old 30-minute interval was cleared: nothing fires at the 30-min mark.
    vi.advanceTimersByTime(30 * 60_000 - 45_000);
    expect(spy).toHaveBeenCalledTimes(1);

    // New 45-minute interval fires at its boundary.
    vi.advanceTimersByTime(15 * 60_000);
    expect(spy).toHaveBeenCalledTimes(2);

    // Next boundary at 90 min total. A leaked old 30-min timer would have
    // fired at 60 min and made this 4.
    vi.advanceTimersByTime(45 * 60_000);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('stops the timer when auto-test is disabled via settings', () => {
    scheduler.start();
    const spy = vi.spyOn(scheduler as unknown as { tick: () => Promise<void> }, 'tick');
    settings.automation = { autoTestNodes: { enabled: false, intervalMinutes: 30 } };
    onChangeFn?.();
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(spy).not.toHaveBeenCalled();
  });

  it('ignores change notifications before start()', () => {
    settings.automation = { autoTestNodes: { enabled: true, intervalMinutes: 5 } };
    onChangeFn?.();
    const spy = vi.spyOn(scheduler as unknown as { tick: () => Promise<void> }, 'tick');
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(spy).not.toHaveBeenCalled(); // never armed
  });
});
