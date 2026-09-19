import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../src/routes/context';
import type { PlatformNetworkController } from '../src/providers/platform/types';

/**
 * Engine intake — "add what I found to the engine, now".
 *
 * Two flows are covered end to end, because they are the two ways a config
 * actually reaches this app: a link the user pasted, and a node already stored
 * (whose credential lives in the vault, not the database). Both must produce a
 * usable result or an honest refusal — never a profile that could only fail at
 * connect time, and never a node attributed to a source that does not exist.
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

// Hostnames, not literal IPs: the parser refuses reserved/test-range addresses
// on purpose (target policies), so a fixture using 198.51.100.x could never
// parse and would test nothing.
const VLESS_REALITY =
  'vless://b831381d-6324-4d53-ad4f-8cda48b30811@nl1.intake-test.net:443?type=tcp&security=reality&sni=www.example.com&pbk=PBK1&sid=ab12&fp=chrome&flow=xtls-rprx-vision#Amsterdam%20relay';
const TROJAN = 'trojan://troj4n-pass@tr1.intake-test.net:443?sni=t.example.com&type=ws&path=%2Fws#Trojan%20node';

let app: FastifyInstance;
let ctx: AppContext;
let cookieHeader: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-intake-'));
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
  const cookie = res.cookies.find((c) => c.name === 'netpulse_session');
  cookieHeader = `netpulse_session=${cookie!.value}`;
});

afterAll(async () => {
  await app.close();
  ctx.db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const H = () => ({ cookie: cookieHeader, 'content-type': 'application/json' });

async function importConfigs(configs: string[]) {
  return app.inject({ method: 'POST', url: '/api/v1/nodes/import', headers: H(), payload: { configs } });
}

describe('POST /nodes/import — adding a config you found', () => {
  it('stores a pasted share link as a node with no invented source', async () => {
    const res = await importConfigs([VLESS_REALITY]);
    expect(res.statusCode).toBe(201);
    const body = res.json() as { imported: number; duplicates: number; invalid: number; nodeIds: string[] };
    expect(body.imported).toBe(1);
    expect(body.invalid).toBe(0);
    expect(body.nodeIds).toHaveLength(1);

    const node = ctx.repos.publicNodes.get(body.nodeIds[0]!);
    expect(node).not.toBeNull();
    expect(node!.protocol).toBe('vless');
    expect(node!.host).toBe('nl1.intake-test.net');
    expect(node!.security).toBe('reality');
    // A manual config has no feed behind it: attributing it to a source would
    // put a fiction in the Sources page.
    expect(node!.sourceIds).toEqual([]);
    expect(node!.sourceCount).toBe(0);
  });

  it('counts a repeat of the same config as a duplicate instead of adding it again', async () => {
    const res = await importConfigs([VLESS_REALITY]);
    expect(res.statusCode).toBe(201);
    const body = res.json() as { imported: number; duplicates: number; invalid: number };
    expect(body.imported).toBe(0);
    expect(body.duplicates).toBe(1);
  });

  it('reports malformed input as invalid rather than storing something unusable', async () => {
    const res = await importConfigs(['not-a-config', 'ss://%%%broken']);
    expect(res.statusCode).toBe(201);
    const body = res.json() as { imported: number; duplicates: number; invalid: number; nodeIds: string[] };
    expect(body.imported).toBe(0);
    expect(body.invalid).toBe(2);
    expect(body.nodeIds).toEqual([]);
  });

  it('rejects an empty or oversized payload at the boundary', async () => {
    const empty = await importConfigs([]);
    expect(empty.statusCode).toBe(400);
    const tooMany = await importConfigs(Array.from({ length: 201 }, () => TROJAN));
    expect(tooMany.statusCode).toBe(400);
  });
});

describe('POST /vpn/profiles/from-node — promoting a node into an engine profile', () => {
  let vlessNodeId: string;

  beforeAll(async () => {
    // VLESS was already imported by the earlier describe block, so it comes
    // back here as a duplicate and does not appear in nodeIds (which lists
    // only created rows). Look the node up by fingerprint instead of assuming
    // the batch created it.
    await importConfigs([VLESS_REALITY, TROJAN]);
    const { buildFingerprint, fingerprintHash } = await import('../src/services/nodeParsers');
    const parsed = (await import('../src/services/nodeParsers')).parseNodeUri(VLESS_REALITY);
    const fpHash = parsed.result ? fingerprintHash(buildFingerprint(parsed.result.config)) : null;
    const row = fpHash ? ctx.repos.publicNodes.getByFingerprint(fpHash) : undefined;
    vlessNodeId = row?.id ?? '';
    expect(vlessNodeId).toBeTruthy();
  });

  it('creates a sing-box profile from the stored node, credential and all', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/vpn/profiles/from-node',
      headers: H(),
      payload: { nodeId: vlessNodeId },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { profile: { id: string; providerId: string; name: string; protocol: string }; node: { id: string } };
    expect(body.profile.providerId).toBe('singbox');
    expect(body.profile.name).toBe('Amsterdam relay');
    expect(body.node.id).toBe(vlessNodeId);

    const listed = await app.inject({ method: 'GET', url: '/api/v1/vpn/profiles', headers: H() });
    const profiles = (listed.json() as { profiles: Array<{ id: string }> }).profiles;
    expect(profiles.some((p) => p.id === body.profile.id)).toBe(true);

    await app.inject({ method: 'DELETE', url: `/api/v1/vpn/profiles/${body.profile.id}`, headers: H() });
  });

  it('refuses a node with no vaulted credential instead of writing an unusable profile', async () => {
    // A node whose credential never reached the vault cannot be dialled at all;
    // emitting a link with an empty uuid would only fail later, at connect time.
    const vault = ctx.services.nodeVault!;
    const secret = vault.get(vlessNodeId);
    expect(secret).toBeTruthy();
    vault.delete(vlessNodeId);

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/vpn/profiles/from-node',
        headers: H(),
        payload: { nodeId: vlessNodeId },
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.stringify(res.json())).toContain('node_not_exportable');
      expect(JSON.stringify(res.json())).toMatch(/credential/i);
    } finally {
      vault.set(vlessNodeId, secret!);
    }
  });

  it('404s for an unknown node instead of creating an empty profile', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/vpn/profiles/from-node',
      headers: H(),
      payload: { nodeId: 'node:does-not-exist' },
    });
    expect(res.statusCode).toBe(404);
  });
});
