import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ENGINE_PROFILE_PROTOCOLS,
  PROXY_ENGINES,
  canBecomeEngineProfile,
  engineVersionIsCurrent,
  type ParsedNodeConfig,
} from '@netpulse/shared';

import {
  ENGINE_RELEASES,
  SINGBOX_PINNED_DIGESTS,
  checkLatestReleases,
  installedEngineVersions,
  resetEngineManagerCachesForTests,
  verifyPinnedDigest,
} from '../src/services/engineManager';
import {
  PROXY_ENGINE_ORDER,
  XRAY_PRIVATE_CIDRS,
  buildHysteria2ClientConfig,
  buildSingboxRouteRules,
  buildTunGatewayConfig,
  buildXrayRoutingRules,
  chainExitProtocolUnsupported,
  chainExitUnsupported,
  configIsTestable,
  engineArgs,
  engineSupports,
  engineSupportsConfig,
  engineSupportsOptions,
  isAeadShadowsocksCipher,
  tunGatewayStartRefusal,
  tunRouteExclusions,
} from '../src/services/proxyCores';
import { engineOrder, proxyEngineStatus } from '../src/services/proxyEngineRunner';

/**
 * Fundamental engine logic: the capability matrix, the version-currency
 * comparison, the selection order and the release table are pure
 * contracts the whole app depends on. Every invariant the rest of the
 * engine pipeline assumes is asserted here directly, including the
 * boundary cases the naive implementations used to get wrong.
 */

const ALL_PROTOCOLS = ['vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria2', 'tuic'] as const;

function cfg(partial: Partial<ParsedNodeConfig> & { protocol: ParsedNodeConfig['protocol'] }): ParsedNodeConfig {
  return {
    host: 'node.example.com',
    port: 443,
    transport: 'tcp',
    security: 'none',
    ...partial,
  };
}

/* ============================ engine table invariants ============================ */

describe('PROXY_ENGINES table invariants', () => {
  it('has unique ids and a complete failover order', () => {
    const ids = PROXY_ENGINES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...PROXY_ENGINE_ORDER].sort()).toEqual([...ids].sort());
  });

  it('covers every protocol with at least one engine', () => {
    const covered = new Set(PROXY_ENGINES.flatMap((e) => e.protocols));
    for (const p of ALL_PROTOCOLS) expect(covered.has(p)).toBe(true);
  });

  it('gives hysteria exactly one protocol — its own', () => {
    const hy = PROXY_ENGINES.find((e) => e.id === 'hysteria')!;
    expect(hy.protocols).toEqual(['hysteria2']);
  });

  it('keeps engineSupports in exact agreement with the protocol table', () => {
    for (const engine of PROXY_ENGINES) {
      for (const protocol of ALL_PROTOCOLS) {
        expect(engineSupports(engine.id, protocol)).toBe(engine.protocols.includes(protocol));
      }
    }
  });

  it('only protocols sing-box can dial can become engine profiles', () => {
    const singbox = PROXY_ENGINES.find((e) => e.id === 'sing-box')!;
    for (const p of ENGINE_PROFILE_PROTOCOLS) {
      expect(singbox.protocols).toContain(p);
      expect(canBecomeEngineProfile(p)).toBe(true);
    }
    // hysteria2/tuic are dialable but have no accepted share-link form
    expect(canBecomeEngineProfile('hysteria2')).toBe(false);
    expect(canBecomeEngineProfile('tuic')).toBe(false);
    expect(canBecomeEngineProfile('wireguard')).toBe(false);
  });

  it('spawns cores with the right invocation shape', () => {
    expect(engineArgs('hysteria')).toEqual([]);
    expect(engineArgs('xray')).toEqual(['run']);
    expect(engineArgs('sing-box')).toEqual(['run']);
    expect(engineArgs('v2ray')).toEqual(['run']);
  });
});

/* ============================ version currency ============================ */

describe('engineVersionIsCurrent', () => {
  it('is null when either side is missing', () => {
    expect(engineVersionIsCurrent(null, 'v1.0.0')).toBeNull();
    expect(engineVersionIsCurrent('', 'v1.0.0')).toBeNull();
    expect(engineVersionIsCurrent('Xray 1.0.0', null)).toBeNull();
  });

  it('is null when the tag carries no version digits', () => {
    expect(engineVersionIsCurrent('Xray 1.0.0', 'latest')).toBeNull();
    expect(engineVersionIsCurrent('Xray 1.0.0', 'v')).toBeNull();
  });

  it.each([
    ['Xray 26.3.27 (…)', 'v26.3.27'],
    ['sing-box version 1.14.0', 'v1.14.0'],
    ['V2Ray 5.53.0 (…)', 'v5.53.0'],
    ['Version: v2.12.3', 'app/v2.12.3'],
    ['1.14.0', 'v1.14.0'],
  ])('matches the documented output shapes (%j, %j)', (line, tag) => {
    expect(engineVersionIsCurrent(line, tag)).toBe(true);
  });

  it.each([
    // A bare substring would call these "current" — the tag's digits
    // appear inside a DIFFERENT version number.
    ['Xray 11.4.0 (…)', 'v1.4.0'],
    ['Version: 12.12.3', 'app/v2.12.3'],
    ['Xray 1.14.0.1', 'v1.14.0'],
  ])('rejects substring collisions across version boundaries (%j, %j)', (line, tag) => {
    expect(engineVersionIsCurrent(line, tag)).toBe(false);
  });

  it('accepts a prerelease of the same version, not a different one', () => {
    expect(engineVersionIsCurrent('sing-box 1.14.0-beta.1', 'v1.14.0')).toBe(true);
    expect(engineVersionIsCurrent('sing-box 1.15.0-alpha.1', 'v1.14.0')).toBe(false);
  });
});

/* ============================ capability matrix ============================ */

describe('engineSupportsConfig matrix', () => {
  it('v2ray-core refuses Xray-only extensions', () => {
    expect(engineSupportsConfig('v2ray', cfg({ protocol: 'vless', security: 'reality' })).ok).toBe(false);
    expect(engineSupportsConfig('v2ray', cfg({ protocol: 'vless', transport: 'xhttp' })).ok).toBe(false);
    expect(engineSupportsConfig('v2ray', cfg({ protocol: 'vless', realityPublicKey: 'key' })).ok).toBe(false);
  });

  it('xray and sing-box accept Reality', () => {
    expect(engineSupportsConfig('xray', cfg({ protocol: 'vless', security: 'reality' })).ok).toBe(true);
    expect(engineSupportsConfig('sing-box', cfg({ protocol: 'vless', security: 'reality' })).ok).toBe(true);
  });

  it('the v2ray family refuses non-AEAD shadowsocks ciphers, sing-box still carries them', () => {
    const legacy = cfg({ protocol: 'shadowsocks', encryption: 'aes-256-cfb' });
    expect(engineSupportsConfig('xray', legacy).ok).toBe(false);
    expect(engineSupportsConfig('v2ray', legacy).ok).toBe(false);
    expect(engineSupportsConfig('sing-box', legacy).ok).toBe(true);
    expect(engineSupportsConfig('xray', cfg({ protocol: 'shadowsocks', encryption: 'aes-256-gcm' })).ok).toBe(true);
  });

  it('hysteria2 only implements salamander obfuscation', () => {
    expect(engineSupportsConfig('hysteria', cfg({ protocol: 'hysteria2', extra: { obfs: 'salamander' } })).ok).toBe(true);
    const r = engineSupportsConfig('hysteria', cfg({ protocol: 'hysteria2', extra: { obfs: 'foo' } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/salamander/);
  });

  it('classifies testability honestly', () => {
    expect(configIsTestable(cfg({ protocol: 'shadowsocksr' })).ok).toBe(false);
    expect(configIsTestable(cfg({ protocol: 'shadowsocks', encryption: 'rc4' })).ok).toBe(false);
    expect(configIsTestable(cfg({ protocol: 'shadowsocks', encryption: 'chacha20-ietf-poly1305' })).ok).toBe(true);
    expect(configIsTestable(cfg({ protocol: 'vless' })).ok).toBe(true);
  });

  it('recognizes AEAD ciphers only', () => {
    for (const c of ['none', 'aes-256-gcm', 'chacha20-ietf-poly1305', '2022-blake3-aes128gcm']) {
      expect(isAeadShadowsocksCipher(c)).toBe(true);
    }
    for (const c of ['aes-256-cfb', 'rc4', 'rc4-md5', 'table', '']) {
      expect(isAeadShadowsocksCipher(c)).toBe(false);
    }
  });

  it('honours start-time options per engine', () => {
    expect(engineSupportsOptions('hysteria', { bypass: true })).toMatch(/split tunneling/);
    expect(engineSupportsOptions('hysteria', { dns: true })).toMatch(/DNS/);
    expect(engineSupportsOptions('hysteria', { chain: true })).toMatch(/chain/);
    expect(engineSupportsOptions('hysteria', {})).toBeNull();
    expect(engineSupportsOptions('xray', { bypass: true, dns: true, chain: true })).toBeNull();
  });

  it('refuses chains the engine provably ignores', () => {
    expect(chainExitUnsupported('v2ray', 'vless')).toMatch(/dialerProxy/);
    expect(chainExitUnsupported('hysteria', 'hysteria2')).toMatch(/dial-through/);
    expect(chainExitUnsupported('xray', 'vless')).toBeNull();
    expect(chainExitUnsupported('sing-box', 'trojan')).toBeNull();
    // UDP protocols can never be the exit hop, whichever core runs them
    expect(chainExitProtocolUnsupported('hysteria2')).toMatch(/UDP/);
    expect(chainExitProtocolUnsupported('tuic')).toMatch(/UDP/);
    expect(chainExitProtocolUnsupported('vless')).toBeNull();
    expect(chainExitUnsupported('xray', 'tuic')).toMatch(/UDP/);
  });
});

/* ============================ selection order ============================ */

const tmpDirs: string[] = [];
function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'np-engfund-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/** Point binary discovery at an isolated cores dir with no PATH fallback. */
function withCoresDir(files: string[], fn: () => void): void {
  const dir = tmpDir();
  for (const f of files) fs.writeFileSync(path.join(dir, f), 'fake');
  const savedPath = process.env['PATH'];
  const savedCores = process.env['NETPULSE_CORES_DIR'];
  const savedData = process.env['NETPULSE_DATA_DIR'];
  process.env['NETPULSE_CORES_DIR'] = dir;
  process.env['NETPULSE_DATA_DIR'] = dir;
  process.env['PATH'] = '';
  try {
    fn();
  } finally {
    if (savedPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = savedPath;
    if (savedCores === undefined) delete process.env['NETPULSE_CORES_DIR'];
    else process.env['NETPULSE_CORES_DIR'] = savedCores;
    if (savedData === undefined) delete process.env['NETPULSE_DATA_DIR'];
    else process.env['NETPULSE_DATA_DIR'] = savedData;
  }
}

/** Async variant: the environment stays pointed at the cores dir until the work settles. */
async function withCoresDirAsync(files: string[], fn: () => Promise<void>): Promise<void> {
  const dir = tmpDir();
  for (const f of files) fs.writeFileSync(path.join(dir, f), 'fake');
  const savedPath = process.env['PATH'];
  const savedCores = process.env['NETPULSE_CORES_DIR'];
  const savedData = process.env['NETPULSE_DATA_DIR'];
  process.env['NETPULSE_CORES_DIR'] = dir;
  process.env['NETPULSE_DATA_DIR'] = dir;
  process.env['PATH'] = '';
  try {
    await fn();
  } finally {
    if (savedPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = savedPath;
    if (savedCores === undefined) delete process.env['NETPULSE_CORES_DIR'];
    else process.env['NETPULSE_CORES_DIR'] = savedCores;
    if (savedData === undefined) delete process.env['NETPULSE_DATA_DIR'];
    else process.env['NETPULSE_DATA_DIR'] = savedData;
  }
}

const bin = (base: string) => (process.platform === 'win32' ? `${base}.exe` : base);

describe('engine selection', () => {
  it('orders the failover list with the preference first', () => {
    expect(engineOrder('auto')).toEqual([...PROXY_ENGINE_ORDER]);
    expect(engineOrder('sing-box')).toEqual(['sing-box', 'xray', 'hysteria', 'v2ray']);
    expect(engineOrder('v2ray')).toEqual(['v2ray', 'xray', 'hysteria', 'sing-box']);
  });

  it('reports no effective engine when nothing is installed', () => {
    withCoresDir([], () => {
      const s = proxyEngineStatus('auto');
      expect(s.effective).toBeNull();
      expect(s.engines.every((e) => !e.available)).toBe(true);
    });
  });

  it('picks the first available engine in failover order', () => {
    withCoresDir([bin('xray'), bin('v2ray')], () => {
      const s = proxyEngineStatus('auto');
      expect(s.effective).toBe('xray');
    });
  });

  it('honours the preference when the preferred engine is installed', () => {
    withCoresDir([bin('xray'), bin('v2ray')], () => {
      expect(proxyEngineStatus('v2ray').effective).toBe('v2ray');
    });
  });

  it('falls back to the next installed engine when the preference is missing', () => {
    withCoresDir([bin('xray')], () => {
      expect(proxyEngineStatus('sing-box').effective).toBe('xray');
    });
  });

  it('advertises protocol coverage from the shared table, never invented', () => {
    withCoresDir([bin('sing-box')], () => {
      const s = proxyEngineStatus('auto');
      const sb = s.engines.find((e) => e.id === 'sing-box')!;
      expect(sb.protocols).toEqual(['vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria2', 'tuic']);
      const xr = s.engines.find((e) => e.id === 'xray')!;
      expect(xr.protocols).toEqual(['vless', 'vmess', 'trojan', 'shadowsocks']);
    });
  });

  it('never invents an installed version for a binary that cannot identify itself', async () => {
    await withCoresDirAsync([bin('xray')], async () => {
      resetEngineManagerCachesForTests();
      const versions = await installedEngineVersions({ force: true });
      expect(versions.xray).toBeNull();
      expect(versions['sing-box']).toBeNull();
    });
  });
});

/* ============================ release table ============================ */

describe('ENGINE_RELEASES table', () => {
  it('names the official asset per platform/arch', () => {
    expect(ENGINE_RELEASES.xray.assetName('win32', 'x64')).toBe('Xray-windows-64.zip');
    expect(ENGINE_RELEASES.xray.assetName('win32', 'arm64')).toBe('Xray-windows-arm64.zip');
    expect(ENGINE_RELEASES.xray.assetName('linux', 'x64')).toBe('Xray-linux-64.zip');
    expect(ENGINE_RELEASES['sing-box'].assetName('win32', 'x64')).toBe('sing-box-1.*-windows-amd64.zip');
    expect(ENGINE_RELEASES.v2ray.assetName('win32', 'x64')).toBe('v2ray-windows-64.zip');
    expect(ENGINE_RELEASES.hysteria.assetName('win32', 'x64')).toBe('hysteria-windows-amd64.exe');
    expect(ENGINE_RELEASES.hysteria.assetName('linux', 'arm64')).toBe('hysteria-linux-arm64');
  });

  it('refuses platforms the app does not ship for', () => {
    for (const id of Object.keys(ENGINE_RELEASES) as Array<keyof typeof ENGINE_RELEASES>) {
      expect(ENGINE_RELEASES[id].assetName('darwin', 'x64')).toBeNull();
    }
  });

  it('declares where each core publishes its digests', () => {
    expect(ENGINE_RELEASES.xray.digestAsset('Xray-windows-64.zip')).toBe('Xray-windows-64.zip.dgst');
    expect(ENGINE_RELEASES.v2ray.digestAsset('v2ray-windows-64.zip')).toBe('v2ray-windows-64.zip.dgst');
    expect(ENGINE_RELEASES['sing-box'].digestAsset('sing-box-1.12.15-windows-amd64.zip')).toBeNull();
    expect(ENGINE_RELEASES.hysteria.digestAsset('hysteria-windows-amd64.exe')).toBe('hashes.txt');
  });

  it('ships only hysteria as a bare executable', () => {
    for (const id of Object.keys(ENGINE_RELEASES) as Array<keyof typeof ENGINE_RELEASES>) {
      expect(ENGINE_RELEASES[id].rawAsset ?? false).toBe(id === 'hysteria');
    }
  });

  it('pins well-formed digests for every pinned sing-box asset', () => {
    for (const [asset, digest] of Object.entries(SINGBOX_PINNED_DIGESTS)) {
      expect(asset).toMatch(/^sing-box-[\d.]+-windows-amd64\.zip$/);
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('verdicts the pin layer exactly', () => {
    const A = 'sing-box-1.12.15-windows-amd64.zip';
    expect(verifyPinnedDigest(A, SINGBOX_PINNED_DIGESTS[A]!)).toBe('match');
    expect(verifyPinnedDigest(A, '0'.repeat(64))).toBe('mismatch');
    expect(verifyPinnedDigest('sing-box-9.9.9-windows-amd64.zip', SINGBOX_PINNED_DIGESTS[A]!)).toBe('unpinned');
  });
});

/* ============================ release check honesty ============================ */

describe('checkLatestReleases', () => {
  beforeEach(() => resetEngineManagerCachesForTests());

  it('reports every engine from the injected lookup', async () => {
    const check = await checkLatestReleases({
      force: true,
      lookup: async (repo) => ({
        tag_name: `tag-of-${repo}`,
        html_url: `https://github.com/${repo}/releases/latest`,
        assets: [],
      }),
    });
    expect(check.cached).toBe(false);
    expect(check.releases).toHaveLength(4);
    for (const r of check.releases) {
      expect(r.latestTag).toMatch(/^tag-of-/);
      expect(r.error).toBeNull();
      expect(r.url).toContain('releases/latest');
    }
  });

  it('reports a failed lookup per engine — never as up-to-date', async () => {
    const check = await checkLatestReleases({
      force: true,
      lookup: async (repo) => {
        if (repo === 'SagerNet/sing-box') throw new Error('API rate limit exceeded');
        return { tag_name: 'v1.0.0', html_url: 'https://github.com/', assets: [] };
      },
    });
    const sb = check.releases.find((r) => r.id === 'sing-box')!;
    expect(sb.latestTag).toBeNull();
    expect(sb.url).toBeNull();
    expect(sb.error).toMatch(/rate limit/);
    for (const r of check.releases.filter((x) => x.id !== 'sing-box')) {
      expect(r.error).toBeNull();
      expect(r.latestTag).toBe('v1.0.0');
    }
  });

  it('serves the stored answer inside the TTL and says so', async () => {
    const lookup = async () => ({ tag_name: 'v1.0.0', html_url: 'https://github.com/', assets: [] });
    const first = await checkLatestReleases({ force: true, lookup });
    expect(first.cached).toBe(false);
    const second = await checkLatestReleases({ lookup });
    expect(second.cached).toBe(true);
    expect(second.releases).toEqual(first.releases);
    const forced = await checkLatestReleases({ force: true, lookup });
    expect(forced.cached).toBe(false);
  });
});

/* ============================ config builders ============================ */

describe('routing rule builders', () => {
  const rules = { domains: ['a.com', 'b.com'], ips: ['1.2.3.4'], ports: [80, 443], lan: true };

  it('xray rules fold domains, IPs and ports into one direct rule and list private CIDRs explicitly', () => {
    const out = buildXrayRoutingRules(rules);
    expect(out).toHaveLength(1);
    expect(out[0]!.outboundTag).toBe('direct');
    expect(out[0]!['domain']).toEqual(['domain:a.com', 'domain:b.com']);
    expect(out[0]!['ip']).toEqual(['1.2.3.4', ...XRAY_PRIVATE_CIDRS]);
    expect(out[0]!['port']).toBe('80,443');
    // no geoip.dat dependency: the private ranges are spelled out
    expect(out[0]!['ip']).toContain('10.0.0.0/8');
  });

  it('xray emits no rule for an empty bypass set', () => {
    expect(buildXrayRoutingRules({ domains: [], ips: [], ports: [], lan: false })).toEqual([]);
  });

  it('sing-box rules keep the LAN match in its own rule', () => {
    const out = buildSingboxRouteRules(rules);
    expect(out).toHaveLength(2);
    expect(out[0]!['domain_suffix']).toEqual(['a.com', 'b.com']);
    expect(out[0]!['ip_cidr']).toEqual(['1.2.3.4']);
    expect(out[0]!['port']).toEqual([80, 443]);
    expect(out[0]!.outbound).toBe('direct');
    expect(out[1]!).toEqual({ ip_is_private: true, outbound: 'direct' });
  });
});

describe('hysteria2 client config', () => {
  it('quotes every credential-bearing field and wires the HTTP inbound', () => {
    const yaml = buildHysteria2ClientConfig(cfg({ protocol: 'hysteria2' }), 'pass word', 10808);
    expect(yaml).toContain('server: "node.example.com:443"');
    expect(yaml).toContain('auth: "pass word"');
    expect(yaml).toContain('sni: "node.example.com"');
    expect(yaml).toContain('listen: "127.0.0.1:10808"');
    expect(yaml).toContain('fastOpen: true');
  });

  it('escapes YAML-significant characters in secrets', () => {
    const yaml = buildHysteria2ClientConfig(cfg({ protocol: 'hysteria2' }), 'pa"ss\\word', 10808);
    expect(yaml).toContain('auth: "pa\\"ss\\\\word"');
  });

  it('emits salamander obfuscation only when the node asks for it', () => {
    const withObfs = buildHysteria2ClientConfig(cfg({ protocol: 'hysteria2', extra: { obfs: 'salamander', 'obfs-password': 'pw' } }), 's', 1);
    expect(withObfs).toContain('obfs:');
    expect(withObfs).toContain('type: "salamander"');
    expect(withObfs).toContain('password: "pw"');
    const plain = buildHysteria2ClientConfig(cfg({ protocol: 'hysteria2' }), 's', 1);
    expect(plain).not.toContain('obfs:');
  });

  it('emits bandwidth hints only from advertised values', () => {
    const withBw = buildHysteria2ClientConfig(cfg({ protocol: 'hysteria2', extra: { up: 100, down: 50 } }), 's', 1);
    expect(withBw).toContain('up: "100 mbps"');
    expect(withBw).toContain('down: "50 mbps"');
    const noBw = buildHysteria2ClientConfig(cfg({ protocol: 'hysteria2' }), 's', 1);
    expect(noBw).not.toContain('bandwidth:');
    // non-numeric or non-positive hints are ignored, never invented
    const badBw = buildHysteria2ClientConfig(cfg({ protocol: 'hysteria2', extra: { up: -5, down: 'fast' } }), 's', 1);
    expect(badBw).not.toContain('bandwidth:');
  });
});

describe('TUN gateway config', () => {
  it('captures the default route through the engine hop and never loses the direct outbound', () => {
    const g = buildTunGatewayConfig(1080, 7890);
    expect(g.route.final).toBe('engine-hop');
    const outbounds = g.outbounds as Array<{ type: string; tag: string }>;
    expect(outbounds.map((o) => o.tag)).toEqual(['engine-hop', 'direct']);
    expect((g.route.rules as Array<Record<string, unknown>>).some((r) => r['ip_is_private'] === true)).toBe(true);
  });

  it('resolves names through the hop, with no local fallback inside the tunnel', () => {
    const g = buildTunGatewayConfig(1080, 7890);
    const dns = g.dns as { servers: Array<{ tag: string; server: string; detour: string }> };
    expect(dns.servers.every((s) => s.detour === 'engine-hop')).toBe(true);
    expect((g.route as Record<string, unknown>)['default_domain_resolver']).toBeDefined();
  });

  it('plumbs route exclusions for the hop addresses', () => {
    const g = buildTunGatewayConfig(1080, 7890, { excludeAddresses: ['1.2.3.4/32'] });
    const tun = (g.inbounds as Array<{ type: string }>).find((i) => i.type === 'tun')! as Record<string, unknown>;
    expect(tun['route_exclude_address']).toEqual(['1.2.3.4/32']);
  });

  it('derives exclusions from literal IPs, resolved domains and nothing else', async () => {
    const resolve = async (host: string): Promise<string[]> =>
      host === 'node.example.com' ? ['5.6.7.8', '2001:db8::1'] : Promise.reject(new Error('NXDOMAIN'));
    const out = await tunRouteExclusions(['1.2.3.4', '[2001:db8::2]', 'node.example.com', 'nope.invalid', '', null, undefined], resolve);
    expect(out).toContain('1.2.3.4/32');
    expect(out).toContain('2001:db8::2/128');
    expect(out).toContain('5.6.7.8/32');
    expect(out).toContain('2001:db8::1/128');
    expect(out).not.toContain('nope.invalid');
  });

  it('refuses a TUN start when the process cannot create the adapter', () => {
    const saved = process.env['NETPULSE_TUN_ALLOW_UNELEVATED'];
    delete process.env['NETPULSE_TUN_ALLOW_UNELEVATED'];
    try {
      if (process.platform === 'win32') {
        // The refusal text must name the privilege and the
        // alternative (an elevated test process legitimately
        // sees no refusal at all).
        const refusal = tunGatewayStartRefusal();
        if (refusal) {
          expect(refusal).toMatch(/administrator rights/);
          expect(refusal).toMatch(/system-proxy mode/);
        }
        // An explicit override (tests, elevated sidecar) starts.
        process.env['NETPULSE_TUN_ALLOW_UNELEVATED'] = '1';
        expect(tunGatewayStartRefusal()).toBeNull();
      } else {
        // Off Windows the refusal is deliberately not invented.
        expect(tunGatewayStartRefusal()).toBeNull();
      }
    } finally {
      if (saved === undefined) delete process.env['NETPULSE_TUN_ALLOW_UNELEVATED'];
      else process.env['NETPULSE_TUN_ALLOW_UNELEVATED'] = saved;
    }
  });
});
