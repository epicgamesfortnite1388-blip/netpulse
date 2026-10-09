import fs from 'node:fs';

import { z } from 'zod';

import { AppError, badRequest, newNotFound } from '../util/appError';
import { replyApiError } from '../util/apiError';
import { adminStatus, invalidatePrivilegeCache } from '../util/privileges';
import { engineSupports, findEngineBinary } from '../services/proxyCores';
import { nodeLabel } from '../services/nodeView';
import {
  deleteCloudBackup,
  fetchCloudProfile,
  pushProfileToCloud,
  tombstoneCloudProfile,
} from '../services/profileCloudSync';

import { ProfileCloudError } from '../services/profileCloudSync';

import type { LinkExport } from '../services/nodeLinkExport';
import type { ProfileCloudVault } from '../services/profileCloudVault';
import type { VpnStatus } from '@netpulse/shared';

import type { FastifyInstance } from 'fastify';

import { vpnError } from '../vpn/vpnService';
import { serializeVpnOp } from '../vpn/networkOwnership';

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

/** Promote a stored node into an engine profile.
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

/** A cloud failure reported as the HTTP status it actually is: an expired session
* is 401 (sign in again), an unreachable Worker is 502 (check your connection — the
* same wording the egress route uses for the same cause), and everything else keeps
* its own code so the UI can tell "not backed up yet" from "this engine cannot be
* backed up".
*/
function asHttpError(err: unknown): unknown {
  if (!(err instanceof ProfileCloudError)) return err;
  const status = err.code === 'cloud_unauthorized' ? 401 : err.code === 'cloud_unreachable' ? 502 : err.code === 'not_found' ? 404 : 409;
  const hint =
    err.code === 'cloud_unauthorized'
      ? 'Sign in to the cloud again, then retry the backup.'
      : err.code === 'cloud_unreachable'
        ? 'Start the tunnel or set a system proxy if the cloud is unreachable from here.'
        : undefined;
  return vpnError(status, err.code, err.message, hint);
}

/** The cloud sealer is built once at boot because it owns a key file. A build
* that somehow lacks it (an older context, a partially-migrated test double) must
* say so rather than silently skip the backup and report success.
*/
function requireProfileCloudVault(ctx: AppContext): ProfileCloudVault {
  const vault = ctx.services.profileCloudVault;
  if (!vault) {
    throw new AppError(503, 'cloud_backup_unavailable', 'Cloud profile backup is not available in this build.');
  }
  return vault;
}

/** Cloud backup requests carry the caller's cloud bearer token and nothing else.
*
* The token is a credential the browser already holds for its own account; what it
* replaces is a flow where the browser was handed a profile's real `configText`.
* `configText` is deliberately NOT a field here — there is no shape of this request
* that accepts or returns one.
*/
const CloudBackupSchema = z.object({
  accessToken: z.string().min(1).max(4096),
});

const CloudRestoreSchema = z.object({
  accessToken: z.string().min(1).max(4096),
  cloudProfileId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^np-local-[A-Za-z0-9_-]{1,64}$/, 'must be a cloud profile id created by this app'),
});

/** The single profile-creation path: a pasted config and a promoted node both
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
    // No endpoint: the summary IS the address the config dials, and a profile
    // promoted from a node would put that node's address back on the wire.
    // The repo insert above keeps it — the server needs it to connect.
    createdAt: profile.createdAt,
  };
}

async function runElevatedWireGuardConnect(ctx: AppContext, profileId: string, opId: string) {
  const profile = ctx.vpn.getProfile(profileId);
  if (!profile) throw new AppError(404, 'not_found', 'Profile not found');
  if (profile.providerId !== 'wireguard') {
    throw badRequest('elevation_unsupported', 'Per-action elevation is only available for WireGuard profiles');
  }
  const provider = ctx.vpn.get('wireguard');
  if (!provider) throw new AppError(400, 'unknown_provider', 'WireGuard provider is unavailable');
  const wg = provider as typeof provider & { prepareElevatedConnect?: (p: typeof profile) => string };
  if (!wg.prepareElevatedConnect) {
    throw badRequest('elevation_unsupported', 'The WireGuard provider does not support the elevation flow in this build');
  }
  const stagedConfigPath = wg.prepareElevatedConnect(profile);
  ctx.elevationBroker.registerWireGuardInstall({ opId, configPath: stagedConfigPath });
  ctx.repos.vpnProfiles.touch(profile.id);
  try {
    const outcome = await ctx.elevationBroker.wait(opId);
    if (!outcome.ok) {
      ctx.services.events.record('warn', 'vpn', outcome.declined ? 'Elevation prompt declined by user' : `Elevation failed: ${outcome.error ?? 'unknown error'}`);
      if (outcome.declined) {
        throw vpnError(403, 'elevation_declined', 'The tunnel was not installed because the elevation prompt was declined.', 'Press Connect again and accept the Windows prompt to install the tunnel.');
      }
      throw vpnError(500, 'elevation_failed', outcome.error ?? 'The elevated tunnel install did not complete.');
    }
    let status = await provider.status();
    if (!status.connected) {
      await new Promise((r) => setTimeout(r, 1_500));
      status = await provider.status();
      if (!status.connected) {
        throw vpnError(502, 'tunnel_not_up', 'The tunnel service was installed but no tunnel interface appeared. Check the endpoint and key material.', 'Try reconnecting; if it persists, the profile configuration may be invalid.');
      }
    }
    ctx.services.events.record('info', 'vpn', `WireGuard tunnel "${profile.name}" is up (elevated install)`);
    // Same rule as every other status surface: the dial address never leaves.
    return { outcome: 'connected' as const, status: publicStatus(status) };
  } finally {
    try { fs.rmSync(stagedConfigPath, { force: true }); } catch { /* best effort */ }
  }
}

/**
 * Hand the machine's network over from the proxy tunnel to an engine profile.
 *
 * Both modes write the system proxy, arm the kill switch and (in TUN form)
 * claim the default route — each capturing the value it must restore at ITS
 * own start time. Starting an engine while the tunnel still held those made
 * the two restore paths overwrite each other: whichever stopped second
 * "restored" a port the other mode had set, and traffic ended up on a dead
 * proxy or the kill-switch hold was released from under the survivor. The
 * only safe order is: previous owner fully releases, then the new mode starts
 * — with the tunnel's own internal chain, never nested inside another queued
 * section's re-entry (the caller already holds the ownership queue).
 */
async function stopTunnelForEngine(ctx: AppContext): Promise<void> {
  const tunnel = ctx.services.tunnel.getStatus();
  if (tunnel.state === 'idle') return;
  await ctx.services.tunnel.stop();
  ctx.services.events.record(
    'info',
    'vpn',
    `Proxy tunnel${tunnel.nodeName ? ` \"${tunnel.nodeName}\"` : ''} stopped to hand the network over to the VPN engine`,
  );
}

/**
 * A provider status without its dial address. The endpoint summary is
 * `host:port` — the profile's configuration — and for a profile promoted
 * from a node it is THAT node's address, which this app never hands back
 * (`endpointHidden` replaces it everywhere else). Spread + delete leaves the
 * key ABSENT (VpnStatus.endpoint is optional): withheld, not unknown, so no
 * surface renders it as a blank or null gap. Latency to the endpoint
 * survives — the measurement is still real and still useful.
 */
function publicStatus(status: VpnStatus): VpnStatus {
  if (status.endpoint === undefined) return status;
  const copy = { ...status };
  delete copy.endpoint;
  return copy;
}

export function registerVpnRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/vpn/providers', async () => ({
    providers: ctx.vpn.all().map((p) => p.info),
  }));
  app.get('/api/v1/vpn/killswitch', async () => ({
    killSwitch: ctx.services.killSwitch.status(),
  }));
  const readAdmin = (fresh: boolean) => {
    if (fresh) invalidatePrivilegeCache();
    return { admin: adminStatus({ tunGatewayCoreInstalled: findEngineBinary('sing-box') != null }) };
  };
  app.get('/api/v1/vpn/admin', async () => readAdmin(false));
  app.post('/api/v1/vpn/admin/recheck', async () => readAdmin(true));
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
      // endpoint withheld: the stored dial address is configuration, and for
      // a promoted node it is that node's endpoint. The repo row keeps it.
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
  app.get('/api/v1/vpn/profiles/:id/bundle', async (_req, reply) =>
    replyApiError(reply, 410, 'profile_bundle_retired', 'Profile configuration bundles are no longer served. Nothing in this app hands a stored configuration back to the client. Cloud backup and restore still work — they run on the server.'),
  );

  app.post(
    '/api/v1/vpn/profiles/:id/cloud-backup',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = CloudBackupSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw parsed.error;
      const vault = requireProfileCloudVault(ctx);
      const id = (req.params as { id: string }).id;
      if (!ctx.vpn.getProfile(id)) throw newNotFound(`Profile "${id}" not found`);
      const result = await pushProfileToCloud({ registry: ctx.vpn, vault }, id, parsed.data.accessToken).catch((err) => {
        throw asHttpError(err);
      });
      reply.status(200);
      // envelopeId, name, protocol — nothing that describes the config.
      return result;
    },
  );

  app.post(
    '/api/v1/vpn/profiles/cloud-restore',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = CloudRestoreSchema.safeParse(req.body ?? {});
      if (!parsed.success) throw parsed.error;
      const vault = requireProfileCloudVault(ctx);
      const source = await fetchCloudProfile({ registry: ctx.vpn, vault }, parsed.data.cloudProfileId, parsed.data.accessToken).catch(
        (err) => {
          throw asHttpError(err);
        },
      );
      const providerId = source.payload.providerId as ImportProviderId;
      if (!['wireguard', 'openvpn', 'singbox', 'aether'].includes(providerId)) {
        throw vpnError(400, 'restore_unsupported', `The backup names an engine this app does not have: "${providerId}".`);
      }
      // Imported through the one profile-creation path, so the restored profile is
      // byte-for-byte what a paste would have produced.
      const created = await importProfileVia(ctx, providerId, source.name, source.payload.configText);

      // New backup first (pushProfileToCloud re-keys under the new profile id):
      // an interruption here can lose the pointer, never the only copy.
      await pushProfileToCloud({ registry: ctx.vpn, vault }, created.id, parsed.data.accessToken).catch((err) => {
        throw asHttpError(err);
      });
      await tombstoneCloudProfile(parsed.data.accessToken, source.envelopeId, created.name, created.protocol).catch((err) => {
        throw asHttpError(err);
      });
      await deleteCloudBackup(parsed.data.accessToken, source.envelopeId).catch((err) => {
        throw asHttpError(err);
      });
      ctx.services.events.record('info', 'vpn', `VPN profile "${created.name}" restored from cloud backup`);
      reply.status(201);
      // id, providerId, name, protocol, createdAt — and no endpoint, because the
      // create path's endpoint summary is the address the restored profile dials.
      // `endpoint: undefined` drops the key from the JSON body (JSON omits undefined)
      // without leaving an unused binding behind.
      return { profile: { ...created, endpoint: undefined } };
    },
  );

  app.post(
    '/api/v1/vpn/profiles/from-node',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = FromNodeSchema.safeParse(req.body);
      if (!parsed.success) throw parsed.error;
      const node = ctx.repos.publicNodes.get(parsed.data.nodeId);
      if (!node) throw newNotFound(`Node "${parsed.data.nodeId}" not found`);

      // One owner for "rebuild a stored node's link": the node service reads the
      // row, takes the credential from the vault and round-trips the result through
      // the parser. This route only decides what to do with it.
      const built = ctx.services.nodes.shareLink(node.id) as LinkExport | null;

      // The default profile name must not be the endpoint: a node with no remark
      // used to name itself `host:port`, and the create response echoes the profile
      // — so an unnamed node would have put the address straight back on the wire.
      // `nodeLabel` supplies a name that is never an address, and we reuse the same
      // base through the 400 path so every branch names the same node.
      const baseName = (parsed.data.name ?? '').trim() || nodeLabel(node).slice(0, 100);

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

      const profile = await importProfileVia(ctx, 'singbox', baseName, built.link);
      ctx.services.events.record('info', 'vpn', `Node ${node.id} added to the sing-box engine as a profile`);

      // The response names WHICH node was promoted and nothing about how to reach it.
      // Two things had to come off for that to be true: `node.host`, `node.port`, and
      // then `profile.endpoint` — the promote response embeds the imported profile,
      // whose `endpoint` summary is `host:port`, so stripping the node fields alone
      // still put the address on the wire. The globe picker shows place and ping instead,
      // and neither the link nor the address leaves the server.
      //
      // `endpoint: undefined` rather than a spread-omit: JSON drops undefined values,
      // so the key is absent from the response body, and no local binding is left behind
      // for a later edit to accidentally re-add.
      const profileWithoutEndpoint = { ...profile, endpoint: undefined };
      reply.status(201);
      return { profile: profileWithoutEndpoint, node: { id: node.id, protocol: node.protocol } };
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
    const active = statuses.find((s) => s.connected);
    const blocking = ctx.services.killSwitch.status().blocking;
    if (active) return { ...publicStatus(active), killSwitchActive: active.killSwitchActive || blocking };
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
      return { connected: false, rxBytes: null, txBytes: null, handshakeAgeSec: null, endpointLatencyMs: null, note: 'No active tunnel' };
    }
    const provider = ctx.vpn.get(active.providerId);
    const health = provider?.health ? await provider.health().catch(() => null) : null;
    return {
      connected: true,
      providerId: active.providerId,
      serverName: active.serverName,
      protocol: active.protocol,
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

      // Desktop elevated flow: the UI mints an opId, arms the Rust bridge, and this
      // request long-polls until the UAC outcome lands.
      if (parsed.data.elevation?.opId) {
        ctx.services.events.record('info', 'vpn', `Elevated connect requested for "${profile.name}"`);
        // The elevated flow holds the ownership queue too: the network is
        // handed over from any active proxy tunnel at the moment the elevated
        // install runs, and nothing else may transition meanwhile.
        const result = await serializeVpnOp(async () => {
          await stopTunnelForEngine(ctx);
          return runElevatedWireGuardConnect(ctx, parsed.data.profileId, parsed.data.elevation!.opId);
        });
        ctx.services.events.record('info', 'vpn', `Connected VPN profile "${profile.name}" (elevated)`);
        return { status: publicStatus(result.status), outcome: result.outcome };
      }

      ctx.repos.vpnProfiles.touch(profile.id);
      const status = publicStatus(
        await serializeVpnOp(async () => {
          await stopTunnelForEngine(ctx);
          return provider.connect(profile);
        }),
      );
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
      const status = publicStatus(
        await serializeVpnOp(async () => {
          await stopTunnelForEngine(ctx);
          const statuses = await Promise.all(ctx.vpn.all().map((p) => p.status()));
        if (statuses.some((s) => s.connected)) {
          const activeProvider = ctx.vpn.get(statuses.find((s) => s.connected)!.providerId!);
          await activeProvider?.disconnect().catch(() => undefined);
        }
          return provider.connect(profile);
        }),
      );
      ctx.services.events.record('info', 'vpn', `Reconnected VPN profile "${profile.name}"`);
      return { status };
    },
  );

  app.post('/api/v1/vpn/disconnect', async () => {
    const status = await serializeVpnOp(async () => {
      // Deliberate: the drop watchdog must not read this as a crash and
      // reconnect the profile (or an in-flight reconnect chain of its own)
      // right after the user asked for the tunnel to be down.
      ctx.services.watchdog?.acknowledgeUserDisconnect();
      const statuses = await Promise.all(ctx.vpn.all().map((p) => p.status()));
      const active = statuses.find((s) => s.connected);
      let result: Awaited<ReturnType<VpnProvider['disconnect']>>;
      if (!active?.providerId) {
        const ks = ctx.services.killSwitch.status();
        if (ks.armed || ks.blocking) {
          const released = await ctx.services.killSwitch.onTunnelStopped();
          ctx.services.events.record('warn', 'vpn', 'Kill switch released by explicit disconnect — previous proxy restored');
          result = { connected: false, killSwitchReleased: true, note: released.note } as Awaited<ReturnType<VpnProvider['disconnect']>> & { killSwitchReleased: boolean; note: string | null };
        } else {
          result = { connected: false } as Awaited<ReturnType<VpnProvider['disconnect']>>;
        }
      } else {
        const provider = ctx.vpn.get(active.providerId);
        if (!provider) throw new AppError(500, 'provider_missing', 'Active provider disappeared');
        result = publicStatus(await provider.disconnect());
      }
      // "Disconnect" means the machine is offline from this app, not only the
      // engine profiles: the proxy tunnel is a connection too, and leaving it
      // up after an engine disconnect made the button look broken whenever the
      // tunnel was the active mode.
      const tunnel = ctx.services.tunnel.getStatus();
      if (tunnel.state !== 'idle') {
        await ctx.services.tunnel.stop();
        ctx.services.events.record(
          'info',
          'vpn',
          `Proxy tunnel${tunnel.nodeName ? ` \"${tunnel.nodeName}\"` : ''} stopped by disconnect`,
        );
      }
      return result;
    });
    ctx.services.events.record('info', 'vpn', 'VPN tunnel disconnected');
    return { status };
  });

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
      // A past session's dial address is configuration too. The row keeps it
      // in the DB; the response names the server, protocol and times without
      // it — the web's session line renders exactly those.
      connections: ctx.repos.vpnConnections.latest(limit).map((c) => {
        const copy = { ...c } as Partial<typeof c>;
        delete copy.endpoint;
        return copy;
      }),
    };
  });

  app.post('/api/v1/vpn/verify', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async () => {
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

