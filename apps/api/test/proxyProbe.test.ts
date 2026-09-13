import { describe, expect, it } from 'vitest';

import { buildNodeOutbound, proxyProbe } from '../src/services/proxyProbe';

import type { ParsedNodeConfig } from '@netpulse/shared';

function base(overrides: Partial<ParsedNodeConfig> = {}): ParsedNodeConfig {
  return {
    protocol: 'vless',
    host: '203.0.113.10',
    port: 443,
    transport: 'tcp',
    security: 'tls',
    sni: 'example.com',
    alpn: [],
    fingerprint: null,
    flow: null,
    alterId: null,
    path: null,
    hostHeader: null,
    serviceName: null,
    allowInsecure: false,
    encryption: null,
    ssrProtocol: null,
    remark: null,
    ...overrides,
  } as ParsedNodeConfig;
}

describe('buildNodeOutbound', () => {
  it('builds a vless+tls outbound with placeholder secret', () => {
    const o = buildNodeOutbound(base()) as Record<string, unknown>;
    expect(o['type']).toBe('vless');
    expect(o['server']).toBe('203.0.113.10');
    expect(o['server_port']).toBe(443);
    expect(o['uuid']).toBe('<secret>');
    const tls = o['tls'] as Record<string, unknown>;
    expect(tls['enabled']).toBe(true);
    expect(tls['server_name']).toBe('example.com');
    expect(tls['insecure']).toBe(false);
  });

  it('uses reality block when reality public key present', () => {
    const o = buildNodeOutbound(base({ security: 'reality', realityPublicKey: 'pubkey', realityShortId: 'abcd' })) as Record<string, unknown>;
    const tls = o['tls'] as Record<string, unknown>;
    expect((tls['reality'] as Record<string, unknown>)['public_key']).toBe('pubkey');
    expect(tls['utls']).toBeUndefined();
  });

  it('maps ws transport with path', () => {
    const o = buildNodeOutbound(base({ transport: 'ws', path: '/ws' })) as Record<string, unknown>;
    expect((o['transport'] as Record<string, unknown>)['type']).toBe('ws');
    expect((o['transport'] as Record<string, unknown>)['path']).toBe('/ws');
  });

  it('maps shadowsocks method+password and normalizes ssr', () => {
    const o = buildNodeOutbound(base({ protocol: 'shadowsocks', encryption: 'chacha20-ietf-poly1305' })) as Record<string, unknown>;
    expect(o['method']).toBe('chacha20-ietf-poly1305');
    expect(o['password']).toBe('<secret>');
    const ssr = buildNodeOutbound(base({ protocol: 'shadowsocksr', encryption: 'aes-256-cfb' })) as Record<string, unknown>;
    expect(ssr['type']).toBe('shadowsocks');
  });

  it('omits tls block for plain tcp vless', () => {
    const o = buildNodeOutbound(base({ security: 'none', sni: null })) as Record<string, unknown>;
    expect(o['tls']).toBeUndefined();
  });

  it('never embeds a real secret in the built config', () => {
    const o = buildNodeOutbound(base()) as Record<string, unknown>;
    expect(JSON.stringify(o)).not.toContain('real-password');
  });
});

describe('proxyProbe failure classification (honest results)', () => {
  it('refuses unsupported protocols without spawning anything', async () => {
    const r = await proxyProbe(base({ protocol: 'wireguard' }), { secret: null, timeoutMs: 1000 });
    expect(r.status).toBe('failed');
    expect(r.failureKind).not.toBe('engine_unavailable');
    expect(r.error).toContain('not proxy-testable');
  });

  it('classifies missing engine as engine_unavailable (no fake success)', async () => {
    // sing-box is not installed in the test environment; the probe must fail
    // honestly rather than fabricate a result.
    const r = await proxyProbe(base(), { secret: null, timeoutMs: 15_000 });
    expect(r.status).toBe('failed');
    expect(r.latencyMs).toBeNull();
    expect(r.httpStatus).toBeNull();
    expect(['engine_unavailable', 'engine_start_failed']).toContain(r.failureKind);
  }, 20_000);

  it('rejects invalid test URLs', async () => {
    const r = await proxyProbe(base(), { secret: null, testUrl: 'not a url', timeoutMs: 1000 });
    expect(r.status).toBe('failed');
    expect(r.failureKind).toBe('target_failed');
    expect(r.error).toContain('invalid test URL');
  });
});
