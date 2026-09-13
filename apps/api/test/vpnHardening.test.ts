import { describe, expect, it } from 'vitest';

import {
  parseWgInterfaceNames,
  wgTunnelNameForProfile,
} from '../src/vpn/vpnService';

describe('wireguard tunnel naming / parsing', () => {
  it('derives the tunnel name from the profile id (service name = config basename)', () => {
    expect(wgTunnelNameForProfile('abc-123')).toBe('netpulse-wg-abc-123');
    expect(wgTunnelNameForProfile('abc-123')).toMatch(/^netpulse-wg-/);
  });

  it('parses interface names from wg show all dump output', () => {
    const dump = [
      'netpulse-wg-x\tprivkey123=\t0\t0\t0\toff',
      'netpulse-wg-x\tPUBKEYPEER1=\t10.0.0.1:51820\tallowed\t1699999999\trx\ttx\tkeepalive',
      'my-own-tunnel\tprivkey456=\t0\t0\t0\toff',
      'my-own-tunnel\tPUBKEYPEER2=\t10.0.0.2:51820\tallowed\t1699999998\trx\ttx\tkeepalive',
      '',
    ].join('\n');
    const names = parseWgInterfaceNames(dump);
    expect(names.sort()).toEqual(['my-own-tunnel', 'netpulse-wg-x']);
  });

  it('returns empty for garbage output instead of throwing', () => {
    expect(parseWgInterfaceNames('')).toEqual([]);
    expect(parseWgInterfaceNames('not a dump\n\t\nno tabs here')).toEqual([]);
  });

  it('distinguishes managed from user-owned tunnels', () => {
    const dump = 'netpulse-wg-a\tprivkey=\t0\t0\t0\toff\nuser-tunnel\tprivkey=\t0\t0\t0\toff';
    const ours = parseWgInterfaceNames(dump).filter((n) => n.startsWith('netpulse-wg-'));
    expect(ours).toEqual(['netpulse-wg-a']);
  });
});
