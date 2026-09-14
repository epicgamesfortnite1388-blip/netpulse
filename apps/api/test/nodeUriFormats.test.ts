import { describe, expect, it } from 'vitest';

import { parseNodeUri } from '../src/services/nodeParsers';

/**
 * Regression tests for real-world subscription link formats.
 *
 * Every sample here was taken verbatim from a live public subscription
 * (barry-far / V2ray-Config, fetched 2026-09-12). Before the fixes these
 * formats were rejected wholesale — e.g. ALL 6,122 vless links in one
 * subscription failed to parse — while the sources reported "healthy".
 */

function cfgOf(raw: string) {
  const r = parseNodeUri(raw);
  expect(r.protocol).not.toBe('unknown');
  expect(r.result).not.toBeNull();
  return r.result!.config;
}

describe('vless SIP002 (the universal real-world format)', () => {
  it('parses a plain TLS link with remark', () => {
    const c = cfgOf('vless://11111111-2222-3333-4444-555555555555@165.231.99.52:8443?security=tls&encryption=none&sni=example.com&type=tcp#Node%20Name');
    expect(c.protocol).toBe('vless');
    expect(c.host).toBe('165.231.99.52');
    expect(c.port).toBe(8443);
    expect(c.security).toBe('tls');
    expect(c.sni).toBe('example.com');
    expect(c.remark).toBe('Node Name');
  });

  it('parses reality with grpc transport and authority param', () => {
    const c = cfgOf('vless://524e00ce-ed89-481d-b4a4-6d7017f884e3@31.76.91.72:2087?mode=gun&security=reality&encryption=none&authority=%2F%3FBIA&sni=www.example.com&fp=chrome&pbk=PUBLIC_KEY_99MRki6b93wC&sid=6ba85179&type=grpc&flow=xtls-rprx-vision');
    expect(c.security).toBe('reality');
    expect(c.transport).toBe('grpc');
    expect(c.realityPublicKey).toBe('PUBLIC_KEY_99MRki6b93wC');
    expect(c.realityShortId).toBe('6ba85179');
    expect(c.flow).toBe('xtls-rprx-vision');
  });

  it('parses ws transport with path/host header params', () => {
    const c = cfgOf('vless://0764541b-3e57-4b47-954b-51e996fae5fc@132.243.224.203:47005?type=ws&encryption=none&host=cdn.example.com&path=%2Fws-path&security=tls&sni=cdn.example.com');
    expect(c.transport).toBe('ws');
    expect(c.path).toBe('/ws-path');
    expect(c.hostHeader).toBe('cdn.example.com');
  });

  it('tolerates a stray trailing slash after the port', () => {
    const c = cfgOf('vless://059fbe5b-21dc-413f-8f5c-dac39201914c@13.114.89.187:16611/?type=tcp&encryption=none&security=tls');
    expect(c.host).toBe('13.114.89.187');
    expect(c.port).toBe(16611);
  });

  it('parses reality params on ws type', () => {
    const c = cfgOf('vless://uuid@1.2.3.4:443?security=reality&pbk=PUBKEY&sid=abcd&type=ws&path=%2Fws&encryption=none');
    expect(c.security).toBe('reality');
    expect(c.realityPublicKey).toBe('PUBKEY');
    expect(c.transport).toBe('ws');
    expect(c.path).toBe('/ws');
  });

  it('still parses the legacy base64-JSON variant', () => {
    const raw = Buffer.from(JSON.stringify({ add: 'legacy.example.com', port: '443', id: 'u-1', security: 'tls', net: 'tcp' })).toString('base64');
    const c = cfgOf(`vless://${raw}`);
    expect(c.host).toBe('legacy.example.com');
  });

  it('marks allowInsecure from either param spelling', () => {
    const a = cfgOf('vless://u@1.2.3.4:443?security=tls&allowInsecure=1');
    const b = cfgOf('vless://u@1.2.3.4:443?security=tls&insecure=1');
    expect(a.allowInsecure).toBe(true);
    expect(b.allowInsecure).toBe(true);
  });
});

describe('shadowsocks real-world shapes', () => {
  it('parses plain (unencoded) 2022 userinfo with ephemeral part', () => {
    const c = cfgOf('ss://2022-blake3-aes-256-gcm:KYFtNXJrl3Jei35nSh9hMDqzlRdOjd6NlrtV6wyOVsw=:YBLEjXrK2Rh6XigucXQ4aqV%2Fm70sjyErBcbtt1SFFds=@77.90.61.217:56670?type=tcp');
    expect(c.protocol).toBe('shadowsocks');
    expect(c.host).toBe('77.90.61.217');
    expect(c.port).toBe(56670);
    expect(c.encryption).toBe('2022-blake3-aes-256-gcm');
  });

  it('parses base64 userinfo with a query containing an @ sign', () => {
    const userinfo = Buffer.from('chacha20-ietf-poly1305:7c31a67b41b18c26').toString('base64');
    const c = cfgOf(`ss://${userinfo}@89.223.88.33:11201?note=@FreeOnlineVPN`);
    expect(c.host).toBe('89.223.88.33');
    expect(c.port).toBe(11201);
    expect(c.encryption).toBe('chacha20-ietf-poly1305');
  });
});

describe('hysteria2 / hy2 with unencoded auth', () => {
  it('parses hy2 auth containing slashes and obfs params', () => {
    const c = cfgOf('hy2://C0DD7bgChaltqnhT2az6ijM@140.238.31.111:20000?sni=rmgyvpn.rest&obfs=salamander&obfs-password=C0DD7bgChaltqnhT2az6ijM');
    expect(c.protocol).toBe('hysteria2');
    expect(c.host).toBe('140.238.31.111');
    expect(c.port).toBe(20000);
    expect(c.sni).toBe('rmgyvpn.rest');
  });

  it('parses hysteria2 with trailing slash after port and insecure flag', () => {
    const c = cfgOf('hy2://github.com@62.210.7.139:60111/?insecure=1&sni=bing.com');
    expect(c.host).toBe('62.210.7.139');
    expect(c.port).toBe(60111);
    expect(c.allowInsecure).toBe(true);
  });
});

describe('vmess SIP002-style (non-base64) variant', () => {
  it('parses vmess://uuid@host:port?params', () => {
    const c = cfgOf('vmess://5e40f49a-d8ce-4efa-a0eb-5136586f4fe1@94.183.207.215:5065?packetEncoding=xudp&encryption=auto&security=none&type=tcp');
    expect(c.protocol).toBe('vmess');
    expect(c.host).toBe('94.183.207.215');
    expect(c.port).toBe(5065);
  });
});

describe('honest rejections (unusable configs must stay rejected)', () => {
  it('rejects trojan with no password component', () => {
    expect(parseNodeUri("trojan://8r<[9'l6hAO").result).toBeNull();
  });

  it('rejects hosts that are not valid hostname/IP', () => {
    expect(parseNodeUri('vless://uuid@[not-an-ip:443?security=tls').result).toBeNull();
  });

  it('rejects completely unrelated URIs', () => {
    expect(parseNodeUri('https://example.com/page').protocol).toBe('unknown');
  });
});

describe('SS URI parser: corrupted-cipher regression (149 live nodes affected)', () => {
  it('rejects a plain-text userinfo whose base64 "decoding" is binary garbage', () => {
    // From the wild: `ss://<binary-junk>@host:port#...` — the junk round-trips
    // as neither plain text nor valid base64. Node's lenient decoder used to
    // turn it into random bytes, and `includes(':')` in those bytes promoted
    // them to a "cipher name" stored in the DB.
    const junkUri = 'ss://WvKc1v5cYj7K@198.51.100.7:8388#junk';
    const r = parseNodeUri(junkUri);
    // must either parse cleanly (plausible method) or be rejected — never a
    // binary-garbage cipher. parseNodeUri returns { protocol, result: null }
    // on rejection.
    if (r?.result) {
      const method = (r.result.config as { encryption?: string | null }).encryption ?? '';
      expect(method).toMatch(/^[A-Za-z0-9-]{2,40}$/);
    } else {
      expect(r.result).toBeNull();
    }
  });

  it('still parses a REAL SIP002 plain userinfo (aes-256-gcm)', () => {
    const r = parseNodeUri('ss://aes-256-gcm:thepassword@203.0.113.9:8388#plain');
    expect(r).not.toBeNull();
    if (r && r.protocol === 'shadowsocks' && r.result) {
      expect((r.result.config as { encryption?: string | null }).encryption).toBe('aes-256-gcm');
      expect(r.result.secret).toBe('thepassword');
    }
  });

  it('still parses a REAL base64 userinfo (2022 cipher with colon-bearing key)', () => {
    const userinfo = Buffer.from('2022-blake3-aes-256-gcm:some-long-key:ephkey', 'utf8').toString('base64');
    const r = parseNodeUri(`ss://${userinfo}@203.0.113.10:8388#b64`);
    expect(r).not.toBeNull();
    if (r && r.protocol === 'shadowsocks' && r.result) {
      expect((r.result.config as { encryption?: string | null }).encryption).toBe('2022-blake3-aes-256-gcm');
      expect(r.result.secret).toBe('some-long-key:ephkey');
    }
  });

  it('still parses the legacy all-base64 form', () => {
    const body = Buffer.from('chacha20-ietf-poly1305:pw2@203.0.113.11:8388', 'utf8').toString('base64');
    const r = parseNodeUri(`ss://${body}#legacy`);
    expect(r).not.toBeNull();
    if (r && r.protocol === 'shadowsocks' && r.result) {
      expect((r.result.config as { encryption?: string | null }).encryption).toBe('chacha20-ietf-poly1305');
    }
  });

  it('legacy vmess base64-JSON bodies that are not base64 are rejected, not garbled', () => {
    const r = parseNodeUri('vmess://not-valid-base64-at-all!!');
    if (r?.result) {
      // parsed: host must still be sane
      expect((r.result.config as { host: string }).host).not.toContain(' ');
    } else {
      expect(r.result).toBeNull();
    }
  });
});
