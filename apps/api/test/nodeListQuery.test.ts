import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config';
import { openDb } from '../src/db/client';
import { MAX_LIST_LIMIT, PublicNodesRepository } from '../src/db/repositories';

import type { DbHandle } from '../src/db/client';
import type { PublicNodeRow } from '../src/db/repositories';

/**
 * The node list must describe the database, not a window of it.
 *
 * `list()` used to load at most 2,000 rows and return that window's length as
 * `total`, with filtering, search and sorting applied to those rows in memory.
 * A database holding 34,090 imported nodes therefore reported "total: 2000",
 * the browser could not page past the window (its page-2 slice of a 50-row page
 * was empty), and sorting "fastest first" only ever ranked the newest 2,000
 * rows. These tests use a real database for exactly that reason: the behaviour
 * only exists at the SQL boundary.
 */

const TOTAL = 2500;
/** Rows past this index are the cohort the old 2,000-row window could not see. */
const WINDOW_EDGE = 2000;
const DAY_MS = 86_400_000;

function makeRow(index: number, now: number): PublicNodeRow {
  const old = index > WINDOW_EDGE;
  // The retire cohort sits far in the past so a 14-day rule can only match it.
  const lastSeen = index > 2400 ? now - 20 * DAY_MS : now - index;

  return {
    id: `node:${index}`,
    canonicalFingerprint: `fp-${index}`,
    protocol: index % 2 === 0 ? 'vless' : 'shadowsocks',
    host: `h${index}.example.net`,
    ipv4: index % 3 === 0 ? [`10.0.${Math.floor(index / 255)}.${index % 255}`] : [],
    ipv6: [],
    port: 443,
    transport: 'tcp',
    security: index % 2 === 0 ? 'tls' : 'none',
    sni: null,
    fingerprint: null,
    flow: null,
    alterId: null,
    path: null,
    hostHeader: null,
    serviceName: null,
    allowInsecure: false,
    realityPublicKey: null,
    realityShortId: null,
    realityServerName: null,
    encryption: null,
    ssrProtocol: null,
    remark: index === TOTAL ? 'literal 50% discount' : null,
    sourceIds: ['src'],
    sourceUrls: ['https://example.test/sub'],
    sourceCount: 1,
    firstSeen: now - index,
    lastSeen,
    // The newest cohort is already validated and healthy; the older cohort has
    // never been tested. That is what makes an auto-test that only reads the
    // newest window come back empty.
    lastValidated: old ? null : now - index,
    status: old ? 'discovered' : 'healthy',
    confidence: 'unknown',
    country: index % 4 === 0 ? 'NL' : 'DE',
    city: null,
    asn: 60_000 + (index % 10),
    isp: null,
    organization: null,
    lat: null,
    lon: null,
    geoSourceCount: 0,
    tags: [],
    favorite: index % 100 === 0,
    userNotes: null,
    lastProxyMs: index % 5 === 0 ? index : null,
    lastEngine: index % 4 === 0 ? 'xray' : index % 4 === 1 ? 'sing-box' : index % 4 === 2 ? 'v2ray' : null,
    geoLastAttempt: null,
    lastTcpMs: null,
    lastTlsMs: null,
    testCount: 0,
    successCount: 0,
    failureCount: 0,
    consecutiveFailures: index > 2400 ? 5 : 0,
    recentTestCount: 0,
    recentSuccessCount: 0,
    recentFailureCount: 0,
    medianProxyMs: index % 5 === 0 ? index : null,
    medianTcpMs: null,
    medianTlsMs: null,
    recentLossPct: 0,
    lastSuccessAt: null,
    lastFailureAt: index > 2400 ? now - DAY_MS : null,
    score: index,
    reliabilityPct: 0,
    freshness: 'stale',
    createdAt: now,
    updatedAt: now,
  };
}

describe('node list query', () => {
  let ctx: DbHandle;
  let repo: PublicNodesRepository;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-nodelist-'));
    ctx = openDb(
      loadConfig({}, tmpDir, {
        dataDir: tmpDir,
        dbPath: path.join(tmpDir, 'test.db'),
        tokenFile: path.join(tmpDir, 'token'),
        isTest: true,
      }),
    );
    repo = new PublicNodesRepository(ctx);

    const now = Date.now();
    for (let i = 1; i <= TOTAL; i++) repo.insert(makeRow(i, now));
  });

  afterAll(() => {
    ctx.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports the real number of stored nodes, not the length of a page', () => {
    expect(repo.count()).toBe(TOTAL);

    const page = repo.list({ limit: 50 });
    expect(page.rows).toHaveLength(50);
    // The old contract answered 2000 here — the row cap — no matter how many
    // nodes existed.
    expect(page.total).toBe(TOTAL);
  });

  it('can page to every stored node, without repeats or gaps', () => {
    const pageSize = 100;
    const seen: string[] = [];
    for (let offset = 0; offset < TOTAL + pageSize; offset += pageSize) {
      const { rows, total } = repo.list({ limit: pageSize, offset, sortField: 'score', sortDir: 'desc' });
      expect(total).toBe(TOTAL);
      seen.push(...rows.map((r) => r.id));
      if (rows.length < pageSize) break;
    }

    expect(seen).toHaveLength(TOTAL);
    expect(new Set(seen).size).toBe(TOTAL);
    // Two rows beyond the old window, both reachable only by paging.
    expect(seen).toContain(`node:${TOTAL}`);
    expect(seen).toContain(`node:${WINDOW_EDGE + 1}`);
  });

  it('searches every stored node, including ones the old window never loaded', () => {
    const { rows, total } = repo.list({ search: `h${WINDOW_EDGE + 499}`, limit: 50 });
    expect(total).toBe(1);
    expect(rows[0]?.id).toBe(`node:${WINDOW_EDGE + 499}`);
  });

  it('treats LIKE wildcards in a search as text', () => {
    const { rows } = repo.list({ search: '50%', limit: 50 });
    expect(rows.map((r) => r.id)).toEqual([`node:${TOTAL}`]);
  });

  it('sorts the whole table, and puts unmeasured nodes last in both directions', () => {
    const asc = repo.list({ limit: MAX_LIST_LIMIT, sortField: 'proxyLatency', sortDir: 'asc' });
    expect(asc.rows[0]?.medianProxyMs).toBe(5);
    // 500 measured rows (index % 5 === 0), then the unmeasured ones.
    expect(asc.rows.slice(0, 500).every((r) => r.medianProxyMs !== null)).toBe(true);
    expect(asc.rows[asc.rows.length - 1]?.medianProxyMs).toBeNull();

    const desc = repo.list({ limit: 50, sortField: 'score', sortDir: 'desc' });
    expect(desc.rows[0]?.score).toBe(TOTAL);
    expect(desc.rows[0]?.id).toBe(`node:${TOTAL}`);
  });

  it('groups the runtime sort by core: xray, sing-box, v2ray, never-tested last', () => {
    // Ported from the browser-side sorter this replaced: the runtime column is a
    // grouping, and reversing the direction must not float the untested block to
    // the top. asc orders best score first inside a block.
    const asc = repo.list({ limit: MAX_LIST_LIMIT, sortField: 'engine', sortDir: 'asc' });
    expect(asc.rows[0]?.lastEngine).toBe('xray');
    expect(asc.rows[0]?.score).toBe(TOTAL);

    const firstSingBox = asc.rows.findIndex((r) => r.lastEngine === 'sing-box');
    const lastXray = asc.rows.map((r) => r.lastEngine).lastIndexOf('xray');
    expect(firstSingBox).toBeGreaterThan(lastXray);
    expect(asc.rows.slice(0, firstSingBox).every((r) => r.lastEngine === 'xray')).toBe(true);
    expect(asc.rows[asc.rows.length - 1]?.lastEngine).toBeNull();

    const desc = repo.list({ limit: 50, sortField: 'engine', sortDir: 'desc' });
    expect(desc.rows[0]?.lastEngine).toBe('xray');
    // Direction flips the within-block score ordering, not the blocks.
    expect(desc.rows[0]?.score).toBe(4);
  });

  it('counts the same rows it returns, for filtered lists too', () => {
    const filtered = repo.list({ status: 'discovered', limit: 10 });
    expect(filtered.rows).toHaveLength(10);
    expect(filtered.total).toBe(repo.count({ status: 'discovered' }));
    expect(filtered.total).toBe(TOTAL - WINDOW_EDGE);

    const favorites = repo.list({ favorite: true, limit: 5 });
    expect(favorites.total).toBe(25);
  });

  it('breaks down the whole table, not the first thousand rows', () => {
    const summary = repo.summary();
    expect(summary.total).toBe(TOTAL);
    expect(summary.favoriteCount).toBe(25);

    const protocolSum = Object.values(summary.protocolBreakdown).reduce((a, b) => a + b, 0);
    const countrySum = Object.values(summary.countryBreakdown).reduce((a, b) => a + b, 0);
    expect(protocolSum).toBe(TOTAL);
    // Every row claims a country in this fixture, so the breakdown must add up
    // to the whole table rather than to a capped window.
    expect(countrySum).toBe(TOTAL);
    expect(summary.transportBreakdown).toEqual({ tcp: TOTAL });
  });

  it('offers the auto-tester candidates the old window could not see', () => {
    // Every node in the newest 2,000 rows is already validated, so a cohort
    // selected from a newest-2,000 window is empty by construction.
    const candidates = repo.pickForAutoTest('never-validated', 50);
    expect(candidates).toHaveLength(50);
    for (const c of candidates) {
      const index = Number(c.id.split(':')[1]);
      expect(index).toBeGreaterThan(WINDOW_EDGE);
    }
  });

  it('retires stale nodes across the whole table in one statement', () => {
    const now = Date.now();
    const retired = repo.retireStale(now - 14 * DAY_MS, 3);
    // Only the 100-row cohort carries consecutive failures, and it sits 20 days
    // in the past — far outside the slice the old loop ever loaded.
    expect(retired).toBe(100);
    expect(repo.count({ status: 'stale' })).toBe(100);
  });
});
