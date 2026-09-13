import net from 'node:net';

import type { TcpProbeResult } from '@netpulse/shared';

/**
 * Measure TCP connection establishment time. No privileges required and
 * locale-independent, which makes it the primary latency signal on Windows
 * (ICMP raw sockets need admin rights there).
 */
export function tcpProbe(
  host: string,
  port: number,
  timeoutMs: number,
  family?: 4 | 6,
): Promise<TcpProbeResult> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const start = process.hrtime.bigint();
    let done = false;

    const finish = (ok: boolean, error?: string) => {
      if (done) return;
      done = true;
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      socket.destroy();
      resolve({ ok, ms: ok ? Math.round(ms * 100) / 100 : null, error });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, 'timeout'));
    socket.once('error', (err: Error) => finish(false, err.message));
    socket.connect({
      host,
      port,
      family: family === 6 && net.isIP(host) === 0 ? 6 : family,
    });
  });
}
