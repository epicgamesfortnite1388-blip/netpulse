/**
 * A measurement nobody made must not reach the UI as a number that reads well.
 *
 * This is the same defect the desktop side has now fixed twice (`sidecar_restarts`
 * reporting 0 for an unreadable state, `log_file_bytes` reporting 0 for a log it
 * could not stat): an absent observation published as the healthiest plausible
 * value. A node that has never been probed has no packet loss, and `lossPct: 0`
 * is the single most reassuring thing the node health tab can print — it renders
 * as a green "ok" tone next to a real 0% reading that means the same thing.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildApp } from '../src/app';

import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let tmpDir: string;
const token = 'd'.repeat(64);

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-unmeasured-'));
  const built = await buildApp({
    configOverrides: {
      dataDir: tmpDir,
      dbPath: path.join(tmpDir, 'test.db'),
      tokenFile: path.join(tmpDir, 'token'),
      webDist: path.join(tmpDir, 'no-dist'),
      isTest: true,
    },
    daemonToken: token,
  });
  app = built.app;
  await app.ready();
});

afterAll(async () => {
  await app.close();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* WAL handle release can race on Windows */
  }
});

const auth = { Authorization: `Bearer ${token}` };

describe('GET /nodes/:id/health for a node with no recorded probes', () => {
  it('reports the rates as unmeasured, not as zero', async () => {
    // No health row exists for this id, which is exactly the state of a node
    // that was just imported and has never been probed.
    const res = await app.inject({ method: 'GET', url: '/api/v1/nodes/node:never-probed/health', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, number | null>;

    // The COUNTS are real measurements and stay 0: "no probes recorded" is true,
    // and the UI shows this count next to the rates.
    expect(body.testCount).toBe(0);
    expect(body.successCount).toBe(0);
    expect(body.failureCount).toBe(0);
    expect(body.consecutiveFailures).toBe(0);

    // The RATES are not measurements. `lossPct: 0` would render green and tell
    // the user this node drops nothing, on the strength of a probe never run.
    expect(body.lossPct).toBeNull();
    expect(body.reliabilityPct).toBeNull();

    // Latency and timestamps already answered null; the rates must say the same
    // thing in the same object rather than half of it claiming a measurement.
    expect(body.medianLatencyMs).toBeNull();
    expect(body.p95LatencyMs).toBeNull();
    expect(body.latencyVariance).toBeNull();
    expect(body.lastSuccessAt).toBeNull();
    expect(body.lastFailureAt).toBeNull();
  });
});
