import { describe, expect, it } from 'vitest';

import { buildTunGatewayConfig } from '../src/services/proxyCores';
import { tunGatewayStartRefusal, tunRouteExclusions } from '../src/services/proxyCores';

/**
 * TUN gateway contract (system-wide mode for every engine):
 *
 * The gateway is a sing-box core with a TUN inbound whose ONLY outbound is a
 * plain HTTP proxy pointed at the engine hop's inbound. That wiring is what
 * makes TUN work for xray/v2ray/hysteria (which have no TUN inbound at all):
 * one core owns route capture, the protocol engines stay proxy-only.
 *
 * Honesty rules the config must uphold:
 *   - loopback (the gateway's own dial to the hop) must be direct, never
 *     looped back through the TUN device
 *   - the gateway exposes its own verification inbound so the tunnel service
 *     can prove the TUN path with real traffic
 *   - split-tunnel bypass rules are honoured by the gateway too
 */
describe('buildTunGatewayConfig', () => {
  it('wires a TUN inbound + a verification mixed inbound + an http outbound to the hop', () => {
    const cfg = buildTunGatewayConfig(18931, 18932) as {
      inbounds: Array<{ type: string; listen_port?: number; auto_route?: boolean; address?: string[] }>;
      outbounds: Array<{ type: string; tag: string; server?: string; server_port?: number }>;
      route: { rules: Array<Record<string, unknown>> };
    };

    const tun = cfg.inbounds.find((i) => i.type === 'tun');
    expect(tun).toBeTruthy();
    expect(tun?.auto_route).toBe(true);

    const gw = cfg.inbounds.find((i) => i.type === 'mixed');
    expect(gw?.listen_port).toBe(18932);

    const hop = cfg.outbounds.find((o) => o.tag === 'engine-hop');
    expect(hop?.type).toBe('http');
    expect(hop?.server).toBe('127.0.0.1');
    expect(hop?.server_port).toBe(18931);
  });

  it('fronts a SOCKS5 inbound when that is what the engine speaks (Aether)', () => {
    // Aether serves SOCKS5 and nothing else, so an HTTP-typed outbound would
    // make TUN mode impossible for that engine. Same gateway, both protocols —
    // which is what "TUN for every engine" actually requires.
    const cfg = buildTunGatewayConfig(1819, 18933, { upstream: 'socks' }) as {
      outbounds: Array<{ type: string; tag: string; server_port?: number }>;
    };
    const hop = cfg.outbounds.find((o) => o.tag === 'engine-hop');
    expect(hop?.type).toBe('socks');
    expect(hop?.server_port).toBe(1819);

    // Default stays HTTP: the local cores expose a mixed/HTTP inbound.
    const httpCfg = buildTunGatewayConfig(1, 2) as { outbounds: Array<{ type: string; tag: string }> };
    expect(httpCfg.outbounds.find((o) => o.tag === 'engine-hop')?.type).toBe('http');
  });

  it('keeps loopback traffic out of the TUN device (no routing loop)', () => {
    const cfg = buildTunGatewayConfig(1, 2) as { route: { rules: Array<Record<string, unknown>> } };
    const loopback = cfg.route.rules.find((r) => r['ip_is_private'] === true);
    expect(loopback).toBeTruthy();
    expect(loopback?.['outbound']).toBe('direct');
  });

  it('passes split-tunnel bypass rules through to direct', () => {
    const cfg = buildTunGatewayConfig(1, 2, { bypass: { domains: ['internal.corp'], ips: ['10.0.0.0/8'], ports: [], lan: true } }) as {
      route: { rules: Array<Record<string, unknown>> };
      outbounds: Array<{ type: string; tag: string }>;
    };
    expect(cfg.outbounds.some((o) => o.tag === 'direct')).toBe(true);
    const rule = cfg.route.rules.find((r) => Array.isArray(r['domain_suffix']) && (r['domain_suffix'] as string[]).includes('internal.corp'));
    expect(rule?.['outbound']).toBe('direct');
  });
});

/**
 * The two defects a live TUN bring-up exposed (gateway up, route claimed, no
 * relay) — both visible in the gateway core's own log:
 *   `router: outbound not found: direct` on every private-address packet, and
 *   a name resolution that depended on the system resolver the device had just
 *   captured.
 */
describe('TUN gateway config the live run had to prove', () => {
  type Cfg = {
    dns?: { servers: Array<Record<string, unknown>>; final?: string };
    outbounds: Array<{ type: string; tag: string }>;
    route: { rules: Array<Record<string, unknown>>; final?: string; default_domain_resolver?: { server?: string } };
  };

  it('always defines the direct outbound its private-address rule points at', () => {
    // Without bypass rules configured the rule used to point at a tag nothing
    // defined: sing-box dropped those packets ("outbound not found: direct"),
    // including the device's own DNS, so the gateway relayed nothing.
    const cfg = buildTunGatewayConfig(1, 2) as unknown as Cfg;
    expect(cfg.outbounds.some((o) => o.tag === 'direct' && o.type === 'direct')).toBe(true);
    const privateRule = cfg.route.rules.find((r) => r['ip_is_private'] === true);
    expect(privateRule?.['outbound']).toBe('direct');
    // …and exactly once, even when bypass rules add their own direct traffic.
    const withBypass = buildTunGatewayConfig(1, 2, { bypass: { domains: ['internal.corp'], ips: [], ports: [], lan: true } }) as unknown as Cfg;
    expect(withBypass.outbounds.filter((o) => o.tag === 'direct').length).toBe(1);
  });

  it('resolves names itself, through the hop, never through the captured system resolver', () => {
    const cfg = buildTunGatewayConfig(18931, 18932) as unknown as Cfg;
    expect(cfg.dns?.servers.length).toBeGreaterThan(0);
    // Every server rides the hop: a local/undetoured server would answer outside
    // the tunnel and re-enter the device it was meant to serve.
    for (const server of cfg.dns?.servers ?? []) {
      expect(server['detour']).toBe('engine-hop');
    }
    expect(cfg.dns?.servers.some((s) => s['type'] === 'https')).toBe(true);
    expect(cfg.route.default_domain_resolver?.server).toBe(cfg.dns?.final);
    // The catch-all rides the hop too — never decided by outbound ordering.
    expect(cfg.route.final).toBe('engine-hop');
  });

  it('sniffs first, then hijacks the device\'s DNS queries', () => {
    const cfg = buildTunGatewayConfig(1, 2) as unknown as Cfg;
    expect(cfg.route.rules[0]?.['action']).toBe('sniff');
    const hijack = cfg.route.rules.findIndex((r) => r['action'] === 'hijack-dns');
    expect(hijack).toBeGreaterThan(0);
    // Hijacking before the private-address rule matters: that rule sends private
    // destinations direct, which would take the queries out of the tunnel.
    expect(hijack).toBeLessThan(cfg.route.rules.findIndex((r) => r['ip_is_private'] === true));
  });

  it('refuses a malformed resolver rather than emitting a broken one', () => {
    const cfg = buildTunGatewayConfig(1, 2, { resolver: { doh: 'not a url', plainFallback: '1.1.1.1' } }) as unknown as Cfg;
    expect(cfg.dns).toBeUndefined();
    expect(cfg.route.default_domain_resolver).toBeUndefined();
    // The rest of the gateway is still a working proxy path.
    expect(cfg.route.final).toBe('engine-hop');
    expect(cfg.route.rules.some((r) => r['ip_is_private'] === true)).toBe(true);
  });
});

describe('tunGatewayStartRefusal', () => {
  it('gives an actionable reason on a non-elevated Windows sidecar (or null when elevated/allowed)', () => {
    const refusal = tunGatewayStartRefusal();
    // On a dev machine this can legitimately be either: elevated shell → null,
    // or non-elevated → the fix-it message. Both are honest; a riddle is not.
    if (refusal !== null) {
      expect(refusal).toMatch(/administrator|elevated/i);
      expect(refusal).toMatch(/wintun|system-proxy/i);
    }
  });
});

/**
 * Route exclusions — the fix for the capture that broke relay on a real
 * machine: the device takes the default route, so the hop's own dial to the
 * node (a public address, which `ip_is_private` does not cover) was captured,
 * handed back to the gateway, and forwarded to the hop again — an endless loop
 * that relayed nothing while the default route was held.
 */
describe('TUN route exclusions', () => {
  const tunOf = (cfg: Record<string, unknown>) =>
    (cfg['inbounds'] as Array<Record<string, unknown>>).find((i) => i['type'] === 'tun');

  it('excludes the hop addresses given, de-duplicated', () => {
    const cfg = buildTunGatewayConfig(1, 2, { excludeAddresses: ['199.232.78.159/32', '2001:db8::1/128', '199.232.78.159/32'] }) as Record<string, unknown>;
    expect(tunOf(cfg)?.['route_exclude_address']).toEqual(['199.232.78.159/32', '2001:db8::1/128']);
    // Still a TUN inbound with route capture — excluding addresses must not
    // quietly disable the mode it is protecting.
    expect(tunOf(cfg)?.['auto_route']).toBe(true);
  });

  it('omits the field entirely when there is nothing to exclude', () => {
    expect('route_exclude_address' in (tunOf(buildTunGatewayConfig(1, 2) as Record<string, unknown>) ?? {})).toBe(false);
    expect('route_exclude_address' in (tunOf(buildTunGatewayConfig(1, 2, { excludeAddresses: [] }) as Record<string, unknown>) ?? {})).toBe(false);
  });
});

describe('tunRouteExclusions', () => {
  it('turns an IP host into a /32 and an IPv6 host into a /128', async () => {
    expect(await tunRouteExclusions(['199.232.78.159', '2001:db8::1'])).toEqual(['199.232.78.159/32', '2001:db8::1/128']);
  });

  it('resolves a domain host to the addresses it actually has', async () => {
    const resolved = await tunRouteExclusions(['node.example'], async () => ['203.0.113.7', '2001:db8::9']);
    expect(resolved).toEqual(['203.0.113.7/32', '2001:db8::9/128']);
  });

  it('contributes nothing for an unresolvable host rather than inventing an address', async () => {
    const resolved = await tunRouteExclusions(['gone.example'], async () => { throw new Error('ENOTFOUND'); });
    expect(resolved).toEqual([]);
  });

  it('ignores absent/blank hosts', async () => {
    expect(await tunRouteExclusions([null, undefined, '   '])).toEqual([]);
  });
});
