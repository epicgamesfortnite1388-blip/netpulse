import fs from 'node:fs';

import { z } from 'zod';

import { AppError, badRequest, newNotFound } from '../util/appError';

import type { FastifyInstance } from 'fastify';

import { vpnError } from '../vpn/vpnService';

import type { AppContext } from './context';
import type { VpnProvider } from '../vpn/vpnService';

const ImportSchema = z.object({
  providerId: z.enum(['wireguard', 'openvpn', 'singbox']),
  // printable, single-line: the name is echoed into events/log lines and the UI
  name: z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f<>]*$/, 'must not contain control characters or angle brackets'),
  /** WireGuard: INI config text. OpenVPN: .ovpn text. sing-box: share link or outbound JSON. */
  configText: z.string().min(1).max(64_000),
});

const ConnectSchema = z.object({
  profileId: z.string().min(1).max(64),
  /** Desktop flow: drive the per-action UAC prompt through the Rust bridge. */
  elevation: z.object({ opId: z.string().min(1).max(64) }).optional(),
});

/**
 * Full elevated WireGuard connect: stage the op for the Rust bridge, wait for
 * the UAC outcome, then let the provider verify the interface. The opId is
 * minted by the UI; the descriptor is built by the broker from the provider's
 * own staged config, so no untrusted path ever reaches the privileged side.
 *
 * Only WireGuard on Windows uses the bridge today. Other providers either do
 * not need elevation (sing-box proxy mode) or are not wired to the broker —
 * they run the plain unprivileged path and fail honestly.
 */
async function runElevatedWireGuardConnect(ctx: AppContext, profileId: string, opId: string) {
  const profile = ctx.vpn.getProfile(profileId);
  if (!profile) throw new AppError(404, 'not_found', 'Profile not found');
  if (profile.providerId !== 'wireguard') {
    throw badRequest('elevation_unsupported', 'Per-action elevation is only available for WireGuard profiles');
  }
  const provider = ctx.vpn.get('wireguard');
  if (!provider) throw new AppError(400, 'unknown_provider', 'WireGuard provider is unavailable');

  // Ordering:
  //  1. prepareElevatedConnect materializes the REAL config (key material)
  //     into the private tmp dir — the file the tunnel service will consume.
  //  2. register the op: the broker hashes THAT file into the descriptor.
  //  3. the UI invokes the Rust bridge with the opId; Rust fetches the
  //     descriptor (nonce-gated, re-hashed at fetch), validates the fixed
  //     exe/args shape, prompts UAC once, launches, reports the outcome.
  //  4. the long-poll below resolves and we verify the interface came up.
  // The unprivileged attempt is skipped entirely: on Windows it can only
  // fail (access denied) — going straight to the prompt is one action,
  // one UAC dialog, no double error.
  const wg = provider as typeof provider & { prepareElevatedConnect?: (p: typeof profile) => string };
  if (!wg.prepareElevatedConnect) {
    throw badRequest('elevation_unsupported', 'The WireGuard provider does not support the elevation flow in this build');
  }
  const stagedConfigPath = wg.prepareElevatedConnect(profile);
  ctx.elevationBroker.registerWireGuardInstall({ opId, configPath: stagedConfigPath });
  ctx.repos.vpnProfiles.touch(profile.id);

  try {
    // Long-poll: resolved by POST /vpn/elevation/result from the Rust bridge,
    // or by TTL expiry (never hangs forever).
    const outcome = await ctx.elevationBroker.wait(opId);
    if (!outcome.ok) {
      ctx.services.events.record('warn', 'vpn', outcome.declined ? 'Elevation prompt declined by user' : `Elevation failed: ${outcome.error ?? 'unknown error'}`);
      if (outcome.declined) {
        throw vpnError(403, 'elevation_declined', 'The tunnel was not installed because the elevation prompt was declined.', 'Press Connect again and accept the Windows prompt to install the tunnel.');
      }
      throw vpnError(500, 'elevation_failed', outcome.error ?? 'The elevated tunnel install did not complete.');
    }

    // The bridge launched wireguard.exe successfully — verify the interface.
    let status = await provider.status();
    if (!status.connected) {
      // The tunnel service can take a moment; retry once before failing.
      await new Promise((r) => setTimeout(r, 1_500));
      status = await provider.status();
      if (!status.connected) {
        throw vpnError(502, 'tunnel_not_up', 'The tunnel service was installed but no tunnel interface appeared. Check the endpoint and key material.', 'Try reconnecting; if it persists, the profile configuration may be invalid.');
      }
    }
    ctx.services.events.record('info', 'vpn', `WireGuard tunnel "${profile.name}" is up (elevated install)`);
    return { outcome: 'connected' as const, status };
  } finally {
    // The materialized config contains the REAL private key: delete it on
    // EVERY exit path (success, decline, expiry, error).
    try { fs.rmSync(stagedConfigPath, { force: true }); } catch { /* best effort */ }
  }
}

/**
 * Global VPN operation mutex.
 *
 * connect/reconnect/disconnect mutate provider child-process state; running
 * two of them concurrently produces double-spawned tunnels, leaked processes
 * or lost disconnects. Serializing them at the API boundary makes the state
 * machine race-free from the UI's perspective: the second click simply waits
 * (bounded) instead of interleaving.
 */
let vpnOp: Promise<unknown> = Promise.resolve();
function serializeVpnOp<T>(op: () => Promise<T>): Promise<T> {
  const next = vpnOp.then(op, op);
  // Swallow rejection here so the chain never becomes poisoned; callers get
  // their own rejection via `next`.
  vpnOp = next.catch(() => undefined);
  return next;
}

export function registerVpnRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/vpn/providers', async () => ({
    providers: ctx.vpn.all().map((p) => p.info),
  }));

  app.get('/api/v1/vpn/profiles', async () => ({
    profiles: ctx.vpn.listProfiles().map((p) => ({
      id: p.id,
      providerId: p.providerId,
      name: p.name,
      protocol: p.protocol,
      endpoint: p.endpoint,
      createdAt: p.createdAt,
    })),
  }));

  app.post(
    '/api/v1/vpn/profiles',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = ImportSchema.safeParse(req.body);
      if (!parsed.success) throw parsed.error;
      const provider = ctx.vpn.get(parsed.data.providerId);
      if (!provider) throw new AppError(400, 'unknown_provider', 'Unknown VPN provider');
      const profile = await provider.importProfile({
        name: parsed.data.name,
        configText: parsed.data.configText,
        protocol: parsed.data.providerId === 'singbox' ? 'custom' : parsed.data.providerId,
      });
      ctx.vpn.addProfile(parsed.data.providerId, profile);
      ctx.repos.vpnProfiles.insert({
        id: profile.id,
        providerId: parsed.data.providerId,
        name: profile.name,
        protocol: profile.protocol,
        endpoint: profile.endpoint,
        publicKeyFingerprint: profile.publicKeyFingerprint,
        allowedIps: profile.allowedIps ? profile.allowedIps.join(',') : null,
        dnsServers: profile.dns ? profile.dns.join(',') : null,
        secretRef: profile.secretRef,
        configPath: profile.configPath,
        lastUsedAt: null,
        createdAt: profile.createdAt,
      });
      ctx.services.events.record('info', 'vpn', `VPN profile "${profile.name}" imported (${parsed.data.providerId})`);
      reply.status(201);
      return {
        profile: {
          id: profile.id,
          providerId: parsed.data.providerId,
          name: profile.name,
          protocol: profile.protocol,
          endpoint: profile.endpoint,
          createdAt: profile.createdAt,
        },
      };
    },
  );

  app.delete('/api/v1/vpn/profiles/:id', async (req) => {
    const { id } = req.params as { id: string };
    const profile = ctx.vpn.getProfile(id);
    if (!profile) throw newNotFound(`Profile "${id}" not found`);
    const { provider } = ctx.vpn.removeProfile(id);
    provider?.deleteProfile?.(id);
    ctx.repos.vpnProfiles.remove(id);
    ctx.services.events.record('info', 'vpn', `VPN profile "${profile.name}" deleted`);
    return { ok: true };
  });

  app.get('/api/v1/vpn/status', async () => {
    const statuses = await Promise.all(ctx.vpn.all().map((p) => p.status()));
    // the active provider is whichever reports a live tunnel
    const active = statuses.find((s) => s.connected);
    return active ?? { connected: false, serverId: null, serverName: null, protocol: null, since: null, supported: statuses.some((s) => s.supported), killSwitchActive: false };
  });

  app.get('/api/v1/vpn/health', async () => {
    const statuses = await Promise.all(ctx.vpn.all().map((p) => p.status()));
    const active = statuses.find((s) => s.connected);
    if (!active?.providerId) {
      return { connected: false, rxBytes: null, txBytes: null, handshakeAgeSec: null, endpointLatencyMs: null, endpoint: null, note: 'No active tunnel' };
    }
    const provider = ctx.vpn.get(active.providerId);
    const health = provider?.health ? await provider.health().catch(() => null) : null;
    return {
      connected: true,
      providerId: active.providerId,
      serverName: active.serverName,
      protocol: active.protocol,
      endpoint: active.endpoint ?? null,
      since: active.since,
      rxBytes: health?.rxBytes ?? active.rxBytes ?? null,
      txBytes: health?.txBytes ?? active.txBytes ?? null,
      handshakeAgeSec: health?.handshakeAgeSec ?? active.handshakeAgeSec ?? null,
      endpointLatencyMs: health?.endpointLatencyMs ?? active.endpointLatencyMs ?? null,
    };
  });

  app.post(
    '/api/v1/vpn/connect',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      const parsed = ConnectSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw parsed.error;
      const profile = ctx.vpn.getProfile(parsed.data.profileId);
      if (!profile) throw new AppError(404, 'not_found', 'Profile not found');
      const provider = ctx.vpn.get(profile.providerId);
      if (!provider) throw new AppError(400, 'unknown_provider', 'Provider for this profile is unavailable');

      // Desktop elevated flow: the UI mints an opId, arms the Rust bridge,
      // and this request long-polls until the UAC outcome lands.
      if (parsed.data.elevation?.opId) {
        ctx.services.events.record('info', 'vpn', `Elevated connect requested for "${profile.name}"`);
        const result = await runElevatedWireGuardConnect(ctx, parsed.data.profileId, parsed.data.elevation.opId);
        ctx.services.events.record('info', 'vpn', `Connected VPN profile "${profile.name}" (elevated)`);
        return { status: result.status, outcome: result.outcome };
      }

      ctx.repos.vpnProfiles.touch(profile.id);
      const status = await serializeVpnOp(() => provider.connect(profile));
      ctx.services.events.record('info', 'vpn', `Connected VPN profile "${profile.name}"`);
      return { status };
    },
  );

  app.post(
    '/api/v1/vpn/reconnect',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      const parsed = ConnectSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw parsed.error;
      const profile = ctx.vpn.getProfile(parsed.data.profileId);
      if (!profile) throw new AppError(404, 'not_found', 'Profile not found');
      const provider = ctx.vpn.get(profile.providerId);
      if (!provider) throw new AppError(400, 'unknown_provider', 'Provider for this profile is unavailable');
      ctx.repos.vpnProfiles.touch(profile.id);
      const status = await serializeVpnOp(async () => {
        // bring the tunnel down first if something is up
        const statuses = await Promise.all(ctx.vpn.all().map((p) => p.status()));
        if (statuses.some((s) => s.connected)) {
          const activeProvider = ctx.vpn.get(statuses.find((s) => s.connected)!.providerId!);
          await activeProvider?.disconnect().catch(() => undefined);
        }
        return provider.connect(profile);
      });
      ctx.services.events.record('info', 'vpn', `Reconnected VPN profile "${profile.name}"`);
      return { status };
    },
  );

  app.post('/api/v1/vpn/disconnect', async () => {
    const status = await serializeVpnOp(async () => {
      const statuses = await Promise.all(ctx.vpn.all().map((p) => p.status()));
      const active = statuses.find((s) => s.connected);
      if (!active?.providerId) {
        return { connected: false } as Awaited<ReturnType<VpnProvider['disconnect']>>;
      }
      const provider = ctx.vpn.get(active.providerId);
      if (!provider) throw new AppError(500, 'provider_missing', 'Active provider disappeared');
      return provider.disconnect();
    });
    ctx.services.events.record('info', 'vpn', 'VPN tunnel disconnected');
    return { status };
  });

  // ---- Per-action elevation bridge (Windows WireGuard connect) ----
  //
  // These two endpoints serve the RUST elevation broker, not the webview:
  // the Rust command fetches the pending descriptor (with the nonce the UI
  // passed it) and reports the launch outcome. Authenticated like every other
  // route; the nonce additionally binds each call to the UI round-trip.

  app.get('/api/v1/vpn/elevation/pending', async (req) => {
    const q = z.object({ opId: z.string().min(1).max(64), nonce: z.string().min(16).max(128) }).safeParse(req.query);
    if (!q.success) throw badRequest('invalid_elevation_query', 'opId and nonce are required');
    const descriptor = ctx.elevationBroker.fetchForBridge(q.data.opId, q.data.nonce);
    return descriptor;
  });

  app.post('/api/v1/vpn/elevation/result', async (req) => {
    const q = z.object({ opId: z.string().min(1).max(64), nonce: z.string().min(16).max(128) }).safeParse(req.query);
    if (!q.success) throw badRequest('invalid_elevation_query', 'opId and nonce are required');
    const body = z.object({ ok: z.boolean(), error: z.string().max(500).nullable() }).safeParse(req.body);
    if (!body.success) throw badRequest('invalid_elevation_result', 'ok and error are required');
    const accepted = ctx.elevationBroker.resolveFromBridge(q.data.opId, q.data.nonce, { ok: body.data.ok, error: body.data.error });
    return { accepted };
  });

  app.get('/api/v1/vpn/connections', async (req) => {
    const q = z.coerce.number().int().min(1).max(100).default(20).safeParse((req.query as { limit?: string }).limit ?? undefined);
    const limit = q.success ? q.data : 20;
    return {
      connections: ctx.repos.vpnConnections.latest(limit),
    };
  });

  app.post('/api/v1/vpn/verify', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async () => {
    // re-verify the active tunnel: current public IP vs the IP recorded at connect
    const statuses = await Promise.all(ctx.vpn.all().map((p) => p.status()));
    const active = statuses.find((s) => s.connected);
    if (!active) throw badRequest('not_connected', 'No active tunnel to verify');
    const info = await ctx.services.ipInfo.lookup(4, { force: true });
    const previous = active.verifiedPublicIp ?? null;
    const changed = previous != null && previous !== info.ip;
    return {
      connected: active.connected,
      providerId: active.providerId,
      currentPublicIp: info.ip,
      ipAtConnect: previous,
      trafficStillViaTunnel: changed ? false : previous != null ? true : null,
      note:
        previous == null
          ? 'The tunnel was connected without a recorded public IP, so identity continuity cannot be checked.'
          : changed
            ? `Public IP changed since connect (${previous} → ${info.ip}). The tunnel may have dropped and failed over.`
            : `Public IP unchanged since connect (${info.ip}).`,
    };
  });
}
