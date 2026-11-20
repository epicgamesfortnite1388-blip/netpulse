import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TESTS } from '@netpulse/shared';

const mocks = vi.hoisted(() => ({
  httpsRequest: vi.fn(),
  tlsConnect: vi.fn(),
  netCreateConnection: vi.fn(),
  dnsLookup: vi.fn(async () => ({ address: '203.0.113.10' })),
}));

vi.mock('node:dns/promises', () => ({ lookup: mocks.dnsLookup }));
vi.mock('node:https', () => ({ request: mocks.httpsRequest }));
vi.mock('node:tls', () => ({ connect: mocks.tlsConnect }));
vi.mock('node:net', () => ({ createConnection: mocks.netCreateConnection }));

import { runDiagnosticTest } from '../src/services/naniProbeAdapter';

const controller = {} as Parameters<typeof runDiagnosticTest>[0];
const log = { warn: vi.fn() } as unknown as Parameters<typeof runDiagnosticTest>[4];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.dnsLookup.mockResolvedValue({ address: '203.0.113.10' });
});

describe('naniProbeAdapter TLS paths', () => {
  it('uses node:https with SNI for a port-443 health probe', async () => {
    const req = new EventEmitter() as any;
    req.end = vi.fn(() => {
      const resp = new EventEmitter() as any;
      resp.statusCode = 200;
      resp.resume = vi.fn();
      req.emit('response', resp);
    });
    mocks.httpsRequest.mockReturnValue(req);

    const test = DEFAULT_TESTS.find((t) => t.id === 'http-reachability')!;
    const obs = await runDiagnosticTest(controller, test, 'api.example.test:443', Date.now(), log);

    expect(mocks.httpsRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        host: '203.0.113.10',
        port: 443,
        path: '/',
        servername: 'api.example.test',
        rejectUnauthorized: true,
      }),
    );
    expect(req.end).toHaveBeenCalledTimes(1);
    expect(obs.outcome).toBe('success');
  });

  it('destroys both sockets when the TLS handshake fails', async () => {
    const tlsSocket = new EventEmitter() as any;
    const tlsDestroy = vi.fn();
    tlsSocket.destroy = tlsDestroy;
    vi.spyOn(tlsSocket, 'off');
    const socket = new EventEmitter() as any;
    socket.destroy = vi.fn();
    mocks.tlsConnect.mockReturnValue(tlsSocket);
    mocks.netCreateConnection.mockReturnValue(socket);
    setImmediate(() => tlsSocket.emit('error', new Error('handshake failed')));

    const test = DEFAULT_TESTS.find((t) => t.id === 'tls-handshake')!;
    const obs = await runDiagnosticTest(controller, test, 'api.example.test:443', Date.now(), log);

    expect(obs.outcome).toBe('failure');
    expect(tlsDestroy).toHaveBeenCalledTimes(1);
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(tlsSocket.off).toHaveBeenCalled();
  });
});
