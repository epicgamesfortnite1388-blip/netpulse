import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildSingboxConfig,
  buildV2rayConfig,
  buildXrayConfig,
  buildXrayOutbound,
  configIsTestable,
  engineSupports,
  engineSupportsConfig,
  findEngineBinary,
} from '../src/services/proxyCores';
import { engineOrder } from '../src/services/proxyEngineRunner';
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

describe('engine coverage for real-world v2ray-family configs', () => {
  it('hysteria2 outbound gets its REQUIRED password (sing-box exits without one)', () => {
    const full = buildSingboxConfig(cfg({ protocol: 'hysteria2', transport: 'udp', security: 'tls' }), 'hy2-pass', 45678);
    const out = (full['outbounds'] as Array<Record<string, unknown>>)[0]!;
    expect(out['type']).toBe('hysteria2');
    expect(out['password']).toBe('hy2-pass');
    expect(out['tls']).toBeDefined();
  });

  it('hysteria2 obfs + bandwidth params from extra are carried', () => {
    const full = buildSingboxConfig(
      cfg({ protocol: 'hysteria2', transport: 'udp', security: 'tls', extra: { obfs: 'salamander', 'obfs-password': 'ob', up: '50', down: '200' } }),
      'pw', 45678,
    );
    const out = (full['outbounds'] as Array<Record<string, unknown>>)[0]!;
    expect(out['obfs']).toEqual({ type: 'salamander', password: 'ob' });
    expect(out['up_mbps']).toBe(50);
    expect(out['down_mbps']).toBe(200);
  });

  it('tuic outbound gets uuid + congestion control', () => {
    const full = buildSingboxConfig(cfg({ protocol: 'tuic', transport: 'udp', security: 'tls' }), 'tuic-uuid', 45678);
    const out = (full['outbounds'] as Array<Record<string, unknown>>)[0]!;
    expect(out['type']).toBe('tuic');
    expect(out['uuid']).toBe('tuic-uuid');
    expect(out['congestion_control']).toBe('bbr');
    expect(out['udp_relay_mode']).toBe('native');
  });

  it('httpupgrade transport generates httpupgradeSettings for xray and httpupgrade for sing-box', () => {
    const x = buildXrayOutbound(cfg({ transport: 'httpupgrade', path: '/up', hostHeader: 'up.example.com' }), 'u');
    const ss = x['streamSettings'] as Record<string, unknown>;
    expect(ss['network']).toBe('httpupgrade');
    expect(ss['httpupgradeSettings']).toEqual({ path: '/up', host: 'up.example.com' });

    const s = buildSingboxConfig(cfg({ transport: 'httpupgrade', path: '/up', hostHeader: 'up.example.com' }), 'u', 45678);
    const out = (s['outbounds'] as Array<Record<string, unknown>>)[0]!;
    expect(out['transport']).toEqual({ type: 'httpupgrade', path: '/up', host: 'up.example.com' });
  });

  it('xhttp transport generates xhttpSettings for xray', () => {
    const x = buildXrayOutbound(cfg({ transport: 'xhttp', path: '/x', hostHeader: null }), 'u');
    const ss = x['streamSettings'] as Record<string, unknown>;
    expect(ss['network']).toBe('xhttp');
    expect(ss['xhttpSettings']).toEqual({ path: '/x' });
  });

  it('vmess uses vmessSecurity, falling back to encryption then auto', () => {
    const a = buildSingboxConfig(cfg({ protocol: 'vmess', vmessSecurity: 'aes-128-gcm' }), 'u', 1);
    expect((a['outbounds'] as Array<Record<string, unknown>>)[0]!['security']).toBe('aes-128-gcm');
    const b = buildSingboxConfig(cfg({ protocol: 'vmess', encryption: 'chacha20-poly1305' }), 'u', 1);
    expect((b['outbounds'] as Array<Record<string, unknown>>)[0]!['security']).toBe('chacha20-poly1305');
    const c = buildSingboxConfig(cfg({ protocol: 'vmess' }), 'u', 1);
    expect((c['outbounds'] as Array<Record<string, unknown>>)[0]!['security']).toBe('auto');
  });

  it('configIsTestable rejects ssr with an honest reason', () => {
    const r = configIsTestable(cfg({ protocol: 'shadowsocksr' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('shadowsocksr');
  });

  it('configIsTestable rejects legacy SS ciphers before spawning a core', () => {
    const r = configIsTestable(cfg({ protocol: 'shadowsocks', encryption: 'rc4-md5' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('rc4-md5');
    expect(configIsTestable(cfg({ protocol: 'shadowsocks', encryption: 'aes-256-gcm' })).ok).toBe(true);
  });

  it('neither engine claims shadowsocksr anymore (was falsely advertised)', () => {
    expect(engineSupports('sing-box', 'shadowsocksr')).toBe(false);
    expect(engineSupports('xray', 'shadowsocksr')).toBe(false);
  });
});

/* ---------------- v2ray (v2fly) core support ---------------- */

describe('v2ray core support', () => {
  it('buildV2rayConfig emits the same schema as xray for a plain node', () => {
    const c = cfg();
    const v2 = buildV2rayConfig(c, 'sec-1', 18080);
    const xr = buildXrayConfig(c, 'sec-1', 18080);
    expect(v2).toEqual(xr);
    const outbounds = (v2 as { outbounds: Array<{ protocol: string }> }).outbounds;
    expect(outbounds[0].protocol).toBe('vless');
  });

  it('engineSupports: v2ray dials the v2ray family but not hy2/tuic/ssr', () => {
    for (const p of ['vless', 'vmess', 'trojan', 'shadowsocks']) {
      expect(engineSupports('v2ray', p)).toBe(true);
    }
    expect(engineSupports('v2ray', 'hysteria2')).toBe(false);
    expect(engineSupports('v2ray', 'tuic')).toBe(false);
    expect(engineSupports('v2ray', 'shadowsocksr')).toBe(false);
  });

  it('engineSupportsConfig refuses Reality and xhttp for v2ray only', () => {
    expect(engineSupportsConfig('v2ray', cfg({ security: 'reality', realityPublicKey: 'k' }))).toEqual({
      ok: false,
      error: 'v2ray-core does not support Reality (use xray or sing-box for this node)',
    });
    expect(engineSupportsConfig('v2ray', cfg({ transport: 'xhttp' }))).toEqual({
      ok: false,
      error: 'v2ray-core does not support the xhttp transport (use xray for this node)',
    });
    expect(engineSupportsConfig('v2ray', cfg()).ok).toBe(true);
    expect(engineSupportsConfig('xray', cfg({ security: 'reality', realityPublicKey: 'k' })).ok).toBe(true);
  });

  it('engineOrder puts the preferred engine first and never repeats it', () => {
    expect(engineOrder('auto')).toEqual(['xray', 'sing-box', 'v2ray']);
    expect(engineOrder('v2ray')[0]).toBe('v2ray');
    expect(new Set(engineOrder('sing-box')).size).toBe(3);
  });

  it('findEngineBinary locates a v2ray drop-in', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'np-cores-v2-'));
    const coresDir = path.join(tmp, 'cores');
    fs.mkdirSync(coresDir);
    const fake = path.join(coresDir, process.platform === 'win32' ? 'v2ray.exe' : 'v2ray');
    fs.writeFileSync(fake, 'existence check only');
    try {
      process.env['NETPULSE_DATA_DIR'] = tmp;
      delete process.env['NETPULSE_CORES_DIR'];
      expect(findEngineBinary('v2ray')).toBe(fake);
    } finally {
      delete process.env['NETPULSE_DATA_DIR'];
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
