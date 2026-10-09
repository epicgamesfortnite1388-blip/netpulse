import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../src/routes/context';
import type { PlatformNetworkController } from '../src/providers/platform/types';

/**
 * The endpoint boundary: host, port and the addresses that identify a node may
 * not appear in ANY response the user can read.
 *
 * This is deliberately wider than "the field is absent from the DTO". Absence
 * of a key proves nothing about a nested object, a summary line, a label, or a
 * status message — so each assertion scans the SERIALIZED BODY for the actual
 * fixture values, and separately pins the substitute (a real, non-empty
 * `label` plus `endpointHidden`) so a removal cannot degrade into blanks.
 *
 * Failure mode this exists to catch: a half-removed field that comes back as
 * `undefined`, `NaN`, an empty string or a redaction blob. A surface rendering
 * `Host: ` is a defect in the same way a leak is, so both directions are
 * asserted here.
 *
 * Fixtures use hostnames rather than literal IPs: the parser refuses reserved
 * ranges on purpose, so an IP fixture would never import.
 *
 * All fixtures are imported in ONE request — `/nodes/import` allows 6 calls a
 * minute, and a test that needs ten nodes has to be a test that imports once.
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

const SECRET_UUID = '5f0a3c1e-9d27-4b64-8a11-2ce4b7d9e0aa';

/** Every fixture, imported together. Distinct hosts = distinct fingerprints. */
const FIXTURES: Array<{ key: string; host: string; port: number; remark?: string }> = [
  { key: 'list', host: 'list-leak.example.test', port: 8443 },
  { key: 'detail', host: 'detail-leak.example.test', port: 9443 },
  { key: 'search', host: 'search-leak.example.test', port: 443 },
  { key: 'recheck', host: 'recheck-leak.example.test', port: 443 },
  { key: 'map', host: 'map-leak.example.test', port: 7443 },
  { key: 'gateway', host: 'gateway-leak.example.test', port: 6443 },
  { key: 'compare', host: 'compare-leak.example.test', port: 5443 },
  { key: 'sweep', host: 'sweep-leak.example.test', port: 3443 },
  // A provider that names a node after its own endpoint, verbatim…
  { key: 'remarkHost', host: 'remark-leak.example.test', port: 4443, remark: 'remark-leak.example.test' },
  // …and one that names it after the IP the endpoint resolves to.
  { key: 'remarkIp', host: 'ipremark-leak.example.test', port: 4444, remark: '198.51.100.7' },
];

const link = (f: (typeof FIXTURES)[number]) =>
  `vless://${SECRET_UUID}@${f.host}:${f.port}?type=tcp&security=tls&sni=${f.host}#${encodeURIComponent(f.remark ?? 'Endpoint fixture')}`;

let app: FastifyInstance;
let ctx: AppContext;
let cookieHeader: string;
let tmpDir: string;
/** fixture key → imported node id */
const ids: Record<string, string> = {};

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-endpoint-'));
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

  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/nodes/import',
    headers: H(),
    payload: { configs: FIXTURES.map(link) },
  });
  expect(created.statusCode).toBe(201);
  const body = created.json() as { imported: number; nodeIds: string[] };
  expect(body.imported, 'not every fixture imported').toBe(FIXTURES.length);
  FIXTURES.forEach((f, i) => {
    ids[f.key] = body.nodeIds[i]!;
  });
});

afterAll(async () => {
  await app.close();
  ctx.db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const H = () => ({ cookie: cookieHeader, 'content-type': 'application/json' });

/** What a client may never learn from this API about a stored node. */
const FORBIDDEN_KEYS = ['host', 'port', 'ipv4', 'ipv6', 'sni', 'hostHeader', 'realityServerName'];

/**
 * Every object in a response that looks like a node view — it carries a
 * `label`, which is this pass's substitute for the address.
 *
 * A recursive walk rather than a top-level check, because nesting is exactly
 * how a field comes back: `/nodes/recommend` wraps its rows in `context` +
 * `nodes`, and a future response could bury one deeper still.
 */
function nodeShaped(value: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) nodeShaped(item, out);
    return out;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj['label'] === 'string') out.push(obj);
    for (const child of Object.values(obj)) nodeShaped(child, out);
  }
  return out;
}

/**
 * The assertion every user-visible node response must pass.
 *
 * Two independent halves, both required:
 *
 *   - VALUE scan over the whole body: the fixture's hostname and port, a share
 *     link or the credential must never appear, at any depth, in any string.
 *   - KEY scan over node-shaped objects only: a withheld key must be absent,
 *     and `endpointHidden` must be declared.
 *
 * The key scan is scoped deliberately. A whole-body key scan false-positives on
 * `/nodes/recommend`, whose `context.ipv4: false` is a FILTER FLAG saying the
 * preset needs IPv4 — not an address. Scoping by shape keeps the scan honest
 * about what it is actually claiming: that no node view carries an endpoint.
 */
function expectNoEndpoint(body: string, host: string, port?: number, opts: { nodes?: unknown } = {}) {
  expect(body, `response leaked the node hostname (${host})`).not.toContain(host);
  if (port != null) {
    expect(body, `response leaked the node port (${port})`).not.toMatch(new RegExp(`["':\\s]${port}\\b`));
  }
  expect(body, 'response leaked a share link').not.toMatch(/\b(vless|vmess|trojan|ss|ssr|hysteria2|tuic):\/\//i);
  expect(body, 'response leaked the credential').not.toMatch(new RegExp(SECRET_UUID, 'i'));

  for (const node of nodeShaped(opts.nodes ?? JSON.parse(body))) {
    for (const key of FORBIDDEN_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(node, key), `a node view still carries "${key}" in ${body.slice(0, 200)}`).toBe(
        false,
      );
    }
    expect(node['endpointHidden'], 'a node view does not declare endpointHidden').toBe(true);
  }
}

/**
 * The other direction: a surface whose endpoint is hidden must say so. If it
 * renders empty/undefined/NaN it reads as broken data rather than as a
 * deliberate omission, so a missing or blank label is a failure here too.
 */
function expectHonestLabel(node: Record<string, unknown>, where: string) {
  expect(node, `${where} has no label substitute`).toHaveProperty('label');
  const label = node['label'];
  expect(typeof label, `${where} label is ${String(label)}`).toBe('string');
  expect(label, `${where} label is empty`).not.toBe('');
  expect(label, `${where} label is blank whitespace`).not.toMatch(/^\s*$/);
  expect(label, `${where} label is not a missing-value marker`).not.toMatch(/^(undefined|null|NaN|-|—|N\/A)$/i);
  expect(node['endpointHidden'], `${where} does not declare endpointHidden`).toBe(true);
}

describe('GET /nodes list never carries an endpoint', () => {
  it('returns no host, port or address, and a real label instead', async () => {
    const host = 'list-leak.example.test';
    const res = await app.inject({ method: 'GET', url: '/api/v1/nodes?limit=50', headers: H() });
    expect(res.statusCode).toBe(200);
    expectNoEndpoint(res.body, host, 8443);

    const body = res.json() as { nodes: Array<Record<string, unknown>> };
    const mine = body.nodes.find((n) => n['id'] === ids['list']);
    expect(mine, 'the imported node was not in the list').toBeDefined();
    expectHonestLabel(mine!, 'list row');
    expect(String(mine!['label'])).not.toContain(host);
  });

  it('holds across every row, not only the fixture', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/nodes?limit=200', headers: H() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { nodes: Array<Record<string, unknown>> };
    expect(body.nodes.length).toBeGreaterThan(0);
    for (const node of body.nodes) expectHonestLabel(node, 'list row');
    // A blanket key scan over every row catches a leak from ANY node, not only
    // the ones this file imported.
    for (const key of FORBIDDEN_KEYS) {
      const offenders = body.nodes.filter((n) => Object.prototype.hasOwnProperty.call(n, key));
      expect(offenders.map((o) => o['id']), `rows still expose "${key}"`).toEqual([]);
    }
  });
});

describe('GET /nodes/:id detail never carries an endpoint', () => {
  it('withholds the address and renders it as deliberately hidden', async () => {
    const host = 'detail-leak.example.test';
    const res = await app.inject({ method: 'GET', url: `/api/v1/nodes/${ids['detail']}`, headers: H() });
    expect(res.statusCode).toBe(200);
    expectNoEndpoint(res.body, host, 9443);

    const node = res.json() as Record<string, unknown>;
    expectHonestLabel(node, 'detail');

    // The decisions the old Host/Port rows served are still served: protocol,
    // transport, security and the route facts a user acts on are present.
    for (const kept of ['protocol', 'protocolLabel', 'transport', 'security', 'path', 'serviceName']) {
      expect(Object.prototype.hasOwnProperty.call(node, kept), `detail dropped "${kept}"`).toBe(true);
    }
    // And the withheld ones are absent rather than null-ified: a null says
    // "unknown", which would be a lie about a value the server does hold.
    for (const gone of FORBIDDEN_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(node, gone), `detail still has "${gone}"`).toBe(false);
    }
  });
});

describe('search and geo-recheck responses are clean', () => {
  it('search results carry no endpoint', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/nodes/search?q=search-leak', headers: H() });
    expect(res.statusCode).toBe(200);
    expectNoEndpoint(res.body, 'search-leak.example.test');
    const body = res.json() as { results: Array<Record<string, unknown>> };
    for (const node of body.results) expectHonestLabel(node, 'search result');
  });

  it('geo-recheck, which returns the refreshed node, carries no endpoint', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${ids['recheck']}/geo-recheck`,
      headers: H(),
      payload: {},
    });
    // The probe is disabled in tests, so the outcome is a refusal — the point
    // is that whatever it answers, it never answers with the endpoint.
    expect([200, 500]).toContain(res.statusCode);
    expectNoEndpoint(res.body, 'recheck-leak.example.test');
  });
});

describe('map targets withhold a node endpoint but stay measurable', () => {
  it('marks a verified node endpointHidden and omits host/port', async () => {
    const host = 'map-leak.example.test';
    // The map only lists geo-verified nodes, so give this one a real location.
    ctx.repos.publicNodes.updateGeo(ids['map'], {
      lat: 52.37,
      lon: 4.9,
      country: 'NL',
      city: 'Amsterdam',
      confidence: 'high',
      geoSourceCount: 1,
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/map/targets', headers: H() });
    expect(res.statusCode).toBe(200);
    // The node's hostname must not appear anywhere in the catalog…
    expect(res.body).not.toContain(host);

    const { targets } = res.json() as { targets: Array<Record<string, unknown>> };
    const mine = targets.find((t) => String(t['id']) === `node:${ids['map']}`);
    expect(mine, 'the node was not offered as a map target').toBeDefined();
    expect(mine!['endpointHidden'], 'map target does not declare endpointHidden').toBe(true);
    expect(Object.prototype.hasOwnProperty.call(mine!, 'host'), 'map target still carries host').toBe(false);
    expect(Object.prototype.hasOwnProperty.call(mine!, 'port'), 'map target still carries port').toBe(false);
    // Still selectable and still named — the map must not lose the target.
    expect(String(mine!['name'] ?? '')).not.toBe('');
    expect(String(mine!['name'])).not.toContain(host);
  });
});

describe('gateway memory and history withhold the remembered endpoint', () => {
  it('GET /vpn/tunnel/gateways returns a label, not host:port', async () => {
    const host = 'gateway-leak.example.test';
    ctx.services.gatewayMemory.remember({
      nodeId: ids['gateway'],
      name: 'Remembered fixture',
      label: 'Remembered fixture',
      protocol: 'vless',
      engine: 'sing-box',
      exitIp: '203.0.113.9',
      exitCountry: 'NL',
      verifyMs: 42,
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/vpn/tunnel/gateways', headers: H() });
    expect(res.statusCode).toBe(200);
    expectNoEndpoint(res.body, host, 6443);

    const { gateways } = res.json() as { gateways: Array<Record<string, unknown>> };
    const mine = gateways.find((g) => g['nodeId'] === ids['gateway']);
    expect(mine, 'the remembered gateway was not returned').toBeDefined();
    expectHonestLabel(mine!, 'gateway memory row');
    expect(String(mine!['label'])).not.toContain(host);
  });

  it('GET /vpn/history gateway rows also withhold it', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/vpn/history', headers: H() });
    expect(res.statusCode).toBe(200);
    expectNoEndpoint(res.body, 'gateway-leak.example.test', 6443);

    const body = res.json() as { history: { gateways: Array<Record<string, unknown>> } };
    for (const row of body.history.gateways) expectHonestLabel(row, 'history gateway row');
  });
});

describe('direct-vs-VPN resolves a node server-side', () => {
  it('accepts a nodeId and returns the node label with no address', async () => {
    const host = 'compare-leak.example.test';
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/route-compare/vpn?nodeId=${encodeURIComponent(ids['compare'])}`,
      headers: H(),
    });
    expect(res.statusCode).toBe(200);
    expectNoEndpoint(res.body, host, 5443);

    const body = res.json() as { target: string; endpointHidden?: true; status: string };
    expect(body.endpointHidden, 'node comparison does not declare endpointHidden').toBe(true);
    // `target` is the node's LABEL: a usable, non-empty display string, so the
    // comparison still says what it compared.
    expect(typeof body.target).toBe('string');
    expect(body.target).not.toBe('');
    expect(body.target).not.toContain(host);
    expect(body.status).toBeTruthy();
  });

  it('still accepts a host the user typed, because typing one discloses nothing', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/route-compare/vpn?target=example.com', headers: H() });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { target: string; endpointHidden?: true };
    expect(body.target).toBe('example.com');
    expect(body.endpointHidden).toBeUndefined();
  });

  it('rejects being given both, rather than guessing which one to trust', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/route-compare/vpn?nodeId=${encodeURIComponent(ids['compare'])}&target=example.com`,
      headers: H(),
    });
    expect(res.statusCode).toBe(400);
  });

  it('404s an unknown nodeId, and the message cannot be used to reach an endpoint', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/route-compare/vpn?nodeId=node:does-not-exist', headers: H() });
    expect(res.statusCode).toBe(404);
    // The id the caller supplied is echoed back — that is their own input, not
    // a node's address. What matters is that no real fixture endpoint, link or
    // credential accompanies it.
    for (const f of FIXTURES) expect(res.body).not.toContain(f.host);
    expect(res.body).not.toMatch(/\b(vless|vmess|trojan|ss|ssr|hysteria2|tuic):\/\//i);
    expect(res.body).not.toMatch(new RegExp(SECRET_UUID, 'i'));
  });
});

describe('a remark that IS the endpoint cannot smuggle it back', () => {
  it('withholds the address-shaped remark as well as the address', async () => {
    const host = 'remark-leak.example.test';
    const res = await app.inject({ method: 'GET', url: `/api/v1/nodes/${ids['remarkHost']}`, headers: H() });
    expect(res.statusCode).toBe(200);
    expectNoEndpoint(res.body, host, 4443);

    const node = res.json() as { remark: string | null; label: string };
    // The remark field is nulled rather than echoed — it IS the endpoint here,
    // and `label` carries the identity that the remark would have supplied.
    expect(node.remark).toBeNull();
    expect(node.label).not.toContain(host);
    expectHonestLabel(node as unknown as Record<string, unknown>, 'remark-as-host detail');
  });

  it('rejects an IP-literal remark too', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/v1/nodes/${ids['remarkIp']}`, headers: H() });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('198.51.100.7');
    expectHonestLabel(res.json() as Record<string, unknown>, 'IP-literal remark detail');
  });
});

describe('a node\'s subscription URL never rides out on the DTO', () => {
  it('masks sourceUrls the same way every /sources route does', async () => {
    // A subscription URL IS the configuration: fetch it outside the app and
    // you hold every node it carries. `/sources` masks it on every read, and
    // the node DTO used to hand it over unmaksed — roundabout, but complete.
    const raw = 'https://k7f2ab9cd.my-panel.example/subscribe/verylongtoken?token=alsosecret';
    ctx.repos.publicNodes.update(ids['list'], { sourceUrls: [raw] });

    const res = await app.inject({ method: 'GET', url: `/api/v1/nodes/${ids['list']}`, headers: H() });
    expect(res.statusCode).toBe(200);
    expect(res.body, 'the raw subscription URL rode out on the node DTO').not.toContain('verylongtoken');
    expect(res.body).not.toContain('alsosecret');
    expect(res.body).not.toContain('k7f2ab9cd');

    const node = res.json() as { sourceUrls: string[] };
    expect(Array.isArray(node.sourceUrls)).toBe(true);
    expect(node.sourceUrls).toHaveLength(1);
    // The user can still tell two sources apart: the domain survives.
    expect(node.sourceUrls[0]).toContain('my-panel.example');

    // And the list route, which is the one the explorer actually calls.
    const list = await app.inject({ method: 'GET', url: '/api/v1/nodes?limit=50', headers: H() });
    expect(list.body).not.toContain('verylongtoken');
    expect(list.body).not.toContain('alsosecret');

    // Restore so later tests see the fixture as imported.
    ctx.repos.publicNodes.update(ids['list'], { sourceUrls: [] });
  });
});

describe('no node response anywhere exposes an endpoint key', () => {
  it('sweeps every node-reading GET this app offers', async () => {
    const host = 'sweep-leak.example.test';

    const requests: Array<[string, string]> = [
      ['list', '/api/v1/nodes?limit=100'],
      ['detail', `/api/v1/nodes/${ids['sweep']}`],
      ['search', '/api/v1/nodes/search?q=sweep-leak'],
      ['stats', '/api/v1/nodes/stats'],
      ['recommend fastest', '/api/v1/nodes/recommend?preset=fastest'],
      ['recommend ipv6', '/api/v1/nodes/recommend?preset=best-ipv6'],
    ];

    for (const [what, url] of requests) {
      const res = await app.inject({ method: 'GET', url, headers: H() });
      expect([200, 400, 404, 503], `${what} unexpected status ${res.statusCode}`).toContain(res.statusCode);
      if (res.statusCode !== 200) continue;
      expectNoEndpoint(res.body, host, 3443);
    }
  });

  it('scans the mixed map catalog for node endpoints without banning public hosts', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/map/targets', headers: H() });
    expect(res.statusCode).toBe(200);
    // Value scan for every fixture: resolvers and game front doors are named
    // on purpose, so the key scan does not apply — but no stored node's address
    // may appear anywhere in the catalog.
    for (const f of FIXTURES) expect(res.body, `${f.key} host leaked into map catalog`).not.toContain(f.host);
    // Every node-derived target in the catalog declares itself and carries no
    // address; public resolvers/game doors keep theirs and are not node views
    // (they have no `label`), so the shape scan leaves them alone.
    const { targets } = res.json() as { targets: Array<Record<string, unknown>> };
    const nodeTargets = targets.filter((t) => String(t['id']).startsWith('node:'));
    for (const t of nodeTargets) {
      expect(t['endpointHidden'], `${t['id']} does not declare endpointHidden`).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(t, 'host'), `${t['id']} carries host`).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(t, 'port'), `${t['id']} carries port`).toBe(false);
    }
  });
});

/**
 * Responses assembled from STORED rows, written before anyone knew they would
 * be shown: probe results (which record the dialled address as `probedIp` and
 * may quote it in an error), stored traceroutes (whose `params.target` can be
 * a node address when the map traced a node target), and past VPN sessions
 * (whose rows keep the dial address for the server's own bookkeeping).
 */
describe('stored rows are scrubbed before they reach a response', () => {
  it('POST /nodes/:id/test never returns the address it probed', async () => {
    const host = 'detail-leak.example.test';
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/nodes/${ids['detail']}/test`,
      headers: H(),
      payload: { type: 'tcp' },
    });
    // The controller refuses every probe in tests, so this is the FAILURE
    // path — exactly where an error string would otherwise quote the target.
    expect([200, 500]).toContain(res.statusCode);
    const body = res.json() as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(body, 'probedIp'), 'probedIp rode out on the test result').toBe(false);
    expect(res.body, `test response leaked ${host}`).not.toContain(host);
    expect(res.body).not.toMatch(new RegExp(`["':\\s]9443\\b`));
  });

  it('POST /nodes/test-batch masks every per-node failure the same way', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/nodes/test-batch',
      headers: H(),
      payload: { nodeIds: [ids['detail'], ids['list']], type: 'tcp' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { results: Record<string, { error?: string }> };
    expect(Object.keys(body.results)).toHaveLength(2);
    for (const f of [FIXTURES[1]!, FIXTURES[0]!]) {
      expect(res.body, `batch test leaked ${f.host}`).not.toContain(f.host);
      expect(res.body).not.toMatch(new RegExp(`["':\\s]${f.port}\\b`));
    }
  });

  it('GET /nodes/:id/history drops probedIp and masks stored error text', async () => {
    const host = 'detail-leak.example.test';
    // A row as a probe would have written it long before this boundary existed.
    ctx.repos.nodeTests.insert({
      id: `leak-hist-${Date.now()}`,
      nodeId: ids['detail'],
      type: 'tcp',
      status: 'error',
      startedAt: Date.now() - 1_000,
      finishedAt: Date.now(),
      latencyMs: null,
      totalMs: 8_000,
      tlsVersion: null,
      authorized: null,
      httpStatus: null,
      responseSize: null,
      error: `connect ETIMEDOUT ${host}:9443`,
      family: 4,
      probedIp: host,
      testEndpoint: `${host}:9443`,
      engine: null,
    });

    const res = await app.inject({ method: 'GET', url: `/api/v1/nodes/${ids['detail']}/history`, headers: H() });
    expect(res.statusCode).toBe(200);
    expect(res.body, `stored history leaked ${host}`).not.toContain(host);
    expect(res.body).not.toMatch(new RegExp(`["':\\s]9443\\b`));

    const { tests } = res.json() as { tests: Array<Record<string, unknown>> };
    expect(tests.length).toBeGreaterThan(0);
    for (const t of tests) {
      expect(Object.prototype.hasOwnProperty.call(t, 'probedIp'), 'a history row carries probedIp').toBe(false);
      expect(Object.prototype.hasOwnProperty.call(t, 'testEndpoint'), 'a history row carries testEndpoint').toBe(false);
      if (typeof t['error'] === 'string' && t['error'].length > 0) {
        expect(t['error'], 'a stored probe error still quotes the address').not.toContain(host);
      }
    }
  });

  it('GET /route-compare/vpn/history rewrites a stored node address to its label', async () => {
    const host = 'gateway-leak.example.test';
    const testId = `leak-route-${Date.now()}`;
    ctx.repos.tests.create(testId, 'route', {
      target: host,
      resolvedIp: '203.0.113.99',
      vpn: { connected: false, providerId: null, verifiedPublicIp: null },
    });
    ctx.repos.tests.finish(testId, {
      status: 'done',
      summary: { hops: 8, totalLatencyMs: 120, score: 0.8 },
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/route-compare/vpn/history', headers: H() });
    expect(res.statusCode).toBe(200);
    expect(res.body, `route history leaked ${host}`).not.toContain(host);

    const { routes } = res.json() as { routes: Array<Record<string, unknown>> };
    const mine = routes.find((r) => r['id'] === testId);
    expect(mine, 'the seeded route row was not returned').toBeDefined();
    // The substitute, not a blank: the row still says WHAT was compared, by
    // name, and declares that the address is deliberately withheld.
    expect(String(mine!['target'] ?? '')).not.toBe('');
    expect(String(mine!['target'])).not.toContain(host);
    expect(mine!['endpointHidden'], 'rewritten route row does not declare endpointHidden').toBe(true);
    expect(mine!['resolvedIp'], 'hidden row still resolves an address').toBeNull();
  });

  it('GET /vpn/connections withholds the dial address of past sessions', async () => {
    const host = 'gateway-leak.example.test';
    ctx.repos.vpnConnections.insert({
      id: `leak-conn-${Date.now()}`,
      providerId: 'singbox',
      serverId: null,
      serverName: 'Stored session',
      endpoint: `${host}:6443`,
      protocol: 'vless',
      status: 'connected',
      connectedAt: Date.now() - 60_000,
      error: null,
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/vpn/connections', headers: H() });
    expect(res.statusCode).toBe(200);
    expect(res.body, `connection history leaked ${host}`).not.toContain(host);
    const { connections } = res.json() as { connections: Array<Record<string, unknown>> };
    expect(connections.length).toBeGreaterThan(0);
    for (const c of connections) {
      expect(Object.prototype.hasOwnProperty.call(c, 'endpoint'), 'a connection row carries endpoint').toBe(false);
      // The row still tells the user which session it was.
      expect(Object.prototype.hasOwnProperty.call(c, 'serverName')).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(c, 'connectedAt')).toBe(true);
    }
  });
});
