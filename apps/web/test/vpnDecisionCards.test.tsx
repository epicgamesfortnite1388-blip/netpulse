import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AutonomyBody, type AgentPermissionsDto, type TrainResult } from '../src/features/vpn/AgentAutonomyCard';
import { SmartConnectBody, type SmartPlan } from '../src/features/vpn/SmartConnectCard';

/**
 * The two decision cards, rendered as the user reads them.
 *
 * Acceptance #15 stayed PARTIAL because neither card had ever been rendered by a
 * test or looked at by a human. This covers the rendering half: real components,
 * real formatting, assertions on the visible text. `renderToStaticMarkup` is
 * enough because the extracted bodies hold no state — the fetching wrappers keep
 * it — so this needs no testing-library, no DOM and no act().
 *
 * What it does NOT do is click. The Verify and Train buttons live in the card
 * actions, outside the bodies, and their POST paths are covered by the API suite.
 */

const NOW = 1_790_000_000_000;

/** The value tile for `label`, exactly as the user reads it. */
function tile(html: string, label: string): string {
  const m = new RegExp(`>${label}</p><p[^>]*>([^<]*)</p>`).exec(html);
  expect(m, `no tile labelled "${label}" in the rendered card`).toBeTruthy();
  return m![1]!.trim();
}

const COMPONENTS = {
  reliability: 80,
  latency: 61,
  freshness: 100,
  evidence: 96,
  sources: 40,
  adaptiveBoost: 2.4,
  failurePenalty: 0,
};

function candidate(over: Partial<SmartPlan['candidates'][number]> = {}): SmartPlan['candidates'][number] {
  return {
    nodeId: 'node:aaaa1111-bbb',
    protocol: 'shadowsocks',
    country: 'DE',
    engine: 'xray',
    score: 84,
    components: COMPONENTS,
    confidence: 'verified',
    trust: 'verified_traffic',
    reasons: ['reliability 80% over 4 tests', 'latency evidence 580 ms'],
    probe: null,
    ...over,
  };
}

function plan(over: Partial<SmartPlan> = {}): SmartPlan {
  return {
    generatedAt: NOW,
    considered: 300,
    excludedByReason: { 'engine-rejects-config': 157, stale: 45 },
    candidates: [
      candidate({
        probe: { at: NOW, status: 'done', latencyMs: 580, httpStatus: 200, verified: true, error: null },
      }),
      candidate({
        nodeId: 'node:cccc2222-ddd',
        protocol: 'vmess',
        country: null,
        score: 61,
        confidence: 'tested',
        trust: 'tested_proxy',
        reasons: ['reliability 61% over 9 tests'],
      }),
    ],
    chosen: null,
    decision: 'Probing the top 3 candidates; traffic must traverse before anything is called verified.',
    adaptive: {
      available: true,
      enabled: true,
      context: 'dns:0|tls:0|relay:0|v6:0|p:balanced',
      contextSummary: 'balanced profile',
      engineProbabilities: [{ engine: 'xray', probability: 0.267, confidence: 'high' }],
      note: 'xray+doh has 41 observations in this context',
    },
    limits: ['Scores rank stored evidence; only a probe result is verification.'],
    next: null,
    ...over,
  };
}

describe('Smart Connect card', () => {
  const html = renderToStaticMarkup(<SmartConnectBody plan={plan()} />);

  it('reports what was considered, kept and excluded', () => {
    expect(tile(html, 'Considered')).toBe('300');
    expect(tile(html, 'Candidates')).toBe('2');
    // 157 + 45, summed from the reason counts rather than hard-coded.
    expect(tile(html, 'Excluded')).toBe('202');
  });

  it('names the reason a config was never dialled, instead of printing the raw enum', () => {
    expect(html).toContain('refused by the installed core: 157');
    expect(html).not.toContain('engine-rejects-config');
    expect(html).toContain('stale: 45');
  });

  it('says verified only where a probe carried traffic, with its latency', () => {
    expect(html).toContain('verified 580 ms');
    // The second candidate has confidence `tested` and no probe: it must not
    // acquire a verification sentence from its confidence label alone.
    expect((html.match(/verified 580 ms/g) ?? []).length).toBe(1);
    expect(html).toContain('tested');
  });

  it('shows the decision sentence the backend produced', () => {
    expect(html).toContain('Probing the top 3 candidates');
  });

  it('explains an empty candidate list from the exclusion counts, not a spinner', () => {
    const empty = renderToStaticMarkup(
      <SmartConnectBody
        plan={plan({
          candidates: [],
          considered: 12,
          excludedByReason: { stale: 12 },
          decision:
            '12 of 12 stored configurations have stale test evidence. Refresh a source, or run a scan so the evidence is current again.',
        })}
      />,
    );

    expect(tile(empty, 'Candidates')).toBe('0');
    expect(empty).toContain('12 of 12 stored configurations have stale test evidence');
    expect(empty).toContain('stale: 12');
  });
});

const CAPABILITIES: AgentPermissionsDto['capabilities'] = [
  {
    id: 'network:probe-endpoint',
    tier: 'budgeted',
    title: 'Probe public endpoints',
    allows: 'Dial a stored public endpoint to see whether it answers.',
    bound: 'Capped per hour and paused with unattended work.',
    granted: 'granted',
    usedThisHour: 6,
    limitPerHour: 60,
    remaining: 54,
  },
  {
    id: 'network:fetch-source',
    tier: 'budgeted',
    title: 'Refresh a public feed',
    allows: 'Download a registered public configuration feed.',
    bound: 'Only feeds the user registered.',
    granted: 'granted',
    usedThisHour: 1,
    limitPerHour: 12,
    remaining: 11,
  },
  {
    id: 'network:verify-traffic',
    tier: 'budgeted',
    title: 'Verify through a tunnel',
    allows: 'Send a test request through a candidate and require it to arrive.',
    bound: 'Charged per probe, on request only.',
    granted: 'granted',
    usedThisHour: 8,
    limitPerHour: 20,
    remaining: 12,
  },
  {
    id: 'exec:shell',
    tier: 'forbidden',
    title: 'Run shell commands',
    allows: 'never',
    bound: 'no setting can grant this',
    granted: 'forbidden',
    usedThisHour: 0,
    limitPerHour: null,
    remaining: null,
  },
  {
    id: 'read:credential',
    tier: 'forbidden',
    title: 'Read stored credentials',
    allows: 'never',
    bound: 'no setting can grant this',
    granted: 'forbidden',
    usedThisHour: 0,
    limitPerHour: null,
    remaining: null,
  },
];

function permissions(over: Partial<AgentPermissionsDto> = {}): AgentPermissionsDto {
  return {
    version: 1,
    paused: false,
    capabilities: CAPABILITIES,
    recent: [
      {
        at: NOW - 60_000,
        capability: 'network:probe-endpoint',
        origin: 'autonomous',
        allowed: false,
        code: 'budget_exhausted',
        reason: 'Hourly probe allowance spent; the scheduler waits for the window to roll.',
        count: 1,
        detail: null,
      },
      {
        at: NOW - 30_000,
        capability: 'network:verify-traffic',
        origin: 'user',
        allowed: true,
        code: 'granted',
        reason: 'User asked for this verification.',
        count: 1,
        detail: null,
      },
    ],
    note: 'The agent may probe and fetch within hourly budgets and may never execute code, raise privileges or read credentials.',
    limits: { fetchPerHour: 12, probesPerHour: 60, verifyPerHour: 20 },
    cannot: ['exec:shell', 'exec:elevated', 'read:credential'],
    enforcement: [
      {
        action: 'POST /vpn/smart-connect',
        capability: 'network:verify-traffic',
        where: 'routes/vpn.ts',
        onDenial: 'refused before any dial',
      },
    ],
    training: {
      observationsKept: 53,
      calibration: {
        samples: 12,
        brier: 0.146,
        baselineBrier: 0.25,
        skill: 0.104,
        meanPredicted: 0.25,
        observedRate: 0.167,
      },
      note: 'Brier 0.146 over 12 scored attempt(s); a 0.5 baseline scores 0.25.',
    },
    ...over,
  };
}

const TRAINED: TrainResult = {
  attempted: 6,
  verified: 1,
  failed: 5,
  byEngine: { xray: { attempted: 6, verified: 1 } },
  calibrationAfter: null,
  note: 'Probed 6 candidates at most 2 at a time.',
};

describe('Agent autonomy card', () => {
  const html = renderToStaticMarkup(<AutonomyBody data={permissions()} trained={TRAINED} />);

  it('shows the hourly budgets the backend enforces', () => {
    expect(tile(html, 'Probes / hour')).toBe('6 / 60');
    expect(tile(html, 'Fetches / hour')).toBe('1 / 12');
    expect(tile(html, 'Verifications / hour')).toBe('8 / 20');
  });

  it('counts the capabilities no setting can grant', () => {
    expect(tile(html, 'Permanently denied')).toBe('2');
    expect(html).toContain('Run shell commands');
    expect(html).toContain('Read stored credentials');
    expect(html).toContain('This list lives in code, not in settings.');
  });

  it('reports calibration as a score against a baseline, not as a success count', () => {
    expect(tile(html, 'Calibration skill')).toBe('0.104');
    expect(html).toContain('Brier 0.146 vs 0.25 baseline');
  });

  it('says calibration is unmeasured rather than showing zero', () => {
    const unmeasured = renderToStaticMarkup(
      <AutonomyBody
        data={permissions({
          training: {
            observationsKept: 3,
            calibration: null,
            note: 'No attempt has carried a prediction yet, so calibration is unmeasured rather than good.',
          },
        })}
      />,
    );

    expect(tile(unmeasured, 'Calibration skill')).toBe('—');
    expect(unmeasured).toContain('no scored prediction yet');
    expect(unmeasured).not.toContain('0.000');
  });

  it('lists refusals only, never the decision that was allowed', () => {
    expect(html).toContain('Hourly probe allowance spent');
    expect(html).not.toContain('User asked for this verification.');
  });

  it('reports the batch the Train button just ran', () => {
    expect(html).toContain('Last batch: probed 6, 1 carried traffic, 5 did not.');
  });
});
