#!/usr/bin/env node
/** Stress: 5000 synthetic nodes → measure list/search/sort/bucket-query latency
 *  against the real repo layer. Proves large node DBs stay responsive. */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import crypto from 'node:crypto';

const dbPath = ':memory:';
const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
const db = drizzle(sqlite);

const t0 = Date.now();
migrate(db, { migrationsFolder: 'apps/api/drizzle' });
console.log(`migrate: ${Date.now() - t0}ms`);

process.env.NODE_OPTIONS = '--experimental-specifier-resolution=node';
const mod = await import('file://' + process.cwd().replace(/\\/g, '/') + '/apps/api/src/db/schema.ts');
const publicNodes = mod.publicNodes;
if (!publicNodes) { console.log('SCHEMA_IMPORT_FAILED (tsx-only)'); process.exit(2); }

const N = 5000;
const protocols = ['vmess', 'vless', 'trojan', 'shadowsocks'];
const countries = ['DE', 'NL', 'US', 'SG', 'JP', 'IR', 'TR', 'FR', 'GB', null];
const rows = [];
const now = Date.now();
for (let i = 0; i < N; i++) {
  const cc = countries[i % countries.length];
  rows.push({
    id: `node:${crypto.randomUUID().slice(0, 12)}`,
    canonicalFingerprint: `fp:${i}`,
    protocol: protocols[i % protocols.length],
    host: `host${i}.example.com`,
    ipv4: `[]`,
    ipv6: '[]',
    port: 443,
    transport: 'ws',
    security: 'tls',
    sni: null,
    alpn: '[]',
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
    sourceIds: '[]',
    sourceUrls: '[]',
    sourceCount: 1,
    firstSeen: now - i * 1000,
    lastSeen: now - (i % 100) * 60_000,
    lastValidated: i % 2 === 0 ? now - (i % 500) * 60_000 : null,
    status: ['discovered', 'healthy', 'degraded', 'failed', 'stale'][i % 5],
    confidence: 'unknown',
    country: cc,
    city: null,
    asn: null,
    isp: null,
    organization: null,
    lat: cc ? 40 + (i % 20) : null,
    lon: cc ? 5 + (i % 30) : null,
    geoSourceCount: 0,
    geoLastAttempt: null,
    tags: '[]',
    favorite: false,
    userNotes: null,
    lastProxyMs: null,
    lastTcpMs: i % 3 === 0 ? 50 + (i % 200) : null,
    lastTlsMs: null,
    testCount: i % 7,
    successCount: i % 4,
    failureCount: i % 3,
    consecutiveFailures: 0,
    recentTestCount: i % 7,
    recentSuccessCount: i % 4,
    recentFailureCount: i % 3,
    score: (i % 101),
    reliabilityPct: i % 101,
    medianProxyMs: null,
    medianTcpMs: null,
    medianTlsMs: null,
    recentLossPct: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    freshness: 'stale',
    createdAt: now,
    updatedAt: now,
  });
}

const tIns = Date.now();
const insert = db.insert(publicNodes);
const chunk = 500;
for (let i = 0; i < rows.length; i += chunk) insert.values(rows.slice(i, i + chunk)).run();
console.log(`insert ${N}: ${Date.now() - tIns}ms`);

// Raw timed queries mirroring the service hot paths
function time(label, fn, iter = 20) {
  fn(); // warm
  const t = Date.now();
  for (let i = 0; i < iter; i++) fn();
  console.log(`${label}: ${((Date.now() - t) / iter).toFixed(2)}ms avg`);
}

time('list 500 by lastSeen', () => {
  sqlite.prepare('SELECT * FROM public_nodes ORDER BY last_seen DESC LIMIT 500').all();
});
time('filter by country + status', () => {
  sqlite.prepare("SELECT * FROM public_nodes WHERE country = 'DE' AND status = 'healthy' ORDER BY score DESC LIMIT 100").all();
});
time('top-score page', () => {
  sqlite.prepare('SELECT * FROM public_nodes WHERE score >= 60 ORDER BY score DESC LIMIT 100').all();
});
time('search LIKE host', () => {
  sqlite.prepare("SELECT * FROM public_nodes WHERE host LIKE '%500%' LIMIT 50").all();
});
time('statusCounts group', () => {
  sqlite.prepare('SELECT status, COUNT(*) as n FROM public_nodes GROUP BY status').all();
});
time('never-validated newest', () => {
  sqlite.prepare('SELECT id FROM public_nodes WHERE last_validated IS NULL ORDER BY first_seen DESC LIMIT 12').all();
});

console.log('STRESS_DONE');
sqlite.close();
