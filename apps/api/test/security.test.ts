import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';
import { assertPublicDohUrl } from '../src/providers/dns/resolver';
import { wgTunnelNameForProfile } from '../src/vpn/vpnService';
import { isPrivateIp } from '../src/util/targetGuard';

describe('security regression', () => {
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let ctx: Awaited<ReturnType<typeof buildApp>>['ctx'];
  let cookieHeader: string;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-sec-'));
    const built = await buildApp({
      configOverrides: {
        dataDir: tmpDir,
        dbPath: path.join(tmpDir, 'test.db'),
        tokenFile: path.join(tmpDir, 'token'),
        webDist: path.join(tmpDir, 'no-dist'),
        isTest: true,
      },
    });
    app = built.app;
    ctx = built.ctx;
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/session', remoteAddress: '127.0.0.1' });
    const cookie = res.cookies.find((c) => c.name === 'netpulse_session');
    expect(cookie).toBeDefined();
    cookieHeader = `netpulse_session=${cookie!.value}`;
  });

  afterAll(async () => {
    await app.close();
    ctx.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('DoH SSRF guard', () => {
    it('accepts a public https DoH endpoint', () => {
      expect(() => assertPublicDohUrl('https://cloudflare-dns.com/dns-query?dns')).not.toThrow();
      expect(() => assertPublicDohUrl('https://9.9.9.9/dns-query')).not.toThrow();
    });

    it('rejects plain http and non-http schemes', () => {
      expect(() => assertPublicDohUrl('http://cloudflare-dns.com/dns-query')).toThrow(/https/);
      expect(() => assertPublicDohUrl('file:///etc/passwd')).toThrow();
      expect(() => assertPublicDohUrl('gopher://example.com')).toThrow();
    });

    it('rejects loopback, private and metadata literal hosts', () => {
      expect(() => assertPublicDohUrl('https://127.0.0.1/dns-query')).toThrow(/private|loopback|metadata/i);
      expect(() => assertPublicDohUrl('https://169.254.169.254/dns-query')).toThrow(/private|loopback|metadata/i);
      expect(() => assertPublicDohUrl('https://10.0.0.1/dns-query')).toThrow(/private|loopback|metadata/i);
      expect(() => assertPublicDohUrl('https://[::1]/dns-query')).toThrow(/private|loopback|metadata/i);
    });
  });

  describe('private-range coverage', () => {
    it('classifies cloud metadata and CGNAT ranges as private', () => {
      expect(isPrivateIp('169.254.169.254')).toBe(true); // AWS/GCP metadata
      expect(isPrivateIp('100.100.100.100')).toBe(true); // Alibaba metadata (CGNAT)
      expect(isPrivateIp('127.0.0.1')).toBe(true);
      expect(isPrivateIp('::1')).toBe(true);
      expect(isPrivateIp('fe80::1')).toBe(true);
      expect(isPrivateIp('1.1.1.1')).toBe(false);
      expect(isPrivateIp('9.9.9.9')).toBe(false);
    });
  });

  describe('ws ticket endpoint', () => {
    it('rejects unauthenticated ticket minting', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/ws/ticket' });
      expect(res.statusCode).toBe(401);
    });

    it('mints a single-use shaped ticket for an authenticated session', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/ws/ticket',
        headers: { cookie: cookieHeader },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { ticket: string; expiresInMs: number };
      expect(body.ticket).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes, hex
      expect(body.expiresInMs).toBeLessThanOrEqual(30_000);
    });
  });

  describe('custom resolver route validation', () => {
    it('rejects non-https DoH URLs at admission', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/dns/providers/custom',
        headers: { cookie: cookieHeader, 'content-type': 'application/json' },
        payload: {
          id: 'sec-test-1',
          name: 'Evil Resolver',
          dohUrl: 'http://169.254.169.254/dns-query',
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects DoT hosts with non-hostname characters', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/dns/providers/custom',
        headers: { cookie: cookieHeader, 'content-type': 'application/json' },
        payload: {
          id: 'sec-test-2',
          name: 'Sneaky DoT',
          dotHost: 'evil.example.com/../../x',
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('accepts a legitimate public custom resolver', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/dns/providers/custom',
        headers: { cookie: cookieHeader, 'content-type': 'application/json' },
        payload: {
          id: crypto.randomUUID().slice(0, 8),
          name: 'Mullvad DoH (sec test)',
          dohUrl: 'https://dns.mullvad.net/dns-query',
        },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('wireguard tunnel naming', () => {
    it('derives service names from UUID profile ids (no path/command metacharacters)', () => {
      const id = crypto.randomUUID();
      const name = wgTunnelNameForProfile(id);
      expect(name).toBe(`netpulse-wg-${id}`);
      expect(name).not.toMatch(/[\\/:"*?<>|&;$\s]/);
    });
  });
});
