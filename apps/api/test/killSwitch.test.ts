import { describe, expect, it } from 'vitest';

import { KillSwitchService, KILL_SWITCH_SINK } from '../src/services/killSwitch';
import { renderAetherRoutes } from '../src/vpn/aetherProvider';

import type { BypassRuleSet } from '@netpulse/shared';

/**
 * Kill-switch contracts (the \"when a proxy-mode tunnel drops\" rules):
 *   - armed + enabled + drop  → the system proxy is pointed at the sink, and
 *     `blocking` is true ONLY because the write actually succeeded
 *   - armed + disabled + drop → the user's own proxy is restored (direct access
 *     returns deliberately, never by accident)
 *   - stop while blocking      → the original proxy is put back
 *   - never armed              → nothing is ever written (a proxy the user owns
 *     must not be wiped by a service that never took it)
 *   - a failed write is reported honestly and never claims a block
 */

interface Recorded {
  writes: Array<string | null>;
}

function makeService(opts: { enabled?: boolean; bypass?: BypassRuleSet | null; writeOk?: boolean; current?: string | null; live?: boolean } = {}): {
  ks: KillSwitchService;
  rec: Recorded;
  /** what the OS currently points at (meaningful when `live` is set) */
  current: () => string | null;
} {
  const rec: Recorded = { writes: [] };
  // `live` models the OS: a write actually lands, so a later read sees it.
  // Without this the harness cannot express the state that broke restore —
  // after a drop the system proxy IS the sink we just wrote.
  let current = opts.current ?? null;
  const ks = new KillSwitchService({
    setSystemProxy: async (p) => {
      rec.writes.push(p);
      if (opts.writeOk === false) return { ok: false, error: 'registry write failed (ProxyEnable)' };
      if (opts.live) current = p;
      return { ok: true };
    },
    getSystemProxy: async () => ({ proxy: opts.live ? current : (opts.current ?? null) }),
    enabled: () => opts.enabled ?? true,
    bypass: () => opts.bypass ?? null,
  });
  return { ks, rec, current: () => current };
}

/** The sink clear on a route-mode re-arm is fire-and-forget; let it land. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('kill switch', () => {
  it('blocks non-bypassed traffic when an armed tunnel drops', async () => {
    const { ks, rec } = makeService({ enabled: true });
    ks.arm({ previousProxy: 'corp-proxy:8080', label: 'Aether live' });
    const status = await ks.onTunnelDropped('aether exited (code 1)');
    expect(rec.writes).toEqual([KILL_SWITCH_SINK]);
    expect(status.blocking).toBe(true);
    expect(status.armed).toBe(true);
    expect(status.reason).toBe('aether exited (code 1)');
    expect(status.note).toMatch(/ENGAGED/);
  });

  it('restores the user proxy on drop when the switch is off', async () => {
    const { ks, rec } = makeService({ enabled: false });
    ks.arm({ previousProxy: 'corp-proxy:8080', label: 'proxy tunnel' });
    const status = await ks.onTunnelDropped('core exited (code 7)');
    expect(rec.writes).toEqual(['corp-proxy:8080']);
    expect(status.blocking).toBe(false);
    expect(status.armed).toBe(false);
    expect(status.note).toMatch(/Kill switch is off/);
  });

  it('restores the original proxy when the user stops a blocked tunnel', async () => {
    const { ks, rec } = makeService({ enabled: true });
    ks.arm({ previousProxy: null, label: 'Aether live' });
    await ks.onTunnelDropped('aether exited (code 1)');
    expect(ks.status().blocking).toBe(true);
    const after = await ks.onTunnelStopped();
    expect(rec.writes).toEqual([KILL_SWITCH_SINK, null]);
    expect(after.blocking).toBe(false);
    expect(after.armed).toBe(false);
  });

  it('never writes a proxy it did not take over', async () => {
    const { ks, rec } = makeService({ enabled: true });
    await ks.onTunnelDropped('core exited (code 1)');
    await ks.onTunnelStopped();
    await ks.release('disabled in settings');
    expect(rec.writes).toEqual([]);
    expect(ks.status().armed).toBe(false);
  });

  it('reports a failed block honestly instead of claiming it', async () => {
    const { ks } = makeService({ enabled: true, writeOk: false });
    ks.arm({ previousProxy: 'corp-proxy:8080', label: 'Aether live' });
    const status = await ks.onTunnelDropped('aether exited (code 1)');
    expect(status.blocking).toBe(false);
    expect(status.note).toMatch(/could not apply its rule/);
    expect(status.note).toMatch(/NOT blocked/);
  });

  it('releases a live block when the user disables the switch', async () => {
    const { ks, rec } = makeService({ enabled: true });
    ks.arm({ previousProxy: 'corp-proxy:8080', label: 'Aether live' });
    await ks.onTunnelDropped('aether exited (code 1)');
    await ks.release('disabled in settings');
    expect(rec.writes).toEqual([KILL_SWITCH_SINK, 'corp-proxy:8080']);
    expect(ks.status().blocking).toBe(false);
  });

  it('names the exemptions from the live bypass rule set', async () => {
    const { ks } = makeService({
      enabled: true,
      bypass: { domains: ['bank.example.com'], ips: ['10.0.0.0/8'], ports: [25], lan: true },
    });
    ks.arm({ previousProxy: null, label: 'Aether live' });
    const status = await ks.onTunnelDropped('aether exited (code 1)');
    expect(status.bypassSummary).toBe('1 domain, 1 address, 1 port, LAN');
    expect(status.note).toContain('1 domain, 1 address, 1 port, LAN');
    expect(status.note).toMatch(/stay direct/);
  });

  it('claims no exemption when no bypass rules are active', async () => {
    const { ks } = makeService({ enabled: true, bypass: null });
    ks.arm({ previousProxy: null, label: 'Aether live' });
    const status = await ks.onTunnelDropped('aether exited (code 1)');
    expect(status.bypassSummary).toBeNull();
    expect(status.note).toMatch(/nothing is exempt/);
  });
});

describe('aether [direct] routes from the split-tunnel rule set', () => {
  it('renders domains, addresses, ports and LAN space', () => {
    const rules: BypassRuleSet = { domains: ['bank.example.com'], ips: ['10.0.0.0/8', '2001:db8::1'], ports: [25, 3000], lan: true };
    expect(renderAetherRoutes(rules)).toBe(
      '# Generated by NetPulse from the split-tunnel rule set — do not edit.\n[direct]\nprivate\nfull:bank.example.com\n10.0.0.0/8\n2001:db8::1\nport:25\nport:3000\n',
    );
  });

  it('omits an empty rule set rather than emitting an empty block', () => {
    expect(renderAetherRoutes({ domains: [], ips: [], ports: [], lan: false })).toBeNull();
    expect(renderAetherRoutes(null)).toBeNull();
  });
});

describe('kill switch route mode (TUN owns the default route)', () => {
  it('arms in route mode without writing the system proxy', async () => {
    const { ks, rec } = makeService({ enabled: true });
    const status = ks.arm({ previousProxy: null, label: 'proxy tunnel', mode: 'route' });
    expect(status.armed).toBe(true);
    expect(status.mode).toBe('route');
    expect(rec.writes).toEqual([]); // route mode touches nothing on arm
    expect(status.note).toMatch(/route mode/);
  });

  it('a TUN drop with the switch enabled fails closed at the sink instead of falling back to direct', async () => {
    const { ks, rec } = makeService({ enabled: true });
    ks.arm({ previousProxy: 'corp-proxy:8080', label: 'proxy tunnel', mode: 'route' });
    rec.writes.length = 0;
    const status = await ks.onTunnelDropped('TUN gateway exited unexpectedly (code 1)');
    expect(rec.writes).toEqual([KILL_SWITCH_SINK]);
    expect(status.blocking).toBe(true);
    expect(status.mode).toBe('route');
    expect(status.note).toMatch(/ENGAGED/);
    expect(status.note).toMatch(/system-proxy layer/);
  });

  it('a TUN drop with the switch disabled restores the user proxy (direct returns deliberately)', async () => {
    const { ks, rec } = makeService({ enabled: false });
    ks.arm({ previousProxy: 'corp-proxy:8080', label: 'proxy tunnel', mode: 'route' });
    rec.writes.length = 0;
    const status = await ks.onTunnelDropped('TUN gateway exited unexpectedly (code 1)');
    expect(rec.writes).toEqual(['corp-proxy:8080']);
    expect(status.blocking).toBe(false);
  });

  it('re-arming after reconnect clears an engaged sink (route mode)', async () => {
    const { ks, rec } = makeService({ enabled: true });
    ks.arm({ previousProxy: 'corp-proxy:8080', label: 'proxy tunnel', mode: 'route' });
    await ks.onTunnelDropped('TUN gateway exited unexpectedly (code 1)');
    rec.writes.length = 0;
    // reconnect brings the tunnel back with TUN verified
    const status = ks.arm({ previousProxy: 'corp-proxy:8080', label: 'proxy tunnel', mode: 'route' });
    expect(status.blocking).toBe(false);
    // a clean stop in route mode must clear a previously applied sink too
    await ks.onTunnelStopped();
    expect(rec.writes.filter((w) => w !== KILL_SWITCH_SINK)).toContain('corp-proxy:8080');
    expect(ks.status().armed).toBe(false);
  });

  it('clean stop in route mode with no sink applied writes nothing', async () => {
    const { ks, rec } = makeService({ enabled: true });
    ks.arm({ previousProxy: null, label: 'proxy tunnel', mode: 'route' });
    rec.writes.length = 0;
    await ks.onTunnelStopped();
    expect(rec.writes).toEqual([]);
    expect(ks.status().armed).toBe(false);
  });

  it('proxy mode keeps the original restore-on-stop contract', async () => {
    const { ks, rec } = makeService({ enabled: true });
    ks.arm({ previousProxy: 'corp-proxy:8080', label: 'Aether live' });
    expect(ks.status().mode).toBe('proxy');
    await ks.onTunnelStopped();
    expect(rec.writes).toContain('corp-proxy:8080');
  });
});

/**
 * The drop → watchdog heal → stop cycle, with the OS modelled truthfully.
 * Found live on the installed exe: after the watchdog re-armed a TUN capture,
 * the system proxy was left pointing at the kill switch's own sink
 * (`ProxyEnable=1, ProxyServer=127.0.0.1:9`) while the status reported
 * `armed: false, blocking: false` — every proxy-aware app on the machine was
 * cut off with nothing left to explain why.
 */
describe('kill switch survives a drop → heal → stop cycle', () => {
  const live = (opts: { enabled: boolean; current?: string | null }) => makeService({ ...opts, live: true });

  it('a healed route-mode capture never adopts our own sink as the user setting', async () => {
    const { ks, rec, current } = live({ enabled: true });
    ks.arm({ previousProxy: null, label: 'proxy tunnel', mode: 'route' });
    await ks.onTunnelDropped('TUN gateway exited unexpectedly (code 1)');
    expect(rec.writes).toEqual([KILL_SWITCH_SINK]);
    expect(current()).toBe(KILL_SWITCH_SINK);

    // The watchdog heals: the tunnel re-arms with whatever the app READS now,
    // which is the sink this service wrote.
    const status = ks.arm({ previousProxy: KILL_SWITCH_SINK, label: 'proxy tunnel', mode: 'route' });
    await flush();

    expect(status.previousProxy).toBeNull(); // the user's real setting, not the sink
    expect(status.armed).toBe(true);
    expect(status.mode).toBe('route');
    expect(current()).toBeNull(); // the re-arm cleared the sink

    await ks.onTunnelStopped();
    expect(current()).toBeNull(); // stop leaves the machine as it found it
    expect(ks.status().armed).toBe(false);
    expect(rec.writes.at(-1)).toBeNull();
  });

  it('gives back the user\u2019s own proxy through the same cycle', async () => {
    const { ks, rec, current } = live({ enabled: true, current: 'corp-proxy:8080' });
    ks.arm({ previousProxy: 'corp-proxy:8080', label: 'proxy tunnel', mode: 'route' });
    await ks.onTunnelDropped('TUN gateway exited unexpectedly (code 1)');
    const status = ks.arm({ previousProxy: KILL_SWITCH_SINK, label: 'proxy tunnel', mode: 'route' });
    await flush();

    expect(status.previousProxy).toBe('corp-proxy:8080');
    expect(current()).toBe('corp-proxy:8080'); // the heal restored it, not the sink

    await ks.onTunnelStopped();
    expect(current()).toBe('corp-proxy:8080');
    expect(rec.writes.at(-1)).toBe('corp-proxy:8080');
    expect(rec.writes.filter((w) => w === KILL_SWITCH_SINK)).toHaveLength(1);
  });

  it('a first arm that reads our stale sink never makes it the value to restore', async () => {
    // A previous session died while blocking: no hold in memory, sink on disk.
    const { ks } = live({ enabled: true, current: KILL_SWITCH_SINK });
    const status = ks.arm({ previousProxy: KILL_SWITCH_SINK, label: 'proxy tunnel', mode: 'route' });
    expect(status.previousProxy).toBeNull();
  });
});

/**
 * Force-kill cleanup guard (boot recovery): every proxy write is covered by a
 * persisted hold record, so the next boot can undo it no matter how the last
 * session ended. The sink case was already covered; the guard extends to the
 * ordinary handoff a force-kill leaves behind (observed live: a killed app
 * left ProxyEnable=1 → 127.0.0.1:<port> with nothing listening, breaking
 * every proxy-honoring app on the machine with no process to explain why).
 */
describe('force-kill cleanup guard (recoverAfterRestart)', () => {
  interface Rec { writes: Array<string | null>; events: string[]; saved: unknown[] }
  function makeRecoverable(opts: { hold: { previousProxy: string | null; label: string; blocking: boolean } | null; current: string | null }) {
    const rec: Rec = { writes: [], events: [], saved: [] };
    let current = opts.current;
    let persisted = opts.hold;
    const ks = new KillSwitchService({
      setSystemProxy: async (p) => { rec.writes.push(p); current = p; return { ok: true }; },
      getSystemProxy: async () => ({ proxy: current }),
      enabled: () => false,
      bypass: () => null,
      event: (level, message) => rec.events.push(`${level}: ${message}`),
      loadHold: () => persisted,
      saveHold: (record) => { persisted = record; rec.saved.push(record); },
    });
    return { ks, rec, current: () => current };
  }

  it('restores the captured setting when a force-kill left a dead handoff', async () => {
    // Last session: user had NO proxy, tunnel handed off to 127.0.0.1:54179,
    // process was force-killed. The dead port is still on disk.
    const { ks, rec } = makeRecoverable({ hold: { previousProxy: null, label: 'proxy tunnel', blocking: false }, current: '127.0.0.1:54179' });
    await ks.recoverAfterRestart();
    expect(rec.writes).toEqual([null]);
    expect(rec.events.some((e) => e.startsWith('info: Stale system-proxy handoff recovered'))).toBe(true);
    expect(rec.saved.at(-1)).toBeNull(); // record consumed
  });

  it('restores the user proxy when the handoff hid it', async () => {
    const { ks, rec } = makeRecoverable({ hold: { previousProxy: 'corp-proxy:8080', label: 'proxy tunnel', blocking: false }, current: '127.0.0.1:9999' });
    await ks.recoverAfterRestart();
    expect(rec.writes).toEqual(['corp-proxy:8080']);
  });

  it('never stomps a proxy owned by someone else after our death', async () => {
    // After our force-kill, another tool (or the user) set a non-loopback
    // proxy. Our captured value must NOT overwrite it.
    const { ks, rec } = makeRecoverable({ hold: { previousProxy: 'corp-proxy:8080', label: 'proxy tunnel', blocking: false }, current: '10.0.0.2:3128' });
    await ks.recoverAfterRestart();
    expect(rec.writes).toEqual([]);
    expect(rec.saved.at(-1)).toBeNull();
  });

  it('writes nothing when a clean shutdown already restored the value', async () => {
    const { ks, rec } = makeRecoverable({ hold: { previousProxy: 'corp-proxy:8080', label: 'proxy tunnel', blocking: false }, current: 'corp-proxy:8080' });
    await ks.recoverAfterRestart();
    expect(rec.writes).toEqual([]);
    expect(rec.saved.at(-1)).toBeNull();
  });

  it('still repairs the fail-closed sink case', async () => {
    const { ks, rec } = makeRecoverable({ hold: { previousProxy: 'corp-proxy:8080', label: 'proxy tunnel', blocking: true }, current: KILL_SWITCH_SINK });
    await ks.recoverAfterRestart();
    expect(rec.writes).toEqual(['corp-proxy:8080']);
    expect(rec.events.some((e) => e.startsWith('warn: Kill switch state recovered'))).toBe(true);
  });

  it('does nothing without a persisted record', async () => {
    const { ks, rec } = makeRecoverable({ hold: null, current: '127.0.0.1:54179' });
    await ks.recoverAfterRestart();
    expect(rec.writes).toEqual([]);
    expect(rec.events).toEqual([]);
  });
});
