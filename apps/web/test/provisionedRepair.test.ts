import { beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
const provision = vi.fn();

vi.mock('@/lib/api', () => ({
  api: {
    post: (...args: unknown[]) => post(...args),
    get: vi.fn(),
  },
}));

vi.mock('@/lib/cloud/client', () => ({
  CloudError: class CloudError extends Error {
    constructor(
      readonly code: string,
      readonly status: number,
      message: string,
    ) {
      super(message);
      this.name = 'CloudError';
    }
  },
  cloudApi: {
    provision: () => provision(),
  },
}));

const {
  evidenceSummary,
  failingProvisionedNodes,
  isProvisionedNode,
  needsCredentialRefresh,
  refreshProvisionedCredentials,
} = await import('@/features/vpn/provisionedRepair');

/** The Worker's VLESS/REALITY client config, field for field. */
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
  id: '6ebe8dee-16a2-4b02-895f-e7c614965b98',
};

const HYSTERIA2 = {
  protocol: 'hysteria2',
  server: '206.1.96.89',
  port: 8443,
  password: 'u_3f1bd194bdbc:5cae0bdd1d31db7779aa629bf8db0e3a',
  obfs: { type: 'salamander', salamander: { password: '2cb4aee1863dd4b764c196a4476799e4' } },
  tls: { serverName: '206-1-96-89.sslip.io' },
};

function profile(name: string, protocol: string, config: Record<string, unknown>) {
  return { id: `vp_${name}`, name, protocol, config: JSON.stringify(config) };
}

/** Only the fields the detection reads. */
function node(over: Partial<Parameters<typeof needsCredentialRefresh>[0]> = {}) {
  return {
    id: 'node:abc123',
    label: 'NetPulse · Xray VLESS Reality',
    remark: 'NetPulse · Xray VLESS Reality',
    consecutiveFailures: 0,
    testCount: 0,
    successCount: 0,
    ...over,
  };
}

/** Route the two API calls the refresh makes, so the ordering is explicit. */
function stubApi(importResponse: Record<string, unknown>, probeResponse?: Record<string, unknown>) {
  post.mockImplementation((path: string) => {
    if (path === '/nodes/import') return Promise.resolve(importResponse);
    if (path === '/nodes/test-batch') {
      if (probeResponse instanceof Error) return Promise.reject(probeResponse);
      return Promise.resolve(probeResponse ?? { results: {} });
    }
    return Promise.reject(new Error(`unexpected call ${path}`));
  });
}

beforeEach(() => {
  post.mockReset();
  provision.mockReset();
});

describe('detecting subscription profiles', () => {
  it('recognises a provisioned profile by its remark or its label', () => {
    expect(isProvisionedNode({ remark: 'NetPulse · Xray VLESS Reality', label: 'anything' })).toBe(true);
    // The view layer withholds a remark that reads as an endpoint, so the label
    // can be the only place the marker survives.
    expect(isProvisionedNode({ remark: null, label: 'NetPulse · Xray VLESS Reality' })).toBe(true);
  });

  it('does not claim a node the user pasted themselves', () => {
    expect(isProvisionedNode({ remark: '🇺🇸 US Premium 01', label: '🇺🇸 US Premium 01' })).toBe(false);
  });

  it('flags a profile that has never passed a probe', () => {
    expect(needsCredentialRefresh(node({ testCount: 5, successCount: 0 }))).toBe(true);
  });

  it('flags a profile that stopped passing', () => {
    expect(needsCredentialRefresh(node({ testCount: 20, successCount: 18, consecutiveFailures: 2 }))).toBe(true);
  });

  it('leaves a passing provisioned profile alone', () => {
    expect(needsCredentialRefresh(node({ testCount: 9, successCount: 9, consecutiveFailures: 0 }))).toBe(false);
  });

  it('does not flag an untested profile — there is no evidence of anything yet', () => {
    expect(needsCredentialRefresh(node({ testCount: 0, successCount: 0, consecutiveFailures: 0 }))).toBe(false);
  });

  it('filters a node list down to the ones worth acting on', () => {
    const list = [
      node({ id: 'a' }),
      node({ id: 'b', testCount: 4, successCount: 0 }),
      node({ id: 'c', remark: 'other', label: 'other', testCount: 4, successCount: 0 }),
      node({ id: 'd', testCount: 4, successCount: 4 }),
    ];
    expect(failingProvisionedNodes(list).map((n) => n.id)).toEqual(['b']);
  });

  it('states the observation without diagnosing the cause', () => {
    expect(evidenceSummary([node({ id: 'a' }), node({ id: 'b', testCount: 2, successCount: 0 }), node({ id: 'c', testCount: 9, successCount: 7, consecutiveFailures: 2 })])).toBe(
      '2 has never passed a probe, 1 stopped passing',
    );
  });
});

describe('refreshing from the subscription', () => {
  it('stores the re-issued credential, probes the node, and says the credential had changed', async () => {
    provision.mockResolvedValue({ ok: true, provisioned: [profile('Xray VLESS Reality', 'xray-vless-reality', REALITY)], skipped: [], errors: [] });
    stubApi({ imported: 0, duplicates: 1, invalid: 0, nodeIds: ['node:abc123'], credentialsUpdated: 1 }, { results: { 'node:abc123': { success: true } } });

    const result = await refreshProvisionedCredentials(['node:abc123']);

    expect(result.outcome).toBe('credential-replaced');
    expect(result.credentialsUpdated).toBe(1);
    expect(result.probed).toEqual({ attempted: 1, carried: 1 });
    expect(result.message).toMatch(/different credential/);
    expect(result.message).toMatch(/1 of 1 now carries a probe/);

    // The imported link is the one the tunnel dials: a share link built from the
    // control plane's own config, not a paraphrase of it.
    const [importPath, importBody] = post.mock.calls.find((c) => c[0] === '/nodes/import') as [string, { configs: string[] }];
    expect(importPath).toBe('/nodes/import');
    expect(importBody.configs).toHaveLength(1);
    expect(importBody.configs[0]).toContain(`vless://${REALITY.id}@`);
    expect(importBody.configs[0]).toContain(`pbk=${REALITY.publicKey}`);
  });

  it('says the credential was NOT the difference when the server issues the same one', async () => {
    provision.mockResolvedValue({ ok: true, provisioned: [profile('Xray VLESS Reality', 'xray-vless-reality', REALITY)], skipped: [], errors: [] });
    stubApi({ imported: 0, duplicates: 1, invalid: 0, nodeIds: ['node:abc123'], credentialsUpdated: 0 }, { results: { 'node:abc123': { success: false } } });

    const result = await refreshProvisionedCredentials(['node:abc123']);

    expect(result.outcome).toBe('credential-unchanged');
    expect(result.message).toMatch(/same credential/);
    expect(result.message).toMatch(/0 of 1 now carry a probe/);
    // Nothing may claim a repair happened.
    expect(result.message).not.toMatch(/replaced/);
  });

  it('does not claim the node works when no probe could run', async () => {
    provision.mockResolvedValue({ ok: true, provisioned: [profile('Xray VLESS Reality', 'xray-vless-reality', REALITY)], skipped: [], errors: [] });
    stubApi({ imported: 0, duplicates: 1, invalid: 0, nodeIds: ['node:abc123'], credentialsUpdated: 1 }, new Error('no core installed'));

    const result = await refreshProvisionedCredentials(['node:abc123']);

    expect(result.outcome).toBe('credential-replaced');
    expect(result.probed).toBeNull();
    expect(result.message).toMatch(/not probed/);
  });

  it('probes only the nodes the surface flagged', async () => {
    provision.mockResolvedValue({ ok: true, provisioned: [profile('Xray VLESS Reality', 'xray-vless-reality', REALITY)], skipped: [], errors: [] });
    stubApi({ imported: 0, duplicates: 1, invalid: 0, nodeIds: ['node:flagged', 'node:unrelated'], credentialsUpdated: 1 }, { results: { 'node:flagged': { success: true } } });

    const result = await refreshProvisionedCredentials(['node:flagged']);

    const probe = post.mock.calls.find((c) => c[0] === '/nodes/test-batch') as [string, { nodeIds: string[]; type: string }];
    expect(probe[1].nodeIds).toEqual(['node:flagged']);
    expect(probe[1].type).toBe('proxy');
    expect(result.addressed).toEqual(['node:flagged']);
  });

  it('probes what a refresh created when nothing it flagged was touched', async () => {
    provision.mockResolvedValue({ ok: true, provisioned: [profile('Xray VLESS Reality', 'xray-vless-reality', REALITY)], skipped: [], errors: [] });
    stubApi({ imported: 1, duplicates: 0, invalid: 0, nodeIds: ['node:new'], credentialsUpdated: 0 }, { results: { 'node:new': { success: true } } });

    const result = await refreshProvisionedCredentials(['node:old']);

    expect(result.addressed).toEqual(['node:new']);
    expect(result.probed).toEqual({ attempted: 1, carried: 1 });
  });

  it('names a protocol a node link cannot carry instead of failing the refresh', async () => {
    provision.mockResolvedValue({
      ok: true,
      provisioned: [profile('Xray VLESS Reality', 'xray-vless-reality', REALITY), profile('Hysteria 2', 'hysteria2', HYSTERIA2)],
      skipped: [],
      errors: [],
    });
    stubApi({ imported: 0, duplicates: 1, invalid: 0, nodeIds: ['node:abc123'], credentialsUpdated: 1 }, { results: { 'node:abc123': { success: true } } });

    const result = await refreshProvisionedCredentials(['node:abc123']);

    expect(result.unconvertible).toBe(1);
    expect(result.message).toMatch(/only be copied from the Account page/);
  });

  it('says there is nothing to re-issue when the subscription returns no configs', async () => {
    provision.mockResolvedValue({ ok: true, provisioned: [], skipped: [], errors: [] });

    const result = await refreshProvisionedCredentials(['node:abc123']);

    expect(result.outcome).toBe('unavailable');
    expect(result.message).toMatch(/issues no configs/);
    expect(post).not.toHaveBeenCalled();
  });

  it('names an expired subscription as the reason a refresh cannot work', async () => {
    const { CloudError } = await import('@/lib/cloud/client');
    provision.mockRejectedValue(new CloudError('entitlement_expired', 403, 'gone'));
    stubApi({ imported: 0, duplicates: 0, invalid: 0, nodeIds: [], credentialsUpdated: 0 });

    const result = await refreshProvisionedCredentials(['node:abc123']);

    expect(result.outcome).toBe('unavailable');
    expect(result.message).toMatch(/expired/);
    expect(post).not.toHaveBeenCalled();
  });

  it('tells a signed-out user where to sign in', async () => {
    const { CloudError } = await import('@/lib/cloud/client');
    provision.mockRejectedValue(new CloudError('not_authenticated', 401, 'no session'));

    const result = await refreshProvisionedCredentials(['node:abc123']);

    expect(result.message).toMatch(/Sign in on the Account page/);
  });

  it('says nothing changed when the configs cannot be stored', async () => {
    provision.mockResolvedValue({ ok: true, provisioned: [profile('Xray VLESS Reality', 'xray-vless-reality', REALITY)], skipped: [], errors: [] });
    post.mockRejectedValue(new Error('sidecar is not running'));

    const result = await refreshProvisionedCredentials(['node:abc123']);

    expect(result.outcome).toBe('unavailable');
    expect(result.message).toMatch(/Nothing about your profile changed/);
  });
});
