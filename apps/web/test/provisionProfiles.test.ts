import { beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    post: (...args: unknown[]) => post(...args),
  },
}));

const { PROFILE_NAME_PREFIX, describeImport, importProvisionedConfigs, toShareLink } = await import(
  '@/lib/cloud/provisionProfiles'
);

/**
 * These fixtures are the exact JSON `generateVpnConfig` in
 * cloud/worker/src/index.ts produces — field for field. If the Worker changes a
 * key, the conversion must fail loudly here rather than silently emitting a link
 * the tunnel cannot dial.
 *
 * The target is a share link (not a sing-box outbound): `POST /api/v1/nodes/import`
 * parses it, vaults the credential, and `POST /vpn/tunnel/start` dials it with
 * the bundled xray core — the core that completes REALITY against the deployed
 * server. The earlier sing-box-profile import API (`toSingboxOutbound`,
 * `toImportRequest`, `importProvisionedProfiles`) is gone; this file tests what
 * replaced it.
 */
const REALITY = {
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
  spiderX: '/',
  id: '6ebe8dee-16a2-4b02-895f-e7c614965b98',
  encryption: 'none',
};

const VMESS_WS = {
  protocol: 'vmess',
  server: '206.1.96.89',
  port: 8443,
  id: '6ebe8dee-16a2-4b02-895f-e7c614965b98',
  alterId: 0,
  security: 'none',
  network: 'ws',
  path: '/np-vmess',
};

const VLESS_WS_TLS = {
  protocol: 'vless',
  server: '206.1.96.89',
  port: 2053,
  id: '6ebe8dee-16a2-4b02-895f-e7c614965b98',
  encryption: 'none',
  network: 'ws',
  security: 'tls',
  serverName: '206-1-96-89.sslip.io',
  path: '/np-vless',
  host: '206-1-96-89.sslip.io',
};

const TROJAN = {
  protocol: 'trojan',
  server: '206.1.96.89',
  port: 2087,
  password: 'deadbeefdeadbeefdeadbeefdeadbeef',
  security: 'tls',
  serverName: '206-1-96-89.sslip.io',
};

const HYSTERIA2 = {
  protocol: 'hysteria2',
  server: '206.1.96.89',
  port: 8443,
  password: 'u_3f1bd194bdbc:5cae0bdd1d31db7779aa629bf8db0e3a',
  obfs: { type: 'salamander', salamander: { password: '2cb4aee1863dd4b764c196a4476799e4' } },
  tls: { serverName: '206-1-96-89.sslip.io' },
};

function profile(id: string, name: string, protocol: string, config: Record<string, unknown>) {
  return { id, name, protocol, config: JSON.stringify(config) };
}

/** The link for a fixture, or a thrown reason — so a refusal fails the test. */
function link(protocol: string, config: Record<string, unknown>): URL {
  const res = toShareLink(profile('vp_1', 'X', protocol, config));
  if (!res.ok) throw new Error(`conversion refused: ${res.reason}`);
  return new URL(res.request.link);
}

function vmessPayload(url: URL): Record<string, unknown> {
  return JSON.parse(Buffer.from(url.href.slice('vmess://'.length), 'base64').toString('utf8')) as Record<string, unknown>;
}

describe('cloud config → share link the tunnel can dial', () => {
  it('keeps REALITY parameters, including the pinned public key and fingerprint', () => {
    const url = link('xray-vless-reality', REALITY);
    expect(url.protocol).toBe('vless:');
    expect(url.username).toBe(REALITY.id);
    expect(url.hostname).toBe('206.1.96.89');
    expect(url.port).toBe('443');
    expect(url.searchParams.get('security')).toBe('reality');
    expect(url.searchParams.get('sni')).toBe('www.microsoft.com');
    expect(url.searchParams.get('pbk')).toBe(REALITY.publicKey);
    expect(url.searchParams.get('sid')).toBe(REALITY.shortId);
    expect(url.searchParams.get('fp')).toBe('chrome');
    expect(url.searchParams.get('flow')).toBe('xtls-rprx-vision');
  });

  it('carries the WebSocket path and host so the CDN/edge route still matches', () => {
    const url = link('xray-vless-ws-tls', VLESS_WS_TLS);
    expect(url.port).toBe('2053');
    expect(url.searchParams.get('security')).toBe('tls');
    expect(url.searchParams.get('sni')).toBe('206-1-96-89.sslip.io');
    expect(url.searchParams.get('type')).toBe('ws');
    expect(url.searchParams.get('path')).toBe('/np-vless');
    expect(url.searchParams.get('host')).toBe('206-1-96-89.sslip.io');
  });

  it('emits VMess in the v2rayN shape every client reads', () => {
    const url = link('xray-vmess-ws', VMESS_WS);
    const payload = vmessPayload(url);
    expect(payload['add']).toBe('206.1.96.89');
    expect(payload['port']).toBe(8443);
    expect(payload['id']).toBe(VMESS_WS.id);
    expect(payload['aid']).toBe(0);
    expect(payload['net']).toBe('ws');
    expect(payload['path']).toBe('/np-vmess');
  });

  it('imports Trojan with its password and SNI', () => {
    const url = link('xray-trojan-tls', TROJAN);
    expect(url.protocol).toBe('trojan:');
    expect(decodeURIComponent(url.username)).toBe(TROJAN.password);
    expect(url.searchParams.get('sni')).toBe('206-1-96-89.sslip.io');
  });

  it('names every link so the app lists provisioned nodes as one family', () => {
    const res = toShareLink(profile('vp_1', 'Xray VLESS Reality', 'xray-vless-reality', REALITY));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const url = new URL(res.request.link);
    expect(decodeURIComponent(url.hash.slice(1))).toBe(`${PROFILE_NAME_PREFIX}Xray VLESS Reality`);
  });

  it('refuses a config with no credential instead of emitting an unusable link', () => {
    const res = toShareLink(profile('vp_1', 'X', 'xray-vless-reality', { ...REALITY, id: '' }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/credential/i);
  });

  it('refuses REALITY without its public key', () => {
    const res = toShareLink(profile('vp_1', 'X', 'xray-vless-reality', { ...REALITY, publicKey: '' }));
    expect(res.ok).toBe(false);
  });

  it('refuses Trojan without a password rather than emitting a link that cannot authenticate', () => {
    const res = toShareLink(profile('vp_1', 'X', 'xray-trojan-tls', { ...TROJAN, password: '' }));
    expect(res.ok).toBe(false);
  });

  it('skips Hysteria2 with its obfuscation reason — a node link cannot carry salamander', () => {
    const res = toShareLink(profile('vp_1', 'Hysteria 2', 'hysteria2', HYSTERIA2));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/obfuscation/i);
  });

  it('reports a protocol that is not a tunnel as skipped, naming it', () => {
    const res = toShareLink(profile('vp_1', 'WhiteDNS Soar', 'whitedns-soar', { protocol: 'whitedns' }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('whitedns-soar');
  });

  it('rejects a config that is not JSON', () => {
    const res = toShareLink({ id: 'vp_1', name: 'X', protocol: 'xray-vmess-ws', config: 'not json' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/JSON/i);
  });
});

describe('importProvisionedConfigs', () => {
  beforeEach(() => {
    post.mockReset();
    post.mockResolvedValue({ imported: 2, duplicates: 0, invalid: 0 });
  });

  it('imports every linkable config in ONE batch and reports what the server did', async () => {
    const summary = await importProvisionedConfigs([
      profile('vp_1', 'Xray VLESS Reality', 'xray-vless-reality', REALITY),
      profile('vp_2', 'Xray Trojan TLS', 'xray-trojan-tls', TROJAN),
    ]);

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toBe('/nodes/import');
    const sent = (post.mock.calls[0]?.[1] as { configs: string[] }).configs;
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain('vless://');
    expect(sent[1]).toContain('trojan://');
    expect(summary).toEqual({ imported: 2, present: 0, skipped: [], failed: [] });
  });

  it('reports already-present links as present, not as failures', async () => {
    post.mockResolvedValue({ imported: 0, duplicates: 2, invalid: 0 });
    const summary = await importProvisionedConfigs([
      profile('vp_1', 'Xray VMess WS', 'xray-vmess-ws', VMESS_WS),
      profile('vp_2', 'Xray VLESS WS TLS', 'xray-vless-ws-tls', VLESS_WS_TLS),
    ]);
    expect(summary.imported).toBe(0);
    expect(summary.present).toBe(2);
    expect(summary.failed).toHaveLength(0);
  });

  it('sends nothing when no protocol can become a link', async () => {
    const summary = await importProvisionedConfigs([
      profile('vp_1', 'Hysteria 2', 'hysteria2', HYSTERIA2),
      profile('vp_2', 'WhiteDNS Soar', 'whitedns-soar', { protocol: 'whitedns' }),
    ]);

    expect(post).not.toHaveBeenCalled();
    expect(summary.imported).toBe(0);
    expect(summary.skipped).toHaveLength(2);
    expect(summary.skipped[0]?.protocol).toBe('hysteria2');
    expect(summary.skipped[1]?.protocol).toBe('whitedns-soar');
  });

  it('imports the linkable ones and skips the rest in the same call', async () => {
    post.mockResolvedValue({ imported: 1, duplicates: 0, invalid: 0 });
    const summary = await importProvisionedConfigs([
      profile('vp_1', 'Xray VLESS Reality', 'xray-vless-reality', REALITY),
      profile('vp_2', 'Hysteria 2', 'hysteria2', HYSTERIA2),
    ]);

    expect(summary.imported).toBe(1);
    expect(summary.skipped.map((s) => s.protocol)).toEqual(['hysteria2']);
    const sent = (post.mock.calls[0]?.[1] as { configs: string[] }).configs;
    expect(sent).toHaveLength(1);
  });

  it('reports rejected links as one honest batch failure, never as a named protocol', async () => {
    post.mockResolvedValue({ imported: 1, duplicates: 0, invalid: 2 });
    const summary = await importProvisionedConfigs([
      profile('vp_1', 'Xray VLESS Reality', 'xray-vless-reality', REALITY),
      profile('vp_2', 'Xray VMess WS', 'xray-vmess-ws', VMESS_WS),
      profile('vp_3', 'Xray Trojan TLS', 'xray-trojan-tls', TROJAN),
    ]);

    expect(summary.imported).toBe(1);
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]?.protocol).toBe('batch');
    expect(summary.failed[0]?.reason).toMatch(/2 generated link\(s\) were rejected/);
  });

  it('reports a failed import instead of throwing, so the refresh cannot crash the page', async () => {
    post.mockRejectedValue(new Error('backend unreachable'));
    const summary = await importProvisionedConfigs([
      profile('vp_1', 'Xray VLESS Reality', 'xray-vless-reality', REALITY),
    ]);

    expect(summary.imported).toBe(0);
    expect(summary.failed).toEqual([{ protocol: 'batch', reason: 'backend unreachable' }]);
  });

  it('does nothing at all for an empty subscription', async () => {
    const summary = await importProvisionedConfigs([]);
    expect(post).not.toHaveBeenCalled();
    expect(summary).toEqual({ imported: 0, present: 0, skipped: [], failed: [] });
  });
});

describe('describeImport', () => {
  it('says nothing when everything imported cleanly', () => {
    expect(describeImport({ imported: 3, present: 0, skipped: [], failed: [] }, 3)).toBeNull();
  });

  it('counts what happened when part of the batch failed', () => {
    const note = describeImport({ imported: 1, present: 0, skipped: [], failed: [{ protocol: 'batch', reason: 'nope' }] }, 2);
    expect(note).toMatch(/1 of 2/);
  });

  it('does not read as success when nothing could be added', () => {
    const note = describeImport({ imported: 0, present: 0, skipped: [], failed: [] }, 2);
    expect(note).toMatch(/none of them could be added/);
  });

  it('names protocols that can only be copied instead of counting them as failures', () => {
    const note = describeImport(
      { imported: 1, present: 0, skipped: [{ protocol: 'hysteria2', reason: 'cannot be expressed as a tunnel link' }], failed: [] },
      2,
    );
    expect(note).toMatch(/only be copied/);
  });
});
