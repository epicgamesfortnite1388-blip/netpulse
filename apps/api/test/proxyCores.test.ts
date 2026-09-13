import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildSingboxConfig,
  buildXrayConfig,
  buildXrayOutbound,
  engineSupports,
  findEngineBinary,
} from '../src/services/proxyCores';
import { NodeSecretVault } from '../src/services/nodeSecretVault';

import type { ParsedNodeConfig } from '@netpulse/shared';

function cfg(overrides: Partial<ParsedNodeConfig> = {}): ParsedNodeConfig {
  return {
    protocol: 'vless',
    host: 'example.com',
    port: 443,
    transport: 'ws',
    security: 'tls',
    sni: 'cdn.example.com',
    path: '/wspath',
    hostHeader: 'ws.example.com',
    ...overrides,
  };
}

describe('xray config generation', () => {
  it('builds a vless+ws+tls outbound with streamSettings', () => {
    const out = buildXrayOutbound(cfg(), 'uuid-1234');
    expect(out['protocol']).toBe('vless');
    const settings = out['settings'] as { vnext: Array<{ address: string; port: number; users: Array<{ id: string; encryption: string }> }> };
    expect(settings.vnext[0].address).toBe('example.com');
    expect(settings.vnext[0].users[0].id).toBe('uuid-1234');
    expect(settings.vnext[0].users[0].encryption).toBe('none');

    const ss = out['streamSettings'] as Record<string, unknown>;
    expect(ss['network']).toBe('ws');
    expect(ss['security']).toBe('tls');
    const tls = ss['tlsSettings'] as { serverName: string; fingerprint: string };
    expect(tls.serverName).toBe('cdn.example.com');
    const ws = ss['wsSettings'] as { path: string; headers: { Host: string } };
    expect(ws.path).toBe('/wspath');
    expect(ws.headers.Host).toBe('ws.example.com');
  });

  it('builds reality settings when reality fields present', () => {
    const out = buildXrayOutbound(cfg({ security: 'reality', realityPublicKey: 'pubkey', realityShortId: 'abcd', fingerprint: 'chrome' }), 'u');
    const ss = out['streamSettings'] as Record<string, unknown>;
    expect(ss['security']).toBe('reality');
    const reality = ss['realitySettings'] as { publicKey: string; shortId: string };
    expect(reality.publicKey).toBe('pubkey');
    expect(reality.shortId).toBe('abcd');
  });

  it('builds trojan and shadowsocks settings with the secret', () => {
    const trojan = buildXrayOutbound(cfg({ protocol: 'trojan', transport: 'tcp', security: 'tls' }), 'pass1');
    expect((trojan['settings'] as { servers: Array<{ password: string }> }).servers[0].password).toBe('pass1');
    const ss = buildXrayOutbound(cfg({ protocol: 'shadowsocks', transport: 'tcp', security: 'none', encryption: 'chacha20-ietf-poly1305' }), 'pass2');
    const servers = (ss['settings'] as { servers: Array<{ method: string; password: string }> }).servers[0];
    expect(servers.method).toBe('chacha20-ietf-poly1305');
    expect(servers.password).toBe('pass2');
  });

  it('full config has an http inbound on the given port', () => {
    const full = buildXrayConfig(cfg(), 'u', 41234);
    const inbounds = full['inbounds'] as Array<{ protocol: string; port: number; listen: string }>;
    expect(inbounds[0].protocol).toBe('http');
    expect(inbounds[0].port).toBe(41234);
    expect(inbounds[0].listen).toBe('127.0.0.1');
  });
});

describe('sing-box config generation', () => {
  it('builds a mixed inbound and typed outbound', () => {
    const full = buildSingboxConfig(cfg(), 'uuid-9', 45678);
    const inbounds = full['inbounds'] as Array<{ type: string; listen_port: number }>;
    expect(inbounds[0].type).toBe('mixed');
    expect(inbounds[0].listen_port).toBe(45678);
    const outbounds = full['outbounds'] as Array<Record<string, unknown>>;
    expect(outbounds[0]['type']).toBe('vless');
    expect(outbounds[0]['uuid']).toBe('uuid-9');
  });
});

describe('engine support matrix', () => {
  it('xray cannot dial hysteria2/tuic/ssr; sing-box can', () => {
    expect(engineSupports('xray', 'hysteria2')).toBe(false);
    expect(engineSupports('xray', 'tuic')).toBe(false);
    expect(engineSupports('xray', 'vless')).toBe(true);
    expect(engineSupports('sing-box', 'hysteria2')).toBe(true);
    expect(engineSupports('sing-box', 'tuic')).toBe(true);
  });
});

describe('binary detection', () => {
  it('returns null or a path without executing anything', () => {
    const r = findEngineBinary('xray');
    expect(r === null || fs.existsSync(r)).toBe(true);
  });

  it('finds cores in the data-dir drop-in folder before PATH', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'np-cores-test-'));
    const coresDir = path.join(tmp, 'cores');
    fs.mkdirSync(coresDir);
    const fake = path.join(coresDir, 'xray.exe');
    fs.writeFileSync(fake, 'not really a binary — existence check only');
    try {
      process.env['NETPULSE_DATA_DIR'] = tmp;
      delete process.env['NETPULSE_CORES_DIR'];
      expect(findEngineBinary('xray')).toBe(fake);
    } finally {
      delete process.env['NETPULSE_DATA_DIR'];
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('honors NETPULSE_CORES_DIR over the data dir', () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'np-cores-a-'));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'np-cores-b-'));
    fs.writeFileSync(path.join(a, 'sing-box.exe'), 'a');
    fs.writeFileSync(path.join(b, 'sing-box.exe'), 'b');
    try {
      process.env['NETPULSE_DATA_DIR'] = a;
      process.env['NETPULSE_CORES_DIR'] = b;
      expect(findEngineBinary('sing-box')).toBe(path.join(b, 'sing-box.exe'));
    } finally {
      delete process.env['NETPULSE_DATA_DIR'];
      delete process.env['NETPULSE_CORES_DIR'];
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });
});

describe('NodeSecretVault', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-vault-test-'));
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips a secret and deletes it', () => {
    const vault = new NodeSecretVault(path.join(dir, 'vault'));
    vault.set('node:abc', 's3cret-uuid');
    expect(vault.get('node:abc')).toBe('s3cret-uuid');
    vault.delete('node:abc');
    expect(vault.get('node:abc')).toBeNull();
  });

  it('stores ciphertext on disk, not plaintext', () => {
    const vault = new NodeSecretVault(path.join(dir, 'vault2'));
    vault.set('node:xyz', 'PLAINTEXT-MARKER-123');
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('vault2.nodes'));
    expect(files.length).toBeGreaterThan(0);
    const raw = fs.readFileSync(path.join(dir, files[0]!), 'latin1');
    expect(raw.includes('PLAINTEXT-MARKER-123')).toBe(false);
  });
});
