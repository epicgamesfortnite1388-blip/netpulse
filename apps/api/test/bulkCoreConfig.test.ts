import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';

const h = vi.hoisted(() => ({
  /** Ports handed out by the reservation seam, in order (repeats the last). */
  ports: [] as number[],
  reserveCalls: 0,
  /** What the shared owner should return per spawn, in order (repeats last). */
  results: [] as Array<Record<string, unknown>>,
  spawnCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('../src/services/coreProcess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/coreProcess')>();
  return {
    ...actual,
    reservePort: () => {
      const port = h.ports[Math.min(h.reserveCalls, h.ports.length - 1)] ?? 45_000 + h.reserveCalls;
      h.reserveCalls += 1;
      return Promise.resolve(port);
    },
    spawnCoreProcess: (spec: Record<string, unknown>) => {
      h.spawnCalls.push(spec);
      const result = h.results[Math.min(h.spawnCalls.length - 1, h.results.length - 1)]!;
      return Promise.resolve(result);
    },
  };
});

import {
  buildSingboxMultiConfig,
  buildXrayMultiConfig,
  multiInboundTag,
  multiOutboundTag,
  startMultiCore,
} from '../src/services/proxyCores';

import type { MultiCoreNode } from '../src/services/proxyCores';
import type { ParsedNodeConfig } from '@netpulse/shared';

/**
 * Batched core configs — the part that makes bulk node testing stop paying a
 * process per node.
 *
 * These pin the two properties a batched config must never lose:
 *   1. each node has its OWN inbound port and outbound, and
 *   2. the routing pins inbound i to outbound i.
 * Without (2) a probe on port 5001 could exit through node 7 and be scored as
 * node 1 — a measurement that looks fine and is about the wrong machine. The
 * tests check the credentials too, so a crossed pair of tags would show up as
 * the wrong secret in the wrong outbound.
 */

function cfg(overrides: Partial<ParsedNodeConfig> = {}): ParsedNodeConfig {
  return {
    protocol: 'vless',
    host: 'node.example',
    port: 443,
    transport: 'tcp',
    security: 'tls',
    sni: 'node.example',
    ...overrides,
  } as ParsedNodeConfig;
}

/** Three nodes with distinct protocols and secrets — cross-wiring is visible. */
const NODES: MultiCoreNode[] = [
  { config: cfg({ security: 'reality', realityPublicKey: 'pub-key', realityShortId: 'abcd' }), secret: 'secret-vless' },
  { config: cfg({ protocol: 'vmess', transport: 'ws', security: 'tls', path: '/ws', hostHeader: 'cdn.example', encryption: 'aes-128-gcm' }), secret: 'secret-vmess' },
  { config: cfg({ protocol: 'trojan', security: 'tls' }), secret: 'secret-trojan' },
];
const PORTS = [45_101, 45_102, 45_103];

function fakeProcess(cleanup: () => void = () => undefined) {
  return {
    ok: true,
    process: {
      child: { once: () => undefined, kill: () => true },
      readyPort: PORTS[0],
      output: '',
      cleanup,
    },
  };
}

beforeEach(() => {
  h.ports = [];
  h.reserveCalls = 0;
  h.results = [fakeProcess()];
  h.spawnCalls = [];
});

describe('batched xray config', () => {
  it('gives every node its own http inbound and pins the route to its outbound', () => {
    const json = buildXrayMultiConfig(NODES, PORTS) as {
      inbounds: Array<{ tag: string; protocol: string; listen: string; port: number }>;
      outbounds: Array<{ tag: string; protocol: string }>;
      routing: { rules: Array<{ type: string; inboundTag: string[]; outboundTag: string }> };
    };

    expect(json.inbounds).toHaveLength(3);
    expect(json.inbounds.map((i) => i.protocol)).toEqual(['http', 'http', 'http']);
    expect(json.inbounds.map((i) => i.port)).toEqual(PORTS);
    expect(json.inbounds.every((i) => i.listen === '127.0.0.1')).toBe(true);
    expect(json.inbounds.map((i) => i.tag)).toEqual([multiInboundTag(0), multiInboundTag(1), multiInboundTag(2)]);

    expect(json.outbounds.map((o) => o.tag)).toEqual([multiOutboundTag(0), multiOutboundTag(1), multiOutboundTag(2)]);
    expect(json.outbounds.map((o) => o.protocol)).toEqual(['vless', 'vmess', 'trojan']);

    // One rule per node, pairing its inbound with its own outbound.
    expect(json.routing.rules).toEqual(NODES.map((_, i) => ({
      type: 'field',
      inboundTag: [multiInboundTag(i)],
      outboundTag: multiOutboundTag(i),
    })));
  });

  it('keeps each node’s credential in its own outbound', () => {
    const json = buildXrayMultiConfig(NODES, PORTS) as {
      outbounds: Array<{ tag: string; protocol: string; settings: Record<string, unknown> }>;
    };
    const byTag = new Map(json.outbounds.map((o) => [o.tag, o]));
    const vless = byTag.get(multiOutboundTag(0))!.settings as { vnext: Array<{ users: Array<{ id: string }> }> };
    expect(vless.vnext[0].users[0].id).toBe('secret-vless');
    const vmess = byTag.get(multiOutboundTag(1))!.settings as { vnext: Array<{ users: Array<{ id: string }> }> };
    expect(vmess.vnext[0].users[0].id).toBe('secret-vmess');
    const trojan = byTag.get(multiOutboundTag(2))!.settings as { servers: Array<{ password: string }> };
    expect(trojan.servers[0].password).toBe('secret-trojan');
    // And no outbound carries another node's secret.
    expect(JSON.stringify(byTag.get(multiOutboundTag(0)))).not.toContain('secret-vmess');
  });

  it('carries reality material and ws host headers exactly like a single-node config', () => {
    const json = buildXrayMultiConfig(NODES, PORTS) as {
      outbounds: Array<{ tag: string; streamSettings: { realitySettings?: { publicKey: string }; wsSettings?: { path: string; headers?: { Host?: string } } } }>;
    };
    const byTag = new Map(json.outbounds.map((o) => [o.tag, o]));
    expect(byTag.get(multiOutboundTag(0))!.streamSettings.realitySettings?.publicKey).toBe('pub-key');
    expect(byTag.get(multiOutboundTag(1))!.streamSettings.wsSettings).toEqual({ path: '/ws', headers: { Host: 'cdn.example' } });
  });

  it('refuses mismatched or duplicated ports instead of shipping a broken batch', () => {
    expect(() => buildXrayMultiConfig(NODES, [1, 2])).toThrow(/one port per node/);
    expect(() => buildXrayMultiConfig(NODES, [1, 1, 2])).toThrow(/distinct/);
    expect(() => buildXrayMultiConfig([], [])).toThrow(/at least one node/);
  });
});

describe('batched sing-box config', () => {
  it('wires one mixed inbound and one outbound per node with inbound routing', () => {
    const json = buildSingboxMultiConfig(NODES, PORTS) as {
      inbounds: Array<{ type: string; tag: string; listen: string; listen_port: number }>;
      outbounds: Array<Record<string, unknown>>;
      route: { rules: Array<{ inbound: string[]; outbound: string }> };
    };

    expect(json.inbounds.map((i) => i.type)).toEqual(['mixed', 'mixed', 'mixed']);
    expect(json.inbounds.map((i) => i.listen_port)).toEqual(PORTS);
    expect(json.inbounds.map((i) => i.tag)).toEqual([multiInboundTag(0), multiInboundTag(1), multiInboundTag(2)]);
    expect(json.outbounds.map((o) => o['type'])).toEqual(['vless', 'vmess', 'trojan']);
    expect(json.outbounds.map((o) => o['tag'])).toEqual([multiOutboundTag(0), multiOutboundTag(1), multiOutboundTag(2)]);
    expect(json.route.rules).toEqual(NODES.map((_, i) => ({ inbound: [multiInboundTag(i)], outbound: multiOutboundTag(i) })));

    expect(json.outbounds[0]!['uuid']).toBe('secret-vless');
    expect(json.outbounds[1]!['uuid']).toBe('secret-vmess');
    expect(json.outbounds[2]!['password']).toBe('secret-trojan');
    // ws host header parity with the xray builder (CDN routing key).
    expect((json.outbounds[1]!['transport'] as { headers?: { Host?: string } }).headers?.Host).toBe('cdn.example');
  });

  it('can batch a hysteria2 node, which the Hysteria client config could not', () => {
    const nodes: MultiCoreNode[] = [
      { config: cfg({ protocol: 'hysteria2', transport: 'udp', security: 'tls' }), secret: 'hy2-pass' },
      { config: cfg(), secret: 'vless-uuid' },
    ];
    const json = buildSingboxMultiConfig(nodes, [46_001, 46_002]) as { outbounds: Array<Record<string, unknown>> };
    expect(json.outbounds[0]!['type']).toBe('hysteria2');
    expect(json.outbounds[0]!['password']).toBe('hy2-pass');
  });
});

describe('startMultiCore', () => {
  const engine = { id: 'xray' as const, bin: 'C:/fake/xray.exe', args: ['run'] };

  it('spawns ONE core for the whole batch and returns one port per node', async () => {
    h.ports = [46_101, 46_102, 46_103];

    const res = await startMultiCore(engine, NODES);

    expect(res.ok).toBe(true);
    expect(h.spawnCalls).toHaveLength(1);
    const spec = h.spawnCalls[0]!;
    expect(spec['readyPort']).toBe(46_101);
    expect(spec['extraReadyPorts']).toEqual([46_102, 46_103]);
    expect(spec['bin']).toBe('C:/fake/xray.exe');
    expect(String(spec['label'])).toContain('batch of 3');

    if (!res.ok) return;
    expect(res.run.inboundPorts).toEqual([46_101, 46_102, 46_103]);

    // The config written to disk is the batched one — three inbounds, three
    // outbounds — which is what makes the single spawn serve all three nodes.
    const cfgPath = (spec['args'] as string[])[(spec['args'] as string[]).length - 1]!;
    const written = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as { inbounds: unknown[]; outbounds: unknown[] };
    expect(written.inbounds).toHaveLength(3);
    expect(written.outbounds).toHaveLength(3);
  });

  it('retries ONCE with a fresh port set when a reserved port is taken', async () => {
    h.ports = [47_001, 47_002, 47_003, 47_004, 47_005, 47_006];
    h.results = [
      { ok: false, failure: 'port_clash', error: 'port 47001 is already in use', output: '', exitCode: null },
      fakeProcess(),
    ];

    const res = await startMultiCore(engine, NODES);

    expect(res.ok).toBe(true);
    expect(h.spawnCalls).toHaveLength(2);
    // A retry must NOT reuse the clashing ports.
    expect(h.spawnCalls[0]!['readyPort']).toBe(47_001);
    expect(h.spawnCalls[1]!['readyPort']).toBe(47_004);
    expect(h.reserveCalls).toBe(6);
  });

  it('reports how many cores were started, never more than one per batch', async () => {
    h.ports = [48_001, 48_002];
    const res = await startMultiCore(engine, NODES.slice(0, 2));
    expect(res.ok).toBe(true);
    expect(h.spawnCalls).toHaveLength(1);
    expect(h.reserveCalls).toBe(2);
  });

  it('refuses hysteria instead of silently testing one node N times', async () => {
    const res = await startMultiCore({ id: 'hysteria', bin: 'C:/fake/hysteria.exe', args: [] }, NODES);

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure).toBe('engine_unavailable');
    expect(res.error).toContain('one server per config');
    expect(h.spawnCalls).toHaveLength(0);
  });

  it('classifies an unexecutable core as engine_unavailable and a refused config as engine_start_failed', async () => {
    h.results = [{ ok: false, failure: 'spawn_error', error: 'xray spawn failed: ENOENT', output: '', exitCode: null }];
    const missing = await startMultiCore(engine, NODES);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.failure).toBe('engine_unavailable');
      expect(missing.error).toBe('xray spawn failed: ENOENT');
    }

    h.spawnCalls = [];
    h.results = [{ ok: false, failure: 'exited', error: 'xray (batch of 3) exited during startup (code 23)', output: 'FATAL', exitCode: 23 }];
    const bad = await startMultiCore(engine, NODES);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.failure).toBe('engine_start_failed');
  });

  it('cleans the core up through the owner (one teardown for the batch)', async () => {
    const cleanup = vi.fn();
    h.results = [fakeProcess(cleanup)];
    h.ports = [49_001, 49_002, 49_003];

    const res = await startMultiCore(engine, NODES);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    res.run.cleanup();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
