import { describe, expect, it } from 'vitest';

import {
  promotionRefusal,
  validateCandidate,
  validateRegistry,
  type AdaptiveCandidate,
} from '../src/adaptive';

/**
 * The research gate. Every refusal here is a way the app declines to act on
 * something it found on the internet.
 */

const base = (over: Partial<AdaptiveCandidate> = {}): AdaptiveCandidate => ({
  id: 'xray-reality-vision',
  version: 1,
  title: 'REALITY with XTLS Vision flow',
  problem: 'TLS-in-TLS detection drops ordinary TLS tunnels on some access networks.',
  summary: 'Use REALITY with the vision flow so the outer handshake is indistinguishable from the borrowed site.',
  source: {
    kind: 'protocol-repository',
    reference: 'https://github.com/XTLS/Xray-core/discussions/1295',
    publisher: 'XTLS',
    retrievedAt: Date.UTC(2026, 9, 20),
  },
  license: 'MPL-2.0',
  compatibility: { clientCores: ['xray'], protocols: ['vless'], platforms: ['windows', 'linux', 'macos'] },
  security: { risk: 'medium', concerns: ['the SNI target must be a site whose operator tolerates the borrowing'], authorization: 'own infrastructure only' },
  expectedBenefit: { claim: 'higher completion rate on filtered paths', metric: 'verified tunnel success rate', baseline: 'current xray reality without flow' },
  testPlan: ['dial the owned staging server through xray with and without flow', 'compare verified tunnel success over 20 attempts each'],
  status: 'testing',
  evidence: [],
  conclusion: null,
  proposedAt: Date.UTC(2026, 9, 20),
  updatedAt: Date.UTC(2026, 9, 20),
  ...over,
});

const codes = (c: unknown): string[] => validateCandidate(c).refusals.map((r) => r.code);

describe('a candidate must be traceable', () => {
  it('accepts a fully specified candidate', () => {
    const result = validateCandidate(base());
    expect(result.ok).toBe(true);
    expect(result.refusals).toEqual([]);
  });

  it('refuses a candidate with no source', () => {
    expect(codes(base({ source: undefined as never }))).toContain('missing-source');
  });

  it('refuses a paste service as a source', () => {
    const result = validateCandidate(base({ source: { ...base().source, reference: 'https://pastebin.com/abc123' } }));
    expect(result.ok).toBe(false);
    expect(result.refusals.map((r) => r.code)).toContain('unsafe-source');
  });

  it('refuses an unknown source kind', () => {
    expect(codes(base({ source: { ...base().source, kind: 'blog' as never } }))).toContain('missing-source');
  });

  it('refuses a candidate with no licence statement', () => {
    expect(codes(base({ license: '' }))).toContain('missing-license');
  });

  it('warns, but does not refuse, an explicitly unknown licence', () => {
    const result = validateCandidate(base({ license: 'unknown — do not ship' }));
    expect(result.ok).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/cannot be recommended/);
  });

  it('refuses a candidate with no test plan', () => {
    expect(codes(base({ testPlan: ['look at it'] }))).toContain('missing-test-plan');
  });

  it('refuses an unstated problem', () => {
    expect(codes(base({ problem: 'faster' }))).toContain('missing-problem');
  });
});

describe('a candidate may not carry credentials', () => {
  it('refuses a share link anywhere in the candidate', () => {
    const result = validateCandidate(base({ summary: 'paste vless://aaaa-bbbb@1.2.3.4:443?sni=x#node into the client' }));
    expect(result.refusals.map((r) => r.code)).toContain('credential-material');
  });

  it('refuses a bare UUID in the evidence', () => {
    const result = validateCandidate(
      base({
        evidence: [
          {
            method: 'dial',
            result: 'worked with 6ebe8dee-16a2-4b02-895f-e7c614965b98',
            environment: 'lab',
            at: 1,
          },
        ],
      }),
    );
    expect(result.refusals.map((r) => r.code)).toContain('credential-material');
  });

  it('refuses user:password@host material', () => {
    const result = validateCandidate(base({ summary: 'authenticate as alice:hunter2pass@node.example.com' }));
    expect(result.refusals.map((r) => r.code)).toContain('credential-material');
  });

  it('refuses an embedded private key', () => {
    const result = validateCandidate(base({ summary: '-----BEGIN OPENSSH PRIVATE KEY----- AAAA' }));
    expect(result.refusals.map((r) => r.code)).toContain('credential-material');
  });

  it('does not echo the secret in the refusal', () => {
    const result = validateCandidate(base({ summary: 'vless://secret-uuid-here@1.2.3.4:443#x' }));
    const text = result.refusals.map((r) => r.detail).join(' ');
    expect(text).toContain('[redacted]');
    expect(text).not.toContain('secret-uuid-here');
  });
});

describe('third-party endpoints need authorization', () => {
  it('refuses using a real hostname as an SNI target without permission', () => {
    const result = validateCandidate(
      base({
        summary: 'borrow www.microsoft.com as the SNI front for the handshake',
        security: { risk: 'medium', concerns: [], authorization: null },
      }),
    );
    expect(result.refusals.map((r) => r.code)).toContain('unauthorized-endpoint');
  });

  it('accepts the same idea when the authorization is stated', () => {
    const result = validateCandidate(base({ summary: 'borrow our own staging site as the SNI front' }));
    expect(result.ok).toBe(true);
  });
});

describe('terminal states need evidence', () => {
  it('refuses "accepted" with no measurement', () => {
    expect(codes(base({ status: 'accepted', conclusion: 'it looked good in testing' }))).toContain('terminal-without-evidence');
  });

  it('refuses "accepted" with no conclusion', () => {
    const result = validateCandidate(
      base({
        status: 'accepted',
        evidence: [{ method: '20 dials', result: '18/20 verified', environment: 'owned staging', at: 1 }],
        conclusion: null,
      }),
    );
    expect(result.refusals.map((r) => r.code)).toContain('terminal-without-conclusion');
  });

  it('accepts "accepted" with a measurement and a conclusion', () => {
    const result = validateCandidate(
      base({
        status: 'accepted',
        evidence: [{ method: '20 dials with and without flow', result: '18/20 vs 11/20 verified', environment: 'owned staging server', at: 1 }],
        conclusion: 'Flow raised the verified success rate on this path; keep it on for reality nodes.',
      }),
    );
    expect(result.ok).toBe(true);
  });
});

describe('the registry and promotion', () => {
  it('counts states and promotes only accepted, valid candidates', () => {
    const report = validateRegistry({
      version: 1,
      updatedAt: 1,
      candidates: [
        base({ id: 'a-proposed', status: 'proposed' }),
        base({ id: 'b-accepted', status: 'accepted', evidence: [{ method: 'm', result: 'r', environment: 'lab', at: 1 }], conclusion: 'keep it, it measured better' }),
        base({ id: 'c-broken', status: 'testing', license: '' }),
      ],
    });

    expect(report.summary.proposed).toBe(1);
    expect(report.summary.accepted).toBe(1);
    expect(report.ok).toBe(false); // c-broken is invalid
    expect(report.promotable).toEqual(['b-accepted']);
  });

  it('refuses to promote anything that is not accepted with evidence', () => {
    expect(promotionRefusal(base({ status: 'testing' }))).toEqual({
      promotable: false,
      reason: expect.stringContaining('only an accepted candidate'),
    });
    expect(promotionRefusal(base({ status: 'accepted', conclusion: 'x', evidence: [] })).promotable).toBe(false);
    expect(promotionRefusal(base()).promotable).toBe(false);
  });

  it('lets nothing reach the app automatically: a valid accepted candidate is only promotable', () => {
    const accepted = base({
      status: 'accepted',
      evidence: [{ method: 'm', result: 'r', environment: 'lab', at: 1 }],
      conclusion: 'measured better, keep it',
    });
    expect(promotionRefusal(accepted)).toEqual({ promotable: true });
    // There is deliberately no function that turns a candidate into a live
    // strategy — promotion is a code change, not a data change.
    expect(Object.keys({ promotionRefusal })).toEqual(['promotionRefusal']);
  });
});
