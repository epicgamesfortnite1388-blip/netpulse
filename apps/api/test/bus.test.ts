import { describe, expect, it } from 'vitest';

import { RealtimeBus } from '../src/realtime/bus';

describe('RealtimeBus', () => {
  it('delivers messages to subscribers', () => {
    const bus = new RealtimeBus();
    const received: string[] = [];
    const unsub = bus.subscribe('t1', (m) => received.push(m.type as string));
    bus.publish('t1', { type: 'test:progress', pct: 40 });
    bus.publish('t1', { type: 'test:done' });
    expect(received).toEqual(['test:progress', 'test:done']);
    unsub();
  });

  it('replays the latest message to a late subscriber (fast-test race fix)', () => {
    const bus = new RealtimeBus();
    bus.publish('fast', { type: 'test:done', testId: 'fast', result: { ok: true } });

    const received: unknown[] = [];
    bus.subscribe('fast', (m) => received.push(m));
    expect(received).toHaveLength(1);
    expect((received[0] as { type: string }).type).toBe('test:done');
    expect((received[0] as { result: { ok: boolean } }).result.ok).toBe(true);
  });

  it('does not replay to the same subscriber that published (no duplicate on live subscribe)', () => {
    const bus = new RealtimeBus();
    const received: string[] = [];
    bus.subscribe('t2', (m) => received.push(m.type as string));
    bus.publish('t2', { type: 'test:done' });
    // the live listener got it once; a NEW late subscriber gets the replay once
    bus.subscribe('t2', (m) => received.push(`replay:${m.type}`));
    expect(received).toEqual(['test:done', 'replay:test:done']);
  });

  it('clears topics on clear()', () => {
    const bus = new RealtimeBus();
    bus.publish('gone', { type: 'test:done' });
    bus.clear();
    const received: unknown[] = [];
    bus.subscribe('gone', (m) => received.push(m));
    expect(received).toHaveLength(0);
  });
});