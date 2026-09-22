import fs from 'node:fs';

import { z } from 'zod';

import { AppError, badRequest, newNotFound } from '../util/appError';
import { adminStatus, invalidatePrivilegeCache } from '../util/privileges';
import { engineSupports, findEngineBinary } from '../services/proxyCores';
import type { LinkExport } from '../services/nodeLinkExport';
import { BundleError, buildProfileBundle } from '../services/profileBundle';

import type { FastifyInstance } from 'fastify';

import { vpnError } from '../vpn/vpnService';

import type { AppContext } from './context';
import type { VpnProvider } from '../vpn/vpnService';

const ImportSchema = z.object({
  providerId: z.enum(['wireguard', 'openvpn', 'singbox', 'aether']),
  // printable, single-line: the name is echoed into events/log lines and the UI
  name: z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f<>]*$/, 'must not contain control characters or angle brackets'),
  /** WireGuard: INI config text. OpenVPN: .ovpn text. sing-box: share link or
   *  outbound JSON. aether: settings JSON (empty string = defaults). */
  configText: z.string().max(64_000).default(''),
});

const ConnectSchema = z.object({
  profileId: z.string().min(1).max(64),
  /** Desktop flow: drive the per-action UAC prompt through the Rust bridge. */
  elevation: z.object({ opId: z.string().min(1).max(64) }).optional(),
});

/**
 * Promote a stored node into an engine profile.
 *
 * Only sing-box consumes share links today; the local cores (xray / v2ray) are
 * driven straight from the node row by the proxy tunnel and need no profile, so
 * they are not offered here rather than accepted and silently ignored.
 */
const FromNodeSchema = z.object({
  nodeId: z.string().min(1).max(64),
  providerId: z.literal('singbox').default('singbox'),
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[^\u0000-\u001f\u007f<>]*$/, 'must not contain control characters or angle brackets')
    .optional(),
});

type ImportProviderId = 'wireguard' | 'openvpn' | 'singbox' | 'aether';

/**
 * The single profile-creation path: a pasted config and a promoted node both
 * land here, so both get the same provider validation, vault write and event.
 */
async function importProfileVia(ctx: AppContext, providerId: ImportProviderId, name: string, configText: string) {
  const provider = ctx.vpn.get(providerId);
  if (!provider) throw new AppError(400, 'unknown_provider', 'Unknown VPN provider');
  const profile = await provider.importProfile({
    name,
    configText,
    protocol: providerId === 'singbox' || providerId === 'aether' ? 'custom' : providerId,
  });
  ctx.vpn.addProfile(providerId, profile);
  ctx.repos.vpnProfiles.insert({
    id: profile.id,
    providerId,
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
  ctx.services.events.record('info', 'vpn', `VPN profile "${profile.name}" imported (${providerId})`);
  return {
    id: profile.id,
    providerId,
    name: profile.name,
    protocol: profile.protocol,
    endpoint: profile.endpoint,
    createdAt: profile.createdAt,
  };
}

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

  // Kill switch state — the honest answer to "is traffic actually blocked
  // right now, and what is exempt". Reports the live enforcement state, not
  // the preference: `blocking` is true only while the sink is really set.
  app.get('/api/v1/vpn/killswitch', async () => ({
    killSwitch: ctx.services.killSwitch.status(),
  }));

  // Administrator rights — the honest answer to "what can this app do that
  // Windows only lets an admin do, and what do I do about it".
  //
  // Detection is real (util/privileges runs the OS check); nothing here is
  // inferred from a setting. `privileges[]` carries a reason for every entry and
  // a remedy where one exists, so the UI never has to invent wording and a
  // refusal is never a dead end.
  // Both capability inputs are filesystem checks, so this is cheap enough to
  // answer on every poll and never depends on a network probe succeeding.
  const readAdmin = (fresh: boolean) => {
    if (fresh) invalidatePrivilegeCache();
    return { admin: adminStatus({ tunGatewayCoreInstalled: findEngineBinary('sing-box') != null }) };
  };

  app.get('/api/v1/vpn/admin', async () => readAdmin(false));

  // Re-probe after an elevated relaunch or a Settings change, so the UI does
  // not keep showing a stale "no admin" from the 60 s cache.
  app.post('/api/v1/vpn/admin/recheck', async () => readAdmin(true));

  // Aether engine lifecycle: version/install-state, and a verified
  // install/update through the same release pipeline as the proxy cores.
  // Rate-limited: each call downloads + verifies a ~15 MB asset.
  app.get('/api/v1/vpn/aether/engine', async () => {
    const provider = ctx.vpn.get('aether') as (VpnProvider & { installOrUpdate?: () => Promise<unknown> }) | undefined;
    if (!provider) return { installed: false, version: null, note: 'Aether provider is not registered in this build' };
    const { aetherDir } = await import('../vpn/aetherProvider');
    const fsMod = await import('node:fs');
    const pathMod = await import('node:path');
    const exe = process.platform === 'win32' ? 'aether.exe' : 'aether';
    const bin = pathMod.join(aetherDir(), exe);
    const installed = fsMod.existsSync(bin);
    let version: string | null = null;
    if (installed) {
      try {
        const { runCommand } = await import('../util/exec');
        const res = await runCommand(bin, ['-v'], { timeoutMs: 8_000 });
        version = res.stdout.match(/aether\s+(\d+\.\d+\.\d+)/)?.[1] ?? null;
      } catch {
        version = null;
      }
    }
    // The TUN preference lives on the provider (applied at the next connect),
    // so it is read from there rather than duplicated in settings.
    const tunCapable = provider as unknown as { getTunPreference?: () => boolean };
    return {
      installed,
      version,
      path: installed ? bin : null,
      available: provider.info.available,
      tun: tunCapable.getTunPreference?.() ?? false,
      note:
        installed && version
          ? `aether ${version} installed and self-check passing`
          : installed
            ? 'aether binary exists but failed its -v self-check — reinstall'
            : 'aether is not installed — use Install/Update',
    };
  });

  // System-wide (TUN) mode for Aether.
  //
  // Aether serves SOCKS5, so on its own it only captures apps that honour a
  // proxy setting. This puts the shared sing-box TUN gateway in front of that
  // port so the OS default route carries everything — the same mechanism the
  // local cores use. The preference is applied to the NEXT connect; an active
  // tunnel is never silently re-routed, and `tun` in the status is only
  // 'active' after traffic provably traversed the whole path.
  app.post('/api/v1/vpn/aether/tun', async (req) => {
    const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!parsed.success) throw parsed.error;
    const provider = ctx.vpn.get('aether') as unknown as { setTunPreference?: (on: boolean) => void; getTunPreference?: () => boolean } | undefined;
    if (!provider?.setTunPreference) {
      throw new AppError(501, 'not_implemented', 'Aether system-wide mode is not available in this build');
    }
    provider.setTunPreference(parsed.data.enabled);
    return { tun: provider.getTunPreference?.() ?? parsed.data.enabled };
  });

  app.post(
    '/api/v1/vpn/aether/engine/install',
    { config: { rateLimit: { max: 3, timeWindow: '5 minutes' } } },
    async () => {
      const provider = ctx.vpn.get('aether') as (VpnProvider & { installOrUpdate?: () => Promise<{ ok: boolean; status: string; version: string | null; error: string | null; checksumVerified: boolean }> }) | undefined;
      if (!provider?.installOrUpdate) throw new AppError(501, 'not_implemented', 'Aether engine management is not available in this build');
      const outcome = await provider.installOrUpdate();
      ctx.services.events.record(
        outcome.ok ? 'info' : 'error',
        'vpn',
        outcome.ok
          ? `Aether engine ${outcome.status} (version ${outcome.version ?? 'unknown'}, checksum ${outcome.checksumVerified ? 'verified' : 'UNVERIFIED'})`
          : `Aether engine install failed: ${outcome.error ?? 'unknown error'}`,
      );
      return outcome;
    },
  );

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
      const profile = await importProfileVia(ctx, parsed.data.providerId, parsed.data.name, parsed.data.configText);
      reply.status(201);
      return { profile };
    },
  );

  /**
   * Full-config export for end-to-end ENCRYPTED cloud backup. The response
   * carries the real credential (reconstructed from the vault) — it exists
   * so the webview can encrypt it client-side before anything leaves the
   * machine; the cloud only ever receives ciphertext. Loopback + bearer
   * gated like every local route, and rate-limited harder than reads.
   */
  app.get(
    '/api/v1/vpn/profiles/:id/bundle',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => {
      const { id } = req.params as { id: string };
      try {
        return buildProfileBundle(ctx.vpn, id);
      } catch (err) {
        if (err instanceof BundleError) {
          if (err.code === 'not_found') throw newNotFound(`Profile "${id}" not found`);
          throw new AppError(409, err.code, err.message);
        }
        throw err;
      }
    },
  );

  /**
   * Add a stored node to an engine profile immediately.
   *
   * The node's link is rebuilt from its row plus the vaulted credential (the
   * database never held the original config text), round-tripped through the
   * parser, and then imported exactly like a pasted link. When the rebuild or
   * the engine's protocol support says no, the route refuses with the reason
   * instead of creating a profile that could only fail at connect time.
   */
  app.post(
    '/api/v1/vpn/profiles/from-node',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = FromNodeSchema.safeParse(req.body);
      if (!parsed.success) throw parsed.error;

      const node = ctx.repos.publicNodes.get(parsed.data.nodeId);
      if (!node) throw newNotFound(`Node "${parsed.data.nodeId}" not found`);

      // One owner for "rebuild a stored node's link": the node service reads the
      // row, takes the credential from the vault and round-trips the result
      // through the parser. This route only decides what to do with it.
      const built = ctx.services.nodes.shareLink(node.id) as LinkExport | null;
      if (!built) throw newNotFound(`Node "${parsed.data.nodeId}" not found`);
      if (!built.ok) {
        throw vpnError(
          400,
          'node_not_exportable',
          built.reason,
          "Add the node's original config instead, or re-import the source it came from so its credential is vaulted.",
        );
      }

      if (!engineSupports('sing-box', node.protocol)) {
        throw vpnError(
          400,
          'engine_unsupported_protocol',
          `The sing-box core cannot dial ${node.protocol} nodes, so no profile was created.`,
          'Use this node through the proxy tunnel, where the app picks a core that supports it.',
        );
      }

      const baseName = (node.remark?.trim() || `${node.host}:${node.port}`).slice(0, 100);
      const profile = await importProfileVia(ctx, 'singbox', parsed.data.name ?? baseName, built.link);

      ctx.services.events.record('info', 'vpn', `Node ${node.host}:${node.port} added to the sing-box engine as a profile`);
      reply.status(201);
      return { profile, node: { id: node.id, protocol: node.protocol, host: node.host, port: node.port } };
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
    // The kill switch outlives the tunnel it was armed by: when it is blocking
    // there is no connected provider, so the aggregate status must still say so
    // rather than reporting a bare "disconnected" over fail-closed traffic.
    const blocking = ctx.services.killSwitch.status().blocking;
    if (active) return { ...active, killSwitchActive: active.killSwitchActive || blocking };
    return {
      connected: false,
      serverId: null,
      serverName: null,
      protocol: null,
      since: null,
      supported: statuses.some((s) => s.supported),
      killSwitchActive: blocking,
    };
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
        // No provider is connected — but the kill switch may still be holding
        // the machine fail-closed after a drop. "Disconnect" is the user's way
        // out, so it must release that block (restoring their own proxy)
        // instead of returning a bare disconnected status over blocked traffic.
        const ks = ctx.services.killSwitch.status();
        if (ks.armed || ks.blocking) {
          const released = await ctx.services.killSwitch.onTunnelStopped();
          ctx.services.events.record('warn', 'vpn', 'Kill switch released by explicit disconnect — previous proxy restored');
          return { connected: false, killSwitchReleased: true, note: released.note } as Awaited<ReturnType<VpnProvider['disconnect']>> & { killSwitchReleased: boolean; note: string | null };
        }
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
