import type { FastifyInstance } from 'fastify';

import type { AppContext } from '../routes/context';

/**
 * Auto-connect (settings.vpn.autoConnect): bring the VPN up on start. Runs in
 * the background so a slow scan/verification never delays readiness; the
 * outcome is logged, never invented. Routed through the real quick-connect
 * path (remembered gateways → discovery scan) so boot behavior is exactly the
 * Connect button's behavior. Shared by both entry points (dev `index.ts` and
 * the packaged desktop sidecar) — token acquisition differs, behavior does not.
 */
export function runAutoConnectIfNeeded(app: FastifyInstance, ctx: AppContext, token: string): void {
  if (!ctx.services.settings.get().vpn?.autoConnect) return;
  app.log.info('autoConnect enabled — connecting the VPN in the background');
  void app
    .inject({
      method: 'POST',
      url: '/api/v1/vpn/tunnel/quick',
      headers: { authorization: `Bearer ${token}` },
      payload: { systemProxy: true },
    })
    .then((res) => {
      const body = res.json() as { quick?: { ok: boolean; summary?: string } };
      app.log.info(`Auto-connect finished: ${body.quick?.summary ?? `HTTP ${res.statusCode}`}`);
    })
    .catch((err: unknown) => {
      app.log.warn(`Auto-connect failed: ${err instanceof Error ? err.message : String(err)}`);
    });
}
