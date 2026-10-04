import { describe, expect, it } from 'vitest';

import {
  assertCloudUrl,
  classify,
  cloudOrigin,
  normalizeProxy,
  resolveProxy,
  SOCKS_UNSUPPORTED,
} from '../src/services/egressProxy';

/**
 * The proxy decision lives in exactly one place because getting it wrong is
 * invisible: a bare fetch to a filtered host fails, and "check your connection"
 * sends the user to debug a tunnel that was working the whole time.
 *
 * These pin the *ordering* and the *classification*, which are the two things
 * that silently regress.
 */

describe('normalizeProxy', () => {
  it('treats an empty or missing value as no proxy', () => {
    for (const v of [null, undefined, '', '   ']) {
      expect(normalizeProxy(v)).toBeNull();
    }
  });

  it('adds a scheme to the bare host:port WinINET stores', () => {
    expect(normalizeProxy('127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
  });

  it('keeps an explicit http(s) scheme', () => {
    expect(normalizeProxy('http://10.0.0.5:3128')).toBe('http://10.0.0.5:3128');
    expect(normalizeProxy('https://proxy.internal:443')).toBe('https://proxy.internal:443');
  });

  it('picks https from a per-protocol WinINET value', () => {
    // Several clients (v2rayN among them) write this form rather than a bare
    // host:port. Reading it as a literal hostname would silently connect direct.
    expect(normalizeProxy('http=127.0.0.1:8080;https=127.0.0.1:8443')).toBe('http://127.0.0.1:8443');
    expect(normalizeProxy('http=127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
  });

  it('reports a SOCKS proxy instead of silently bypassing it', () => {
    expect(normalizeProxy('socks=127.0.0.1:1080')).toBe(SOCKS_UNSUPPORTED);
    expect(normalizeProxy('socks5://127.0.0.1:1080')).toBe(SOCKS_UNSUPPORTED);
    // undici has no SOCKS agent; quietly falling back to direct is the very
    // bug this module exists to remove.
    expect(normalizeProxy('socks=127.0.0.1:1080')).not.toBeNull();
  });
});

describe('resolveProxy', () => {
  const clean = {} as NodeJS.ProcessEnv;

  it('prefers the explicit override over everything', () => {
    expect(
      resolveProxy({
        override: 'http://127.0.0.1:9999',
        systemProxy: '127.0.0.1:8080',
        env: { HTTPS_PROXY: 'http://127.0.0.1:7777' },
      }),
    ).toBe('http://127.0.0.1:9999');
  });

  it('prefers the system proxy over env vars', () => {
    // The system proxy is what the app's own tunnel writes, and what an
    // external client writes — it is the user's live choice, so it wins.
    expect(
      resolveProxy({ systemProxy: '127.0.0.1:2080', env: { HTTPS_PROXY: 'http://127.0.0.1:7777' } }),
    ).toBe('http://127.0.0.1:2080');
  });

  it('falls back to env vars when no system proxy is set', () => {
    expect(resolveProxy({ systemProxy: null, env: { HTTPS_PROXY: 'http://127.0.0.1:7777' } })).toBe(
      'http://127.0.0.1:7777',
    );
    expect(resolveProxy({ systemProxy: null, env: { http_proxy: 'http://127.0.0.1:7778' } })).toBe(
      'http://127.0.0.1:7778',
    );
  });

  it('returns null for a direct connection when nothing is configured', () => {
    expect(resolveProxy({ systemProxy: null, env: clean })).toBeNull();
    expect(resolveProxy({ override: null, systemProxy: null, env: clean })).toBeNull();
  });
});

describe('classify', () => {
  it('blames the proxy when the proxy itself refused', () => {
    // The cloud was never contacted; telling the user to check their
    // connection sends them to debug the thing that already works.
    const e = classify({ cause: { code: 'ECONNREFUSED' } }, 'http://127.0.0.1:2080');
    expect(e.reason).toBe('proxy_unreachable');
    expect(e.message).toContain('127.0.0.1:2080');
    expect(e.proxy).toBe('http://127.0.0.1:2080');
  });

  it('does not blame the proxy for a direct refusal', () => {
    const e = classify({ cause: { code: 'ECONNREFUSED' } }, null);
    expect(e.reason).toBe('direct_unreachable');
    expect(e.proxy).toBeNull();
  });

  it('names a timeout as a timeout', () => {
    expect(classify({ name: 'AbortError' }, null).reason).toBe('timeout');
    expect(classify({ name: 'TimeoutError' }, 'http://127.0.0.1:2080').reason).toBe('timeout');
  });

  it('names a TLS rejection as filtering, which is what it usually is', () => {
    const e = classify({ cause: { code: 'CERT_HAS_EXPIRED' } }, null);
    expect(e.reason).toBe('tls_failed');
    expect(e.message).toMatch(/filtered/i);
  });

  it('carries the reason and message out for the UI', () => {
    const d = classify({ cause: { code: 'ECONNREFUSED' } }, 'http://127.0.0.1:2080').toDetail();
    expect(d).toEqual({
      reason: 'proxy_unreachable',
      proxy: 'http://127.0.0.1:2080',
      message: d.message,
    });
    expect(d.message.length).toBeGreaterThan(10);
  });
});

describe('assertCloudUrl', () => {
  it('accepts the cloud origin', () => {
    expect(assertCloudUrl(`${cloudOrigin().origin}/api/v1/auth/login`).pathname).toBe('/api/v1/auth/login');
  });

  it('refuses any other host so the route cannot become a relay', () => {
    expect(() => assertCloudUrl('http://127.0.0.1:22/')).toThrow(/limited to/);
    expect(() => assertCloudUrl('https://evil.example/steal')).toThrow(/limited to/);
    expect(() => assertCloudUrl('https://netpulse-cloud.shuridehradin.workers.dev.evil.test/')).toThrow(
      /limited to/,
    );
  });

  it('refuses plain http even on the right host', () => {
    expect(() => assertCloudUrl('http://netpulse-cloud.shuridehradin.workers.dev/api/v1/health')).toThrow(
      /limited to/,
    );
  });
});