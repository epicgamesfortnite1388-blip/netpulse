import Fastify from 'fastify';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { NaniDiagnosticAdapter, parseDiagnosticTarget } from '../src/services/naniDiagnosticAdapter';
import { registerNaniDiagnosticRoutes } from '../src/routes/naniDiagnostics';
import type { AppContext } from '../src/routes/context';
import type { NodeTestResult } from '@netpulse/shared';

function nodeResult(over: Partial<NodeTestResult> = {}): NodeTestResult {
  return {
    nodeId: 'nani-read-only-diagnostic',
    type: 'tcp',
    status: 'done',
    startedAt: 0,
    finishedAt: 1,
    latencyMs: 12,
    totalMs: 12,
    tlsVersion: null,
    authorized: null,
    httpStatus: null,
    responseSize: null,
    error: null,
    family: 4,
    probedIp: '93.184.216.34',
    testEndpoint: null,
    engine: null,
    ...over,
  } as NodeTestResult;
}

const log = pino({ level: 'silent' });

function adapter(overrides: Partial<ConstructorParameters<typeof NaniDiagnosticAdapter>[0]> = {}) {
  return new NaniDiagnosticAdapter({
    log,
    resolve: async (host) => ({ host, ips: ['93.184.216.34'], family: 4 }),
    tcpProbe: async () => nodeResult(),
    tlsProbe: async () => nodeResult({ type: 'tls', tlsVersion: 'TLSv1.3', authorized: true }),
    ...overrides,
  });
}

describe('parseDiagnosticTarget', () => {
  it('defaults the port and splits host:port', () => {
    expect(parseDiagnosticTarget('example.com')).toEqual({ host: 'example.com', port: 443 });
    expect(parseDiagnosticTarget('example.com:8443')).toEqual({ host: 'example.com', port: 8443 });
  });

  it('accepts bracketed IPv6 with and without a port', () => {
    expect(parseDiagnosticTarget('[2001:db8::1]:443')).toEqual({ host: '2001:db8::1', port: 443 });
    expect(parseDiagnosticTarget('[2001:db8::1]')).toEqual({ host: '2001:db8::1', port: 443 });
  });

  it('rejects an out-of-range port', () => {
    expect(() => parseDiagnosticTarget('example.com:70000')).toThrow(/invalid port/);
  });
});

describe('NaniDiagnosticAdapter', () => {
  it('folds verified DNS/TCP/TLS probes into a NANI diagnosis', async () => {
    const result = await adapter().diagnose('example.com');
    expect(result.readOnly).toBe(true);
    expect(result.observations.map((o) => [o.testId, o.outcome])).toEqual([
      ['dns-lookup', 'success'],
      ['tcp-connect', 'success'],
      ['tls-handshake', 'success'],
    ]);
    expect(result.diagnosis.evidenceCount).toBe(3);
    expect(result.limits.join(' ')).toMatch(/never disable/i);
  });

  it('treats an unauthenticated TLS handshake as a TLS failure', async () => {
    const result = await adapter({
      tlsProbe: async () => nodeResult({ type: 'tls', status: 'done', authorized: false }),
    }).diagnose('example.com');
    const tls = result.observations.find((o) => o.testId === 'tls-handshake');
    expect(tls?.outcome).toBe('failure');
    expect(result.diagnosis.insufficientEvidence || result.diagnosis.top === 'tls').toBe(true);
  });

  it('maps probe timeouts to the NANI timeout outcome', async () => {
    const result = await adapter({
      tcpProbe: async () => nodeResult({ status: 'failed', error: 'timeout' }),
      tlsProbe: vi.fn(),
    }).diagnose('example.com');
    const tcp = result.observations.find((o) => o.testId === 'tcp-connect');
    expect(tcp?.outcome).toBe('timeout');
  });

  it('records skipped transport probes when DNS fails', async () => {
    const tcp = vi.fn();
    const result = await adapter({
      resolve: async () => {
        const { badRequest } = await import('../src/util/appError');
        throw badRequest('dns_resolution_failed', 'no such host');
      },
      tcpProbe: tcp,
    }).diagnose('missing.invalid');
    // DNS failure: TCP and TLS probes are not attempted but recorded as skipped
    expect(tcp).not.toHaveBeenCalled();
    expect(result.observations.map((o) => [o.testId, o.outcome])).toEqual([
      ['dns-lookup', 'failure'],
      ['tcp-connect', 'skipped'],
      ['tls-handshake', 'skipped'],
    ]);
  });

  it('skips TLS by default on non-443 ports', async () => {
    const tls = vi.fn();
    const result = await adapter({ tlsProbe: tls }).diagnose('example.com:8080');
    expect(tls).not.toHaveBeenCalled();
    expect(result.observations.find((o) => o.testId === 'tls-handshake')?.outcome).toBe('skipped');
  });

  it('rejects private targets through the shared SSRF guard', async () => {
    await expect(new NaniDiagnosticAdapter({ log }).diagnose('127.0.0.1')).rejects.toMatchObject({
      status: 400,
      code: 'private_target_not_allowed',
    });
  });
});

describe('GET /api/v1/nani/diagnostics/read-only', () => {
  it('returns 400 for a private target and never probes it', async () => {
    const app = Fastify();
    registerNaniDiagnosticRoutes(app, { log } as unknown as AppContext);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/nani/diagnostics/read-only?target=127.0.0.1',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'private_target_not_allowed' } });
    await app.close();
  });

  it('requires a target', async () => {
    const app = Fastify();
    registerNaniDiagnosticRoutes(app, { log } as unknown as AppContext);
    const res = await app.inject({ method: 'GET', url: '/api/v1/nani/diagnostics/read-only' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
