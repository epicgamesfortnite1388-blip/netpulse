import { describe, expect, it, vi } from 'vitest';

import type { AdaptiveAttemptOutcome, AdaptiveStatus } from '../src/services/adaptiveEngine';
import { MAX_CONCURRENCY, MAX_PROBES, SmartConnectService, VERIFIED_WINDOW, type SmartNodeRow, type SmartProbeResult } from '../src/services/smartConnect';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const NOW = 1_790_000_000_000;

function row(over: Partial<SmartNodeRow> = {}): SmartNodeRow {
  return {
    id: 'node-1',
    protocol: 'vless',
    // A dialable VLESS node carries TLS; plaintext VLESS is refused by xray and
    // is opted into explicitly by the tests that check that refusal.
    security: 'tls',
    host: 'example.test',
    port: 443,
    status: 'healthy',
    freshness: 'fresh',
    score: 80,
    reliabilityPct: 80,
    medianProxyMs: 500,
    medianTcpMs: null,
    lastProxyMs: 500,
    lastTcpMs: null,
    lastSuccessAt: NOW - MIN,
    lastFailureAt: null,
    lastValidated: NOW - MIN,
    lastSeen: NOW - MIN,
    consecutiveFailures: 0,
    testCount: 4,
    successCount: 3,
    failureCount: 1,
    sourceCount: 2,
    country: 'DE',
    ...over,
  };
}

/** Only the fields SmartConnectService reads; the rest is irrelevant here. */
function adaptiveWith(entries: Array<{ strategyId: string; successProbability: number; confidence: string }>): AdaptiveStatus {
  return {
    enabled: true,
    exploration: false,
    context: 'network:unknown|isp:unknown',
    contextSummary: 'unknown network',
    entries,
  } as unknown as AdaptiveStatus;
}

function service(opts: {
  rows?: SmartNodeRow[];
  engines?: Array<'xray' | 'sing-box' | 'v2ray' | 'hysteria'>;
  probe?: (nodeId: string) => Promise<SmartProbeResult>;
  adaptive?: { status: () => AdaptiveStatus; observe: (o: AdaptiveAttemptOutcome) => unknown } | null;
}) {
  const rows = opts.rows ?? [row()];
  return new SmartConnectService({
    listCandidates: () => rows,
    engines: () => opts.engines ?? ['xray', 'sing-box'],
    probe: opts.probe,
    adaptive: opts.adaptive ?? null,
    now: () => NOW,
  });
}

const okProbe = (latencyMs = 420): SmartProbeResult => ({
  status: 'done',
  latencyMs,
  httpStatus: 200,
  engine: 'xray',
  error: null,
});

const badProbe = (error = 'handshake timed out'): SmartProbeResult => ({
  status: 'failed',
  latencyMs: null,
  httpStatus: null,
  engine: null,
  error,
});

describe('SmartConnect plan', () => {
  it('excludes revoked, failing, stale and unsupported rows with counted reasons', () => {
    const svc = service({
      rows: [
        row({ id: 'ok' }),
        row({ id: 'revoked', status: 'revoked' }),
        row({ id: 'dead', consecutiveFailures: 3 }),
        row({ id: 'old', freshness: 'stale', lastSuccessAt: NOW - 48 * HOUR, lastValidated: NOW - 48 * HOUR }),
        // tuic IS a supported protocol — it is excluded here only because no
        // installed core can dial it, which is a different fact from...
        row({ id: 'tuic', protocol: 'tuic' }),
        // ...this one: no supported core speaks `http` at all.
        row({ id: 'http', protocol: 'http' }),
      ],
      engines: ['xray'],
    });

    const plan = svc.plan();

    expect(plan.considered).toBe(6);
    expect(plan.candidates.map((c) => c.nodeId)).toEqual(['ok']);
    expect(plan.excludedByReason).toMatchObject({
      revoked: 1,
      failed: 1,
      stale: 1,
      'no-engine-installed': 1,
      'unsupported-protocol': 1,
    });
  });

  it('excludes a config the installed core refuses, instead of spending a probe to prove it', () => {
    // Measured on xray 26.10.31: plaintext VLESS to a public IP makes the core
    // exit at startup. A live training batch dialled six of these and counted
    // them as failures before this rule existed.
    const plaintextIp = row({ id: 'plain-ip', host: '203.0.113.9', security: 'none' });
    const plan = service({ rows: [plaintextIp], engines: ['xray'] }).plan();

    expect(plan.candidates).toHaveLength(0);
    expect(plan.excludedByReason['engine-rejects-config']).toBe(1);
    expect(plan.decision).toMatch(/refused by the installed core/i);
  });

  it('lets training re-measure a time-stale node, but never retries one that only ever failed', async () => {
    const oldSuccess = row({ id: 'old-success', lastSuccessAt: NOW - 3 * 24 * HOUR, lastValidated: NOW - 3 * 24 * HOUR });
    const onlyFailed = row({ id: 'only-failed', lastSuccessAt: null, lastValidated: null, testCount: 3, successCount: 0, failureCount: 3 });
    const probe = vi.fn(async () => okProbe());
    const svc = service({ rows: [oldSuccess, onlyFailed], probe });

    // Connecting must still refuse both: one has old evidence, one has none but failures.
    expect(svc.plan().candidates).toHaveLength(0);

    const plan = svc.plan({ allowStale: true });
    expect(plan.candidates.map((c) => c.nodeId)).toEqual(['old-success']);

    const trained = await svc.train({ size: 2, concurrency: 1 });
    expect(trained.attempted).toBe(1);
    expect(probe).toHaveBeenCalledWith('old-success');
  });

  it('hands that same node to sing-box, which was not observed rejecting it', () => {
    const plaintextIp = row({ id: 'plain-ip', host: '203.0.113.9', security: 'none' });
    const plan = service({ rows: [plaintextIp], engines: ['sing-box'] }).plan();

    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]?.engine).toBe('sing-box');
  });

  it('also refuses plaintext VLESS on a hostname, which a live batch showed xray rejects', () => {
    const plainDomain = row({ id: 'plain-domain', host: 'wwww.qarvian.ir', security: 'none' });
    const plan = service({ rows: [plainDomain], engines: ['xray'] }).plan();

    expect(plan.candidates).toHaveLength(0);
    expect(plan.excludedByReason['engine-rejects-config']).toBe(1);
  });

  it('refuses a REALITY row with no public key, which builds as plaintext and dies at startup', () => {
    const keyless = row({ id: 'reality-keyless', security: 'reality', realityPublicKey: null });
    const keyed = row({ id: 'reality-keyed', security: 'reality', realityPublicKey: 'PUBKEY' });
    const plan = service({ rows: [keyless, keyed], engines: ['xray'] }).plan();

    expect(plan.candidates.map((c) => c.nodeId)).toEqual(['reality-keyed']);
    expect(plan.excludedByReason['engine-rejects-config']).toBe(1);
  });

  it('leaves TLS VLESS and plaintext VMess alone, because neither was observed rejected', () => {
    const tlsIp = row({ id: 'tls-ip', host: '203.0.113.9', security: 'tls' });
    const vmessPlain = row({ id: 'vmess-plain', protocol: 'vmess', host: 'node.example.com', security: 'none' });
    const plan = service({ rows: [tlsIp, vmessPlain], engines: ['xray'] }).plan();

    expect(plan.candidates.map((c) => c.nodeId).sort()).toEqual(['tls-ip', 'vmess-plain']);
    expect(plan.excludedByReason['engine-rejects-config']).toBeUndefined();
  });

  it('distinguishes "no engine installed" from "protocol unsupported"', () => {
    const plan = service({ rows: [row({ id: 'tuic', protocol: 'tuic' })], engines: [] }).plan();
    expect(plan.excludedByReason).toMatchObject({ 'no-engine-installed': 1 });
    expect(plan.candidates).toHaveLength(0);
  });

  it('keeps a freshly discovered, never-tested row eligible even though its test freshness is stale', () => {
    // importParsedConfigs writes new nodes as freshness 'stale' because they have
    // no test yet. Excluding those would empty Smart Connect right after a refresh.
    const plan = service({
      rows: [row({ id: 'new', testCount: 0, successCount: 0, lastSuccessAt: null, lastProxyMs: null, lastValidated: null, freshness: 'stale' })],
    }).plan();

    expect(plan.candidates.map((c) => c.nodeId)).toEqual(['new']);
    expect(plan.candidates[0]!.confidence).toBe('untested');
    // and it must not be badged STALE — there is no evidence to be stale
    expect(plan.candidates[0]!.trust).toBe('STATICALLY_VALIDATED');
    expect(plan.excludedByReason['stale']).toBeUndefined();
  });

  it('still excludes a node whose test evidence has gone stale', () => {
    const plan = service({
      rows: [row({ id: 'old', freshness: 'stale', testCount: 4, lastSuccessAt: NOW - 48 * HOUR, lastValidated: NOW - 48 * HOUR })],
    }).plan();
    expect(plan.candidates).toHaveLength(0);
    expect(plan.excludedByReason['stale']).toBe(1);
  });

  it('keeps a just-verified node even when its stored freshness flag still says stale', () => {
    // Observed live: a proxy test wrote last_proxy_ms 580 / HTTP 200 and the row
    // still carried freshness 'stale' from import. Excluding it would drop the
    // only node that provably worked a minute ago.
    const plan = service({
      rows: [row({ id: 'just-worked', freshness: 'stale', testCount: 1, successCount: 1, lastProxyMs: 580, lastSuccessAt: NOW - MIN })],
    }).plan();

    expect(plan.candidates.map((c) => c.nodeId)).toEqual(['just-worked']);
    expect(plan.candidates[0]!.confidence).toBe('verified');
    expect(plan.candidates[0]!.trust).toBe('TRAFFIC_VERIFIED');
  });

  it('never labels a row without proxy evidence as verified, and caps its score', () => {
    const plan = service({
      rows: [
        row({
          id: 'untested',
          testCount: 0,
          successCount: 0,
          lastSuccessAt: null,
          lastProxyMs: null,
          lastValidated: null,
          reliabilityPct: 100,
          score: 100,
          medianProxyMs: 100,
        }),
      ],
    }).plan();

    const candidate = plan.candidates[0]!;
    expect(candidate.confidence).toBe('untested');
    expect(candidate.trust).toBe('STATICALLY_VALIDATED');
    expect(candidate.score).toBeLessThanOrEqual(55);
    // and it is not silently reported as the safe choice
    expect(plan.decision).toContain('Untested');
  });

  it('never lets a TCP-only success outrank a traffic-verified node', () => {
    // Observed live: a 15 ms TCP success scored 93 and displaced the node that
    // had just carried HTTP traffic at 580 ms. A port is not a tunnel.
    const plan = service({
      rows: [
        row({ id: 'port-only', lastProxyMs: null, medianProxyMs: null, reliabilityPct: 100, lastSuccessAt: NOW - MIN, successCount: 9, testCount: 9 }),
        row({ id: 'traffic', reliabilityPct: 80, medianProxyMs: 580, lastProxyMs: 580, lastSuccessAt: NOW - MIN, successCount: 1, testCount: 1 }),
      ],
    }).plan();

    const portOnly = plan.candidates.find((c) => c.nodeId === 'port-only')!;
    const traffic = plan.candidates.find((c) => c.nodeId === 'traffic')!;
    expect(portOnly.score).toBeLessThanOrEqual(70);
    expect(traffic.score).toBeGreaterThan(portOnly.score);
    expect(plan.chosen?.nodeId).toBe('traffic');
  });

  it('ranks fresh verified evidence above a higher stored score with no evidence', () => {
    const plan = service({
      rows: [
        row({ id: 'stored-only', testCount: 0, successCount: 0, lastSuccessAt: null, lastProxyMs: null, lastValidated: null, score: 99 }),
        row({ id: 'verified', reliabilityPct: 90, medianProxyMs: 300, lastSuccessAt: NOW - 5 * MIN, successCount: 5, testCount: 6 }),
      ],
    }).plan();

    expect(plan.chosen?.nodeId).toBe('verified');
    expect(plan.chosen?.confidence).toBe('verified');
  });

  it('resolves the nudge from a real strategy id, which is `xray+doh`, not `xray:doh`', () => {
    const rows = [
      row({ id: 'a', protocol: 'vless', reliabilityPct: 60, medianProxyMs: 900, sourceCount: 1 }),
      row({ id: 'b', protocol: 'trojan', reliabilityPct: 95, medianProxyMs: 200, sourceCount: 4 }),
    ];
    const plain = service({ rows }).plan();
    const plan = service({
      rows,
      adaptive: {
        status: () => adaptiveWith([{ strategyId: 'xray+doh', successProbability: 0.99, confidence: 'high' }]),
        observe: () => undefined,
      },
    }).plan();

    // Before the '+' split fix the key was 'xray+doh', so the nudge never reached
    // the xray row and these two scores were identical.
    expect(plan.candidates.find((c) => c.nodeId === 'a')!.score).toBeGreaterThan(
      plain.candidates.find((c) => c.nodeId === 'a')!.score,
    );
  });

  it('ignores a belief learned under a different network context', () => {
    const rows = [
      row({ id: 'a', protocol: 'vless', reliabilityPct: 60, medianProxyMs: 900, sourceCount: 1 }),
      row({ id: 'b', protocol: 'trojan', reliabilityPct: 95, medianProxyMs: 200, sourceCount: 4 }),
    ];
    const status = {
      ...adaptiveWith([{ strategyId: 'xray+doh', successProbability: 0.99, confidence: 'high' }]),
      context: 'dns:0|tls:0|relay:0|v6:0|p:balanced',
      entries: [
        { context: 'dns:0|tls:0|relay:1|v6:0|p:balanced', strategyId: 'xray+doh', successProbability: 0.99, confidence: 'high' },
      ],
    } as unknown as AdaptiveStatus;

    const plan = service({ rows, adaptive: { status: () => status, observe: () => undefined } }).plan();
    const plain = service({ rows }).plan();

    expect(plan.candidates.find((c) => c.nodeId === 'a')!.score).toBe(
      plain.candidates.find((c) => c.nodeId === 'a')!.score,
    );
  });

  it('stamps each training observation with the probability the model assigned', async () => {
    const observed: AdaptiveAttemptOutcome[] = [];
    const svc = service({
      rows: [row({ id: 'a', security: 'tls' })],
      probe: async () => okProbe(),
      adaptive: {
        status: () => adaptiveWith([{ strategyId: 'xray+doh', successProbability: 0.8, confidence: 'high' }]),
        observe: (o) => observed.push(o),
      },
    });

    await svc.train({ size: 1, concurrency: 1 });

    expect(observed).toHaveLength(1);
    expect(observed[0]?.predicted).toBeCloseTo(0.8, 6);
  });

  it('lets the adaptive engine nudge but not decide', () => {
    const rows = [
      row({ id: 'a', protocol: 'vless', reliabilityPct: 60, medianProxyMs: 900, sourceCount: 1 }),
      row({ id: 'b', protocol: 'trojan', reliabilityPct: 95, medianProxyMs: 200, sourceCount: 4 }),
    ];

    const without = service({ rows }).plan();
    const withLearning = service({
      rows,
      adaptive: {
        status: () => adaptiveWith([{ strategyId: 'xray', successProbability: 0.99, confidence: 'high' }]),
        observe: () => undefined,
      },
    }).plan();

    const before = without.candidates.find((c) => c.nodeId === 'a')!;
    const after = withLearning.candidates.find((c) => c.nodeId === 'a')!;

    expect(after.score - before.score).toBeLessThanOrEqual(8);
    // the better-evidenced node still wins: learning is a nudge
    expect(withLearning.chosen?.nodeId).toBe('b');
  });

  it('falls back to evidence when the adaptive layer throws', () => {
    const plan = service({
      adaptive: {
        status: () => {
          throw new Error('settings store unavailable');
        },
        observe: () => undefined,
      },
    }).plan();

    expect(plan.candidates).toHaveLength(1);
    expect(plan.adaptive.note).toContain('threw');
  });

  it('says to refresh when nothing is stored, and to stay disconnected when all filtered out', () => {
    const empty = service({ rows: [] }).plan();
    expect(empty.chosen).toBeNull();
    expect(empty.decision).toContain('Refresh a source');

    const filtered = service({ rows: [row({ status: 'revoked' })] }).plan();
    expect(filtered.chosen).toBeNull();
    expect(filtered.decision.toLowerCase()).toContain('stay disconnected');
  });

  it('names the dominant filter when the list is empty instead of blaming the configs', () => {
    // A live run with no core installed said "stale, failing, revoked, or
    // unsupported" while every row was blocked by a missing engine.
    const plan = service({ rows: [row({ id: 'a' }), row({ id: 'b' })], engines: [] }).plan();
    expect(plan.chosen).toBeNull();
    expect(plan.decision).toContain('no local proxy core is installed');
    expect(plan.decision).not.toContain('stale');
  });

  it('explains stale evidence as a refresh problem, not a permanent verdict', () => {
    const plan = service({
      rows: [row({ id: 'a', freshness: 'stale', testCount: 3, lastSuccessAt: NOW - 48 * HOUR, lastValidated: NOW - 48 * HOUR })],
    }).plan();
    expect(plan.decision).toContain('stale test evidence');
    expect(plan.decision).toContain('Refresh a source');
  });

  it('marks evidence older than the verified window as tested, not verified', () => {
    const plan = service({
      rows: [row({ lastSuccessAt: NOW - VERIFIED_WINDOW - MIN })],
    }).plan();
    expect(plan.candidates[0]!.confidence).toBe('tested');
    expect(plan.candidates[0]!.trust).toBe('RECENTLY_RELIABLE');
  });
});

describe('SmartConnect verify', () => {
  it('stops launching probes once a candidate carries traffic, and learns every attempt', async () => {
    const probe = vi.fn(async () => okProbe());
    const observe = vi.fn();
    const result = await service({
      rows: [row({ id: 'first' }), row({ id: 'second' })],
      probe,
      adaptive: { status: () => adaptiveWith([]), observe },
    }).verify({ maxProbes: 3, concurrency: 2 });

    expect(result.verified).toBe(true);
    // The pool had already dialled its second slot when the first succeeded, so
    // that attempt is paid for and its evidence is kept — asserted, not hidden.
    expect(result.probesRun).toBe(2);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(result.chosen?.nodeId).toBe('first');
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'first', ok: true }));
  });

  it('moves to the next candidate when the first fails, and records the failure', async () => {
    const observe = vi.fn();
    const seen: string[] = [];
    const result = await service({
      rows: [row({ id: 'a' }), row({ id: 'b' })],
      probe: async (nodeId) => {
        seen.push(nodeId);
        return nodeId === 'a' ? badProbe() : okProbe(600);
      },
      adaptive: { status: () => adaptiveWith([]), observe },
    }).verify({ maxProbes: 2, concurrency: 2 });

    expect(result.verified).toBe(true);
    expect(result.probesRun).toBe(2);
    expect(result.chosen?.nodeId).toBe('b');
    expect(seen).toEqual(['a', 'b']);
    // Settlement order is a race, so assert the set of observations, not a
    // sequence that only holds when probes happen to finish in launch order.
    const outcomes = new Map(
      observe.mock.calls.map((c) => [c[0].nodeId as string, c[0].ok as boolean]),
    );
    expect(outcomes.get('a')).toBe(false);
    expect(outcomes.get('b')).toBe(true);
  });

  it('stays disconnected when every probe fails, without promoting a stored score', async () => {
    const result = await service({
      rows: [row({ id: 'a', score: 90 }), row({ id: 'b', score: 85 })],
      probe: async () => badProbe('connection reset'),
    }).verify({ maxProbes: 2 });

    expect(result.verified).toBe(false);
    expect(result.chosen).toBeNull();
    expect(result.decision).toContain('Staying disconnected');
    expect(result.candidates.every((c) => c.probe?.verified !== true)).toBe(true);
  });

  it('treats an out-of-band HTTP status as not verified', async () => {
    const result = await service({
      probe: async () => ({ ...okProbe(), httpStatus: 502 }),
    }).verify({ maxProbes: 1 });
    expect(result.verified).toBe(false);
    expect(result.chosen).toBeNull();
  });

  it('does not dial when no probe capability exists', async () => {
    const result = await service({ rows: [row()] }).verify();
    expect(result.probesRun).toBe(0);
    expect(result.verified).toBe(false);
    expect(result.decision).toContain('No proxy core probe');
  });

  it('respects the probe budget', async () => {
    const probe = vi.fn(async () => badProbe());
    const rows = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' }), row({ id: 'd' })];
    const result = await service({ rows, probe }).verify({ maxProbes: 2 });
    expect(result.probesRun).toBe(2);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('does not fail the request when adaptive observation throws', async () => {
    const result = await service({
      probe: async () => okProbe(),
      adaptive: {
        status: () => adaptiveWith([]),
        observe: () => {
          throw new Error('disk full');
        },
      },
    }).verify({ maxProbes: 1 });

    expect(result.verified).toBe(true);
  });

  it('surfaces a thrown probe as a failed attempt rather than an exception', async () => {
    const result = await service({
      probe: async () => {
        throw new Error('core spawn failed');
      },
    }).verify({ maxProbes: 1 });

    expect(result.verified).toBe(false);
    expect(result.candidates[0]?.probe?.error).toContain('core spawn failed');
  });

  // ---- bounded concurrent pool -------------------------------------------

  /** Track high-water-mark concurrency without depending on wall-clock timing. */
  function tracked<T>(fn: (nodeId: string) => Promise<T>) {
    const stats = { inFlight: 0, max: 0, calls: 0 };
    return {
      stats,
      probe: async (nodeId: string): Promise<T> => {
        stats.calls += 1;
        stats.inFlight += 1;
        stats.max = Math.max(stats.max, stats.inFlight);
        try {
          return await fn(nodeId);
        } finally {
          stats.inFlight -= 1;
        }
      },
    };
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('keeps exactly one dial in flight when concurrency is 1', async () => {
    const t = tracked(async () => okProbe());
    const rows = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })];
    const result = await service({ rows, probe: t.probe }).verify({ maxProbes: 3, concurrency: 1 });

    expect(t.stats.max).toBe(1);
    expect(result.probesRun).toBe(1);
    expect(result.chosen?.nodeId).toBe('a');
  });

  it('runs up to `concurrency` probes at once and keeps the pool full while nothing verifies', async () => {
    const t = tracked(async () => {
      await sleep(5);
      return badProbe('dead');
    });
    const rows = ['a', 'b', 'c', 'd', 'e'].map((id) => row({ id }));
    const result = await service({ rows, probe: t.probe }).verify({ maxProbes: 5, concurrency: 3 });

    expect(t.stats.max).toBe(3);
    expect(result.probesRun).toBe(5);
    expect(t.stats.calls).toBe(5);
    expect(result.verified).toBe(false);
  });

  it('prefers rank order over finish order when several probes succeed', async () => {
    const probe = async (nodeId: string) => {
      // The better-ranked node answers last, the way a slower but closer
      // endpoint would. The winner must still be the higher-ranked one.
      await sleep(nodeId === 'best' ? 25 : 1);
      return okProbe(nodeId === 'best' ? 900 : 120);
    };
    // Ranked on evidence, not on `score`: the better node has more successful
    // tests and a lower stored latency, so it is first in the queue.
    const rows = [
      row({ id: 'best', reliabilityPct: 96, successCount: 19, testCount: 20, failureCount: 1, medianProxyMs: 240 }),
      row({ id: 'worse', reliabilityPct: 61, successCount: 6, testCount: 10, failureCount: 4, medianProxyMs: 1_400 }),
    ];
    const result = await service({ rows, probe }).verify({ maxProbes: 2, concurrency: 2 });

    expect(result.verified).toBe(true);
    expect(result.chosen?.nodeId).toBe('best');
    expect(result.probesRun).toBe(2);
  });

  it('clamps concurrency to the hard ceiling even when asked for more', async () => {
    const t = tracked(async () => {
      await sleep(5);
      return badProbe('dead');
    });
    const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => row({ id }));
    await service({ rows, probe: t.probe }).verify({ maxProbes: 6, concurrency: 10 });

    expect(t.stats.max).toBe(MAX_CONCURRENCY);
  });

  it('trains on a whole batch and learns from failures too, not just the winner', async () => {
    const observe = vi.fn();
    const probe = vi.fn(async (nodeId: string) =>
      nodeId === 'dead' ? badProbe('refused') : okProbe(300),
    );
    const rows = [row({ id: 'ok1' }), row({ id: 'dead' }), row({ id: 'ok2' })];
    const result = await service({
      rows,
      probe,
      adaptive: { status: () => adaptiveWith([]), observe },
    }).train({ size: 3, concurrency: 2 });

    // Unlike verify, training must not stop at the first success: the failures
    // are the majority of public nodes and they are the signal the model needs.
    expect(result.attempted).toBe(3);
    expect(result.verified).toBe(2);
    expect(result.failed).toBe(1);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(observe).toHaveBeenCalledTimes(3);
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'dead', ok: false }));
    expect(result.byEngine['xray']).toEqual({ attempted: 3, verified: 2 });
  });

  it('records the probability the model assigned, so calibration can be scored', async () => {
    const observe = vi.fn();
    const result = await service({
      rows: [row({ id: 'a' }), row({ id: 'b' })],
      probe: async () => badProbe('dead'),
      adaptive: {
        status: () => adaptiveWith([{ strategyId: 'xray', successProbability: 0.82, confidence: 'high' }]),
        observe,
      },
    }).train({ size: 2, concurrency: 2 });

    expect(result.attempted).toBe(2);
    expect(observe).toHaveBeenCalledTimes(2);
    for (const call of observe.mock.calls) {
      expect(call[0].predicted).toBe(0.82);
    }
  });

  it('leaves the prediction null when the model had no confident view', async () => {
    const observe = vi.fn();
    await service({
      rows: [row({ id: 'a' })],
      probe: async () => okProbe(),
      adaptive: {
        status: () => adaptiveWith([{ strategyId: 'xray', successProbability: 0.7, confidence: 'none' }]),
        observe,
      },
    }).train({ size: 1 });

    expect(observe.mock.calls[0]![0].predicted).toBeNull();
  });

  it('caps a training batch at the hard probe ceiling', async () => {
    const probe = vi.fn(async () => badProbe('dead'));
    const rows = Array.from({ length: 14 }, (_, i) => row({ id: `n${i}` }));
    const result = await service({ rows, probe }).train({ size: 50, concurrency: 9 });

    expect(result.attempted).toBe(MAX_PROBES);
    expect(probe).toHaveBeenCalledTimes(MAX_PROBES);
  });

  it('launches nothing new after a hit, even with a long queue', async () => {
    const t = tracked(async () => {
      await sleep(5);
      return okProbe();
    });
    const rows = Array.from({ length: 6 }, (_, i) => row({ id: `n${i}` }));
    const result = await service({ rows, probe: t.probe }).verify({ maxProbes: 6, concurrency: 2 });

    expect(result.verified).toBe(true);
    expect(result.chosen?.nodeId).toBe('n0');
    expect(result.probesRun).toBe(2);
    expect(t.stats.calls).toBe(2);
  });
});
