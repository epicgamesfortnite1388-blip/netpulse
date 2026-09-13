import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../src/routes/context';

// The platform controller is never invoked in these tests (no WireGuard
// binary in CI), but the app requires one — a throwing fake documents that
// expectation loudly if a code path ever reaches the OS layer.
class NoBinariesController {
  readonly id = 'fake-none';
  async icmpPing(): Promise<never> {
    throw new Error('not expected in this test');
  }
  async tcpProbe(): Promise<never> {
    throw new Error('not expected in this test');
  }
  async systemDnsServers(): Promise<string[]> {
    return ['1.1.1.1'];
  }
  async traceroute(): Promise<never> {
    throw new Error('not expected in this test');
  }
  async mtuProbe(): Promise<never> {
    throw new Error('not expected in this test');
  }
  async detectVpnBinaries(): Promise<Record<string, boolean>> {
    return { wireguard: false, openvpn: false, singbox: false };
  }
}

let app: FastifyInstance;
let ctx: AppContext;
let cookieHeader: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-vpn-'));
  const built = await buildApp({
    configOverrides: {
      dataDir: tmpDir,
      dbPath: path.join(tmpDir, 'test.db'),
      tokenFile: path.join(tmpDir, 'token'),
      webDist: path.join(tmpDir, 'no-dist'),
      isTest: true,
    },
    controller: new NoBinariesController() as never,
  });
  app = built.app;
  ctx = built.ctx;

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/session',
    remoteAddress: '127.0.0.1',
  });
  const cookie = res.cookies.find((c) => c.name === 'netpulse_session');
  cookieHeader = `netpulse_session=${cookie!.value}`;
});

afterAll(async () => {
  await app.close();
  ctx.db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function get(url: string) {
  return app.inject({ method: 'GET', url, headers: { cookie: cookieHeader } });
}
function post(url: string, payload?: unknown) {
  return app.inject({ method: 'POST', url, headers: { cookie: cookieHeader }, payload });
}
function del(url: string) {
  return app.inject({ method: 'DELETE', url, headers: { cookie: cookieHeader } });
}

describe('vpn profile lifecycle', () => {
  it('imports a sing-box profile, persists it, and exposes it via the API', async () => {
    const link = 'vless://11111111-2222-3333-4444-555555555555@example.com:443?security=tls&type=tws#TestNode';
    const created = await post('/api/v1/vpn/profiles', {
      providerId: 'singbox',
      name: 'Test tunnel',
      configText: link,
    });
    expect(created.statusCode).toBe(201);
    const profile = created.json().profile;
    expect(profile.protocol).toBe('vless');
    expect(profile.endpoint).toBe('example.com:443');
    expect(JSON.stringify(profile)).not.toContain('11111111'); // secret never echoed

    // visible through the API
    const list = await get('/api/v1/vpn/profiles');
    expect(list.json().profiles.some((p: { id: string }) => p.id === profile.id)).toBe(true);

    // durable: row exists in SQLite with the secret only as a vault reference
    const row = ctx.repos.vpnProfiles.get(profile.id);
    expect(row).toBeDefined();
    expect(row!.providerId).toBe('singbox');
    expect(row!.secretRef).not.toContain('11111111');

    // sanitized config on disk must not contain the credential
    const onDisk = fs.readFileSync(row!.configPath, 'utf8');
    expect(onDisk).toContain('<stored in vault>');
    expect(onDisk).not.toContain('11111111');

    // vault file exists and is not readable plaintext (the vault base file is
    // `<dataDir>/secrets`, and FileSecretVault appends a hash per ref)
    const vaultFiles = fs.readdirSync(tmpDir).filter((f) => f.startsWith('secrets.'));
    expect(vaultFiles.length).toBeGreaterThan(0);
    const vaultBlob = fs.readFileSync(path.join(tmpDir, vaultFiles[0]!), 'utf8');
    expect(vaultBlob).not.toContain('11111111');

    // cleanup for the following assertions
    await del(`/api/v1/vpn/profiles/${profile.id}`);
    expect(ctx.repos.vpnProfiles.get(profile.id)).toBeUndefined();
    expect(fs.existsSync(row!.configPath)).toBe(false);
  });

  it('rejects malformed share links with a 400', async () => {
    const res = await post('/api/v1/vpn/profiles', {
      providerId: 'singbox',
      name: 'bad',
      configText: 'https://not-a-supported-scheme.example',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_config');
  });

  it('rejects unknown providers', async () => {
    const res = await post('/api/v1/vpn/profiles', {
      providerId: 'nessus',
      name: 'x',
      configText: 'y',
    });
    expect(res.statusCode).toBe(400);
  });

  it('404s when deleting an unknown profile', async () => {
    const res = await del(`/api/v1/vpn/profiles/${crypto.randomUUID()}`);
    expect(res.statusCode).toBe(404);
  });

  it('connect fails honestly with 501 when the engine is not installed', async () => {
    const created = await post('/api/v1/vpn/profiles', {
      providerId: 'singbox',
      name: 'unreachable',
      configText: 'trojan://pw@1.2.3.4:443#t',
    });
    expect(created.statusCode).toBe(201);
    const profileId = created.json().profile.id as string;

    const res = await post('/api/v1/vpn/connect', { profileId });
    expect(res.statusCode).toBe(501);
    expect(res.json().error.code).toBe('singbox_missing');

    // a 501 means nothing was attempted, so no session row may exist
    const conns = await get('/api/v1/vpn/connections');
    const attempt = conns.json().connections.find((c: { serverName: string | null }) => c.serverName === 'unreachable');
    expect(attempt).toBeUndefined();

    await del(`/api/v1/vpn/profiles/${profileId}`);
  });

  it('health endpoint reports no-tunnel state honestly', async () => {
    const res = await get('/api/v1/vpn/health');
    expect(res.statusCode).toBe(200);
    expect(res.json().connected).toBe(false);
    expect(res.json().note).toContain('No active tunnel');
  });

  it('exposes the singbox provider with protocol capabilities', async () => {
    const res = await get('/api/v1/vpn/providers');
    const sb = res.json().providers.find((p: { id: string }) => p.id === 'singbox');
    expect(sb).toBeDefined();
    expect(sb.available).toBe(false); // CI has no sing-box binary
    expect(sb.protocols).toEqual(expect.arrayContaining(['vless', 'vmess', 'trojan', 'shadowsocks']));
  });
});
