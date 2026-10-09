import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../src/routes/context';
import type { PlatformNetworkController } from '../src/providers/platform/types';

/**
 * The raw-configuration boundary.
 *
 * Three routes used to put a provider's credential on the wire — the share link,
 * the bulk export, and the profile bundle. All three now answer 410 Gone. This
 * file is the adversarial half of that change, and it is deliberately written so
 * that restoring any one of the old handlers makes it fail:
 *
 *   - the status is asserted, so a reverted route (200) cannot pass;
 *   - the whole response body is scanned for the secret, so a route that kept
 *     answering while dropping the `link` field still cannot pass;
 *   - a node that does not exist gets the same 410 as one that does, so the
 *     tombstone cannot be probed for which nodes are real;
 *   - entitlement headers are sent anyway and change nothing, which pins the
 *     decision that this is NOT a premium gate with a way in.
 *
 * Hostnames rather than literal IPs: the parser refuses reserved ranges on
 * purpose, so an IP fixture would never import and would test nothing.
 */

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

/** The UUID every fixture below carries — the credential being hunted for. */
const SECRET_UUID = 'b831381d-6324-4d53-ad4f-8cda48b30811';

/** Distinct hosts keep each import a distinct fingerprint (a repeat is a duplicate). */
const vlessLink = (host: string) =>
  `vless://${SECRET_UUID}@${host}.retire-test.net:443?type=tcp&security=tls&sni=t.retire-test.net#Retire%20me`;

let app: FastifyInstance;
let ctx: AppContext;
let cookieHeader: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-retire-'));
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
});

afterAll(async () => {
  await app.close();
  ctx.db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const H = () => ({ cookie: cookieHeader, 'content-type': 'application/json' });

async function importOne(config: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/nodes/import', headers: H(), payload: { configs: [config] } });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { imported: number; nodeIds: string[] };
  expect(body.imported).toBe(1);
  return body.nodeIds[0]!;
}

/**
 * The actual assertion these routes have to pass: nothing recognisable as a
 * credential, an endpoint or a config document may appear anywhere in the
 * response. Scans the serialized body rather than named fields, because a route
 * could hide one in a field nobody thought to name.
 */
function expectNoRawConfig(body: string, host?: string) {
  const forbidden: Array<[string, RegExp]> = [
    ['a vless/vmess/trojan/ss URI', /\b(vless|vmess|trojan|ss|ssr|hysteria2|tuic):\/\//i],
    ['a sing-box or clash config document', /"(outbounds|proxies)"\s*:/],
    ['the credential', new RegExp(SECRET_UUID, 'i')],
    ['a base64-encoded config blob', /[A-Za-z0-9+/]{40,}={0,2}/],
  ];
  if (host) forbidden.push(['the node hostname', new RegExp(host.replace(/\./g, '\\.'), 'i')]);

  for (const [what, re] of forbidden) {
    expect(body, `response leaked ${what}`).not.toMatch(re);
  }
  for (const key of ['configText', 'link', 'data', 'password', 'uuid', 'secret']) {
    expect(body, `response carries a "${key}" key`).not.toContain(`"${key}"`);
  }
}

/** The three retired endpoints, with the code each one answers with. */
const RETIRED = [
  { name: 'GET /nodes/:id/link', path: (id: string) => `/api/v1/nodes/${id}/link`, code: 'share_link_retired' },
  { name: 'GET /nodes/export', path: (id: string) => `/api/v1/nodes/export?nodeIds=${id}&format=uri`, code: 'node_export_retired' },
] as const;

describe('retired raw-config routes answer 410 and disclose nothing', () => {
  it('refuses a share link for a node that really exists, with no credential in the body', async () => {
    const id = await importOne(vlessLink('gone1'));
    const res = await app.inject({ method: 'GET', url: `/api/v1/nodes/${id}/link`, headers: H() });

    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe('share_link_retired');
    expectNoRawConfig(res.body, 'gone1.retire-test.net');
  });

  it('refuses every export format, not just the one the old button used', async () => {
    const id = await importOne(vlessLink('gone2'));
    for (const format of ['uri', 'plaintext', 'base64', 'json', 'clash', 'singbox']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/nodes/export?nodeIds=${id}&format=${format}`,
        headers: H(),
      });
      expect(res.statusCode, `format=${format} was not refused`).toBe(410);
      expect(res.json().error.code).toBe('node_export_retired');
      expectNoRawConfig(res.body, 'gone2.retire-test.net');
    }
  });

  it('refuses a profile bundle, for a real profile and for a made-up id alike', async () => {
    const nodeId = await importOne(vlessLink('gone3'));
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/vpn/profiles/from-node',
      headers: H(),
      payload: { nodeId, name: 'Retire bundle' },
    });
    expect(created.statusCode).toBe(201);
    const profileId = (created.json() as { profile: { id: string } }).profile.id;

    for (const id of [profileId, 'profile:does-not-exist']) {
      const res = await app.inject({ method: 'GET', url: `/api/v1/vpn/profiles/${id}/bundle`, headers: H() });
      expect(res.statusCode, `bundle for ${id} was not refused`).toBe(410);
      expect(res.json().error.code).toBe('profile_bundle_retired');
      expectNoRawConfig(res.body);
    }
  });

  it('gives a node that does not exist the same answer, so the tombstone cannot be used to probe for real nodes', async () => {
    for (const { path, code } of RETIRED) {
      const res = await app.inject({ method: 'GET', url: path('node:does-not-exist'), headers: H() });
      expect(res.statusCode, `${code} leaked existence`).toBe(410);
      expect(res.json().error.code).toBe(code);
      expectNoRawConfig(res.body);
    }
  });

  it('does not answer differently for a caller claiming any entitlement', async () => {
    const id = await importOne(vlessLink('gone4'));
    // No tier system exists in this codebase; these headers are sent anyway so
    // that adding one later cannot quietly reopen the route.
    const premium = {
      ...H(),
      'x-plan': 'premium',
      'x-entitlement': 'raw-config',
      'x-license': 'pro',
      authorization: 'Bearer premium-admin-token',
    };
    const res = await app.inject({ method: 'GET', url: `/api/v1/nodes/${id}/link`, headers: premium });
    expect(res.statusCode).toBe(410);
    expectNoRawConfig(res.body, 'gone4.retire-test.net');
  });
});

describe('from-node promotes without describing the node', () => {
  it('creates the profile and returns no host, no port and no link', async () => {
    const nodeId = await importOne(vlessLink('promo1'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/vpn/profiles/from-node',
      headers: H(),
      payload: { nodeId, name: 'Picked from the globe' },
    });

    expect(res.statusCode).toBe(201);
    // The whole serialized body, not just `node` — this is what the picker path
    // actually receives, and it must not carry the endpoint either.
    expectNoRawConfig(res.body, 'promo1.retire-test.net');

    const body = res.json() as { profile: { id: string; name: string }; node: Record<string, unknown> };
    expect(body.profile.id).toBeTruthy();
    // Exactly two keys. Adding host/port back is the regression this pins.
    expect(Object.keys(body.node).sort()).toEqual(['id', 'protocol']);
    expect(body.node.protocol).toBe('vless');
  });

  it('still works for every node, which is what replaced the copy button', async () => {
    const nodeId = await importOne(vlessLink('promo2'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/vpn/profiles/from-node',
      headers: H(),
      payload: { nodeId },
    });
    expect(res.statusCode).toBe(201);
    // The profile really was created — retiring the read side must not have
    // quietly broken the write side the globe depends on.
    expect(ctx.vpn.getProfile((res.json() as { profile: { id: string } }).profile.id)).toBeDefined();
  });
});

describe('source URLs are masked on the way out', () => {
  it('never returns a stored subscription URL in the clear', async () => {
    const secretUrl = 'https://k7f2ab9cd.my-panel.example/subscribe/verylongtoken?token=alsosecret';
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sources',
      headers: H(),
      payload: { name: 'Masked panel', urls: [secretUrl] },
    });
    expect(created.statusCode).toBe(201);
    // The create response echoes the new source back, so it is masked too.
    expect(created.body).not.toContain('verylongtoken');
    expect(created.body).not.toContain('alsosecret');
    expect(created.body).not.toContain('k7f2ab9cd');

    // Stored in full, so fetching still works…
    const stored = ctx.repos.publicSources.get((created.json() as { id: string }).id);
    expect(stored!.urls).toContain(secretUrl);

    // …but neither read endpoint hands it over.
    const list = await app.inject({ method: 'GET', url: '/api/v1/sources', headers: H() });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain('verylongtoken');
    expect(list.body).not.toContain('alsosecret');
    expect(list.body).not.toContain('k7f2ab9cd');

    const single = await app.inject({ method: 'GET', url: `/api/v1/sources/${stored!.id}`, headers: H() });
    expect(single.statusCode).toBe(200);
    expect(single.body).not.toContain('verylongtoken');
    expect(single.body).not.toContain('alsosecret');
    expect(single.body).not.toContain('k7f2ab9cd');

    // The user can still tell it apart: the provider's domain survives.
    expect(list.body).toContain('my-panel.example');
  });

  it('masks a URL echoed back in a validation error', async () => {
    // A rejected URL can still be a real one (a private/self-hosted panel), and
    // the hint is the one place an unsanitized URL came back out.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sources',
      headers: H(),
      payload: { name: 'Local panel', urls: ['http://127.0.0.1:8080/sub?token=localsecret'] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain('localsecret');
  });
});