import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppSettings } from '@netpulse/shared';

import { RealtimeBus } from '../src/realtime/bus';
import { ScheduleService } from '../src/services/scheduleService';
import type { DnsService } from '../src/services/dnsService';
import type { GamingService } from '../src/services/gamingService';
import type { SettingsService } from '../src/services/settingsService';

import type { Logger } from '../src/logger';

function makeSettings(overrides: Partial<AppSettings['scheduling']> = {}) {
  let scheduling: AppSettings['scheduling'] = {
    dnsEnabled: false,
    dnsIntervalMin: 60,
    gamingEnabled: false,
    gamingIntervalMin: 60,
    gamingGameId: null,
    ...overrides,
  };
  let onChange: ((s: AppSettings) => void) | null = null;
  const svc = {
    get: (): AppSettings => ({ scheduling } as AppSettings),
    setOnChange: (fn: (s: AppSettings) => void) => {
      onChange = fn;
    },
    trigger: (s: AppSettings) => {
      scheduling = { ...scheduling, ...(s.scheduling ?? {}) };
      onChange?.(s);
    },
  };
  return svc as SettingsService & { trigger: (s: AppSettings) => void };
}

function makeDeps(settings: SettingsService) {
  const dns = {
    runTest: vi.fn().mockResolvedValue({ testId: 'dns-1', results: [] }),
  } as unknown as DnsService;
  const gaming = {
    listGames: () => [{ id: 'valorant', name: 'VALORANT' }],
    runGameTest: vi.fn().mockResolvedValue({ testId: 'game-1' }),
  } as unknown as GamingService;
  const events = { record: vi.fn() };
  const log = { warn: vi.fn(), info: vi.fn() } as unknown as Logger;
  const bus = new RealtimeBus();
  return { dns, gaming, events, log, bus };
}

describe('ScheduleService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('disabled schedules nothing', () => {
    const settings = makeSettings();
    const deps = makeDeps(settings);
    const svc = new ScheduleService({ settings, ...deps });
    svc.start();

    expect(svc.statusSnapshot().dns.enabled).toBe(false);
    expect(svc.statusSnapshot().dns.nextRunAt).toBeNull();
    expect(svc.statusSnapshot().gaming.nextRunAt).toBeNull();
  });

  it('runs the DNS benchmark after the interval and reschedules', async () => {
    const settings = makeSettings({ dnsEnabled: true, dnsIntervalMin: 15 });
    const deps = makeDeps(settings);
    const svc = new ScheduleService({ settings, ...deps });
    svc.start();

    const statusMessages: { type: string; status: { dns: { lastResult: string | null; nextRunAt: number | null } } }[] = [];
    deps.bus.subscribe('schedule', (m) => statusMessages.push(m as never));

    expect(svc.statusSnapshot().dns.nextRunAt).not.toBeNull();
    await vi.advanceTimersByTimeAsync(15 * 60_000);

    expect(deps.dns.runTest).toHaveBeenCalledTimes(1);
    const st = svc.statusSnapshot().dns;
    expect(st.lastResult).toBe('ok');
    expect(st.running).toBe(false);
    expect(st.nextRunAt).not.toBeNull();
    expect(statusMessages.some((m) => m.status.dns.lastResult === 'ok')).toBe(true);
  });

  it('never stacks overlapping runs', async () => {
    const settings = makeSettings({ dnsEnabled: true, dnsIntervalMin: 15 });
    const deps = makeDeps(settings);
    let release!: () => void;
    (deps.dns.runTest as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => {
        release = () => resolve({ testId: 'slow', results: [] });
      }),
    );
    const svc = new ScheduleService({ settings, ...deps });
    svc.start();

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(deps.dns.runTest).toHaveBeenCalledTimes(1);
    expect(svc.statusSnapshot().dns.running).toBe(true);

    // interval passes while the run is still in flight — no second run starts
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(deps.dns.runTest).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(svc.statusSnapshot().dns.running).toBe(false);
    expect(svc.statusSnapshot().dns.nextRunAt).not.toBeNull();
  });

  it('records failures and still schedules the next run', async () => {
    const settings = makeSettings({ dnsEnabled: true, dnsIntervalMin: 15 });
    const deps = makeDeps(settings);
    (deps.dns.runTest as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network blocked'));
    const svc = new ScheduleService({ settings, ...deps });
    svc.start();

    await vi.advanceTimersByTimeAsync(15 * 60_000);

    const st = svc.statusSnapshot().dns;
    expect(st.lastResult).toBe('error');
    expect(st.lastError).toContain('network blocked');
    expect(st.nextRunAt).not.toBeNull();
    expect(deps.events.record).toHaveBeenCalled();
  });

  it('re-arms immediately when settings change', async () => {
    const settings = makeSettings({ dnsEnabled: true, dnsIntervalMin: 15 });
    const deps = makeDeps(settings);
    const svc = new ScheduleService({ settings, ...deps });
    svc.start();
    expect(svc.statusSnapshot().dns.nextRunAt).not.toBeNull();

    // simulate a PUT /settings that disables DNS scheduling
    settings.trigger({ scheduling: { dnsEnabled: false, dnsIntervalMin: 15, gamingEnabled: false, gamingIntervalMin: 60, gamingGameId: null } } as AppSettings);
    expect(svc.statusSnapshot().dns.nextRunAt).toBeNull();

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(deps.dns.runTest).not.toHaveBeenCalled();
  });

  it('gaming runs use the configured game and auto-pick fallback', async () => {
    const settings = makeSettings({ gamingEnabled: true, gamingIntervalMin: 15, gamingGameId: 'valorant' });
    const deps = makeDeps(settings);
    const svc = new ScheduleService({ settings, ...deps });
    svc.start();

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(deps.gaming.runGameTest).toHaveBeenCalledWith({ gameId: 'valorant' });

    // auto-pick when unset
    const settings2 = makeSettings({ gamingEnabled: true, gamingIntervalMin: 15, gamingGameId: null });
    const deps2 = makeDeps(settings2);
    const svc2 = new ScheduleService({ settings: settings2, ...deps2 });
    svc2.start();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(deps2.gaming.runGameTest).toHaveBeenCalledWith({ gameId: 'valorant' });
  });

  it('runNow triggers an immediate run', async () => {
    const settings = makeSettings();
    const deps = makeDeps(settings);
    const svc = new ScheduleService({ settings, ...deps });
    svc.start();

    const status = await svc.runNow('dns');
    expect(deps.dns.runTest).toHaveBeenCalledTimes(1);
    expect(status.dns.lastRunAt).not.toBeNull();
    expect(status.dns.lastResult).toBe('ok');
  });

  it('stop() clears timers', async () => {
    const settings = makeSettings({ dnsEnabled: true, dnsIntervalMin: 15 });
    const deps = makeDeps(settings);
    const svc = new ScheduleService({ settings, ...deps });
    svc.start();
    svc.stop();

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(deps.dns.runTest).not.toHaveBeenCalled();
  });
});