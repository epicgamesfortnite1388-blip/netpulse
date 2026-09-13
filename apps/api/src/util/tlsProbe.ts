import tls from 'node:tls';

export interface TlsProbeResult {
  ok: boolean;
  /** full handshake duration in ms */
  ms: number | null;
  error?: string;
  tlsVersion?: string | null;
  cipher?: string | null;
  /** false when the certificate failed verification */
  authorized?: boolean | null;
}

/**
 * Measure TLS handshake time to host:port. `sni` sets the Server Name
 * Indication (defaults to host). No shell, no privileges, hard timeout.
 */
export function tlsProbe(
  host: string,
  port: number,
  timeoutMs: number,
  sni?: string,
  family?: 4 | 6,
): Promise<TlsProbeResult> {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    let done = false;
    let socket: tls.TLSSocket | null = null;

    const finish = (result: TlsProbeResult) => {
      if (done) return;
      done = true;
      try {
        socket?.destroy();
      } catch {
        // already closed
      }
      resolve(result);
    };

    try {
      socket = tls.connect({
        host,
        port,
        servername: sni || (host.match(/^[\d.]+$/) ? undefined : host),
        timeout: timeoutMs,
        rejectUnauthorized: false, // we report certificate authorization, not enforce it
        ...(family === 4 || family === 6 ? { family } : {}),
      });
    } catch (err) {
      finish({ ok: false, ms: null, error: err instanceof Error ? err.message : String(err) });
      return;
    }

    socket.once('secureConnect', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const s = socket;
      finish({
        ok: true,
        ms: Math.round(ms * 100) / 100,
        tlsVersion: s?.getProtocol?.() ?? null,
        cipher: s?.getCipher?.()?.name ?? null,
        authorized: s?.authorized ?? null,
      });
    });
    socket.once('timeout', () => finish({ ok: false, ms: null, error: 'timeout' }));
    socket.once('error', (err: Error) => finish({ ok: false, ms: null, error: err.message }));
  });
}
