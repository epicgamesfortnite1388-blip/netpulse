import { describe, expect, it } from 'vitest';

import { buildShareLink, isExportableProtocol } from '../src/services/nodeLinkExport';
import { parseNodeUri } from '../src/services/nodeParsers';

import type { LinkSourceNode } from '../src/services/nodeLinkExport';

/**
 * Node → share link contract.
 *
 * The export path used to emit literal templates (`vless://<password>@…`), so
 * every exported "config" was unusable. These tests hold the replacement to the
 * only property that matters: the app must be able to read back what it wrote,
 * with the same endpoint and the same credential.
 */

const UUID = 'b831381d-6324-4d53-ad4f-8cda48b30811';

function node(overrides: Partial<LinkSourceNode>): LinkSourceNode {
  return {
    protocol: 'vless',
    host: 'example.com',
    port: 443,
    transport: 'tcp',
    security: 'tls',
    sni: 'example.com',
    alpn: [],
    path: null,
    hostHeader: null,
    serviceName: null,
    flow: null,
    alterId: null,
    allowInsecure: false,
    realityPublicKey: null,
    realityShortId: null,
    realityServerName: null,
    encryption: null,
    remark: 'Test node',
    ...overrides,
  };
}

/** Every successful export must survive a round trip through the parser. */
function roundTrip(source: LinkSourceNode, secret: string) {
  const built = buildShareLink(source, secret);
  expect(built.ok).toBe(true);
  if (!built.ok) throw new Error('unreachable');
  const parsed = parseNodeUri(built.link);
  expect(parsed.protocol).toBe(source.protocol);
  expect(parsed.result).not.toBeNull();
  if (!parsed.result) throw new Error('unreachable');
  expect(parsed.result.config.host).toBe(source.host);
  expect(parsed.result.config.port).toBe(source.port);
  expect(parsed.result.secret).toBe(secret);
  return parsed.result.config;
}

describe('buildShareLink', () => {
  it('rebuilds a vless websocket + TLS node with its transport parameters', () => {
    const config = roundTrip(
      node({ transport: 'ws', path: '/ws?ed=2048', hostHeader: 'cdn.example.com', sni: 'cdn.example.com' }),
      UUID,
    );
    expect(config.transport).toBe('ws');
    expect(config.path).toBe('/ws?ed=2048');
    expect(config.hostHeader).toBe('cdn.example.com');
    expect(config.security).toBe('tls');
  });

  it('rebuilds a vless REALITY node with pbk/sid/sni', () => {
    const built = buildShareLink(
      node({
        security: 'reality',
        sni: 'www.microsoft.com',
        realityPublicKey: 'PBK-ABC',
        realityShortId: 'abcd',
        flow: 'xtls-rprx-vision',
      }),
      UUID,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error('unreachable');
    expect(built.link).toContain('security=reality');
    expect(built.link).toContain('pbk=PBK-ABC');
    expect(built.link).toContain('sid=abcd');
    const config = roundTrip(node({ security: 'reality', sni: 'www.microsoft.com', realityPublicKey: 'PBK-ABC', realityShortId: 'abcd', flow: 'xtls-rprx-vision' }), UUID);
    expect(config.security).toBe('reality');
    expect(config.realityPublicKey).toBe('PBK-ABC');
    expect(config.flow).toBe('xtls-rprx-vision');
  });

  it('rebuilds a vmess node as base64 JSON', () => {
    const built = buildShareLink(node({ protocol: 'vmess', transport: 'ws', path: '/v', hostHeader: 'h.example.com' }), UUID);
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error('unreachable');
    expect(built.link.startsWith('vmess://')).toBe(true);
    const config = roundTrip(node({ protocol: 'vmess', transport: 'ws', path: '/v', hostHeader: 'h.example.com' }), UUID);
    expect(config.protocol).toBe('vmess');
    expect(config.transport).toBe('ws');
  });

  it('rebuilds trojan, hysteria2 and tuic with their credentials', () => {
    roundTrip(node({ protocol: 'trojan', transport: 'tcp' }), 'super-secret-pw');
    const hy2 = roundTrip(node({ protocol: 'hysteria2', transport: 'udp', security: 'tls' }), 'hy2-pass');
    expect(hy2.protocol).toBe('hysteria2');
    const tuic = roundTrip(node({ protocol: 'tuic', transport: 'quic', security: 'tls', alpn: ['h3'] }), 'tuic-pass');
    expect(tuic.protocol).toBe('tuic');
  });

  it('rebuilds shadowsocks only when the cipher is known', () => {
    const withCipher = roundTrip(node({ protocol: 'shadowsocks', security: 'none', sni: null, transport: 'tcp', encryption: 'aes-256-gcm' }), 'ss-pass');
    expect(withCipher.encryption).toBe('aes-256-gcm');

    const withoutCipher = buildShareLink(node({ protocol: 'shadowsocks', security: 'none', sni: null, encryption: null }), 'ss-pass');
    expect(withoutCipher.ok).toBe(false);
    if (withoutCipher.ok) throw new Error('unreachable');
    expect(withoutCipher.reason).toMatch(/cipher/i);
  });

  it('refuses protocols that have no share link instead of inventing one', () => {
    for (const protocol of ['shadowsocksr', 'wireguard', 'unknown']) {
      const built = buildShareLink(node({ protocol }), UUID);
      expect(built.ok).toBe(false);
      if (built.ok) throw new Error('unreachable');
      expect(built.reason.length).toBeGreaterThan(10);
      expect(isExportableProtocol(protocol)).toBe(false);
    }
  });

  it('refuses when no credential is stored — an empty uuid would only fail later', () => {
    const built = buildShareLink(node({}), null);
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error('unreachable');
    expect(built.reason).toMatch(/credential/i);
  });

  it('keeps the remark as the link fragment and survives characters that need encoding', () => {
    const built = buildShareLink(node({ remark: 'NL #1 | fast & cheap' }), UUID);
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error('unreachable');
    const parsed = parseNodeUri(built.link);
    expect(parsed.result?.config.remark).toBe('NL #1 | fast & cheap');
  });

  it('refuses a link this app could not read back — an IPv6 literal host in a vless URI', () => {
    // The parser's SIP002 branch does not accept a bracketed IPv6 authority, so
    // exporting one would hand the user a config that only looks valid. The
    // round-trip check turns that into an honest refusal.
    const built = buildShareLink(node({ host: '2001:db8::1' }), UUID);
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error('unreachable');
    expect(built.reason).toMatch(/parse back/i);
  });
});
