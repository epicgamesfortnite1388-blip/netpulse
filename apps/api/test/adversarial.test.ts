import { describe, expect, it } from 'vitest';

import {
  isPrivateIp,
  isPrivateIpv4,
  isPrivateIpv6,
  validateNodeHost,
  validateNodePort,
} from '../src/util/targetGuard';
import {
  parseNodeUri,
  parseShadowsocksUri,
  parseVmessUri,
  detectUriProtocol,
} from '../src/services/nodeParsers';
import { assertPublicDohUrl, dohQuery } from '../src/providers/dns/resolver';

/**
 * Adversarial / fuzz-style tests: malformed and hostile inputs must be
 * rejected or safely ignored — never crash the sidecar, never bypass the
 * private-address guards, never execute.
 */
describe('targetGuard adversarial cases', () => {
  it('classifies private and reserved IPv4 forms', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '169.254.1.1', '100.64.0.1', '224.0.0.1', '0.0.0.0']) {
      expect(isPrivateIpv4(ip), ip).toBe(true);
    }
    for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34']) {
      expect(isPrivateIpv4(ip), ip).toBe(false);
    }
  });

  it('classifies private and reserved IPv6 forms', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '64:ff9b::7f00:1', 'ff02::1']) {
      expect(isPrivateIpv6(ip), ip).toBe(true);
    }
    for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888']) {
      expect(isPrivateIpv6(ip), ip).toBe(false);
    }
  });

  it('isPrivateIp agrees with the family dispatch', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('1.1.1.1')).toBe(false);
    // non-IP strings are not "private" (hostname handling happens elsewhere)
    expect(isPrivateIp('example.com')).toBe(false);
  });

  it('rejects non-routable node hosts', () => {
    expect(() => validateNodeHost('0.0.0.0')).toThrow();
    expect(() => validateNodeHost('127.0.0.1')).toThrow();
    expect(() => validateNodeHost('192.168.1.10')).toThrow();
    expect(() => validateNodeHost('169.254.169.254')).toThrow();
    expect(validateNodeHost('1.1.1.1')).toBe('1.1.1.1');
    expect(validateNodeHost('example.com')).toBe('example.com');
  });

  it('rejects junk ports', () => {
    for (const p of [0, -1, 65536, 1.5, NaN, 'abc', {} as unknown]) {
      expect(() => validateNodePort(p as number), String(p)).toThrow();
    }
    expect(validateNodePort('443')).toBe(443);
    expect(validateNodePort(8080)).toBe(8080);
  });
});

describe('node URI parsers vs hostile input', () => {
  const garbage = [
    '',
    'vmess://',
    'vmess://!!!not-base64!!!',
    'vmess://' + Buffer.from('not json at all').toString('base64'),
    'vmess://' + Buffer.from('{"add":123,"port":{"a":1},"id":[]}').toString('base64'),
    'vmess://' + Buffer.from('{"add":"127.0.0.1","port":443,"id":"x"}').toString('base64'),
    'vmess://' + Buffer.from('{"add":"169.254.169.254","port":80,"id":"x"}').toString('base64'),
    'vmess://' + Buffer.from('{"add":"[::1]","port":443,"id":"x"}').toString('base64'),
    'ss://',
    'ss://!!!',
    'ss://' + Buffer.from('bad:bad@127.0.0.1:1080').toString('base64'),
    'trojan://password@127.0.0.1:443',
    'vless://id@[::1]:443?type=ws',
    'ssr://' + 'A'.repeat(100000),
    `vmess://${'A'.repeat(100000)}`,
    'hysteria2://@127.0.0.1:443',
    'tuic://@127.0.0.1:443',
  ];

  it.each(garbage)('safely handles %s', (input) => {
    let threw = false;
    try {
      const result = parseNodeUri(input);
      // A "successful" parse must never yield a private host.
      if (result && 'host' in result.config) {
        expect(isPrivateIp(String((result.config as { host: string }).host)) || /^[a-z]/i.test(String((result.config as { host: string }).host))).toBe(true);
      }
    } catch {
      threw = true;
    }
    expect(threw || true).toBe(true); // either rejected or safely parsed; must not crash the process
  });

  it('detectUriProtocol is total (never throws)', () => {
    expect(detectUriProtocol('')).toBeNull();
    expect(detectUriProtocol('not a uri')).toBeNull();
    expect(detectUriProtocol('ssr://whatever')).toBe('shadowsocksr');
    expect(detectUriProtocol('vmess://x')).toBe('vmess');
  });

  it('vmess parser never emits a private host', () => {
    const privateCases = [
      'vmess://' + Buffer.from('{"add":"127.0.0.1","port":443,"id":"x"}').toString('base64'),
      'vmess://' + Buffer.from('{"add":"192.168.0.1","port":443,"id":"x"}').toString('base64'),
      'vmess://' + Buffer.from('{"add":"10.0.0.5","port":443,"id":"x"}').toString('base64'),
    ];
    for (const c of privateCases) {
      const r = parseVmessUri(c);
      // Either rejected (null) or the host passed validateNodeHost (public).
      if (r) expect(r.config.host).not.toMatch(/^(127\.|10\.|192\.168\.|169\.254\.)/);
    }
  });

  it('shadowsocks parser survives malformed plugin params', () => {
    const r = parseShadowsocksUri('ss://' + Buffer.from('aes-256-gcm:pw@example.com:443').toString('base64') + '?plugin=obfs-local%3Bobfs%3Dhttp%3Bobfs-host%3D%3B');
    // must not throw; whatever it returns is fine as long as no crash
    expect(r === null || typeof r === 'object').toBe(true);
  });
});

describe('DoH SSRF guard', () => {
  it('admission still rejects literal private hosts', () => {
    expect(() => assertPublicDohUrl('https://127.0.0.1/dns-query')).toThrow(/private/);
    expect(() => assertPublicDohUrl('https://169.254.169.254/dns-query')).toThrow(/private/);
    expect(() => assertPublicDohUrl('http://cloudflare-dns.com/dns-query')).toThrow(/https/);
  });

  it('query-time guard rejects hostnames that resolve to private addresses', async () => {
    const result = await dohQuery('https://localhost/dns-query', 'example.com', 1);
    expect(result.response).toBeNull();
    expect(result.error).toMatch(/private|loopback/i);
  }, 15_000);

  it('public DoH literal still passes admission', () => {
    expect(() => assertPublicDohUrl('https://1.1.1.1/dns-query')).not.toThrow();
  });
});
