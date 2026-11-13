import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';

import type { FastifyInstance } from 'fastify';

/**
 * Mission Control's value is entirely in what it refuses to claim, so these
 * tests pin the classification rules rather than the layout of the JSON:
 *
 *  - every subsystem carries a class from a closed set;
 *  - a fresh process with no tunnel and no self-test says `not_tested`, never
 *    `verified`, and never omits the engine row;
 *  - the overall state is the WEAKEST class present (a blocked row cannot hide
 *    behind four verified ones);
 *  - the snapshot carries no daemon token.
 */

const STATES = ['verified', 'observed', 'not_tested', 'unavailable', 'blocked'] as const;

describe('mission control snapshot', () => {
  let app: FastifyInstance;
  let daemonToken: string;

  beforeAll(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-env-'));
    const built = await buildApp({
      configOverrides: {
        dataDir: tmpDir,
        dbPath: path.join(tmpDir, 'test.db'),
        tokenFile: path.join(tmpDir, 'token'),
        webDist: path.join(tmpDir, 'no-dist'),
        isTest: true,
      },
    });
    app = built.app;
    daemonToken = built.daemonToken;
  });

  afterAll(async () => {
    await app?.close();
  });

  async function getSnapshot() {
    const session = await app.inject({ method: 'POST', url: '/api/v1/auth/session', remoteAddress: '127.0.0.1' });
    const cookie = session.cookies.find((c) => c.name === 'netpulse_session');
    if (!cookie) throw new Error('no session cookie');
    return app.inject({
      method: 'GET',
      url: '/api/v1/mission/status',
      remoteAddress: '127.0.0.1',
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    });
  }

  it('answers with a classified ledger', async () => {
    const res = await getSnapshot();
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(typeof body.generatedAt).toBe('number');
    expect(Array.isArray(body.subsystems)).toBe(true);
    expect(body.subsystems.length).toBeGreaterThan(0);

    for (const row of body.subsystems) {
      expect(STATES).toContain(row.state);
      // A claim with no source is indistinguishable from an invented one.
      expect(typeof row.source).toBe('string');
      expect(row.source.length).toBeGreaterThan(0);
      expect(row.detail.length).toBeGreaterThan(0);
    }

    // The ledger must be complete enough to answer the question the page is for.
    const ids = body.subsystems.map((s: { id: string }) => s.id);
    for (const required of ['adaptive', 'vpn', 'engines', 'whitedns', 'entitlements', 'host-provisioning', 'payments']) {
      expect(ids).toContain(required);
    }
  });

  it('reports a fresh process as untested, not as passing', async () => {
    const body = (await getSnapshot()).json();
    const byId = new Map<string, { state: string; headline: string }>(
      body.subsystems.map((s: { id: string; state: string; headline: string }) => [s.id, s]),
    );

    // No self-test has run in this process, so engine availability is unknown —
    // the one wrong answer here is "no engine installed".
    expect(byId.get('engines')?.state).toBe('not_tested');
    expect(byId.get('vpn')?.state).toBe('not_tested');
    // Payments are not part of this application's surface at all.
    expect(byId.get('payments')?.state).toBe('blocked');
    // The provider host was retired: this row must not keep describing a timer
    // that no longer runs anywhere.
    expect(byId.get('host-provisioning')?.state).toBe('unavailable');
  });

  it('derives the overall state from the weakest claim present', async () => {
    const body = (await getSnapshot()).json();
    const counts = body.summary.counts as Record<string, number>;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(body.subsystems.length);

    const expected =
      counts.blocked! > 0
        ? 'blocked'
        : counts.unavailable! > 0
          ? 'unavailable'
          : counts.not_tested! > 0
            ? 'not_tested'
            : counts.observed! > 0
              ? 'observed'
              : 'verified';
    expect(body.summary.state).toBe(expected);
  });

  it('carries no daemon token', async () => {
    const text = (await getSnapshot()).payload;
    expect(text.includes(daemonToken)).toBe(false);
  });

  it('exposes adaptive state without inventing observations', async () => {
    const body = (await getSnapshot()).json();
    expect(body.adaptive).not.toBeNull();
    expect(body.adaptive.observationsKept).toBe(0);
    expect(body.adaptive.learned).toEqual([]);
    expect(typeof body.adaptive.enabled).toBe('boolean');
  });

  it('returns activity as real event rows', async () => {
    const body = (await getSnapshot()).json();
    expect(Array.isArray(body.activity)).toBe(true);
    for (const event of body.activity) {
      expect(typeof event.id).toBe('number');
      expect(typeof event.ts).toBe('number');
      expect(['info', 'warn', 'error']).toContain(event.level);
    }
  });
});
