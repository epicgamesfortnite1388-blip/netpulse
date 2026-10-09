import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Cloud profile backup and restore, end to end on the server.
 *
 * The flow this pins down replaced one that rendered a config to the user: the
 * webview used to ask for a profile's `configText`, encrypt it, upload it, and —
 * to restore — decrypt it back into the page and post the plaintext back. Now
 * the API reads the config from its file vault, seals it, uploads it, and on
 * restore pulls it back and imports it through the same path a pasted config
 * takes. The browser sends a bearer token and gets a profile id.
 *
 * Two properties matter more than the happy path, so they are asserted on the
 * whole serialized body rather than on named fields:
 *
 *   1. No response from either route may contain a config — not the credential,
 *      not the endpoint, not a config document.
 *   2. A restored profile must really exist and be importable again, because a
 *      restore that returns a nice response and no working profile is worse than
 *      one that fails.
 *
 * The cloud is faked at the egress seam, so no network and no credentials are
 * needed, and every request the server makes is captured for inspection.
 */

const cloudCalls: Array<{ method: string; path: string; body: unknown; headers: Record<string, string> }> = [];
/** The fake Worker's stored blobs, keyed by cloud profile id. */
const cloudStore = new Map<string, { ciphertext: string; updatedAt: number }>();
/** The fake Worker's profile rows, keyed by cloud profile id. */
const cloudProfiles = new Map<string, { id: string; name: string; protocol: string; endpoint: string | null }>();

/** Force the next cloud call to answer with this status (for the failure paths). */
let forcedStatus: number | null = null;

vi.mock('../src/services/egressProxy', async (importOriginal) => {
  const actual = await importOriginal<typeof EgressProxyModule>();
  return {
    ...actual,
    egressFetch: async (req: { url: string; method: string; headers: Record<string, string>; body?: string }) => {
      const url = new URL(req.url);
      cloudCalls.push({ method: req.method, path: url.pathname, body: req.body ? JSON.parse(req.body) : undefined, headers: req.headers });
      if (forcedStatus != null) return { status: forcedStatus, headers: {}, body: '{}' };

      const json = (status: number, payload: unknown) => ({ status, headers: {}, body: JSON.stringify(payload) });

      if (url.pathname === '/api/v1/profile-vaults' && req.method === 'GET') {
        return json(200, {
          vaults: [...cloudStore].map(([profileId, v]) => ({ profileId, ciphertext: v.ciphertext, updatedAt: v.updatedAt })),
        });
      }
      if (url.pathname === '/api/v1/profile-vaults' && req.method === 'PUT') {
        const b = JSON.parse(req.body!) as { profileId: string; ciphertext: string; updatedAt: number };
        cloudStore.set(b.profileId, { ciphertext: b.ciphertext, updatedAt: b.updatedAt });
        return json(200, { ok: true, updatedAt: b.updatedAt });
      }
      if (url.pathname === '/api/v1/profile-vaults/delete' && req.method === 'POST') {
        const b = JSON.parse(req.body!) as { profileId: string };
        cloudStore.delete(b.profileId);
        return json(200, { ok: true, removed: true });
      }
      if (url.pathname === '/api/v1/profiles' && req.method === 'GET') {
        return json(200, { profiles: [...cloudProfiles.values()] });
      }
      if (url.pathname === '/api/v1/profiles' && req.method === 'PUT') {
        const b = JSON.parse(req.body!) as { id: string; name: string; protocol: string; endpoint?: string | null; deleted?: boolean };
        if (b.deleted) cloudProfiles.delete(b.id);
        else cloudProfiles.set(b.id, { id: b.id, name: b.name, protocol: b.protocol, endpoint: b.endpoint ?? null });
        return json(200, { ok: true, updatedAt: Date.now() });
      }
      return json(404, { error: { code: 'not_found', message: 'no fake route' } });
    },
  };
});

import { buildApp } from '../src/app';
import { buildProfileBundle } from '../src/services/profileBundle';

import type * as EgressProxyModule from '../src/services/egressProxy';

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../src/routes/context';
import type { PlatformNetworkController } from '../src/providers/platform/types';

/** The credential that must never appear in any response body. */
const SECRET_UUID = 'b831381d-6324-4d53-ad4f-8cda48b30811';
const NODE_HOST = 'cloudsync.retire-test.net';

class IdleController implements PlatformNetworkController {
  readonly id = 'idle';
  async icmpPing(): Promise<never> {
    throw new Error('network disabled in tests');
  }
  async tcpProbe(): Promise<never> {
    throw new Error('network disabled in tests');
  }
  async systemDnsServers(): Promise<string[]> {
    return [];
  }
  async traceroute(): Promise<never> {
    throw new Error('network disabled in tests');
  }
  async mtuProbe(): Promise<never> {
    throw new Error('network disabled in tests');
  }
  async detectVpnBinaries(): Promise<Record<string, boolean>> {
    return { wireguard: false, openvpn: false, singbox: false };
  }
}

let app: FastifyInstance;
let ctx: AppContext;
let cookieHeader: string;
let tmpDir: string;
let nodeId: string;
let profileId: string;

const TOKEN = 'test-cloud-access-token';

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-cloudsync-'));
  const built = await buildApp({
    configOverrides: {
      dataDir: tmpDir,
      dbPath: path.join(tmpDir, 'test.db'),
      tokenFile: path.join(tmpDir, 'token'),
      webDist: path.join(tmpDir, 'no-dist'),
      isTest: true,
    },
    controller: new IdleController(),
  });
  app = built.app;
  ctx = built.ctx;
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/session', remoteAddress: '127.0.0.1' });
  cookieHeader = `netpulse_session=${res.cookies.find((c) => c.name === 'netpulse_session')!.value}`;

  const imported = await app.inject({
    method: 'POST',
    url: '/api/v1/nodes/import',
    headers: H(),
    payload: { configs: [`vless://${SECRET_UUID}@${NODE_HOST}:443?type=tcp&security=tls&sni=t.${NODE_HOST}#CloudSync`] },
  });
  nodeId = (imported.json() as { nodeIds: string[] }).nodeIds[0]!;

  const promoted = await app.inject({
    method: 'POST',
    url: '/api/v1/vpn/profiles/from-node',
    headers: H(),
    payload: { nodeId, name: 'Cloud synced' },
  });
  expect(promoted.statusCode).toBe(201);
  profileId = (promoted.json() as { profile: { id: string } }).profile.id;
});

afterAll(async () => {
  await app.close();
  ctx.db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  cloudCalls.length = 0;
  cloudStore.clear();
  cloudProfiles.clear();
  forcedStatus = null;
});

const H = () => ({ cookie: cookieHeader, 'content-type': 'application/json' });

/**
 * The invariant both routes exist to protect. Scans the serialized body for
 * anything recognisable as the credential, the endpoint or a config document —
 * a route could drop a named field and still leak through one nobody checked.
 */
function expectNoConfigLeak(body: string) {
  const forbidden: Array<[string, RegExp]> = [
    ['a share-link URI', /\b(vless|vmess|trojan|ss|ssr|hysteria2|tuic):\/\//i],
    ['the credential', new RegExp(SECRET_UUID, 'i')],
    ['the node hostname', new RegExp(NODE_HOST.replace(/\./g, '\\.'), 'i')],
    ['an engine config document', /"(outbounds|outbound|uuid|password|server)"\s*:/],
    ['a base64 config blob', /[A-Za-z0-9+/]{40,}={0,2}/],
  ];
  for (const [what, re] of forbidden) expect(body, `response leaked ${what}`).not.toMatch(re);
  for (const key of ['configText', 'config', 'link', 'blob', 'ciphertext']) {
    expect(body, `response carries a "${key}" key`).not.toContain(`"${key}"`);
  }
}

describe('cloud profile backup is server-side', () => {
  it('backs a profile up without sending a config to the client', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/vpn/profiles/${profileId}/cloud-backup`,
      headers: H(),
      payload: { accessToken: TOKEN },
    });

    expect(res.statusCode).toBe(200);
    expectNoConfigLeak(res.body);
    const body = res.json() as { envelopeId: string; name: string; protocol: string };
    expect(body.envelopeId).toBe(`np-local-${profileId}`);
    expect(body.name).toBe('Cloud synced');

    // The server really did upload a sealed blob for this profile.
    expect(cloudStore.has(`np-local-${profileId}`)).toBe(true);
    const put = cloudCalls.find((c) => c.method === 'PUT' && c.path === '/api/v1/profile-vaults');
    expect(put, 'no vault PUT was made').toBeDefined();
    // …and what it uploaded is opaque, not the config wearing a costume. A
    // sealed blob legitimately looks like base64, so "is it base64?" proves
    // nothing; what matters is that decoding it yields neither the credential
    // nor a readable config document.
    expectSealedNotReadable((put!.body as { ciphertext: string }).ciphertext);
  });

  it('reports a profile it cannot back up rather than claiming success', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/vpn/profiles/profile:does-not-exist/cloud-backup',
      headers: H(),
      payload: { accessToken: TOKEN },
    });
    expect(res.statusCode).toBe(404);
    expectNoConfigLeak(res.body);
    expect(cloudStore.size).toBe(0);
  });

  it('surfaces an expired cloud session as 401, not as a silent skip', async () => {
    forcedStatus = 401;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/vpn/profiles/${profileId}/cloud-backup`,
      headers: H(),
      payload: { accessToken: TOKEN },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('cloud_unauthorized');
  });
});

describe('cloud profile restore never puts a config in the browser', () => {
  it('restores through the engine import path and returns only an id and a name', async () => {
    // Back up first, then delete the local profile so the restore is real.
    await app.inject({
      method: 'POST',
      url: `/api/v1/vpn/profiles/${profileId}/cloud-backup`,
      headers: H(),
      payload: { accessToken: TOKEN },
    });
    const sealed = cloudStore.get(`np-local-${profileId}`)!.ciphertext;

    // Drop the local copy: without this the restore could be a no-op that looks
    // like success because the original profile is still there.
    const before = ctx.vpn.listProfiles().length;
    ctx.vpn.removeProfile(profileId);
    expect(ctx.vpn.listProfiles().length).toBe(before - 1);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/vpn/profiles/cloud-restore',
      headers: H(),
      payload: { accessToken: TOKEN, cloudProfileId: `np-local-${profileId}` },
    });

    expect(res.statusCode).toBe(201);
    expectNoConfigLeak(res.body);
    const body = res.json() as { profile: { id: string; name: string } };
    expect(body.profile.name).toBe('Cloud synced');
    expect(body.profile.id).not.toBe(profileId);

    // The restored profile exists and can be materialised again — the property
    // that makes this a restore rather than a receipt.
    const restored = ctx.vpn.getProfile(body.profile.id);
    expect(restored, 'restored profile is not in the registry').toBeDefined();
    const bundle = buildBundleFor(body.profile.id);
    expect(bundle.configText, 'restored config lost its credential').toContain(SECRET_UUID);

    // The backup was re-keyed to the new id and the old envelope retired.
    expect(cloudStore.has(`np-local-${body.profile.id}`)).toBe(true);
    expect(cloudStore.has(`np-local-${profileId}`)).toBe(false);
    expect(cloudProfiles.has(`np-local-${profileId}`)).toBe(false);
    expect(sealed).not.toContain(SECRET_UUID);
  });

  it('refuses a cloud id that is not one this app created', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/vpn/profiles/cloud-restore',
      headers: H(),
      payload: { accessToken: TOKEN, cloudProfileId: '../../etc/passwd' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('says a legacy browser-encrypted blob is unreadable rather than failing vaguely', async () => {
    // Blobs written by the old webview path were sealed with the account's
    // password-derived key, which this process has never had. The honest answer
    // is "this backup was encrypted elsewhere", not a generic import failure.
    cloudStore.set('np-local-legacy', { ciphertext: Buffer.from('not-sealed-by-us').toString('base64'), updatedAt: 1 });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/vpn/profiles/cloud-restore',
      headers: H(),
      payload: { accessToken: TOKEN, cloudProfileId: 'np-local-legacy' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('legacy_blob_unreadable');
    expectNoConfigLeak(res.body);
  });

  it('404s a cloud backup that is not there', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/vpn/profiles/cloud-restore',
      headers: H(),
      payload: { accessToken: TOKEN, cloudProfileId: 'np-local-missing' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });
});

/**
 * A sealed blob must be opaque: decoding it yields neither the credential nor a
 * readable config document. Comparing raw text is not enough — AES-256-GCM
 * output is high-entropy base64 by construction, so the only honest question is
 * whether the bytes are recoverable without the vault key.
 */
function expectSealedNotReadable(ciphertext: string) {
  const decoded = Buffer.from(ciphertext, 'base64').toString('utf8');
  expect(decoded, 'the uploaded blob decodes to the credential').not.toContain(SECRET_UUID);
  expect(decoded, 'the uploaded blob decodes to a config document').not.toContain('outbound');
  expect(decoded, 'the uploaded blob decodes to a share link').not.toMatch(/\b(vless|vmess|trojan):\/\//i);
}

/** Read a profile's real config back out — server-side only, never over HTTP. */
function buildBundleFor(id: string): { configText: string } {
  return buildProfileBundle(ctx.vpn, id);
}