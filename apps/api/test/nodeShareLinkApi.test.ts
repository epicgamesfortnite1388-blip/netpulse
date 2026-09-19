import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';
import { parseNodeUri } from '../src/services/nodeParsers';

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../src/routes/context';
import type { PlatformNetworkController } from '../src/providers/platform/types';

/**
 * `GET /nodes/:id/link` — the copy button's backing endpoint.
 *
 * The contract this pins down: the link handed to the clipboard is the SAME
 * rebuilt link the engines receive, and a node that cannot produce a usable link
 * says why (200 + `ok:false` + `reason`) instead of handing over something that
 * would fail at connect time. Only a missing node is a 404.
 *
 * Hostnames rather than literal IPs, because the parser refuses reserved ranges
 * on purpose — an IP fixture would never parse and would test nothing.
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

/** Distinct hosts keep each test's node a distinct fingerprint (a repeat import
 *  is a duplicate and yields no node id). */
const vlessLink = (host: string) =>
  `vless://b831381d-6324-4d53-ad4f-8cda48b30811@${host}.link-test.net:443?type=tcp&security=tls&sni=t.link-test.net#Share%20node`;

/** ssr://base64(cred)@host:port/… — a stored protocol with no share link. */
const SSR = `ssr://${Buffer.from(
  `${Buffer.from('aes-256-cfb:pass').toString('base64')}@ssr1.link-test.net:8388/origin`,
).toString('base64url')}`;

let app: FastifyInstance;
let ctx: AppContext;
let cookieHeader: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-link-'));
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

const linkOf = (id: string) => app.inject({ method: 'GET', url: `/api/v1/nodes/${id}/link`, headers: H() });

describe('GET /nodes/:id/link', () => {
  it('rebuilds a share link that parses back to the same endpoint', async () => {
    const id = await importOne(vlessLink('share1'));
    const res = await linkOf(id);
    expect(res.statusCode).toBe(200);

    const body = res.json() as { ok: boolean; link?: string; protocol?: string };
    expect(body.ok).toBe(true);
    expect(body.protocol).toBe('vless');

    const parsed = parseNodeUri(body.link!);
    expect(parsed.protocol).toBe('vless');
    expect(parsed.result?.config.host).toBe('share1.link-test.net');
    expect(parsed.result?.config.port).toBe(443);
    // The credential survives: a link whose uuid was dropped would parse fine
    // and then fail authentication on every core.
    expect(body.link).toContain('b831381d-6324-4d53-ad4f-8cda48b30811');
  });

  it('returns exactly what the bulk export returns for the same node', async () => {
    const id = await importOne(vlessLink('share2'));
    const link = (await linkOf(id)).json() as { ok: boolean; link: string };
    const exported = await app.inject({ method: 'GET', url: `/api/v1/nodes/export?nodeIds=${id}&format=uri`, headers: H() });
    const envelope = exported.json() as { data: string; count: number };
    expect(envelope.count).toBe(1);
    expect(envelope.data).toBe(link.link);
  });

  it('refuses honestly when the credential never reached the vault', async () => {
    const id = await importOne(vlessLink('share3'));
    ctx.services.nodeVault!.delete(id);

    const res = await linkOf(id);
    // 200, not an error: the reason IS the answer the copy button has to show.
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toMatch(/credential/i);
  });

  it('refuses a protocol that has no share link at all', async () => {
    const id = await importOne(SSR);
    const body = (await linkOf(id)).json() as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toMatch(/ShadowsocksR/i);
  });

  it('404s a node that does not exist instead of inventing an empty link', async () => {
    const res = await linkOf('node:does-not-exist');
    expect(res.statusCode).toBe(404);
  });
});
