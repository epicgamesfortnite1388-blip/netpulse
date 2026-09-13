import { describe, expect, it } from 'vitest';

import {
  buildSingboxConfig,
  materializeSingboxConfig,
  parseShadowsocksUri,
  parseTrojanUri,
  parseVlessUri,
  parseVmessUri,
  verifyConnect,
} from '../src/vpn/vpnService';

import type { VpnStatus } from '@netpulse/shared';

describe('parseVlessUri', () => {
  it('parses a plain TLS link', () => {
    const parsed = parseVlessUri('vless://11111111-2222-3333-4444-555555555555@example.com:443?security=tls&type=tcp#MyNode');
    expect(parsed).not.toBeNull();
    expect(parsed!.protocol).toBe('vless');
    expect(parsed!.host).toBe('example.com');
    expect(parsed!.port).toBe(443);
    expect(parsed!.secret).toBe('11111111-2222-3333-4444-555555555555');
    const outbound = parsed!.fields as { tls?: { enabled: boolean }; uuid: string };
    expect(outbound.uuid).toBe('11111111-2222-3333-4444-555555555555');
    expect(outbound.tls?.enabled).toBe(true);
  });

  it('parses reality + ws transport', () => {
    const parsed = parseVlessUri('vless://uuid@1.2.3.4:443?security=reality&pbk=PUBKEY&sid=abcd&type=ws&path=%2Fws&encryption=none#r');
    expect(parsed).not.toBeNull();
    const outbound = parsed!.fields as { tls?: { reality?: { public_key: string } }; transport?: { type: string; path: string } };
    expect(outbound.tls?.reality?.public_key).toBe('PUBKEY');
    expect(outbound.transport?.type).toBe('ws');
    expect(outbound.transport?.path).toBe('/ws');
  });

  it('rejects non-vless URIs and garbage', () => {
    expect(parseVlessUri('https://example.com')).toBeNull();
    expect(parseVlessUri('not a uri')).toBeNull();
  });
});

describe('parseVmessUri', () => {
  it('decodes base64 v2rayN JSON', () => {
    const raw = Buffer.from(JSON.stringify({
      v: '2', ps: 'Test', add: 'vm.example.com', port: '8443', id: 'uuid-1234',
      aid: '0', scy: 'auto', net: 'ws', type: 'none', host: 'cdn.example.com', path: '/ws', tls: 'tls',
    })).toString('base64');
    const parsed = parseVmessUri(`vmess://${raw}`);
    expect(parsed).not.toBeNull();
    expect(parsed!.protocol).toBe('vmess');
    expect(parsed!.host).toBe('vm.example.com');
    expect(parsed!.port).toBe(8443);
    expect(parsed!.secret).toBe('uuid-1234');
    const outbound = parsed!.fields as { transport?: { type: string }; tls?: { enabled: boolean } };
    expect(outbound.transport?.type).toBe('ws');
    expect(outbound.tls?.enabled).toBe(true);
  });

  it('rejects malformed base64', () => {
    expect(parseVmessUri('vmess://%%%not-base64%%%')).toBeNull();
  });
});

describe('parseTrojanUri', () => {
  it('parses password + sni', () => {
    const parsed = parseTrojanUri('trojan://pass-word@t.example.com:443?sni=real.example.com#T');
    expect(parsed).not.toBeNull();
    expect(parsed!.protocol).toBe('trojan');
    expect(parsed!.secret).toBe('pass-word');
    const outbound = parsed!.fields as { tls: { server_name: string } };
    expect(outbound.tls.server_name).toBe('real.example.com');
  });

  it('rejects links without a password', () => {
    expect(parseTrojanUri('trojan://@t.example.com:443#x')).toBeNull();
  });
});

describe('parseShadowsocksUri', () => {
  it('parses SIP002 user-info format', () => {
    const userinfo = Buffer.from('aes-256-gcm:secretpw').toString('base64');
    const parsed = parseShadowsocksUri(`ss://${userinfo}@1.2.3.4:8388#SS`);
    expect(parsed).not.toBeNull();
    expect(parsed!.protocol).toBe('shadowsocks');
    expect(parsed!.host).toBe('1.2.3.4');
    expect(parsed!.port).toBe(8388);
    expect(parsed!.secret).toBe('secretpw');
    const outbound = parsed!.fields as { method: string };
    expect(outbound.method).toBe('aes-256-gcm');
  });

  it('parses legacy fully-encoded format', () => {
    const body = Buffer.from('chacha20-ietf-poly1305:pw@5.6.7.8:9999').toString('base64');
    const parsed = parseShadowsocksUri(`ss://${body}`);
    expect(parsed).not.toBeNull();
    expect(parsed!.host).toBe('5.6.7.8');
    expect(parsed!.port).toBe(9999);
  });
});

describe('buildSingboxConfig', () => {
  it('creates a mixed-inbound single-outbound doc bound to loopback only', () => {
    const doc = buildSingboxConfig({ type: 'trojan', server: 'x', port: 443, password: 'p' }, { mixedPort: 2081 });
    const inbound = (doc['inbounds'] as { listen: string; listen_port: number }[])[0]!;
    expect(inbound.listen).toBe('127.0.0.1');
    expect(inbound.listen_port).toBe(2081);
    expect((doc['outbounds'] as unknown[]).length).toBe(1);
    expect((doc['route'] as { auto_detect_interface: boolean }).auto_detect_interface).toBe(true);
  });
});

describe('materializeSingboxConfig', () => {
  it('reinserts the credential per protocol type', () => {
    const cases: { type: string; field: string }[] = [
      { type: 'vless', field: 'uuid' },
      { type: 'vmess', field: 'uuid' },
      { type: 'trojan', field: 'password' },
      { type: 'shadowsocks', field: 'password' },
    ];
    for (const { type, field } of cases) {
      const doc = buildSingboxConfig({ type, server: 's', port: 1, [field]: '<stored in vault>' }, { mixedPort: 2080 });
      const out = JSON.parse(materializeSingboxConfig(JSON.stringify(doc), 'SECRET')) as { outbounds: Record<string, unknown>[] };
      expect(out.outbounds[0]![field]).toBe('SECRET');
    }
  });

  it('throws on a doc without outbounds', () => {
    expect(() => materializeSingboxConfig('{}', 'x')).toThrow();
  });
});

describe('verifyConnect behavior', () => {
  const baseStatus: VpnStatus = {
    connected: true, serverId: null, serverName: null, protocol: 'wireguard',
    since: null, supported: true, killSwitchActive: false, providerId: 'wireguard',
  };

  it('marks verified when the public IP changes', async () => {
    let call = 0;
    const status = await verifyConnect({ publicIpProbe: async () => (call++ === 0 ? '1.1.1.1' : '2.2.2.2') }, baseStatus);
    expect(status.verification).toBe('verified');
    expect(status.verifiedPublicIp).toBe('2.2.2.2');
    expect(status.previousPublicIp).toBe('1.1.1.1');
  });

  it('marks failed when the public IP is unchanged', async () => {
    const status = await verifyConnect({ publicIpProbe: async () => '1.1.1.1' }, baseStatus);
    expect(status.verification).toBe('failed');
  });

  it('marks unavailable when the post-connect probe cannot run', async () => {
    const status = await verifyConnect({ publicIpProbe: async () => { throw new Error('offline'); } }, baseStatus);
    expect(status.verification).toBe('unavailable');
  });

  it('skips verification for non-connected status', async () => {
    let called = false;
    const disconnected = { ...baseStatus, connected: false };
    const status = await verifyConnect({ publicIpProbe: async () => { called = true; return 'x'; } }, disconnected);
    expect(called).toBe(false);
    expect(status).toBe(disconnected); // returned untouched
  });
});
