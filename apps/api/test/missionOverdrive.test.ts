import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app';
import { buildOverdriveSnapshot, parseBibliography, parseRequirements } from '../src/services/missionOverdrive';

import type { FastifyInstance } from 'fastify';

/**
 * The Overdrive ledger is only as trustworthy as its degradations, so these tests
 * pin what happens when an artifact is missing, unreadable or re-shaped — the
 * cases where a dashboard would otherwise quietly show zero instead of "unknown".
 */

const STATES = ['verified', 'observed', 'not_tested', 'unavailable', 'blocked'] as const;

describe('overdrive parsers', () => {
  it('reads the source registry into entries with real URLs', () => {
    const text = [
      '# Registry',
      '',
      '### S01 — IRBlock (USENIX Security 2025)',
      '',
      '- **Title:** IRBlock',
      '- **URL:** https://www.usenix.org/conference/usenixsecurity25/presentation/tai',
      '- **Type / Iran relevance:** peer-reviewed / direct',
      '- **Date:** August 2025',
      '- **Findings:** DNS poisoning over 6.8M IPs.',
      '- **License / confidence:** open access / **High**',
      '',
      '### S02 — I(ra)nconsistencies',
      '',
      '- **URL:** https://www.petsymposium.org/foci/2025/foci-2025-0002.php',
      '- **Date:** 2025',
    ].join('\n');

    const entries = parseBibliography(text);
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBe('S01');
    expect(entries[0].url).toContain('usenix.org');
    expect(entries[0].findings).toContain('DNS poisoning');
    expect(entries[0].confidence).toContain('High');
    expect(entries[1].id).toBe('S02');
    expect(entries[1].url).toContain('petsymposium.org');
  });

  it('maps roadmap status wording onto evidence classes without upgrading it', () => {
    const text = [
      '## Iran‑Ready Definition (5 requirements, currently 0/5 satisfied)',
      '',
      '1. **Vantage** with consent — **NOT AVAILABLE**',
      '2. **Stage results**, ≥20 repeats — **PARTIAL (lab)** — 20 rounds',
      '3. **Real client and independent egress** — **NOT AVAILABLE**',
      '4. **Negative controls** — **PARTIAL** — 4/4 verified',
      '5. **Failure taxonomy** — **DOCUMENTED**',
      '',
      '---',
      '',
      '## Next section',
    ].join('\n');

    const rows = parseRequirements(text);
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.state)).toEqual(['not_tested', 'observed', 'not_tested', 'observed', 'observed']);
    // The requirement's own words survive; the page must not rewrite them.
    expect(rows[0].status).toBe('NOT AVAILABLE');
    expect(rows[1].text).toContain('Stage results');
  });

  it('returns no rows rather than guessing when the roadmap shape is gone', () => {
    expect(parseRequirements('# something else entirely')).toEqual([]);
  });
});

describe('overdrive snapshot degradation', () => {
  it('reports unreadable artifacts as unavailable rows, never as zeros', async () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-empty-'));
    fs.mkdirSync(path.join(emptyRoot, 'docs', 'research', 'dpi'), { recursive: true });

    // A minimal AppContext is not needed: with no artifacts every row short-circuits
    // before touching a service, and the live read is wrapped in try/catch.
    const snapshot = await buildOverdriveSnapshot({} as never, Date.now(), emptyRoot);

    expect(snapshot.evidence).toHaveLength(8);
    for (const row of snapshot.evidence) {
      expect(row.state).toBe('unavailable');
      expect(row.artifact).not.toBe('');
      expect(row.headline).toContain('no readable measurement');
      expect(STATES).toContain(row.state);
    }
    expect(snapshot.timeline).toEqual([]);
    expect(snapshot.summary.requirementsTotal).toBe(0);
  });

  it('reports a corrupt artifact as unavailable, with the reason attached', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'netpulse-corrupt-'));
    fs.mkdirSync(path.join(root, 'docs', 'research', 'dpi'), { recursive: true });
    fs.mkdirSync(path.join(root, 'reports', 'accounting'), { recursive: true });
    fs.writeFileSync(path.join(root, 'reports', 'accounting', 'free-config-survival-2026-11-03.json'), '{ not json');

    const snapshot = await buildOverdriveSnapshot({} as never, Date.now(), root);
    const survival = snapshot.evidence.find((e) => e.id === 'survival');
    expect(survival?.state).toBe('unavailable');
    expect(survival?.headline).toContain('not valid JSON');
  });
});

describe('overdrive endpoint', () => {
  let app: FastifyInstance;

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
  });

  afterAll(async () => {
    await app?.close();
  });

  async function getOverdrive(extraHeaders: Record<string, string> = {}) {
    const session = await app.inject({ method: 'POST', url: '/api/v1/auth/session', remoteAddress: '127.0.0.1' });
    const cookie = session.cookies.find((c) => c.name === 'netpulse_session');
    if (!cookie) throw new Error('no session cookie');
    return app.inject({
      method: 'GET',
      url: '/api/v1/mission/overdrive',
      remoteAddress: '127.0.0.1',
      headers: { cookie: `${cookie.name}=${cookie.value}`, ...extraHeaders },
    });
  }

  it('serves measured evidence from this repository, classified', async () => {
    const res = await getOverdrive();
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      evidence: Array<{ id: string; state: string; artifact: string; metrics: unknown[] }>;
      research: { total: number };
      requirements: unknown[];
      summary: { state: string };
    };

    expect(body.evidence.length).toBe(8);
    for (const row of body.evidence) {
      expect(STATES).toContain(row.state as (typeof STATES)[number]);
      expect(row.artifact).toMatch(/^reports\//);
    }
    // The measured artifacts in this repository are real files, so at least the
    // free-config census must be readable — if this fails, the artifacts moved.
    expect(body.evidence.some((e) => e.id === 'inventory' && e.state === 'verified')).toBe(true);
    expect(body.research.total).toBeGreaterThan(10);
    expect(body.summary.state).not.toBe('verified');
  });

  it('does not leak key material or subscription links', async () => {
    const res = await getOverdrive();
    const raw = res.body;
    expect(raw).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
    expect(raw).not.toMatch(/aether-masque-localkey/i);
    expect(raw).not.toMatch(/(vmess|vless|trojan|ss):\/\//i);
  });
});
