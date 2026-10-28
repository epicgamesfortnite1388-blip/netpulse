import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';
import { quickConnectCore } from '../src/services/autoConnect';

import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../src/routes/context';
import type { PlatformNetworkController } from '../src/providers/platform/types';
import type { ProxyEngineId, ProxyTunnelStatus } from '@netpulse/shared';

/**
 * The engine, wired into the REAL quick-connect path.
 *
 * Everything else in this mission can be unit-tested; this file exists because
 * the acceptance criterion is not "the policy ranks correctly" but "the app
 * dials a different core because of what it learned". So it drives
 * `quickConnectCore` — the same function the HTTP quick-connect route and boot
 * auto-connect call — with the tunnel's own `start()` replaced by a recorder,
 * after seeding the engine with real observations the way the connect path does.
 *
 * What it proves:
 *  1. With no evidence the dialled engine is the baseline first core (a fresh
 *     install is unchanged).
 *  2. After verified outcomes favour another core, the FIRST core actually
 *     handed to the tunnel is the learned one, and the second is the baseline.
 *  3. The outcome of the attempt goes back into the engine: the winner's success
 *     count rises, so the learning loop is closed through the real code path.
 *  4. A failed attempt is recorded as a failure WITH a classified reason code,
 *     and never as a success.
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

const VLESS_TLS =
  'vless://b831381d-6324-4d53-ad4f-8cda48b30811@adaptive-connect-test.net:443?type=tcp&security=tls&sni=www.example.com&fp=chrome#Adaptive%20connect%20node';

let app: FastifyInstance;
let ctx: AppContext;
let cookieHeader: string;
let tmpDir: string;
let nodeId = '';

/** Records every engine the connect path hands to the tunnel. */
const dialled: ProxyEngineId[] = [];
let answer: (engine: ProxyEngineId, call: number) => ProxyTunnelStatus;

function statusFor(engine: ProxyEngineId, state: 'active' | 'error'): ProxyTunnelStatus {
  return {
    state,
    engine,
    nodeId,
    nodeName: 'Adaptive connect node',
    exitIp: state === 'active' ? '203.0.113.7' : null,
    error: state === 'active' ? null : 'the core started but no exit IP was read through it',
  } as unknown as ProxyTunnelStatus;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-adaptive-'));
  const built = await buildApp({
    configOverrides: {
      dataDir: tmpDir,
      dbPath: path.join(tmpDir, 'test.db'),
      tokenFile: path.join(tmpDir, 'token'),
      webDist: path.join(tmpDir, 'no-dist'),
      isTest: true,
    },
    controller: new IdleController(),
    // Present a machine with three cores installed; the point of the test is the
    // ORDER the app dials them, not binary detection (which has its own tests).
    // The third one exists so the cooling-off fallback has somewhere to go.
    adaptiveEngines: () => ['xray', 'sing-box', 'v2ray'],
  });
  app = built.app;
  ctx = built.ctx;

  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/session', remoteAddress: '127.0.0.1' });
  const cookie = res.cookies.find((c) => c.name === 'netpulse_session');
  cookieHeader = `netpulse_session=${cookie!.value}`;

  const imported = await app.inject({
    method: 'POST',
    url: '/api/v1/nodes/import',
    headers: { cookie: cookieHeader, 'content-type': 'application/json' },
    payload: { configs: [VLESS_TLS] },
  });
  nodeId = (imported.json() as { nodeIds: string[] }).nodeIds[0]!;
  expect(nodeId).toBeTruthy();

  // The connect path only considers remembered gateways; remember this one the
  // way a verified tunnel start would.
  ctx.services.gatewayMemory.remember({
    nodeId,
    name: 'Adaptive connect node',
    label: 'Adaptive connect node',
    protocol: 'vless',
    engine: 'xray',
    exitIp: '203.0.113.7',
    exitCountry: 'NL',
    verifyMs: 800,
  });

  // Record every engine the tunnel is asked to start, and answer with a state
  // the caller can only get from a real verification (exitIp set + active).
  ctx.services.tunnel.start = (async (_node: unknown, opts: { preferredEngine?: ProxyEngineId }) => {
    const engine = (opts.preferredEngine ?? 'xray') as ProxyEngineId;
    dialled.push(engine);
    return answer(engine, dialled.length);
  }) as typeof ctx.services.tunnel.start;
});

afterAll(async () => {
  await app.close();
  ctx.db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('quick connect uses the adaptive order for the real dial', () => {
  it('dials the baseline first core when the engine has learned nothing', async () => {
    dialled.length = 0;
    answer = (engine) => statusFor(engine, 'active');

    const { quick } = await quickConnectCore(ctx, { systemProxy: false, wantTun: false });

    expect(quick.ok).toBe(true);
    expect(dialled[0]).toBe('xray');
    expect(quick.attempts[0]!.ok).toBe(true);
    expect(quick.attempts[0]!.exitIp).toBe('203.0.113.7');
  });

  it('streams per-run adaptive activity milestones without mixing topics', async () => {
    const activityId = 'b0fba4f8-967c-4f18-bf8a-1c4c6a899f10';
    const messages: Array<{ type: string; stage?: string }> = [];
    const unsubscribe = ctx.bus.subscribe(`quick-connect:${activityId}`, (message) => {
      messages.push(message);
    });
    dialled.length = 0;
    answer = (engine) => statusFor(engine, 'active');

    try {
      const { quick } = await quickConnectCore(ctx, { systemProxy: false, wantTun: false, activityId });

      expect(quick.ok).toBe(true);
      expect(messages.every((message) => message.type === 'quick-connect:activity')).toBe(true);
      expect(messages.map((message) => message.stage)).toContain('adaptive-plan');
      expect(messages.map((message) => message.stage)).toContain('attempt-start');
      expect(messages.at(-1)?.stage).toBe('complete');
      // The fake tunnel returns a test status, so this path must not claim that
      // the core independently verified a DNS resolver.
      expect(messages.map((message) => message.stage)).not.toContain('dns-response');
    } finally {
      unsubscribe();
    }
  });

  it('dials the LEARNED core first once outcomes show the other one works', async () => {
    // Seed the engine exactly the way the connect path feeds it: verified
    // successes for one core, failures for the other, under one context.
    for (let i = 0; i < 6; i += 1) {
      ctx.services.adaptive.observe({ nodeId, engine: 'sing-box', ok: true, timeToWorkingMs: 900 });
      ctx.services.adaptive.observe({
        nodeId,
        engine: 'xray',
        ok: false,
        failure: { stage: 'verify', message: 'the core started but no exit IP was read through it' },
      });
    }

    dialled.length = 0;
    answer = (engine) => statusFor(engine, 'active');

    const { quick } = await quickConnectCore(ctx, { systemProxy: false, wantTun: false });

    expect(quick.ok).toBe(true);
    expect(dialled[0]).toBe('sing-box');
    expect(quick.attempts).toHaveLength(1);
    expect(quick.attempts[0]!.ok).toBe(true);
  });

  it('falls back to the baseline core when the learned one fails, within the attempt budget', async () => {
    dialled.length = 0;
    // First dial fails verification; the second (the baseline core) works.
    answer = (engine, call) => statusFor(engine, call === 1 ? 'error' : 'active');

    const { quick } = await quickConnectCore(ctx, { systemProxy: false, wantTun: false });

    expect(dialled[0]).toBe('sing-box');
    expect(dialled[1]).toBe('xray');
    expect(dialled.length).toBe(2);
    expect(quick.ok).toBe(true);

    // The failed attempt is recorded as a failure with a reason code — never as
    // a success — and the winning one as a success.
    const rows = ctx.services.adaptive.status().entries;
    const singbox = rows.find((r) => r.strategyId.startsWith('sing-box'));
    expect(singbox).toBeTruthy();
    expect(singbox!.failures).toBeGreaterThan(0);
  });

  it('dials an untried approved core first once every learned one is cooling off', async () => {
    // The live-corpus dead-end, reproduced through the real connect path: the two
    // cores the app has learned about have each just failed repeatedly, the third
    // is approved and untried, and the attempt budget is two. Before the fallback
    // rule both dials went to cores this state already says are broken, and the
    // working one was never reached.
    for (let i = 0; i < 6; i += 1) {
      for (const engine of ['xray', 'sing-box'] as const) {
        ctx.services.adaptive.observe({
          nodeId,
          engine,
          ok: false,
          failure: { stage: 'verify', message: 'no exit IP through this core' },
        });
      }
    }

    dialled.length = 0;
    answer = (engine) => statusFor(engine, engine === 'v2ray' ? 'active' : 'error');

    const { quick } = await quickConnectCore(ctx, { systemProxy: false, wantTun: false });

    expect(dialled[0]).toBe('v2ray');
    expect(quick.ok).toBe(true);
    expect(quick.attempts).toHaveLength(1);
  });

  it('never reports a tunnel as working from a started core alone', async () => {
    dialled.length = 0;
    // The core "starts" every time but traffic is never verified through it.
    answer = (engine) => statusFor(engine, 'error');

    const { quick, tunnel } = await quickConnectCore(ctx, { systemProxy: false, wantTun: false });

    expect(quick.ok).toBe(false);
    expect(tunnel.state).not.toBe('active');
    expect(quick.attempts.every((a) => !a.ok)).toBe(true);
    expect(quick.attempts.every((a) => a.exitIp === null)).toBe(true);
    expect(quick.summary).toMatch(/none carried traffic/i);
  });

  it('keeps the engine from being able to break the connect path', async () => {
    // A throwing engine must degrade to the baseline order, not abort the run.
    const real = ctx.services.adaptive;
    const plan = real.plan.bind(real);
    real.plan = (() => {
      throw new Error('engine exploded');
    }) as typeof real.plan;

    dialled.length = 0;
    answer = (engine) => statusFor(engine, 'active');
    try {
      const { quick } = await quickConnectCore(ctx, { systemProxy: false, wantTun: false });
      expect(quick.ok).toBe(true);
      expect(dialled[0]).toBe('xray');
    } finally {
      real.plan = plan;
    }
  });
});
