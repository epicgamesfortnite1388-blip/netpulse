import http from 'node:http';
import https from 'node:https';

export interface HttpProbeResult {
  ok: boolean;
  /** ms until response headers arrived */
  ms: number | null;
  status: number | null;
  server: string | null;
  error?: string;
}

export interface HttpProbeOptions {
  host: string;
  port: number;
  path?: string;
  sni?: string;
  tls: boolean;
  timeoutMs: number;
  family?: 4 | 6;
  method?: 'HEAD' | 'GET';
}

/**
 * Time an HTTP(S) request until the response headers arrive.
 * Used by the endpoint tester / Cloudflare scanner (stage 4).
 */
export function httpProbe(opts: HttpProbeOptions): Promise<HttpProbeResult> {
  const { host, port, tls: useTls, timeoutMs, sni, family } = opts;
  const path = opts.path ?? '/';
  const method = opts.method ?? 'HEAD';

  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    let done = false;

    const finish = (result: HttpProbeResult) => {
      if (done) return;
      done = true;
      resolve(result);
    };

    const transport = useTls ? https : http;
    const req = transport.request(
      {
        host,
        port,
        path,
        method,
        timeout: timeoutMs,
        headers: {
          host: sni || host,
          'user-agent': 'NetPulse/1.0 (+local diagnostics)',
          accept: '*/*',
          connection: 'close',
        },
        ...(useTls
          ? { servername: sni || (host.match(/^[\d.]+$/) ? undefined : host), rejectUnauthorized: false }
          : {}),
        ...(family === 4 || family === 6 ? { family } : {}),
      },
      (res) => {
        const ms = Number(process.hrtime.bigint() - start) / 1e6;
        // headers are enough — finish immediately and drain the body
        const server = (res.headers.server as string | undefined) ?? null;
        finish({ ok: true, ms: Math.round(ms * 100) / 100, status: res.statusCode ?? null, server });
        res.resume();
      },
    );

    req.once('timeout', () => {
      req.destroy();
      finish({ ok: false, ms: null, status: null, server: null, error: 'timeout' });
    });
    req.once('error', (err: Error) => {
      finish({ ok: false, ms: null, status: null, server: null, error: err.message });
    });
    req.end();
  });
}
