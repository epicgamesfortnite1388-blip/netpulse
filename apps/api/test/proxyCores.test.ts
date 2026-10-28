import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  PROXY_ENGINE_ORDER,
  buildHysteria2ClientConfig,
  buildSingboxConfig,
  buildV2rayConfig,
  buildXrayConfig,
  buildXrayOutbound,
  chainExitProtocolUnsupported,
  chainExitUnsupported,
  configIsTestable,
  engineArgs,
  engineSupports,
  engineSupportsConfig,
  engineSupportsOptions,
  findEngineBinary,
  isAeadShadowsocksCipher,
  startCore,
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

/**
 * NESTED MODE wiring. The shapes here were measured against xray 26.3.27 / 
 * sing-box 1.14.0: with dialerProxy (xray) or detour (sing-box) pointing at an
 * http outbound into the peer core, killing the peer core kills the path — so
 * these are real chains, not a direct connection with a two-hop label.
 * v2ray-core 5.53 silently ignores dialerProxy, hence the refusal below.
 */
describe('nested-mode chain wiring', () => {
  it('xray exit dials its node through the peer core via docked dialerProxy + http outbound', () => {
    const json = buildXrayConfig(cfg(), 'uuid-1234', 1080, null, 9999);
    const outbounds = json['outbounds'] as Array<Record<string, unknown>>;
    expect(outbounds).toHaveLength(2);
    const nodeOutbound = outbounds[0] as { streamSettings: { sockopt?: { dialerProxy?: string } } };
    const upstream = outbounds[1] as { protocol: string; tag: string; settings: { servers: Array<{ address: string; port: number }> } };
    expect(nodeOutbound.streamSettings.sockopt).toEqual({ dialerProxy: upstream.tag });
    expect(upstream.protocol).toBe('http');
    expect(upstream.settings.servers[0]).toEqual({ address: '127.0.0.1', port: 9999 });
  });

  it('sing-box exit dials its node through the peer core via detour + http outbound', () => {
    const json = buildSingboxConfig(cfg(), 'uuid-1234', 1080, null, 9999);
    const outbounds = json['outbounds'] as Array<Record<string, unknown>>;
    expect(outbounds).toHaveLength(2);
    expect(outbounds[0]!['detour']).toBe(outbounds[1]!['tag']);
    expect(outbounds[1]).toMatchObject({ type: 'http', server: '127.0.0.1', server_port: 9999 });
  });

  it('leaves both configs untouched when no chain is requested (probe path)', () => {
    const xray = JSON.stringify(buildXrayConfig(cfg(), 'uuid', 1080));
    const sing = JSON.stringify(buildSingboxConfig(cfg(), 'uuid', 1080));
    expect(xray).not.toContain('dialerProxy');
    expect(sing).not.toContain('detour');
  });

  it('refuses a v2ray exit hop instead of shipping a chain it ignores', () => {
    expect(chainExitUnsupported('v2ray', 'vless')).toContain('dialerProxy');
    expect(chainExitUnsupported('xray', 'vless')).toBeNull();
    expect(chainExitUnsupported('sing-box', 'vless')).toBeNull();
  });

  it('refuses UDP protocols as the exit hop whichever core would run them', () => {
    expect(chainExitProtocolUnsupported('hysteria2')).toContain('UDP-based');
    expect(chainExitProtocolUnsupported('tuic')).toContain('UDP-based');
    expect(chainExitProtocolUnsupported('vless')).toBeNull();
  });

  it('refuses non-AEAD shadowsocks ciphers on the v2ray family (measured: xray exits with "unknown cipher method")', () => {
    const legacy = cfg({ protocol: 'shadowsocks', encryption: 'aes-256-cfb', transport: 'tcp', security: 'none' });
    expect(engineSupportsConfig('xray', legacy).ok).toBe(false);
    expect(engineSupportsConfig('sing-box', legacy).ok).toBe(true);
    expect(engineSupportsConfig('xray', cfg({ protocol: 'shadowsocks', encryption: 'aes-256-gcm' })).ok).toBe(true);
    expect(isAeadShadowsocksCipher('chacha20-ietf-poly1305')).toBe(true);
    expect(isAeadShadowsocksCipher('2022-blake3-aes-128-gcm')).toBe(true);
    expect(isAeadShadowsocksCipher('aes-256-cfb')).toBe(false);
  });

  it('startCore refuses the exit role on v2ray before spawning anything', async () => {
    const res = await startCore({ id: 'v2ray', bin: 'definitely-not-a-real-binary', args: ['run'] }, cfg(), 'uuid', 500, { dialThroughPort: 9999 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('dialerProxy');
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

  it('consults the engine manager install directory when no data dir is set', () => {
    // The engine manager installs into `<dataDir>/cores`; with NETPULSE_DATA_DIR
    // unset that resolves to `<cwd>/cores` (the dev layout). The finder used to
    // skip that folder, so a core installed through the app's own engine manager
    // was invisible to every probe — `GET /nodes/engines` printed its version
    // while reporting `available: false`.
    //
    // Asserted only where such an install exists (a machine that has used the
    // app's engine manager); on a clean checkout there is no `<cwd>/cores` to
    // find and the check would be vacuous either way. Creating one here instead
    // would leave a fake executable in the app's real install directory if this
    // test ever died mid-way — worse than a conditional assertion.
    const managed = path.join(process.cwd(), 'cores', process.platform === 'win32' ? 'xray.exe' : 'xray');
    if (!fs.existsSync(managed)) return;
    delete process.env['NETPULSE_DATA_DIR'];
    delete process.env['NETPULSE_CORES_DIR'];
    expect(findEngineBinary('xray')).toBe(managed);
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

describe('hysteria2 client engine', () => {
  it('dials hysteria2 and nothing else', () => {
    expect(engineSupports('hysteria', 'hysteria2')).toBe(true);
    for (const p of ['vless', 'vmess', 'trojan', 'shadowsocks', 'tuic']) {
      expect(engineSupports('hysteria', p)).toBe(false);
    }
    // The dedicated client must not have displaced sing-box for hysteria2.
    expect(engineSupports('sing-box', 'hysteria2')).toBe(true);
  });

  it('is invoked with the config path and no `run` subcommand', () => {
    expect(engineArgs('hysteria')).toEqual([]);
    expect(engineArgs('xray')).toEqual(['run']);
    expect(engineArgs('sing-box')).toEqual(['run']);
  });

  it('is tried ahead of sing-box for hysteria2 (protocol\u2019s own client), but xray stays first', () => {
    expect(PROXY_ENGINE_ORDER.indexOf('hysteria')).toBeLessThan(PROXY_ENGINE_ORDER.indexOf('sing-box'));
    expect(PROXY_ENGINE_ORDER[0]).toBe('xray');
    expect([...PROXY_ENGINE_ORDER]).toEqual([...new Set(PROXY_ENGINE_ORDER)]);
  });

  it('builds the documented YAML client config, including salamander obfs and bandwidth', () => {
    const yaml = buildHysteria2ClientConfig(
      cfg({
        protocol: 'hysteria2',
        transport: 'udp',
        security: 'tls',
        host: 'hy.example.net',
        port: 8443,
        sni: 'hy.example.net',
        allowInsecure: false,
        alpn: ['h3'],
        extra: { obfs: 'salamander', 'obfs-password': 'obf-pw', up: '50', down: '200' },
      }),
      'node-secret',
      45678,
    );
    expect(yaml).toContain('server: "hy.example.net:8443"');
    expect(yaml).toContain('auth: "node-secret"');
    expect(yaml).toContain('sni: "hy.example.net"');
    expect(yaml).toContain('alpn: ["h3"]');
    expect(yaml).toContain('type: "salamander"');
    expect(yaml).toContain('password: "obf-pw"');
    expect(yaml).toContain('up: "50 mbps"');
    expect(yaml).toContain('down: "200 mbps"');
    // The local inbound is HTTP: both the probe and the system-proxy handoff
    // speak HTTP CONNECT, and hysteria has no mixed inbound.
    expect(yaml).toContain('http:');
    expect(yaml).toContain('listen: "127.0.0.1:45678"');
    expect(yaml).not.toContain('socks5:');
  });

  it('omits tls.insecure and bandwidth that the node did not advertise', () => {
    const yaml = buildHysteria2ClientConfig(
      cfg({ protocol: 'hysteria2', transport: 'udp', security: 'tls', sni: null, alpn: null, allowInsecure: null, extra: {} }),
      'pw',
      1234,
    );
    expect(yaml).toContain('sni: "example.com"'); // falls back to the host
    expect(yaml).not.toContain('insecure');
    expect(yaml).not.toContain('bandwidth');
    expect(yaml).not.toContain('obfs');
  });

  it('emits tls.insecure only when the node sets allowInsecure', () => {
    const yaml = buildHysteria2ClientConfig(cfg({ protocol: 'hysteria2', transport: 'udp', allowInsecure: true }), 'pw', 1234);
    expect(yaml).toContain('insecure: true');
  });

  it('refuses obfuscation modes the client does not implement', () => {
    const ok = engineSupportsConfig('hysteria', cfg({ protocol: 'hysteria2', extra: { obfs: 'salamander' } }));
    expect(ok.ok).toBe(true);
    const bad = engineSupportsConfig('hysteria', cfg({ protocol: 'hysteria2', extra: { obfs: 'something-else' } }));
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.error).toContain('salamander');
  });

  it('cannot chain, and reports WHY instead of a generic failure', () => {
    expect(chainExitUnsupported('hysteria', 'hysteria2')).toContain('dial-through');
    expect(engineSupportsOptions('hysteria', { chain: true })).toContain('chain');
    expect(engineSupportsOptions('xray', { chain: true })).toBeNull();
  });

  it('is skipped while bypass or DNS-through-tunnel is on, rather than ignoring them', () => {
    expect(engineSupportsOptions('hysteria', { bypass: true })).toContain('bypass');
    expect(engineSupportsOptions('hysteria', { dns: true })).toContain('DNS');
    expect(engineSupportsOptions('hysteria', {})).toBeNull();
    expect(engineSupportsOptions('sing-box', { bypass: true, dns: true, chain: true })).toBeNull();
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

  it('refuses allowInsecure on the v2ray family (measured: xray 26.3.27 exits 23 on the whole config)', () => {
    // The node cannot be dialled by the core that would otherwise take it, and
    // inside a shared core that rejection is not the node's failure alone.
    const insecure = cfg({ security: 'tls', allowInsecure: true });
    for (const engine of ['xray', 'v2ray'] as const) {
      const verdict = engineSupportsConfig(engine, insecure);
      expect(verdict.ok).toBe(false);
      expect(verdict.ok === false && verdict.error).toContain('allowInsecure');
    }
    // sing-box still carries tls.insecure and starts the same node.
    expect(engineSupportsConfig('sing-box', insecure).ok).toBe(true);
    // A verified TLS node is unaffected, and so is Reality (no tlsSettings).
    expect(engineSupportsConfig('xray', cfg({ security: 'tls', allowInsecure: false })).ok).toBe(true);
    expect(engineSupportsConfig('xray', cfg({ security: 'reality', realityPublicKey: 'k', allowInsecure: true })).ok).toBe(true);
  });

  it('engineOrder puts the preferred engine first and never repeats it', () => {
    // Hysteria sits second: it only claims hysteria2, so it cannot displace a
    // core for any other protocol, but it wins for its own protocol.
    expect(engineOrder('auto')).toEqual(['xray', 'hysteria', 'sing-box', 'v2ray']);
    expect(engineOrder('v2ray')[0]).toBe('v2ray');
    expect(engineOrder('hysteria')[0]).toBe('hysteria');
    expect(new Set(engineOrder('sing-box')).size).toBe(4);
    expect(new Set(engineOrder('hysteria')).size).toBe(4);
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

describe('DNS-through-tunnel config wiring', () => {
  const dns = { doh: 'https://1.1.1.1/dns-query', plainFallback: '1.1.1.1' };

  it('xray: pins the dns module to the node outbound via the special dns inboundTag', () => {
    const json = buildXrayConfig(cfg(), 'u', 1080, null, null, dns) as {
      dns?: { servers: string[] };
      routing?: { rules: Array<{ inboundTag?: string[]; outboundTag?: string }> };
      outbounds: Array<{ tag?: string; protocol?: string }>;
    };
    expect(json.dns?.servers).toEqual([dns.doh, dns.plainFallback]);
    const rule = json.routing?.rules.find((r) => r.inboundTag?.includes('dns'));
    expect(rule?.outboundTag).toBe('np-node');
    // the node outbound must carry the tag the rule points at
    expect(json.outbounds.some((o) => o.tag === 'np-node')).toBe(true);
  });

  it('xray: no dns object when the preference is off', () => {
    const json = buildXrayConfig(cfg(), 'u', 1080) as { dns?: unknown };
    expect(json.dns).toBeUndefined();
  });

  it('xray: dns rule prepends to existing bypass routing instead of replacing it', () => {
    const rs = { domains: ['bank.example.com'], ips: [], ports: [], lan: true } as const;
    const json = buildXrayConfig(cfg(), 'u', 1080, rs, null, dns) as {
      routing?: { rules: Array<{ inboundTag?: string[]; outboundTag?: string }> };
    };
    const tags = json.routing?.rules.map((r) => r.outboundTag);
    expect(tags?.indexOf('np-node')).toBeLessThan(tags?.indexOf('direct') ?? -1);
  });

  it('sing-box: default_domain_resolver detours through the node outbound', () => {
    const json = buildSingboxConfig(cfg(), 'u', 1080, null, null, dns) as {
      dns?: { servers: Array<{ tag?: string; type?: string; detour?: string }> };
      route?: { default_domain_resolver?: { server: string } };
      outbounds: Array<{ tag?: string }>;
    };
    expect(json.route?.default_domain_resolver).toEqual({ server: 'dns-tun' });
    const tun = json.dns?.servers.find((s) => s.tag === 'dns-tun');
    expect(tun?.type).toBe('https');
    expect(tun?.detour).toBe('np-node');
    expect(json.outbounds.some((o) => o.tag === 'np-node')).toBe(true);
  });

  it('sing-box: no dns object when the preference is off', () => {
    const json = buildSingboxConfig(cfg(), 'u', 1080) as { dns?: unknown };
    expect(json.dns).toBeUndefined();
  });

  it('sing-box: refuses a malformed DoH URL instead of emitting a broken resolver', () => {
    const json = buildSingboxConfig(cfg(), 'u', 1080, null, null, { doh: 'not-a-url', plainFallback: '1.1.1.1' }) as { dns?: unknown };
    expect(json.dns).toBeUndefined();
  });
});

describe('sing-box ws transport parity with xray', () => {
  it(' forwards the ws Host header (CDN routing key) exactly like the xray builder', () => {
    const withHost = buildSingboxConfig(cfg(), 'u', 1080) as { outbounds: Array<{ transport?: { type: string; headers?: { Host?: string } } }> };
    expect(withHost.outbounds[0]?.transport?.headers?.Host).toBe('ws.example.com');
    const bare = buildSingboxConfig(cfg({ hostHeader: null }), 'u', 1080) as { outbounds: Array<{ transport?: { headers?: unknown } }> };
    expect(bare.outbounds[0]?.transport?.headers).toBeUndefined();
  });
});
