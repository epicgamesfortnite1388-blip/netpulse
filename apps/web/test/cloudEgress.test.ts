import { describe, expect, it } from 'vitest';

import { describeEgressFailure } from '../src/lib/cloud/client';

/**
 * The message a user reads when the cloud cannot be reached.
 *
 * The old copy was "Could not reach the cloud service — check your connection".
 * That is not just vague, it is actively wrong for the most common cause: the
 * cloud is filtered on this network and the user already has a tunnel — the app
 * just was not using it. Sending them to check their connection sent them to
 * debug the thing that already worked. Each case must name what to do.
 */
describe('describeEgressFailure', () => {
  it('names the proxy and tells the user to start it', () => {
    const msg = describeEgressFailure('proxy_unreachable', 'proxy: http://127.0.0.1:2080');
    expect(msg).toContain('127.0.0.1:2080');
    expect(msg).toMatch(/turn the tunnel on|start your proxy/i);
    // The failure mode this whole change exists to prevent.
    expect(msg).not.toMatch(/check your connection/i);
  });

  it('distinguishes a timeout through a proxy from a filtered host', () => {
    expect(describeEgressFailure('timeout', 'proxy: http://127.0.0.1:2080')).toMatch(/207|in time/i);
    expect(describeEgressFailure('timeout', undefined)).toMatch(/blocked or slow/i);
  });

  it('explains a TLS rejection as filtering and points at the VPN', () => {
    const msg = describeEgressFailure('tls_failed', undefined);
    expect(msg).toMatch(/filtered/i);
    expect(msg).toMatch(/vpn|tunnel/i);
  });

  it('explains the SOCKS limitation instead of failing silently', () => {
    const msg = describeEgressFailure('socks_unsupported', undefined);
    expect(msg).toMatch(/socks/i);
    expect(msg).toMatch(/TUN|HTTP proxy/i);
  });

  it('falls back to actionable advice for an unclassified failure', () => {
    const msg = describeEgressFailure('http_502', undefined);
    expect(msg).toMatch(/blocked or offline/i);
    expect(msg).toMatch(/VPN|tunnel/i);
    expect(msg).not.toMatch(/check your connection/i);
  });

  it('survives a missing proxy hint on the proxy reason', () => {
    const msg = describeEgressFailure('proxy_unreachable', undefined);
    expect(msg.length).toBeGreaterThan(20);
    expect(msg).not.toContain('undefined');
  });
});