/**
 * SOCKS5 egress, end to end against a REAL SOCKS5 server.
 *
 * Why this is the test that matters: v2rayN's default listener is SOCKS on
 * 127.0.0.1:10808, so before SOCKS5 was implemented the app answered
 * `socks_unsupported` for a large share of the exact users in the bug report —
 * sign-in failed, just honestly. A unit test of the handshake cannot prove the
 * wiring; a real listener on loopback can: the request must arrive, and the
 * connection must have gone through the tunnel.
 *
 * The server here is a minimal RFC 1928 implementation — greeting, no-auth,
 * CONNECT — that counts the tunnels it opened. If resolution ever reverts to
 * refusing SOCKS, these tunnels drop to zero and the request fails.
 */
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { cert } from './fixtures/selfSignedCert';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { egressFetch, normalizeProxy, resolveProxy, resetProxyCache, SOCKS_UNSUPPORTED, socksTargetPort } from '../src/services/egressProxy';

/** A real SOCKS5 listener that opens tunnels and counts them. */
interface SocksFixture {
  port: number;
  tunnels: Array<{ host: string; port: number }>;
  close(): Promise<void>;
  /** Force every handshake to be refused, to prove failures stay named. */
  refuseNext(reply: number): void;
}

/**
 * A SOCKS5 listener. `auth` makes it demand username/password (RFC 1929) — a
 * normal v2rayN configuration — and `credentials` is what it will accept.
 */
async function startSocks5(
  auth: { username: string; password: string } | null = null,
  credentials: { username: string; password: string } | null = null,
): Promise<SocksFixture> {
  const tunnels: Array<{ host: string; port: number }> = [];
  let refusal: number | null = null;

  const server = net.createServer((socket) => {
    let stage: 'greeting' | 'auth' | 'request' | 'tunnelled' = 'greeting';
    let buf: Buffer = Buffer.alloc(0);

    const onData = (chunk: Buffer): void => {
      // Once the tunnel is up this socket carries plain HTTP; parsing it as a
      // second CONNECT would inject SOCKS bytes into the response stream.
      if (stage === 'tunnelled') return;
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greeting') {
        if (buf.length < 2) return;
        if (refusal !== null) {
          const reply = refusal;
          refusal = null;
          socket.end(Buffer.from([0x05, reply]));
          return;
        }
        const methods = buf.subarray(2, 2 + (buf[1] ?? 0));
        buf = buf.subarray(2 + (buf[1] ?? 0));
        if (auth) {
          if (!methods.includes(0x02)) {
            socket.end(Buffer.from([0x05, 0xff]));
            return;
          }
          socket.write(Buffer.from([0x05, 0x02]));
          stage = 'auth';
          return;
        }
        // Only "no authentication" is offered, which is what v2rayN serves.
        socket.write(Buffer.from([0x05, 0x00]));
        stage = 'request';
      }
      if (stage === 'auth') {
        if (buf.length < 2) return;
        const ulen = buf[1] ?? 0;
        if (buf.length < 2 + ulen + 1) return;
        const plen = buf[2 + ulen] ?? 0;
        if (buf.length < 3 + ulen + plen) return;
        const user = buf.subarray(2, 2 + ulen).toString('utf8');
        const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString('utf8');
        buf = buf.subarray(3 + ulen + plen);
        const ok = user === auth.username && pass === auth.password && credentials === null;
        socket.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
        if (!ok) return;
        stage = 'request';
      }
      if (buf.length < 5) return;
      if (buf[0] !== 0x05 || buf[1] !== 0x01 || buf[3] !== 0x03) {
        socket.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        return;
      }
      const nameLength = buf[4] ?? 0;
      if (buf.length < 5 + nameLength + 2) return;
      const host = buf.subarray(5, 5 + nameLength).toString('utf8');
      const port = (buf[5 + nameLength] ?? 0) * 256 + (buf[6 + nameLength] ?? 0);
      tunnels.push({ host, port });

      const upstream = net.connect(port, host, () => {
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        const rest = buf.subarray(5 + nameLength + 2);
        stage = 'tunnelled';
        socket.removeListener('data', onData);
        if (rest.length > 0) upstream.write(rest);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on('error', () => socket.destroy());
    };
    socket.on('data', onData);
    socket.on('error', () => undefined);
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    port: (server.address() as net.AddressInfo).port,
    tunnels,
    refuseNext: (reply: number) => {
      refusal = reply;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const ORIGIN = 'https://netpulse-cloud.shuridehradin.workers.dev';

describe('SOCKS5 egress', () => {
  let socks: SocksFixture;
  let origin: http.Server;
  let originUrl: string;
  let tunnelsSeen: () => number;

  beforeAll(async () => {
    socks = await startSocks5();
    origin = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
    await new Promise<void>((r) => origin.listen(0, '127.0.0.1', () => r()));
    originUrl = `http://127.0.0.1:${(origin.address() as net.AddressInfo).port}`;
    tunnelsSeen = () => socks.tunnels.length;
  });

  afterAll(async () => {
    await socks.close();
    await new Promise<void>((r) => origin.close(() => r()));
  });

  it('carries a request through a real SOCKS5 listener', async () => {
    const before = tunnelsSeen();
    process.env['NETPULSE_EGRESS_PROXY'] = `socks=127.0.0.1:${socks.port}`;
    resetProxyCache();
    try {
      const out = await egressFetch({
        // Plain http on purpose: it isolates the tunnel from TLS wrapping, so a
        // failure here is the handshake, not the certificate.
        url: `${originUrl}/api/v1/health`,
        method: 'GET',
        headers: {},
        timeoutMs: 10_000,
      });
      expect(out.status).toBe(200);
      expect(JSON.parse(out.body).ok).toBe(true);
      expect(tunnelsSeen(), 'the request must have opened a SOCKS tunnel').toBeGreaterThan(before);
      const tunnel = socks.tunnels.at(-1);
      expect(tunnel?.host).toBe('127.0.0.1');
      expect(tunnel?.port).toBe(Number(new URL(originUrl).port));
    } finally {
      delete process.env['NETPULSE_EGRESS_PROXY'];
      resetProxyCache();
    }
  });

  it('asks for the protocol default port when the URL names none', async () => {
    // Regression, found by the live run: a cloud URL has no explicit port, undici
    // passes an empty string, `Number('') === 0`, and the tunnel went to
    // `host:0` — a hang that surfaced as a plain timeout with no clue why.
    // The origin here is 127.0.0.1 (nothing listens on 443), so the request
    // cannot succeed; what matters is the port the tunnel ASKED for.
    const before = socks.tunnels.length;
    process.env['NETPULSE_EGRESS_PROXY'] = `socks=127.0.0.1:${socks.port}`;
    resetProxyCache();
    try {
      await egressFetch({ url: 'https://127.0.0.1/api/v1/health', method: 'GET', headers: {}, timeoutMs: 5_000 })
        .catch(() => undefined);
      const tunnel = socks.tunnels.at(-1);
      expect(tunnelsSeen()).toBeGreaterThan(before);
      expect(tunnel?.port, 'a URL with no port must ask for 443, never 0').toBe(443);
    } finally {
      delete process.env['NETPULSE_EGRESS_PROXY'];
      resetProxyCache();
    }
    // And the pure derivation behind it.
    expect(socksTargetPort('', 'https:')).toBe(443);
    expect(socksTargetPort(undefined, 'http:')).toBe(80);
    expect(socksTargetPort('1080', 'https:')).toBe(1080);
  });

  it('carries an HTTPS request through the tunnel, TLS and all', async () => {
    // Production only ever talks to the cloud over https, and the TLS wrap
    // lives inside our connector because undici applies none of its own. A
    // plain-http test would pass even if that step were deleted, so this one
    // exists to hold it: a self-signed origin stands in for the Worker, and
    // certificate checking is suspended for the length of the test only.
    const tlsOrigin = https.createServer({ ...cert }, (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, tls: true }));
    });
    await new Promise<void>((r) => tlsOrigin.listen(0, '127.0.0.1', () => r()));
    const tlsPort = (tlsOrigin.address() as net.AddressInfo).port;
    const previous = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    process.env['NETPULSE_EGRESS_PROXY'] = `socks=127.0.0.1:${socks.port}`;
    resetProxyCache();
    try {
      const out = await egressFetch({
        url: `https://127.0.0.1:${tlsPort}/api/v1/health`,
        method: 'GET',
        headers: {},
        timeoutMs: 10_000,
      });
      expect(out.status).toBe(200);
      expect(JSON.parse(out.body).tls).toBe(true);
      expect(socks.tunnels.at(-1)?.port).toBe(tlsPort);
    } finally {
      if (previous === undefined) delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
      else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = previous;
      delete process.env['NETPULSE_EGRESS_PROXY'];
      resetProxyCache();
      await new Promise<void>((r) => tlsOrigin.close(() => r()));
    }
  });

  it('authenticates against a password-protected listener when given a username and password', async () => {
    // RFC 1929. Credentials come from the proxy URL (the Windows system-proxy
    // setting cannot carry any), so this is what makes an authenticated v2rayN
    // usable rather than merely reported.
    const guarded = await startSocks5({ username: 'np', password: 's3cret' });
    process.env['NETPULSE_EGRESS_PROXY'] = `socks5://np:s3cret@127.0.0.1:${guarded.port}`;
    resetProxyCache();
    try {
      const out = await egressFetch({
        url: `${originUrl}/api/v1/health`,
        method: 'GET',
        headers: {},
        timeoutMs: 10_000,
      });
      expect(out.status).toBe(200);
      expect(guarded.tunnels.length, 'authentication must precede the tunnel').toBeGreaterThan(0);
    } finally {
      delete process.env['NETPULSE_EGRESS_PROXY'];
      resetProxyCache();
      await guarded.close();
    }
  });

  it('tells a password-protected listener apart from a broken one', async () => {
    // THE REGRESSION: the old message said "restart your proxy client", which
    // sends the user to restart something that is already running.
    const guarded = await startSocks5({ username: 'np', password: 's3cret' });
    process.env['NETPULSE_EGRESS_PROXY'] = `socks=127.0.0.1:${guarded.port}`;
    resetProxyCache();
    try {
      const err = await egressFetch({
        url: `${originUrl}/api/v1/health`,
        method: 'GET',
        headers: {},
        timeoutMs: 5_000,
      }).then(() => null, (e: unknown) => e);
      expect(err).not.toBeNull();
      const failure = err as { reason: string; message: string };
      expect(failure.reason).toBe('socks_failed');
      expect(failure.message).toMatch(/password/i);
      // It must name the real cause and the real remedy, not a restart.
      expect(failure.message).not.toMatch(/restart/i);
      expect(failure.message).not.toMatch(/check your socks port/i);
    } finally {
      delete process.env['NETPULSE_EGRESS_PROXY'];
      resetProxyCache();
      await guarded.close();
    }
  });

  it('reports wrong credentials as rejected, not as a broken listener', async () => {
    const guarded = await startSocks5({ username: 'np', password: 's3cret' });
    process.env['NETPULSE_EGRESS_PROXY'] = `socks5://np:wrong@127.0.0.1:${guarded.port}`;
    resetProxyCache();
    try {
      const err = await egressFetch({
        url: `${originUrl}/api/v1/health`,
        method: 'GET',
        headers: {},
        timeoutMs: 5_000,
      }).then(() => null, (e: unknown) => e);
      const failure = err as { reason: string; message: string };
      expect(failure.reason).toBe('socks_failed');
      expect(failure.message).toMatch(/rejected/i);
    } finally {
      delete process.env['NETPULSE_EGRESS_PROXY'];
      resetProxyCache();
      await guarded.close();
    }
  });

  it('resolves a v2rayN-style `socks=` system proxy to a usable SOCKS5 endpoint', () => {
    expect(normalizeProxy('socks=127.0.0.1:10808')).toBe('socks5://127.0.0.1:10808');
    expect(normalizeProxy('socks5://127.0.0.1:1080')).toBe('socks5://127.0.0.1:1080');
  });

  it('prefers the HTTP entry of a mixed list instead of handshaking for nothing', () => {
    expect(normalizeProxy('https=127.0.0.1:7890;socks=127.0.0.1:10808')).toBe('http://127.0.0.1:7890');
    expect(normalizeProxy('http=10.0.0.2:3128;socks=127.0.0.1:10808')).toBe('http://10.0.0.2:3128');
  });

  it('still names SOCKS4 rather than connecting direct behind the user', () => {
    expect(normalizeProxy('socks=127.0.0.1:1080') && normalizeProxy('socks4=127.0.0.1:1080')).toBe(SOCKS_UNSUPPORTED);
    expect(normalizeProxy('socks4://127.0.0.1:1080')).toBe(SOCKS_UNSUPPORTED);
  });

  it('reports a SOCKS listener that refuses the tunnel by name, not as a timeout', async () => {
    // Its own listener: a refusal can only be observed on a NEW connection, and
    // the dispatcher pools connections per proxy URL.
    const refusing = await startSocks5();
    refusing.refuseNext(0x05); // general SOCKS server failure
    process.env['NETPULSE_EGRESS_PROXY'] = `socks=127.0.0.1:${refusing.port}`;
    resetProxyCache();
    try {
      await expect(
        egressFetch({ url: `${originUrl}/api/v1/health`, method: 'GET', headers: {}, timeoutMs: 5_000 }),
      ).rejects.toMatchObject({ reason: 'socks_failed' });
    } finally {
      delete process.env['NETPULSE_EGRESS_PROXY'];
      resetProxyCache();
      await refusing.close();
    }
  });

  it('keeps the documented precedence: override, then system proxy, then env', () => {
    expect(resolveProxy({ override: 'socks=127.0.0.1:1', systemProxy: '127.0.0.1:2', env: {} })).toBe(
      'socks5://127.0.0.1:1',
    );
    expect(resolveProxy({ systemProxy: 'socks=127.0.0.1:10808', env: {} })).toBe('socks5://127.0.0.1:10808');
    expect(resolveProxy({ systemProxy: null, env: { HTTPS_PROXY: 'socks5://127.0.0.1:9' } })).toBe(
      'socks5://127.0.0.1:9',
    );
    expect(resolveProxy({ systemProxy: null, env: {} })).toBeNull();
    expect(ORIGIN.startsWith('https://')).toBe(true);
  });
});