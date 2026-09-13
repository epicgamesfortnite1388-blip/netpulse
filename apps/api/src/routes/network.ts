import { computeHealth } from '../services/pingService';
import type { FastifyInstance } from 'fastify';

import type { AppContext } from './context';

let lastOnlineState: boolean | null = null;

export function registerNetworkRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/network/status', async () => {
    const settings = ctx.services.settings.get();
    const probeTimeout = Math.min(settings.network.testTimeoutMs, 3_000);

    const [traceV4, probeV4, probeV6, traceV6] = await Promise.all([
      ctx.services.ipInfo.lookup(4).catch(() => null),
      ctx.controller.tcpProbe('1.1.1.1', 443, probeTimeout, 4),
      ctx.controller.tcpProbe('2606:4700:4700::1111', 443, 2_000, 6),
      ctx.services.ipInfo.lookup(6).catch(() => null),
    ]);

    const online = probeV4.ok;
    if (lastOnlineState !== null && lastOnlineState !== online) {
      ctx.services.events.record(
        online ? 'info' : 'warn',
        'network',
        online ? 'Connection restored' : 'Connection lost: TCP probe to 1.1.1.1:443 failed',
      );
    }
    lastOnlineState = online;

    return {
      online,
      checkedAt: Date.now(),
      latencyTcpMs: probeV4.ms,
      ipv4: { available: probeV4.ok, ip: traceV4?.ip ?? null },
      ipv6: { available: probeV6.ok, ip: probeV6.ok ? (traceV6?.ip ?? null) : null },
      health: computeHealth({ online, latencyTcpMs: probeV4.ms }),
    };
  });
}
