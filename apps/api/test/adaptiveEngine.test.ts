import { describe, expect, it } from 'vitest';

import {
  ADAPTIVE_MANIFEST_LIMITS,
  ADAPTIVE_STATE_VERSION,
  canonicalManifestPayload,
} from '@netpulse/shared';
import { AdaptiveEngine } from '../src/services/adaptiveEngine';
import {
  createEd25519Verifier,
  generatePolicyKeyPair,
  parseEd25519PublicKey,
  signAdaptivePayload,
} from '../src/services/adaptiveManifestTrust';

import type { AdaptiveManifestPayload, ParsedNodeConfig, ProxyEngineId } from '@netpulse/shared';
import type { AdaptiveEngineDeps } from '../src/services/adaptiveEngine';

/**
 * The adaptive engine, against a scripted machine.
 *
 * What these tests defend, in order of importance:
 *
 *  1. **A fresh install behaves exactly as before.** With no evidence the engine
 *     returns the caller's own baseline order, which is why it can ship enabled.
 *  2. **Learning comes only from verified outcomes.** `observe()` is the only way
 *     evidence enters, a failure can never be stored as a success, and the
 *     preferred core is the one that really carried traffic more often.
 *  3. **Nothing is invented.** Only cores that are installed, that can dial THIS
 *     configuration, and that are not revoked by a signed policy update can
 *     appear in an order — the list comes from the same predicates the tunnel
 *     dials with, injected here to describe a machine.
 *  4. **No failure is reported as censorship.** A single kind of failure, however
 *     often it repeats on one strategy, is not a pattern; a hint needs distinct
 *     strategies and still says "pattern, not a diagnosis".
 *  5. **A policy update is authenticated, versioned, revocable and reversible** —
 *     and refused with a stable code otherwise.
 */

const VLESS_TLS: ParsedNodeConfig = {
  protocol: 'vless',
  host: 'node.adaptive-test.net',
  port: 443,
  transport: 'tcp',
  security: 'tls',
  sni: 'www.example.com',
};

const HYSTERIA2: ParsedNodeConfig = {
  protocol: 'hysteria2',
  host: 'hy2.adaptive-test.net',
  port: 8443,
  transport: 'udp',
  security: 'tls',
  sni: 'hy2.adaptive-test.net',
};

const BASELINE: ProxyEngineId[] = ['xray', 'sing-box'];

function store(): AdaptiveEngineDeps['store'] & { rows: Record<string, Record<string, unknown>> } {
  const rows: Record<string, Record<string, unknown>> = {};
  return {
    rows,
    get: (key) => rows[key] ?? null,
    put: (key, value) => {
      rows[key] = value;
    },
  };
}

function engineWith(overrides: Partial<AdaptiveEngineDeps> = {}, installed: ProxyEngineId[] = ['xray', 'sing-box']) {
  const rows = store();
  const engine = new AdaptiveEngine({
    store: rows,
    settings: { get: () => ({ adaptive: { enabled: true, exploration: false }, vpn: { scanProfile: 'balanced', dnsThroughVpn: true } }) },
    installedEngines: () => installed,
    ...overrides,
  });
  return { engine, rows };
}

/** A failure that is not DNS- or TLS-shaped, so the context bucket stays stable. */
const NOT_VERIFIED = { stage: 'verify' as const, message: 'the core started but no exit IP was read through it' };

describe('adaptive engine — ordering from observed outcomes', () => {
  it('keeps the caller baseline order when nothing has been observed', () => {
    const { engine } = engineWith();
    const plan = engine.plan({ config: VLESS_TLS, baselineOrder: BASELINE, attemptBudget: 2 });
    expect(plan.status).toBe('active');
    expect(plan.order).toEqual(['xray', 'sing-box']);
    expect(plan.decisions.every((d) => d.reason === 'no-evidence-baseline-order' || d.reason === 'insufficient-evidence')).toBe(true);
    expect(plan.note).toMatch(/default engine order/i);
  });

  it('prefers the core that really carried traffic, under the same context', () => {
    const { engine } = engineWith();
    // Successes first: a relay that worked is part of the context bucket, and the
    // failures below are deliberately not DNS/TLS shaped so the bucket is stable.
    for (let i = 0; i < 6; i += 1) {
      engine.observe({ nodeId: 'node:1', engine: 'sing-box', ok: true, timeToWorkingMs: 900 });
      engine.observe({ nodeId: 'node:1', engine: 'xray', ok: false, failure: NOT_VERIFIED });
    }

    const plan = engine.plan({ config: VLESS_TLS, baselineOrder: BASELINE, attemptBudget: 2 });
    expect(plan.preferred).toBe('sing-box');
    expect(plan.order[0]).toBe('sing-box');
    expect(plan.decisions[0]!.successProbability).toBeGreaterThan(plan.decisions.at(-1)!.successProbability);
    expect(plan.decisions[0]!.confidence).not.toBe('none');
    expect(plan.decisions[0]!.explanation.length).toBeGreaterThan(0);
  });

  it('never puts a core that is not installed into an order', () => {
    const { engine } = engineWith({}, ['sing-box']);
    for (let i = 0; i < 6; i += 1) engine.observe({ nodeId: 'node:1', engine: 'xray', ok: true, timeToWorkingMs: 500 });

    const plan = engine.plan({ config: VLESS_TLS, baselineOrder: BASELINE, attemptBudget: 2 });
    expect(plan.order).toEqual(['sing-box']);
    expect(plan.decisions.some((d) => d.engine === 'xray')).toBe(false);
  });

  it('has nothing to decide when no installed core can dial the configuration', () => {
    const { engine } = engineWith({}, ['v2ray']);
    const plan = engine.plan({ config: HYSTERIA2, baselineOrder: ['v2ray'], attemptBudget: 1 });
    expect(plan.status).toBe('no-approved-strategy');
    expect(plan.order).toEqual([]);
    expect(plan.note).toMatch(/no installed core can dial/i);
  });

  it('defers to the caller order entirely when it is switched off', () => {
    const { engine } = engineWith({
      settings: { get: () => ({ adaptive: { enabled: false }, vpn: { dnsThroughVpn: true } }) },
    });
    for (let i = 0; i < 6; i += 1) engine.observe({ nodeId: 'node:1', engine: 'sing-box', ok: true, timeToWorkingMs: 500 });

    const plan = engine.plan({ config: VLESS_TLS, baselineOrder: BASELINE, attemptBudget: 2 });
    expect(plan.status).toBe('disabled');
    expect(plan.order).toEqual([]);
    expect(plan.preferred).toBeNull();
  });

  it('treats exploration as opt-in and bounded to the attempt budget', () => {
    const { engine, rows } = engineWith();
    for (let i = 0; i < 8; i += 1) {
      engine.observe({ nodeId: 'node:1', engine: 'sing-box', ok: true, timeToWorkingMs: 700 });
      engine.observe({ nodeId: 'node:1', engine: 'xray', ok: false, failure: NOT_VERIFIED });
    }
    expect(engine.plan({ config: VLESS_TLS, baselineOrder: BASELINE, attemptBudget: 2 }).exploratory).toBeNull();

    // Same state, exploration switched on: at most one position may be exploratory.
    const exploring = new AdaptiveEngine({
      store: rows,
      settings: { get: () => ({ adaptive: { enabled: true, exploration: true }, vpn: { dnsThroughVpn: true } }) },
      installedEngines: () => ['xray', 'sing-box'],
    });
    const plan = exploring.plan({ config: VLESS_TLS, baselineOrder: BASELINE, attemptBudget: 2 });
    expect(plan.decisions.filter((d) => d.exploratory).length).toBeLessThanOrEqual(1);
    expect(plan.decisions[0]!.exploratory).toBe(false);
  });

  it('resets: everything learned is deleted, and the baseline order returns', () => {
    const { engine, rows } = engineWith();
    for (let i = 0; i < 6; i += 1) {
      engine.observe({ nodeId: 'node:1', engine: 'sing-box', ok: true, timeToWorkingMs: 700 });
      engine.observe({ nodeId: 'node:1', engine: 'xray', ok: false, failure: NOT_VERIFIED });
    }
    expect(engine.status().entries.length).toBeGreaterThan(0);

    engine.reset();

    expect(engine.status().entries).toEqual([]);
    expect(engine.status().observationsKept).toBe(0);
    expect(engine.status().lastResetAt).not.toBeNull();
    // Persisted, not merely memoized: a restart must not resurrect the evidence.
    expect(rows.rows['adaptiveLearning']).toBeTruthy();
    const reloaded = new AdaptiveEngine({
      store: rows,
      settings: { get: () => ({ adaptive: { enabled: true }, vpn: { dnsThroughVpn: true } }) },
      installedEngines: () => ['xray', 'sing-box'],
    });
    expect(reloaded.plan({ config: VLESS_TLS, baselineOrder: BASELINE, attemptBudget: 2 }).order).toEqual(['xray', 'sing-box']);
  });

  it('starts from no evidence rather than from a corrupt state', () => {
    const rows = store();
    rows.put('adaptiveLearning', { version: 99, entries: 'not-an-array' } as unknown as Record<string, unknown>);
    const engine = new AdaptiveEngine({
      store: rows,
      settings: { get: () => ({ adaptive: { enabled: true }, vpn: { dnsThroughVpn: true } }) },
      installedEngines: () => ['xray', 'sing-box'],
    });
    const plan = engine.plan({ config: VLESS_TLS, baselineOrder: BASELINE, attemptBudget: 2 });
    expect(plan.order).toEqual(['xray', 'sing-box']);
    expect(plan.decisions.length).toBe(2);
  });
});

describe('adaptive engine — observations stay honest', () => {
  it('never turns a failed attempt into a success', () => {
    const { engine } = engineWith();
    const observation = engine.observe({
      nodeId: 'node:1',
      engine: 'xray',
      ok: false,
      timeToWorkingMs: 5_000,
      failure: { stage: 'resolve', message: 'getaddrinfo ENOTFOUND node.adaptive-test.net' },
    });
    expect(observation.ok).toBe(false);
    // A failure carries no time-to-working value, whatever the caller passed.
    expect(observation.timeToWorkingMs).toBeNull();
    expect(observation.failureKind).toBe('dns');
    expect(observation.reasonCode).toBe('dns-resolution-failed');
    expect(JSON.stringify(observation)).not.toMatch(/dpi|censor/i);
  });

  it('states a missing core as a local problem, and a wrong credential as authentication', () => {
    const { engine } = engineWith();
    expect(engine.classify({ stage: 'core-start', engineUnavailable: true, message: 'core binary not found' }).reasonCode).toBe(
      'engine-unavailable',
    );
    expect(engine.classify({ stage: 'verify', message: 'authentication failed: invalid user id' }).reasonCode).toBe('authentication-rejected');
    // A success recorded for the same node/engine is what proves the credential;
    // without it the class stays authentication, not censorship.
    expect(engine.classify({ stage: 'verify', message: 'authentication failed: invalid user id' }).kind).toBe('authentication');
  });

  it('does not call repeated failures on ONE strategy a pattern', () => {
    const { engine } = engineWith();
    for (let i = 0; i < 6; i += 1) {
      engine.observe({
        nodeId: 'node:1',
        engine: 'xray',
        ok: false,
        failure: { stage: 'tls', message: 'TLS handshake timed out after the TCP connection succeeded', tcpReached: true },
      });
    }
    const hint = engine.status().censorshipHint;
    expect(hint.likely).toBe(false);
    expect(hint.distinctStrategies).toBe(1);
    expect(hint.reason).toMatch(/needed before a pattern is worth looking at/i);
  });

  it('suggests a pattern only across distinct strategies, and never as a diagnosis', () => {
    const { engine } = engineWith();
    for (const engineId of ['xray', 'sing-box', 'v2ray'] as ProxyEngineId[]) {
      engine.observe({
        nodeId: 'node:1',
        engine: engineId,
        ok: false,
        failure: { stage: 'tls', message: 'TLS handshake timed out after the TCP connection succeeded', tcpReached: true },
      });
    }
    const hint = engine.status().censorshipHint;
    expect(hint.likely).toBe(true);
    expect(hint.distinctStrategies).toBe(3);
    expect(hint.kind).toBe('transport');
    expect(hint.reason).toMatch(/pattern, not a diagnosis/i);
  });
});

describe('adaptive engine — signed policy updates', () => {
  const key = generatePolicyKeyPair();

  function envelope(
    payload: Partial<AdaptiveManifestPayload>,
    opts: { keyId?: string; privateKey?: unknown; sign?: (message: string) => string } = {},
  ) {
    const full: AdaptiveManifestPayload = {
      kind: 'adaptive-policy',
      version: 2,
      channel: 'production',
      issuedAt: Date.now() - 60_000,
      expiresAt: Date.now() + 86_400_000,
      policy: {},
      strategies: {},
      compatibility: { stateVersions: [ADAPTIVE_STATE_VERSION] },
      revocations: [],
      ...payload,
    };
    const sign = opts.sign ?? ((message: string) => signAdaptivePayload(message, (opts.privateKey as never) ?? key.privateKey));
    return { payload: full, signature: sign(canonicalManifestPayload(full)), keyId: opts.keyId ?? 'adaptive-test-key' };
  }

  function trusted(overrides: Partial<AdaptiveEngineDeps> = {}) {
    return engineWith({
      verifySignature: createEd25519Verifier(key.publicKeyBase64)!,
      trustedKeyId: 'adaptive-test-key',
      appVersion: '1.1.1',
      ...overrides,
    });
  }

  it('refuses every update when this build has no pinned key', () => {
    const { engine } = engineWith();
    const result = engine.installManifest(envelope({}));
    expect(result.ok).toBe(false);
    expect(result.code).toBe('no-trust-anchor');
  });

  it('installs a manifest signed by the pinned key and clamps what it asks for', () => {
    const { engine } = trusted();
    const result = engine.installManifest(envelope({ policy: { explorationShare: 0.9 } }));
    expect(result.ok).toBe(true);
    // The publisher asked for 0.9; the app's hard ceiling is what is applied, and
    // the clamp is reported instead of silently swallowed.
    expect(engine.policy().explorationShare).toBe(ADAPTIVE_MANIFEST_LIMITS.maxExplorationShare);
    expect(result.applied?.refused.join(' ')).toMatch(/explorationShare/);
  });

  it('refuses a signature from another key, and a payload edited after signing', () => {
    const { engine } = trusted();
    const other = generatePolicyKeyPair();
    const wrongKey = engine.installManifest(envelope({}, { privateKey: other.privateKey }));
    expect(wrongKey.ok).toBe(false);
    expect(wrongKey.code).toBe('signature-invalid');

    const signed = envelope({});
    const tampered = { ...signed, payload: { ...signed.payload, revocations: [{ strategyId: 'xray', reason: 'injected', at: Date.now() }] } };
    const edited = engine.installManifest(tampered);
    expect(edited.ok).toBe(false);
    expect(edited.code).toBe('signature-invalid');
  });

  it('refuses an unknown key id, an expired manifest and a future-dated one', () => {
    const { engine } = trusted();
    expect(engine.installManifest(envelope({}, { keyId: 'someone-else' })).code).toBe('key-mismatch');
    expect(engine.installManifest(envelope({ expiresAt: Date.now() - 1_000 })).code).toBe('expired');
    expect(engine.installManifest(envelope({ issuedAt: Date.now() + 3_600_000 })).code).toBe('not-yet-valid');
  });

  it('refuses a test-channel manifest unless this build accepts that channel', () => {
    const { engine } = trusted();
    expect(engine.installManifest(envelope({ channel: 'test' })).code).toBe('channel-refused');
    expect(engine.installManifest(envelope({ channel: 'test' }), { acceptChannels: ['test'] }).ok).toBe(true);
  });

  it('refuses an incompatible app range and state version', () => {
    const { engine } = trusted();
    expect(engine.installManifest(envelope({ compatibility: { minAppVersion: '9.0.0', stateVersions: [ADAPTIVE_STATE_VERSION] } })).code).toBe(
      'incompatible-app',
    );
    expect(engine.installManifest(envelope({ compatibility: { stateVersions: [7] } })).code).toBe('incompatible-state');
  });

  it('refuses a downgrade, then rolls back to the previously installed version', () => {
    const { engine } = trusted();
    expect(engine.installManifest(envelope({ version: 5 })).ok).toBe(true);
    const stale = engine.installManifest(envelope({ version: 5 }));
    expect(stale.ok).toBe(false);
    expect(stale.code).toBe('not-newer');

    expect(engine.installManifest(envelope({ version: 6 })).ok).toBe(true);
    expect(engine.status().manifest.installed?.version).toBe(6);

    const rolledBack = engine.rollbackManifest();
    expect(rolledBack.ok).toBe(true);
    expect(engine.status().manifest.installed?.version).toBe(5);
    expect(engine.status().manifest.installed?.rolledBackFrom).toBe(6);

    // The previous slot is consumed: a second rollback says so rather than
    // pretending it did something.
    expect(engine.rollbackManifest().ok).toBe(false);
  });

  it('takes a revoked strategy out of the approved set, whatever the evidence says', () => {
    const { engine } = trusted();
    const revokedId = 'xray+doh';
    expect(engine.strategyAllowed(revokedId).allowed).toBe(true);

    const result = engine.installManifest(
      envelope({ revocations: [{ strategyId: revokedId, reason: 'breaks IPv6-only networks', at: Date.now() }] }),
    );
    expect(result.ok).toBe(true);

    const verdict = engine.strategyAllowed(revokedId);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toMatch(/revoked/i);

    // Even with plenty of local evidence that it works, it cannot be chosen.
    for (let i = 0; i < 6; i += 1) engine.observe({ nodeId: 'node:1', engine: 'xray', ok: true, timeToWorkingMs: 400 });
    const plan = engine.plan({ config: VLESS_TLS, baselineOrder: BASELINE, attemptBudget: 2 });
    expect(plan.order).not.toContain('xray');
  });

  it('applies an enable-list as a closed set, so a new core cannot appear unreviewed', () => {
    const { engine } = trusted();
    const result = engine.installManifest(envelope({ strategies: { enable: ['sing-box+doh'] } }));
    expect(result.ok).toBe(true);

    const plan = engine.plan({ config: VLESS_TLS, baselineOrder: BASELINE, attemptBudget: 2 });
    expect(plan.order).toEqual(['sing-box']);
  });
});

describe('policy signature trust', () => {
  it('accepts a real Ed25519 signature and rejects a one-bit change', () => {
    const key = generatePolicyKeyPair();
    const verify = createEd25519Verifier(key.publicKeyBase64);
    expect(verify).not.toBeNull();

    const message = '{"kind":"adaptive-policy"}';
    const signature = signAdaptivePayload(message, key.privateKey);
    expect(verify!(message, signature)).toBe(true);
    expect(verify!(message + ' ', signature)).toBe(false);

    const signatureBytes = Buffer.from(signature, 'base64');
    signatureBytes[0] = signatureBytes[0]! ^ 0x01;
    expect(verify!(message, signatureBytes.toString('base64'))).toBe(false);
  });

  it('refuses a build with no key, an unusable key and a wrong-length signature', () => {
    expect(createEd25519Verifier(undefined)).toBeNull();
    expect(createEd25519Verifier('   ')).toBeNull();
    expect(createEd25519Verifier('not-base64-and-wrong-length')).toBeNull();
    expect(parseEd25519PublicKey('AAAA')).toBeNull();

    const key = generatePolicyKeyPair();
    const verify = createEd25519Verifier(key.publicKeyBase64)!;
    expect(verify('message', Buffer.from('short').toString('base64'))).toBe(false);
  });

  it('accepts a PEM public key as well as a raw base64 key', async () => {
    const crypto = await import('node:crypto');
    const key = generatePolicyKeyPair();
    const publicPem = crypto.createPublicKey(key.privateKey).export({ type: 'spki', format: 'pem' }).toString();
    expect(publicPem).toContain('BEGIN PUBLIC KEY');

    const message = '{"kind":"adaptive-policy"}';
    const signature = signAdaptivePayload(message, key.privateKey);
    expect(createEd25519Verifier(publicPem)?.(message, signature)).toBe(true);
  });
});
