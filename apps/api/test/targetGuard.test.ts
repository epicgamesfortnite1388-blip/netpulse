import { describe, expect, it } from 'vitest';

import {
  familyOfIp,
  isPrivateIp,
  isPrivateIpv6,
  pickIp,
  resolveTarget,
} from '../src/util/targetGuard';

describe('isPrivateIp (IPv4)', () => {
  it('blocks loopback and private ranges', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '172.31.255.255', '169.254.1.1', '100.64.0.1', '224.0.0.1', '240.0.0.1', '0.0.0.0']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });
  it('allows public addresses', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '100.128.0.1', '9.9.9.9']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });
});

describe('isPrivateIpv6', () => {
  it('blocks loopback, ULA, link-local, multicast', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1']) {
      expect(isPrivateIpv6(ip), ip).toBe(true);
    }
  });
  it('allows global unicast', () => {
    for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888']) {
      expect(isPrivateIpv6(ip), ip).toBe(false);
    }
  });
});

describe('resolveTarget', () => {
  it('accepts public IP literals without DNS', async () => {
    const t = await resolveTarget('1.1.1.1');
    expect(t.ips).toEqual(['1.1.1.1']);
    expect(t.family).toBe(4);
  });

  it('rejects private IP literals', async () => {
    await expect(resolveTarget('192.168.1.1')).rejects.toMatchObject({
      code: 'private_target_not_allowed',
    });
    await expect(resolveTarget('127.0.0.1')).rejects.toMatchObject({
      code: 'private_target_not_allowed',
    });
    await expect(resolveTarget('::1')).rejects.toMatchObject({
      code: 'private_target_not_allowed',
    });
  });

  it('rejects hostnames that resolve to private addresses (localhost)', async () => {
    await expect(resolveTarget('localhost')).rejects.toMatchObject({
      code: 'private_target_not_allowed',
    });
  });

  it('rejects invalid characters and injection attempts', async () => {
    await expect(resolveTarget('1.1.1.1 -n 999')).rejects.toMatchObject({ code: 'invalid_target' });
    await expect(resolveTarget('a b.com')).rejects.toMatchObject({ code: 'invalid_target' });
    await expect(resolveTarget('')).rejects.toMatchObject({ code: 'invalid_target' });
  });

  it('rejects non-resolvable hostnames', async () => {
    await expect(resolveTarget('this-domain-does-not-exist-ever-xyz.invalid')).rejects.toMatchObject({
      code: 'dns_resolution_failed',
    });
  });
});

describe('pickIp / familyOfIp', () => {
  it('picks the requested family', () => {
    const ips = ['1.1.1.1', '2606:4700:4700::1111'];
    expect(pickIp(ips, 6)).toBe('2606:4700:4700::1111');
    expect(pickIp(ips, 4)).toBe('1.1.1.1');
    expect(familyOfIp('2606:4700:4700::1111')).toBe(6);
    expect(familyOfIp('1.1.1.1')).toBe(4);
  });
});
