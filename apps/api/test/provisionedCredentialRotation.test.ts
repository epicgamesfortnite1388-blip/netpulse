import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { toShareLink } from '@netpulse/shared';
import { buildApp } from '../src/app';
import { NodeSecretVault } from '../src/services/nodeSecretVault';

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../src/routes/context';
import type { IcmpPingOptions, PlatformNetworkController } from '../src/providers/platform/types';
import type { PingResult, TcpProbeResult } from '@netpulse/shared';

/**
 * Rotated-credential repair, end to end over the real HTTP stack.
 *
 * This is the path the VPN surfaces' one-click refresh takes: the control plane
 * issues a config → `toShareLink` turns it into a share link → `POST
 * /api/v1/nodes/import` stores it and vaults the credential → the tunnel dials
 * that node. When the credential is re-issued, the second import is a DUPLICATE
 * (the fingerprint deliberately ignores the credential), so nothing would ever
 * update the vault without the replacement rule this test pins.
 *
 * It asserts the vault's real contents (read through the same encrypted file the
 * app writes), not just a count: "the server stopped publishing the old
 * credential" is not the same claim as "the app no longer holds it". The second
 * is what makes a repaired node work.
 */

class FakeController implements PlatformNetworkController {
  readonly id = 'fake';

  async icmpPing(ip: string, opts: IcmpPingOptions): Promise<PingResult> {
    const lats = Array.from({ length: opts.count }, (_, i) => 18 + i);
    return {
      method: 'icmp',
      target: ip,
      resolvedIp: ip,
      family: opts.family ?? 4,
      samples: lats.map((ms, i) => ({ seq: i + 1, ok: true, ms })),
      sent: opts.count,
      received: opts.count,
      lossPct: 0,
      min: Math.min(...lats),
      avg: lats.reduce((a, b) => a + b, 0) / lats.length,
      max: Math.max(...lats),
      median: 19,
      jitterMs: 1.2,
      durationMs: 5,
      parseQuality: 'full',
    };
  }

  async tcpProbe(): Promise<TcpProbeResult> {
    return { ok: true, ms: 18 };
  }

  async systemDnsServers(): Promise<string[]> {
    return ['1.1.1.1'];
  }

  async traceroute(): Promise<never> {
    throw new Error('not used');
  }

  async mtuProbe(): Promise<never> {
    throw new Error('not used');
  }

  async detectVpnBinaries(): Promise<Record<string, boolean>> {
    return { wireguard: false, openvpn: false, singbox: false };
  }
}

/** The Worker's VLESS/REALITY client config, with the credential substituted. */
function realityConfig(id: string) {
  return {
    protocol: 'vless',
    server: '206.1.96.89',
    port: 443,
    security: 'reality',
    network: 'tcp',
    flow: 'xtls-rprx-vision',
    serverName: 'www.microsoft.com',
    fingerprint: 'chrome',
    publicKey: 'CAS1AR2c9NrFKDMP1JVMIHx1y4_nxY8HqlemAGclsgU',
    shortId: '674622f7',
    id,
  };
}

const CREDENTIAL_A = '6ebe8dee-16a2-4b02-895f-e7c614965b98';
const CREDENTIAL_B = '0f9d1f2c-4a7b-4c3e-9d10-8b5f4a2c7e31';

let app: FastifyInstance;
let ctx: AppContext;
let tmpDir: string;
let vault: NodeSecretVault;
let cookieHeader: string;

/** The link the surfaces send: the control plane's config the tunnel can dial. */
function linkFor(credential: string): string {
  const conversion = toShareLink({
    id: 'vp_1',
    name: 'Xray VLESS Reality',
    protocol: 'xray-vless-reality',
    config: JSON.stringify(realityConfig(credential)),
  });
  if (!conversion.ok) throw new Error(`conversion failed: ${conversion.reason}`);
  return conversion.request.link;
}

async function importLinks(configs: string[]) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/nodes/import',
    headers: { cookie: cookieHeader },
    payload: { configs },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { imported: number; duplicates: number; invalid: number; nodeIds: string[]; credentialsUpdated: number };
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-rotation-'));
  const built = await buildApp({
    configOverrides: {
      dataDir: tmpDir,
      dbPath: path.join(tmpDir, 'test.db'),
      tokenFile: path.join(tmpDir, 'token'),
      webDist: path.join(tmpDir, 'no-dist'),
      isTest: true,
    },
    controller: new FakeController(),
  });
  app = built.app;
  ctx = built.ctx;
  // The same file the app writes: app.ts builds its vault at <dataDir>/secrets/vault.
  vault = new NodeSecretVault(path.join(tmpDir, 'secrets', 'vault'));

  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/session', remoteAddress: '127.0.0.1' });
  expect(res.statusCode).toBe(200);
  const cookie = res.cookies.find((c) => c.name === 'netpulse_session');
  cookieHeader = `netpulse_session=${cookie!.value}`;
});

afterAll(async () => {
  await app.close();
  ctx.db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('a re-issued subscription credential', () => {
  it('is found by the query the VPN surfaces use to detect provisioned profiles', async () => {
    const first = await importLinks([linkFor(CREDENTIAL_A)]);
    expect(first.imported).toBe(1);
    expect(first.credentialsUpdated).toBe(0);

    // Exactly the request ProvisionedRepairCard issues: the marker prefix the
    // provisioned configs carry in their remark.
    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/nodes?limit=200&search=${encodeURIComponent('NetPulse · ')}`,
      headers: { cookie: cookieHeader },
    });
    expect(listed.statusCode).toBe(200);
    const nodes = (listed.json() as { nodes: Array<{ id: string; label: string; remark: string | null }> }).nodes;
    expect(nodes.map((n) => n.id)).toContain(first.nodeIds[0]);

    const node = nodes.find((n) => n.id === first.nodeIds[0])!;
    // The marker survives to the surface in at least one of the two fields the
    // card tests, so detection does not depend on the remark alone.
    expect(`${node.remark ?? ''}${node.label}`).toContain('NetPulse · ');
  });

  it('replaces the stored credential in the vault instead of leaving the retired one', async () => {
    const nodeId = (await importLinks([linkFor(CREDENTIAL_A)])).nodeIds[0]!;
    expect(vault.get(nodeId)).toBe(CREDENTIAL_A);

    const rotated = await importLinks([linkFor(CREDENTIAL_B)]);

    expect(rotated.duplicates).toBe(1);
    expect(rotated.imported).toBe(0);
    expect(rotated.credentialsUpdated).toBe(1);
    // The claim that matters: the app no longer holds the retired credential.
    expect(vault.get(nodeId)).toBe(CREDENTIAL_B);
  });

  it('settles: re-importing the current credential changes nothing', async () => {
    expect((await importLinks([linkFor(CREDENTIAL_B)])).credentialsUpdated).toBe(0);
  });

  it('detects a credential that went backwards as a change, not as the same config', async () => {
    // A stale copy of the old config (an old email, a saved link) is still a
    // differing credential, and is reported as one rather than silently ignored.
    const stale = await importLinks([linkFor(CREDENTIAL_A)]);
    expect(stale.duplicates).toBe(1);
    expect(stale.credentialsUpdated).toBe(1);
  });
});
