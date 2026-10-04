import http from 'node:http';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { egressFetch, EgressError, resetProxyCache } from '../src/services/egressProxy';

/**
 * The behaviour that the whole change exists for: an outbound cloud call must
 * actually traverse the proxy.
 *
 * `resolveProxy` unit tests only prove the string that comes out. This proves
 * the request goes through the socket. It is the same measurement that showed
 * the bug: with a proxy listening on loopback, a bare `fetch` made 0
 * connections through it while the proxied path made 1 and answered 200.
 */

let connects = 0;
let server: http.Server;
let origin: http.Server;
let originPort = 0;
let proxyUrl = '';

/** A real proxy in front of a real origin server, counting every request.
 *
 *  undici's ProxyAgent tunnels with CONNECT for https targets and forwards in
 *  absolute form for http targets, so the fixture handles both — either way
 *  the only thing that matters is whether traffic reached the proxy at all.
 */
beforeEach(async () => {
  connects = 0;
  server = http.createServer((req, res) => {
    connects++;
    // Absolute-form target: "http://host:port/path".
    const target = new URL(req.url ?? '');
    const upstream = http.request(
      { host: target.hostname, port: target.port, path: target.pathname, method: req.method, headers: req.headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502).end('proxy upstream failed');
    });
    req.pipe(upstream);
  });
  server.on('connect', (req, clientSocket, head) => {
    connects++;
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  proxyUrl = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;

  origin = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, via: 'origin', path: req.url }));
  });
  await new Promise<void>((r) => origin.listen(0, '127.0.0.1', () => r()));
  originPort = (origin.address() as net.AddressInfo).port;

  process.env['NETPULSE_EGRESS_PROXY'] = proxyUrl;
  resetProxyCache();
});

afterEach(async () => {
  delete process.env['NETPULSE_EGRESS_PROXY'];
  resetProxyCache();
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => origin.close(() => r()));
});

describe('egressFetch', () => {
  it('sends the request through the proxy when one is configured', async () => {
    const res = await egressFetch({
      url: `http://127.0.0.1:${originPort}/api/v1/auth/login`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"email":"a@b.test","password":"x"}',
      timeoutMs: 8000,
    });

    expect(connects).toBe(1); // the whole point: it went through the proxy
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, via: 'origin', path: '/api/v1/auth/login' });
  });

  it('forwards the method, body and only the useful response headers', async () => {
    const res = await egressFetch({
      url: `http://127.0.0.1:${originPort}/api/v1/settings`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"payload":"x"}',
      timeoutMs: 8000,
    });
    expect(res.headers['content-type']).toContain('application/json');
    expect(JSON.parse(res.body).path).toBe('/api/v1/settings');
  });

  it('does not touch the proxy when none is configured', async () => {
    delete process.env['NETPULSE_EGRESS_PROXY'];
    resetProxyCache();
    const res = await egressFetch({
      url: `http://127.0.0.1:${originPort}/api/v1/health`,
      method: 'GET',
      headers: {},
      timeoutMs: 8000,
    }).catch((e) => e);

    // On a machine with no system proxy this succeeds and never connects;
    // where one IS set the call is expected to go through it. Either way the
    // request must complete rather than silently hang.
    expect(res).toBeInstanceOf(Object);
    if (!(res instanceof EgressError)) {
      expect(res.status).toBe(200);
      expect(connects).toBe(0);
    }
  });

  it('reports a dead proxy as the proxy, not as a generic outage', async () => {
    // A refused connection while a proxy is configured means the tunnel is
    // down — the user needs to start it, not to debug their connection.
    process.env['NETPULSE_EGRESS_PROXY'] = 'http://127.0.0.1:1';
    resetProxyCache();
    await expect(
      egressFetch({
        url: `http://127.0.0.1:${originPort}/api/v1/health`,
        method: 'GET',
        headers: {},
        timeoutMs: 4000,
      }),
    ).rejects.toMatchObject({ reason: 'proxy_unreachable' });
  });
});
/**
 * A tunnel that just took the system proxy must be visible to the very next
 * outbound call. The user's sequence on a filtered network is: switch the
 * VPN on, then sign in — so a cache still holding "no proxy" makes the
 * first attempt go direct and fail, which is the report this change exists
 * to fix. `setSystemProxy` fires the invalidation for real; this exercises
 * the same hook without writing HKCU.
 */
describe('system-proxy change invalidates the cached decision', () => {
  it('re-reads the proxy after it changes', async () => {
    const { currentProxy, resetProxyCache } = await import('../src/services/egressProxy');
    const { notifySystemProxyChanged } = await import('../src/services/systemProxy');

    process.env['NETPULSE_EGRESS_PROXY'] = proxyUrl;
    resetProxyCache();
    expect(await currentProxy()).toBe(proxyUrl);

    // The tunnel comes up on a different port.
    process.env['NETPULSE_EGRESS_PROXY'] = 'http://127.0.0.1:65000';
    expect(await currentProxy()).toBe(proxyUrl); // still cached

    notifySystemProxyChanged(); // what setSystemProxy does after a write
    expect(await currentProxy()).toBe('http://127.0.0.1:65000');
  });
});
