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

function makeService(opts: { enabled?: boolean; bypass?: BypassRuleSet | null; writeOk?: boolean; current?: string | null } = {}): {
  ks: KillSwitchService;
  rec: Recorded;
} {
  const rec: Recorded = { writes: [] };
  const ks = new KillSwitchService({
    setSystemProxy: async (p) => {
      rec.writes.push(p);
      return opts.writeOk === false ? { ok: false, error: 'registry write failed (ProxyEnable)' } : { ok: true };
    },
    getSystemProxy: async () => ({ proxy: opts.current ?? null }),
    enabled: () => opts.enabled ?? true,
    bypass: () => opts.bypass ?? null,
  });
  return { ks, rec };
}

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
