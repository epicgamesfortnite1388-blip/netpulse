/**
 * Regression tests for the tunnel DNS chokepoint.
 *
 * These pin two fail-closed properties that were previously broken:
 *   1. setPolicy({ mode: 'block' }) is authoritative. It used to be ignored
 *      after forceTunnelDns(), so the policy resolved as 'tunnel' (fail-open).
 *   2. A tunnel answer with no address in the requested family must reject,
 *      not build { address: undefined }.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/vpn/aetherProvider', () => ({
  resolveThroughTunnel: vi.fn(),
}));

import { resolveThroughTunnel } from '../src/vpn/aetherProvider';
import { tunnelDns } from '../src/services/tunnelDns';

const mockResolve = vi.mocked(resolveThroughTunnel);

beforeEach(() => {
  vi.clearAllMocks();
  tunnelDns.allowDirectDns();
});

describe('tunnel DNS policy is authoritative', () => {
  it('setPolicy(block) overrides a prior forced tunnel instead of being ignored', () => {
    tunnelDns.forceTunnelDns(1819);
    expect(tunnelDns.getPolicy().mode).toBe('tunnel');

    tunnelDns.setPolicy({ mode: 'block' });
    expect(tunnelDns.getPolicy().mode).toBe('block');
  });

  it('block mode rejects without touching the network', async () => {
    tunnelDns.setPolicy({ mode: 'block' });
    await expect(tunnelDns.resolve4('example.test')).rejects.toThrow(/blocked/i);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('direct mode after a forced tunnel no longer resolves through the tunnel', () => {
    tunnelDns.forceTunnelDns(1819);
    tunnelDns.setPolicy({ mode: 'direct' });
    expect(tunnelDns.getPolicy()).toEqual({ mode: 'direct' });
  });
});

describe('tunnel DNS never fabricates an address', () => {
  it('rejects when the tunnel returns only IPv6 for an IPv4 lookup', async () => {
    mockResolve.mockResolvedValue({ addresses: ['2001:db8::1'], elapsedMs: 1 });
    tunnelDns.forceTunnelDns(1819);

    await expect(tunnelDns.lookup('example.test', { family: 4 })).rejects.toThrow(/no IPv4/i);
  });

  it('rejects when the tunnel returns only IPv4 for an IPv6 lookup', async () => {
    mockResolve.mockResolvedValue({ addresses: ['203.0.113.7'], elapsedMs: 1 });
    tunnelDns.forceTunnelDns(1819);

    await expect(tunnelDns.lookup('example.test', { family: 6 })).rejects.toThrow(/no IPv6/i);
  });

  it('returns a defined address when the requested family is present', async () => {
    mockResolve.mockResolvedValue({ addresses: ['203.0.113.7', '2001:db8::1'], elapsedMs: 1 });
    tunnelDns.forceTunnelDns(1819);

    await expect(tunnelDns.lookup('example.test', { family: 4 })).resolves.toEqual({
      address: '203.0.113.7',
      family: 4,
    });
    await expect(tunnelDns.lookup('example.test', { family: 6 })).resolves.toEqual({
      address: '2001:db8::1',
      family: 6,
    });
  });
});
