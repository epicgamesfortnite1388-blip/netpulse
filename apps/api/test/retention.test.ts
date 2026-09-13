import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';
import { RETENTION_RULES, RetentionService } from '../src/db/retention';

describe('retention sweeper', () => {
  let tmpDir: string;
  let ctxApp: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-retention-'));
    ctxApp = await buildApp({
      configOverrides: {
        dataDir: tmpDir,
        dbPath: path.join(tmpDir, 'test.db'),
        tokenFile: path.join(tmpDir, 'token'),
        webDist: path.join(tmpDir, 'no-dist'),
        isTest: true,
      },
    });
  });

  afterAll(async () => {
    await ctxApp.app.close();
    ctxApp.ctx.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('deletes rows past each rule window and leaves fresh rows alone', () => {
    const { sqlite } = ctxApp.ctx.db;
    const day = 86_400_000;
    const now = Date.now();

    sqlite
      .prepare(
        `INSERT INTO network_tests (id, type, status, params, summary, result, error, started_at, finished_at)
         VALUES (?, 'ping', 'completed', '{}', '{}', '{}', NULL, ?, ?)`,
      )
      .run('t-old', now - 30 * day, now - 30 * day);
    sqlite
      .prepare(
        `INSERT INTO network_events (ts, level, category, message) VALUES (?, 'info', 'network', 'old')`,
      )
      .run(now - 30 * day);
    sqlite
      .prepare(
        `INSERT INTO map_observations (id, target_id, target_type, name, family, ip, protocol, port, vpn_active, payload, created_at)
         VALUES ('m-old', 'tgt', 'server', 'x', 4, '1.2.3.4', 'icmp', NULL, 0, '{}', ?)`,
      )
      .run(now - 10 * day);
    // fresh rows must survive
    sqlite
      .prepare(
        `INSERT INTO network_tests (id, type, status, params, summary, result, error, started_at, finished_at)
         VALUES (?, 'ping', 'completed', '{}', '{}', '{}', NULL, ?, ?)`,
      )
      .run('t-new', now - 1000, now - 1000);

    const result = new RetentionService(ctxApp.ctx.db).sweep(now);

    expect(result.deleted['network_tests']).toBeGreaterThanOrEqual(1);
    expect(result.deleted['network_events']).toBeGreaterThanOrEqual(1);
    expect(result.deleted['map_observations']).toBeGreaterThanOrEqual(1);
    expect(result.total).toBeGreaterThanOrEqual(3);

    const kept = sqlite.prepare(`SELECT COUNT(*) AS n FROM network_tests WHERE id = 't-new'`).get() as { n: number };
    expect(kept.n).toBe(1);
  });

  it('cascades child detail rows when a test row is pruned', () => {
    const { sqlite } = ctxApp.ctx.db;
    const day = 86_400_000;
    const now = Date.now();
    sqlite
      .prepare(
        `INSERT INTO network_tests (id, type, status, params, summary, result, error, started_at, finished_at)
         VALUES (?, 'ping', 'completed', '{}', '{}', '{}', NULL, ?, ?)`,
      )
      .run('t-cascade', now - 30 * day, now - 30 * day);
    sqlite
      .prepare(`INSERT INTO network_events (ts, level, category, message) VALUES (?, 'info', 'system', 'child')`)
      .run(now - 29 * day);

    new RetentionService(ctxApp.ctx.db).sweep(now);

    const left = sqlite.prepare(`SELECT COUNT(*) AS n FROM network_tests WHERE id = 't-cascade'`).get() as { n: number };
    expect(left.n).toBe(0);
  });

  it('every retention rule targets a real table with an indexed timestamp', () => {
    const { sqlite } = ctxApp.ctx.db;
    for (const rule of RETENTION_RULES) {
      const cols = sqlite.prepare(`PRAGMA table_info(${rule.table})`).all() as { name: string }[];
      expect(cols.map((c) => c.name)).toContain(rule.tsColumn);
      const idx = sqlite.prepare(`PRAGMA index_list(${rule.table})`).all() as { name: string }[];
      expect(idx.length).toBeGreaterThan(0);
    }
  });
});
