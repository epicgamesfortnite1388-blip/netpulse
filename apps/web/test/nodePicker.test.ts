import { describe, expect, it } from 'vitest';

import { pickerNetwork, pickerPlace, pingMs, readPing, selectionConfirmation } from '../src/features/map/nodePicker';

import type { PublicNode } from '@netpulse/shared';

/**
 * The globe picker's presentation rules.
 *
 * The two that actually protect a user are here: a ping is shown only when
 * something measured one (and says which measurement), and the confirmation of a
 * selection cannot carry anything that could be reassembled into a config.
 */

function node(over: Partial<PublicNode>): PublicNode {
  return {
    id: 'n1',
    canonicalFingerprint: 'fp',
    protocol: 'vless',
    host: 'edge-ams-01.example.net',
    ipv4: ['203.0.113.7'],
    ipv6: [],
    port: 8443,
    transport: 'ws',
    security: 'reality',
    sni: 'www.example.com',
    alpn: ['h2'],
    fingerprint: 'chrome',
    flow: 'xtls-rprx-vision',
    alterId: null,
    path: '/ws',
    hostHeader: 'cdn.example.org',
    serviceName: null,
    allowInsecure: false,
    realityPublicKey: 'PUBKEY_99MRki6b93wC',
    realityShortId: 'ab12',
    realityServerName: 'www.example.com',
    encryption: null,
    ssrProtocol: null,
    remark: 'Amsterdam relay',
    sourceIds: ['src1'],
    sourceUrls: ['https://feeds.example/sub'],
    sourceCount: 1,
    firstSeen: 1,
    lastSeen: 2,
    lastValidated: 2,
    status: 'healthy',
    confidence: 'verified',
    country: 'NL',
    city: 'Amsterdam',
    asn: 9009,
    isp: 'FIBER',
    organization: null,
    lat: 52.37,
    lon: 4.9,
    geoSourceCount: 1,
    geoStatusReason: 'known',
    tags: [],
    favorite: false,
    userNotes: null,
    lastProxyMs: null,
    lastEngine: null,
    geoLastAttempt: null,
    lastTcpMs: null,
    lastTlsMs: null,
    testCount: 0,
    successCount: 0,
    failureCount: 0,
    consecutiveFailures: 0,
    recentTestCount: 0,
    recentSuccessCount: 0,
    recentFailureCount: 0,
    score: 0,
    reliabilityPct: 0,
    medianProxyMs: null,
    medianTcpMs: null,
    medianTlsMs: null,
    recentLossPct: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    ...over,
  } as PublicNode;
}

describe('readPing — what the panel is willing to claim', () => {
  it('prefers the median of recent proxy tests over a single last reading', () => {
    const r = readPing({ medianProxyMs: 84, lastProxyMs: 210, lastTcpMs: 40 });
    expect(r.ms).toBe(84);
    expect(r.basis).toBe('median-proxy');
    expect(r.value).toBe('84 ms');
    expect(r.degraded).toBe(false);
  });

  it('falls back to the last proxy test when there is no median yet', () => {
    const r = readPing({ medianProxyMs: null, lastProxyMs: 137, lastTcpMs: 30 });
    expect(r.basis).toBe('last-proxy');
    expect(r.value).toBe('137 ms');
  });

  it('marks a TCP handshake as weaker evidence than a proxy test', () => {
    const r = readPing({ medianProxyMs: null, lastProxyMs: null, lastTcpMs: 62 });
    expect(r.basis).toBe('last-tcp');
    expect(r.degraded).toBe(true);
    expect(r.basisLabel).toContain('not a proxy test');
  });

  it('reads "not measured" rather than 0 ms when nothing was ever probed', () => {
    const r = readPing({ medianProxyMs: null, lastProxyMs: null, lastTcpMs: null });
    expect(r.ms).toBeNull();
    expect(r.value).toBe('not measured');
    expect(r.basis).toBe('none');
  });

  it('keeps a decimal under 10 ms, matching the globe tooltip', () => {
    expect(pingMs(4.25)).toBe('4.3 ms');
    expect(pingMs(9.9)).toBe('9.9 ms');
    expect(pingMs(84.4)).toBe('84 ms');
  });
});

describe('picker location + network lines', () => {
  it('joins the parts that are actually known', () => {
    expect(pickerPlace({ city: 'Amsterdam', country: 'NL' })).toBe('Amsterdam, NL');
    expect(pickerPlace({ city: null, country: 'DE' })).toBe('DE');
    expect(pickerPlace({ city: null, country: null })).toBe('Location unknown');
  });

  it('prefers the ISP over the organization and includes the ASN', () => {
    expect(pickerNetwork({ isp: 'FIBER', organization: 'Fiber BV', asn: 9009 })).toBe('FIBER · AS9009');
    expect(pickerNetwork({ isp: null, organization: 'Fiber BV', asn: null })).toBe('Fiber BV');
    expect(pickerNetwork({ isp: null, organization: null, asn: null })).toBeNull();
  });
});

describe('selectionConfirmation — the user can tell what they got', () => {
  const n = node({});
  const text = (c: ReturnType<typeof selectionConfirmation>) => [c.title, ...c.lines].join('\n');

  it('names the profile, the place and the ping it just showed', () => {
    const c = selectionConfirmation({ profileName: 'Amsterdam relay', node: n, ping: readPing({ medianProxyMs: 84, lastProxyMs: 91, lastTcpMs: 40 }) });
    expect(c.title).toContain('Amsterdam relay');
    expect(c.lines.join(' ')).toContain('Amsterdam, NL');
    expect(c.lines.join(' ')).toContain('84 ms');
    expect(c.lines.join(' ')).toContain('median of recent proxy tests');
  });

  it('carries no host, port or connection parameter', () => {
    const c = selectionConfirmation({ profileName: 'Amsterdam relay', node: n, ping: readPing({ medianProxyMs: 84, lastProxyMs: 91, lastTcpMs: 40 }) });
    const out = text(c);
    // Everything below is on the node record and must NOT reach the confirmation.
    for (const leak of [n.host, 'edge-ams-01', '8443', '203.0.113.7', 'www.example.com', '/ws', 'cdn.example.org', 'PUBKEY_99MRki6b93wC', 'ab12', 'xtls-rprx-vision', 'h2', 'feeds.example']) {
      expect(out).not.toContain(leak);
    }
  });

  it('still confirms honestly when the node has no measurement', () => {
    const c = selectionConfirmation({ profileName: 'Unnamed relay', node: node({ city: null, country: null, isp: null, asn: null }), ping: readPing({}) });
    expect(c.title).toContain('Unnamed relay');
    expect(c.lines.join(' ')).toContain('Location unknown');
    expect(c.lines.join(' ')).toContain('not measured');
  });
});