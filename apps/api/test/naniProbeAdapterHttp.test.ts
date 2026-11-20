import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TESTS } from '@netpulse/shared';

import { runDiagnosticTest } from '../src/services/naniProbeAdapter';

const controller = {} as Parameters<typeof runDiagnosticTest>[0];
const log = { warn: vi.fn() } as unknown as Parameters<typeof runDiagnosticTest>[4];

let server: http.Server | undefined;

afterEach(async () => {
  const current = server;
  server = undefined;
  if (current) await new Promise<void>((resolve) => current.close(() => resolve()));
});

async function startServer(handler: http.RequestListener): Promise<number> {
  server = http.createServer(handler);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server!.address();
  if (!address || typeof address === 'string') throw new Error('test server has no TCP port');
  return address.port;
}

describe('naniProbeAdapter HTTP layer', () => {
  it('sends the bodyless GET and measures a successful response', async () => {
    const paths: string[] = [];
    const port = await startServer((req, res) => {
      paths.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    const test = DEFAULT_TESTS.find((t) => t.id === 'http-reachability');
    expect(test).toBeDefined();

    const obs = await runDiagnosticTest(controller, test!, `127.0.0.1:${port}`, Date.now(), log);

    expect(obs.outcome).toBe('success');
    expect(paths).toEqual(['/']);
  });

  it('uses the supplied path for an application-layer probe', async () => {
    const paths: string[] = [];
    const port = await startServer((req, res) => {
      paths.push(req.url ?? '');
      res.writeHead(200);
      res.end('ok');
    });
    const test = DEFAULT_TESTS.find((t) => t.id === 'rate-limit-check');
    expect(test).toBeDefined();

    const obs = await runDiagnosticTest(
      controller,
      test!,
      `127.0.0.1:${port}`,
      Date.now(),
      log,
      '/healthz-custom',
    );

    expect(obs.outcome).toBe('success');
    expect(paths).toEqual(['/healthz-custom']);
  });
});
