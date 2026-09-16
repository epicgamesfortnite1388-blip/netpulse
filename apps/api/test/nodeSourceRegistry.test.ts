import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';
import { parseNodeUri } from '../src/services/nodeParsers';
import {
  extractRawConfigs,
  fetchAndImportSource,
  getKnownSources,
  partitionConfigs,
} from '../src/services/nodeSourceRegistry';

import type { FetchContext } from '../src/services/nodeSourceRegistry';
import type { PublicSource } from '@netpulse/shared';

/* -------------------------------------------------------------------------- */
/* catalog                                                                    */
/* -------------------------------------------------------------------------- */

describe('built-in source catalog', () => {
  const sources = getKnownSources();

  it('keeps ids unique, so fetch/disable can never resolve the wrong feed', () => {
    const ids = sources.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('declares only https URLs to real hosts', () => {
    for (const s of sources) {
      expect(s.urls.length, `${s.id} has no URLs`).toBeGreaterThan(0);
      for (const u of s.urls) {
        expect(u.startsWith('https://'), `${s.id} → ${u}`).toBe(true);
        expect(new URL(u).hostname.length, `${s.id} → ${u}`).toBeGreaterThan(0);
      }
    }
  });

  it('never declares the same URL in two feeds (that would only add duplicate work)', () => {
    const seen = new Map<string, string>();
    for (const s of sources) {
      for (const u of s.urls) {
        expect(seen.get(u), `${u} declared by both ${seen.get(u)} and ${s.id}`).toBeUndefined();
        seen.set(u, s.id);
      }
    }
  });

  it('documents what each feed served, so a count can be traced to a measurement', () => {
    for (const s of sources) {
      expect(s.notes && s.notes.length > 20, `${s.id} has no provenance note`).toBe(true);
      expect(s.formats.length, `${s.id} declares no format`).toBeGreaterThan(0);
      expect(s.repositoryUrl?.startsWith('https://github.com/'), `${s.id} has no repo`).toBe(true);
    }
  });

  it('starts every feed with zeroed counters — counts come only from real fetches', () => {
    for (const s of sources) {
      expect(s.discoveredConfigCount).toBe(0);
      expect(s.importedConfigCount).toBe(0);
      expect(s.lastSuccess).toBeNull();
      expect(s.status).toBe('idle');
      expect(s.health).toBe('unknown');
    }
  });

  it('hands out copies, so a caller cannot mutate the catalog', () => {
    const first = getKnownSources();
    first[0]!.urls.push('https://example.com/injected');
    first[0]!.name = 'mutated';
    const second = getKnownSources();
    expect(second[0]!.urls).not.toContain('https://example.com/injected');
    expect(second[0]!.name).not.toBe('mutated');
  });

  it('keeps the original built-ins and the added free-VPN feeds present', () => {
    const ids = sources.map((s) => s.id);
    // original catalog
    for (const id of ['barry-far', 'epodonios', 'ebrasha', '0xRadikal']) {
      expect(ids, `built-in ${id} disappeared`).toContain(id);
    }
    // feeds added 2026-09-16, each verified by fetching it
    for (const id of ['mahdibland', 'mheidari98', 'ALIILAPRO', 'ermaozi', 'MhdiTaheri', 'peasoft', 'ts-sf']) {
      expect(ids, `added feed ${id} disappeared`).toContain(id);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* extraction                                                                 */
/* -------------------------------------------------------------------------- */

// Documentation hostnames (RFC 2606) — never a real server, and rejected-by-design
// addresses (TEST-NET) would make the parser refuse the fixture outright.
const VLESS = 'vless://3f7c1a94-42f5-4e6f-9c1e-51b0b6e2a2c1@edge-01.example.net:443?encryption=none&security=tls&sni=cdn.example.org&type=ws&host=cdn.example.org&path=%2Fws#Wrapped-A';
const TROJAN = 'trojan://aSecret@edge-02.example.net:8443?sni=cdn.example.org#Wrapped-B';

function wrap76(text: string): string {
  return text.replace(/(.{76})/g, '$1\n');
}

describe('extractRawConfigs honesty', () => {
  it('reads a 76-column wrapped base64 subscription exactly like its single-line twin', () => {
    const payload = [VLESS, TROJAN].join('\n');
    const single = Buffer.from(payload, 'utf8').toString('base64');
    const wrapped = wrap76(single);

    const a = extractRawConfigs(single);
    const b = extractRawConfigs(wrapped);

    expect(a.configs).toEqual([VLESS, TROJAN]);
    expect(b.configs).toEqual(a.configs);
    expect(b.format).toBe('base64');
  });

  it('reads base64 as it is actually stored, with the fetcher framing in front of it', () => {
    // Regression: the fetcher prefixes every fetched document with
    // `# Source: <url>`. That `#` made the whole document look like markdown,
    // so the base64 branch was unreachable and three shipped feeds that are
    // plain base64 imported zero nodes while reporting a completed fetch.
    const payload = [VLESS, TROJAN].join('\n');
    const framed = [
      '# Source: https://raw.githubusercontent.com/owner/repo/main/list.txt',
      '',
      wrap76(Buffer.from(payload, 'utf8').toString('base64')),
      '',
      '---',
      '',
    ].join('\n');

    const { configs, format } = extractRawConfigs(framed);
    expect(format).toBe('base64');
    expect(configs).toEqual([VLESS, TROJAN]);
  });

  it('does not decode its way to configs that were never in the payload', () => {
    // Prose that happens to be base64-decodable must not become a node list.
    const prose = 'This repository is archived and no longer maintained, see the notice at the top of the README for details.';
    const { configs } = extractRawConfigs(Buffer.from(prose, 'utf8').toString('base64'));
    expect(configs).toEqual([]);
  });

  it('reports nothing for the documents sources actually serve when they fail', () => {
    expect(extractRawConfigs('404: Not Found').configs).toEqual([]);
    expect(extractRawConfigs('').configs).toEqual([]);
    expect(extractRawConfigs('<html><body><h1>502 Bad Gateway</h1></body></html>').configs).toEqual([]);
    expect(extractRawConfigs('{"error":"rate limited"}').configs).toEqual([]);
  });

  it('keeps reading plain URI lists and fenced blocks', () => {
    const list = ['# comment', VLESS, TROJAN].join('\n');
    expect(extractRawConfigs(list).configs).toEqual([VLESS, TROJAN]);

    const fenced = ['# Sub', '```', VLESS, '```'].join('\n');
    expect(extractRawConfigs(fenced).configs).toContain(VLESS);
  });

  it('does not truncate a share link at its `#`, which is the node name', () => {
    // Regression: the remark used to be cut off every node whose feed
    // contained a `#` — i.e. almost every real subscription list.
    const list = ['# header', VLESS].join('\n');
    const [extracted] = extractRawConfigs(list).configs;
    expect(extracted).toBe(VLESS);
    expect(parseNodeUri(extracted!).result && (parseNodeUri(extracted!).result as { config: { remark: string | null } }).config.remark).toBe('Wrapped-A');

    // Trailing markdown table/list padding is still dropped. Extraction stays
    // permissive (`vless://x` has the right scheme but is not a usable node) —
    // the parser is the gate that refuses it.
    const table = ['vless://x | 1.2.3.4 |', VLESS + ' | 1.2.3.4 |'].join('\n');
    expect(extractRawConfigs(table).configs).toEqual(['vless://x', VLESS]);
    expect(parseNodeUri('vless://x').result).toBeNull();
  });

  it('yields the host each share link really named, and nothing for garbage', () => {
    const { configs } = extractRawConfigs([VLESS, TROJAN, 'not-a-config-with-://'].join('\n'));
    const parsed = configs.map((c) => parseNodeUri(c));
    const hosts = parsed.filter((p) => p.result).map((p) => (p.result as { config: { host: string } }).config.host);
    expect(hosts).toContain('edge-01.example.net');
    expect(hosts).toContain('edge-02.example.net');
    expect(parseNodeUri('not-a-config-with-://').protocol).toBe('unknown');
    expect(parseNodeUri('not-a-config-with-://').result).toBeNull();
  });
});

describe('candidate accounting', () => {
  /*
   * The sources table shows Discovered / Imported / Invalid side by side, so
   * those numbers have to describe the same population. Extraction is
   * deliberately permissive and hands over every candidate line — including the
   * nested subscription URLs that real lists are full of — and the count that
   * used to be lost was exactly those lines: reported as discovered, then
   * dropped without being imported or refused. peasoft/NoMoreWalls was the live
   * example (333 discovered, 150 accepted, 12 invalid, 171 unaccounted for).
   */
  it('accounts for every candidate: accepted + invalid === discovered', () => {
    const doc = [
      '# Sub',
      '```',
      VLESS,
      '```',
      TROJAN,
      'vless://x',
      'not-a-config-with-://',
    ].join('\n');
    const candidates = extractRawConfigs(doc).configs;
    const { valid, invalid } = partitionConfigs(candidates);

    expect(valid.length + invalid).toBe(candidates.length);
    expect(valid.length).toBeGreaterThan(0);
  });

  it('counts a nested subscription URL as refused rather than letting it vanish', () => {
    const shared = ['https://example.com/another-subscription', VLESS];
    const { valid, invalid } = partitionConfigs(shared);

    expect(valid.length + invalid).toBe(shared.length);
    expect(valid).toHaveLength(1);
    expect(invalid).toBe(1);
  });

  it('refuses a candidate the extractor was permissive enough to hand over, and counts it', () => {
    const candidates = extractRawConfigs('not-a-config-with-://').configs;
    const { valid, invalid } = partitionConfigs(candidates);

    // Extraction kept the line (permissive by design, the parser is the gate)…
    expect(candidates).toEqual(['not-a-config-with-://']);
    // …and the parser's refusal is counted instead of the line disappearing.
    expect(valid).toHaveLength(0);
    expect(valid.length + invalid).toBe(candidates.length);
    expect(invalid).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* pipeline failure honesty                                                   */
/* -------------------------------------------------------------------------- */

describe('fetchAndImportSource failure honesty', () => {
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let ctx: Awaited<ReturnType<typeof buildApp>>['ctx'];
  let tmpDir: string;
  let cookieHeader: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-registry-'));
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
    ctx = built.ctx;
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/session', remoteAddress: '127.0.0.1' });
    cookieHeader = `netpulse_session=${res.cookies.find((c) => c.name === 'netpulse_session')!.value}`;
  });

  afterAll(async () => {
    await app.close();
    ctx.db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Seed a source row pointing at a loopback URL. The SSRF guard rejects it
   * before any socket exists, so these tests are deterministic and offline
   * while still driving the real pipeline and the real route.
   */
  function seedUnreachableFeed(id: string): PublicSource {
    const source: PublicSource = {
      id,
      name: 'unreachable feed',
      homepage: 'https://github.com/example/unreachable',
      repositoryUrl: 'https://github.com/example/unreachable',
      enabled: true,
      type: 'github_raw',
      urls: ['http://127.0.0.1:9/never.txt'],
      formats: ['uri'],
      intervalMinutes: 60,
      lastFetch: null,
      lastSuccess: null,
      lastFailure: null,
      status: 'idle',
      discoveredConfigCount: 0,
      importedConfigCount: 0,
      duplicateCount: 0,
      invalidCount: 0,
      recentDiscovered: 0,
      recentImported: 0,
      recentHealthy: 0,
      health: 'unknown',
      lastContentHash: null,
      notes: null,
      createdAt: Date.now(),
    };
    ctx.repos.publicSources.insert({
      id: source.id,
      name: source.name,
      homepage: source.homepage ?? null,
      repositoryUrl: source.repositoryUrl ?? null,
      enabled: source.enabled,
      type: source.type,
      urls: source.urls,
      formats: source.formats,
      intervalMinutes: source.intervalMinutes,
      lastFetch: null,
      lastSuccess: null,
      lastFailure: null,
      status: 'idle',
      discoveredConfigCount: 0,
      importedConfigCount: 0,
      duplicateCount: 0,
      invalidCount: 0,
      recentDiscovered: 0,
      recentImported: 0,
      recentHealthy: 0,
      health: 'unknown',
      lastContentHash: null,
      notes: null,
      createdAt: Date.now(),
    });
    return source;
  }

  it('records a failed fetch and imports nothing when a feed cannot be fetched', async () => {
    const source = seedUnreachableFeed('unreachable-feed');

    let imported = 0;
    const fetchContext: FetchContext = {
      sourceId: source.id,
      fetchId: '',
      logger: ctx.log,
      sourcesRepo: ctx.repos.publicSources,
      fetchesRepo: ctx.repos.sourceFetches,
      docsRepo: ctx.repos.rawDocuments,
      onDiscovery: () => {},
      onImport: (n) => { imported += n; },
      onDuplicate: () => {},
      onInvalid: () => {},
      onStatus: () => {},
      onImportConfigs: async (_url, configs) => ({ imported: configs.length, duplicates: 0, invalid: 0 }),
    };

    const result = await fetchAndImportSource(source, fetchContext);

    // The pipeline's own verdict, not "the request finished".
    expect(result.status).toBe('failed');
    expect(result.error).toContain('private/loopback');
    expect(result.imported).toBe(0);
    expect(imported).toBe(0);
    expect(result.documents).toEqual([]);

    const stored = ctx.repos.publicSources.get(source.id);
    expect(stored?.status).toBe('failed');
    expect(stored?.importedConfigCount).toBe(0);
    expect(stored?.discoveredConfigCount).toBe(0);
    expect(stored?.lastFailure).toBeGreaterThan(0);
    expect(stored?.lastSuccess).toBeNull();

    const fetches = ctx.repos.sourceFetches.listBySource(source.id, 5);
    expect(fetches).toHaveLength(1);
    expect(fetches[0]!.status).toBe('failed');
    // The reason is recorded verbatim rather than replaced by a generic message.
    expect(fetches[0]!.error).toContain('private/loopback');
    expect(fetches[0]!.importedCount).toBe(0);
    expect(fetches[0]!.configCount).toBe(0);
  });

  it('reports a failed fetch as a failure over the API, with no invented counts', async () => {
    // Regression: the route hard-coded `status: 'completed'` for every fetch the
    // service returned, so a feed that 404'd looked like a successful refresh.
    const source = seedUnreachableFeed('unreachable-feed-api');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/sources/${source.id}/fetch`,
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('fetch_failed');
    expect(res.json().error.message).toContain('private/loopback');

    const list = await app.inject({ method: 'GET', url: '/api/v1/sources', headers: { cookie: cookieHeader } });
    const row = list.json().sources.find((s: { id: string }) => s.id === source.id);
    expect(row.status).toBe('failed');
    expect(row.importedConfigCount).toBe(0);
    expect(row.discoveredConfigCount).toBe(0);
    expect(row.lastSuccess).toBeNull();
  });
});
