import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config';
import { openDb } from '../src/db/client';
import { PublicNodesRepository } from '../src/db/repositories';
import { scrubAnycastGeo } from '../src/services/nodeGeoService';

import type { DbHandle } from '../src/db/client';
import type { PublicNodeRow } from '../src/db/repositories';

/**
 * Boot geo-scrub paging contract.
 *
 * The scrub runs before the sidecar listens, so what it reads is start-up
 * latency, and it must still cover the WHOLE table — the previous capped-window
 * behaviour left most legacy rows unrepaired while reporting success. These
 * tests use a real database because the behaviour lives at the SQL boundary:
 * only rows that carry geo data may be paged, and paging must be by primary key
 * (the scrub clears the very geo that the page predicate selects, so an OFFSET
 * window over that shrinking set skips rows).
 *
 * Cohort sizes cross the 2,000-row page boundary on purpose.
 */

/** Poisoned rows: edge-fabric ASN with a fabricated country+cities. */
const POISONED = 2_150;
/** Rows with no country/lat/lon at all — the scrub can never act on them. */
const NO_GEO = 300;
/** Legit unicast rows inside their own country box — must survive untouched. */
const CLEAN = 5;

const DAY_MS = 86_400_000;

function makeRow(index: number, geo: 'poisoned' | 'none' | 'clean', now: number): PublicNodeRow {
  const geoFields =
    geo === 'poisoned'
      ? { country: 'US', city: 'San Francisco', asn: 13335, isp: 'Cloudflare, Inc.', lat: 37.77, lon: -122.42 }
      : geo === 'clean'
        ? { country: 'NL', city: 'Amsterdam', asn: 60781, isp: 'LeaseWeb', lat: 52.37, lon: 4.89 }
        : { country: null, city: null, asn: 60_000 + (index % 10), isp: null, lat: null, lon: null };

  return {
    id: `node:${String(index).padStart(6, '0')}`,
    canonicalFingerprint: `fp-${index}`,
    protocol: 'vless',
    host: geo === 'poisoned' ? `104.17.${index % 255}.${(index * 7) % 255}` : `h${index}.example.net`,
    ipv4: [],
    ipv6: [],
    port: 443,
    transport: 'tcp',
    security: 'tls',
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
    remark: null,
    sourceIds: ['src'],
    sourceUrls: ['https://example.test/sub'],
    sourceCount: 1,
    firstSeen: now - index,
    lastSeen: now - index,
    lastValidated: null,
    status: 'discovered',
    confidence: 'unknown',
    ...geoFields,
    geoSourceCount: geo === 'none' ? 0 : 1,
    tags: [],
    favorite: false,
    userNotes: null,
    lastProxyMs: null,
    lastEngine: null,
    geoLastAttempt: null,
    lastTcpMs: null,
    lastTlsMs: null,
    testCount: 0,
    successCount: 0,
    failureCount: 0,
    consecutiveFailures: 0,
    recentTestCount: 0,
    recentSuccessCount: 0,
    recentFailureCount: 0,
    medianProxyMs: null,
    medianTcpMs: null,
    medianTlsMs: null,
    recentLossPct: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    score: 0,
    reliabilityPct: 0,
    freshness: 'fresh',
    createdAt: now,
    updatedAt: now,
  };
}

describe('boot geo scrub page query', () => {
  let ctx: DbHandle;
  let repo: PublicNodesRepository;
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-geoscrub-'));
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
    for (let i = 1; i <= POISONED; i++) repo.insert(makeRow(i, 'poisoned', now));
    for (let i = 1; i <= NO_GEO; i++) repo.insert(makeRow(POISONED + i, 'none', now));
    for (let i = 1; i <= CLEAN; i++) repo.insert(makeRow(POISONED + NO_GEO + i, 'clean', now));
  });

  afterAll(() => {
    ctx.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('pages only geo-carrying rows, in primary-key order, with full coverage', () => {
    const pageSize = 2000;
    const seen: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page = repo.listGeoScrubPage(cursor, pageSize);
      if (page.length === 0) break;
      // The projection is the classifier's inputs, never the wide row: this is
      // what keeps the pre-listen scrub cheap on a large store.
      expect(Object.keys(page[0]!).sort()).toEqual(['asn', 'country', 'host', 'id', 'lat', 'lon']);
      const ids = page.map((r) => r.id);
      expect(ids).toEqual([...ids].sort());
      seen.push(...ids);
      cursor = ids[ids.length - 1]!;
      if (page.length < pageSize) break;
    }

    // Every geo-bearing row exactly once — no gaps across the page boundary,
    // and no row that carries no geo is dragged through the scrub.
    expect(seen).toHaveLength(POISONED + CLEAN);
    expect(new Set(seen).size).toBe(POISONED + CLEAN);
  });

  it('scrubs every poisoned row across pages and leaves no-geo rows untouched', () => {
    const scrubbed = scrubAnycastGeo(repo);
    expect(scrubbed).toBe(POISONED);

    // Legit unicast rows keep their real coordinates.
    const clean = repo.listByIds([`node:${String(POISONED + NO_GEO + 1).padStart(6, '0')}`])[0]!;
    expect(clean.lat).toBeCloseTo(52.37);
    expect(clean.country).toBe('NL');

    // A row the scrub cannot act on is never written to: its geo attempt
    // timestamp is still null, so the geo worker still gets to try it.
    const untouched = repo.listByIds([`node:${String(POISONED + 1).padStart(6, '0')}`])[0]!;
    expect(untouched.geoLastAttempt).toBeNull();
    expect(untouched.country).toBeNull();
  });

  it('is idempotent — a second pass finds nothing left to repair', () => {
    expect(scrubAnycastGeo(repo)).toBe(0);
  });
});
