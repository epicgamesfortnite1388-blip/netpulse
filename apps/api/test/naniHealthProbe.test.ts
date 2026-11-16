import { describe, expect, it } from 'vitest';

import { healthProbeLayers, healthProbePath, isLoopbackHost } from '../src/services/naniService';

/**
 * The desktop sidecar listens on loopback with plain HTTP. Probing it with a
 * TLS handshake fails with ERR_SSL_WRONG_VERSION_NUMBER, which used to mark a
 * perfectly healthy local backend as `0/1 healthy` and trip its circuit breaker.
 * These pin the rule that loopback endpoints skip TLS, while everything else
 * keeps the full chain (skipping TLS there would hide real certificate failures).
 */

const FULL = ['dns', 'tcp', 'tls', 'http'] as const;

describe('isLoopbackHost', () => {
  it('recognizes loopback forms', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  it('rejects everything else', () => {
    for (const host of ['api.telegram.org', '10.0.0.1', '192.168.1.1', '::2', '']) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe('healthProbeLayers', () => {
  it('drops TLS for a loopback endpoint', () => {
    expect(healthProbeLayers('127.0.0.1', [...FULL])).toEqual(['dns', 'tcp', 'http']);
    expect(healthProbeLayers('localhost', [...FULL])).toEqual(['dns', 'tcp', 'http']);
  });

  it('keeps the full chain for a remote endpoint', () => {
    expect(healthProbeLayers('api.telegram.org', [...FULL])).toEqual(['dns', 'tcp', 'tls', 'http']);
    expect(healthProbeLayers('netpulse-cloud.shuridehradin.workers.dev', [...FULL])).toEqual([
      'dns',
      'tcp',
      'tls',
      'http',
    ]);
  });

  it('does not invent layers the caller did not ask for', () => {
    expect(healthProbeLayers('127.0.0.1', ['tcp'])).toEqual(['tcp']);
    expect(healthProbeLayers('127.0.0.1', ['tls'])).toEqual([]);
    expect(healthProbeLayers('api.telegram.org', ['tls'])).toEqual(['tls']);
  });
});

describe('healthProbePath', () => {
  it('accepts a concrete path', () => {
    expect(healthProbePath('/healthz')).toBe('/healthz');
    expect(healthProbePath('  /api/v1/health  ')).toBe('/api/v1/health');
  });

  it('rejects a templated path rather than requesting a URL that cannot exist', () => {
    expect(healthProbePath('/bot<token>/getMe')).toBeUndefined();
  });

  it('rejects missing or non-absolute paths', () => {
    expect(healthProbePath(undefined)).toBeUndefined();
    expect(healthProbePath('')).toBeUndefined();
    expect(healthProbePath('healthz')).toBeUndefined();
  });
});
