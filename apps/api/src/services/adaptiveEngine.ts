import {
  applyManifestPolicy,
  applyObservation,
  censorshipHintOf,
  classifyConnectFailure,
  contextBucketOf,
  describeContextBucket,
  emptyAdaptiveState,
  parseAdaptiveState,
  rankStrategies,
  resetAdaptiveState,
  serializeAdaptiveState,
  strategyAllowed,
  strategyIdFor,
  summarizeState,
  verifyAdaptiveManifest,
  DEFAULT_ADAPTIVE_POLICY,
  type AdaptiveContextSignals,
  type AdaptiveDecision,
  type AdaptiveManifestEnvelope,
  type AdaptiveObservation,
  type AdaptivePolicyOptions,
  type AdaptiveState,
  type AdaptiveStateRow,
  type AdaptiveStrategy,
  type AppliedManifest,
  type ConnectFailureInput,
  type FailureKind,
  type ManifestCheck,
  type ParsedNodeConfig,
  type ProxyEngineId,
  type ScanProfileId,
} from '@netpulse/shared';

import { engineSupports, engineSupportsConfig, findEngineBinary, PROXY_ENGINE_ORDER } from './proxyCores';

import type { Logger } from '../logger';
import type { RealtimeBus } from '../realtime/bus';

/**
 * The adaptive engine — the only place that can change HOW the app connects
 * based on what it observed, and the place that keeps that change small.
 *
 * What it is allowed to decide: which of the ALREADY INSTALLED and ALREADY
 * COMPATIBLE local cores to prefer for the next attempt. Nothing else. It cannot
 * add a core, add a node, add a hostname, change a credential, or turn a research
 * idea into a running configuration — those are code changes with their own
 * review (see `packages/shared/src/adaptive/candidates.ts`).
 *
 * Three properties this file is responsible for keeping true:
 *
 *  1. **The strategy list is derived from the machine, not from learning.** Every
 *     candidate comes from `findEngineBinary` (the core is really on disk) plus
 *     the SAME `engineSupports` / `engineSupportsConfig` predicates the tunnel
 *     itself uses to pick a core. There is no second, drifting opinion about what
 *     can dial what.
 *
 *  2. **Observation means a verified tunnel.** `observe()` is only fed outcomes
 *     where a tunnel reached the internet (or provably did not) — a started core
 *     is not a success, and the caller passes the verification result, not the
 *     fact that a process exists.
 *
 *  3. **Learning stays on this machine.** The state is a value in the local
 *     settings table, it holds counts and timings only, and nothing in it
 *     identifies a network, a server or a user. `reset()` deletes it.
 */

/** Local settings key. Kept next to `gatewayMemory`, which uses the same store. */
const STATE_KEY = 'adaptiveLearning';
const MANIFEST_KEY = 'adaptivePolicyManifest';

/** Minimal key-value persistence seam; `SettingsRepository` satisfies it. */
export interface AdaptiveStore {
  get(key: string): Record<string, unknown> | null;
  put(key: string, value: Record<string, unknown>): void;
}

export interface AdaptiveEngineDeps {
  store: AdaptiveStore;
  settings: { get(): { adaptive?: { enabled?: boolean; exploration?: boolean }; vpn?: { scanProfile?: ScanProfileId; dnsThroughVpn?: boolean } } };
  log?: Logger;
  bus?: RealtimeBus;
  events?: { record(level: 'info' | 'warn' | 'error', category: string, message: string, data?: Record<string, unknown>): void };
  /** Which cores are installed. Injectable so tests can present a machine. */
  installedEngines?: () => ProxyEngineId[];
  /** Injectable clock, so decay and windows are assertable. */
  now?: () => number;
  /** Signature check for policy manifests. Node passes node:crypto; tests pass their own. */
  verifySignature?: (message: string, signatureBase64: string) => boolean;
  /** The key id this build trusts for policy updates. */
  trustedKeyId?: string;
  appVersion?: string;
}

export interface AdaptiveAttemptOutcome {
  nodeId: string;
  engine: ProxyEngineId;
  /** the context this attempt was taken under (from `plan`, or derived here) */
  context?: string;
  /** a tunnel was VERIFIED to carry traffic (an exit IP was read through it) */
  ok: boolean;
  /** ms to the verified tunnel; ignored for failures */
  timeToWorkingMs?: number | null;
  /** raw failure description; classified here */
  failure?: (ConnectFailureInput & { reasonCode?: string }) | null;
}

export interface AdaptivePlan {
  status: 'active' | 'disabled' | 'no-approved-strategy';
  context: string;
  contextSummary: string;
  /** ordered engine preference; empty when the caller should use its own order */
  order: ProxyEngineId[];
  decisions: AdaptiveDecision[];
  /** the first, non-exploratory choice — what to try first */
  preferred: ProxyEngineId | null;
  /** the single choice that exists to learn something (null when none) */
  exploratory: AdaptiveDecision | null;
  /** one honest sentence for the log/UI */
  note: string;
  signals: AdaptiveContextSignals;
}

export interface AdaptiveStatus {
  enabled: boolean;
  exploration: boolean;
  policy: AdaptivePolicyOptions;
  stateVersion: number;
  entries: AdaptiveStateRow[];
  observationsKept: number;
  /** coarse context the engine would use right now, and what it means */
  context: string;
  contextSummary: string;
  signals: AdaptiveContextSignals;
  /** strategies this machine may actually use, with why each is or is not allowed */
  strategies: Array<{ id: string; engine: ProxyEngineId; approved: boolean; reason: string | null }>;
  censorshipHint: ReturnType<typeof censorshipHintOf>;
  lastResetAt: number | null;
  updatedAt: number | null;
  manifest: {
    installed: AppliedManifest | null;
    previousVersion: number | null;
    keyId: string | null;
  };
}

/** Strategies this machine can actually use right now. */
function approvedStrategiesFrom(
  installed: readonly ProxyEngineId[],
  config: ParsedNodeConfig,
  dnsThroughTunnel: boolean,
  applied: AppliedManifest | null,
): AdaptiveStrategy[] {
  const out: AdaptiveStrategy[] = [];
  for (const engine of PROXY_ENGINE_ORDER) {
    if (!installed.includes(engine)) continue;
    if (!engineSupports(engine, config.protocol)) continue;
    if (!engineSupportsConfig(engine, config).ok) continue;
    const id = strategyIdFor(engine, dnsThroughTunnel);
    if (!strategyAllowed(id, applied).allowed) continue;
    out.push({ id, engine, dnsThroughTunnel, label: labelFor(engine, dnsThroughTunnel) });
  }
  return out;
}

function labelFor(engine: ProxyEngineId, dnsThroughTunnel: boolean): string {
  const name =
    engine === 'xray' ? 'Xray-core' : engine === 'sing-box' ? 'sing-box' : engine === 'v2ray' ? 'V2Ray-core' : 'Hysteria2';
  return dnsThroughTunnel ? `${name} · DNS through tunnel` : name;
}

export class AdaptiveEngine {
  private cache: AdaptiveState | null = null;
  private manifestCache: { applied: AppliedManifest | null; previous: AppliedManifest | null } | null = null;

  constructor(private readonly deps: AdaptiveEngineDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /* --------------------------------- policy -------------------------------- */

  /** Effective policy bounds: the defaults, plus a verified update's clamped patch. */
  policy(): AdaptivePolicyOptions {
    const manifest = this.manifest();
    return manifest.applied ? manifest.applied.options : { ...DEFAULT_ADAPTIVE_POLICY };
  }

  enabled(): boolean {
    return this.deps.settings.get().adaptive?.enabled !== false;
  }

  explorationEnabled(): boolean {
    const settings = this.deps.settings.get();
    if (settings.adaptive?.exploration !== true) return false;
    // A policy update may reduce exploration to zero; it may never force it on.
    return this.policy().explorationShare > 0;
  }

  installedEngines(): ProxyEngineId[] {
    if (this.deps.installedEngines) return this.deps.installedEngines();
    return PROXY_ENGINE_ORDER.filter((engine) => findEngineBinary(engine) !== null);
  }

  /* ---------------------------------- state -------------------------------- */

  state(): AdaptiveState {
    if (this.cache) return this.cache;
    try {
      const raw = this.deps.store.get(STATE_KEY);
      const parsed = parseAdaptiveState(raw, this.policy());
      for (const warning of parsed.warnings) this.deps.log?.warn(`adaptive learning state: ${warning}`);
      this.cache = parsed.state;
    } catch (err) {
      this.deps.log?.warn(`adaptive learning state unreadable, starting empty: ${message(err)}`);
      this.cache = emptyAdaptiveState(this.now());
    }
    return this.cache;
  }

  private persist(state: AdaptiveState): void {
    this.cache = state;
    try {
      this.deps.store.put(STATE_KEY, serializeAdaptiveState(state) as unknown as Record<string, unknown>);
    } catch (err) {
      // Learning still works for this process; a failed write costs the user
      // nothing but a colder start next time.
      this.deps.log?.warn(`adaptive learning state write failed: ${message(err)}`);
    }
  }

  /** Delete everything learned. This is the "clear local learning data" action. */
  reset(): AdaptiveState {
    const state = resetAdaptiveState(this.now());
    this.persist(state);
    this.deps.events?.record('info', 'vpn', 'Adaptive connection learning data was cleared');
    return state;
  }

  /* --------------------------------- context ------------------------------- */

  /**
   * The coarse context, derived from what the app itself just observed.
   *
   * This is why no network fingerprinting is needed: the signals are outcomes of
   * previous attempts (a DNS failure, a TLS failure, a successful relay), plus
   * the user's own scan profile. Nothing here is an address or an identifier.
   */
  signals(profile?: ScanProfileId): AdaptiveContextSignals {
    const state = this.state();
    const now = this.now();
    const windowMs = 30 * 60 * 1000;
    const recent = state.observations.filter((o) => now - o.at <= windowMs);

    const failing = (kind: FailureKind): boolean => recent.some((o) => !o.ok && o.failureKind === kind);
    const lastSuccess = [...recent].reverse().find((o) => o.ok);

    return {
      dnsFailing: failing('dns'),
      tlsFailing: failing('transport'),
      relayWorked: Boolean(lastSuccess),
      // IPv6 presence is not measured here: claiming it from nothing would be a
      // guess, and this field exists to keep the bucket honest, not decorative.
      ipv6: false,
      profile: profile ?? this.deps.settings.get().vpn?.scanProfile ?? 'balanced',
    };
  }

  /** Is a strategy allowed by the active policy update (revocation outranks evidence)? */
  strategyAllowed(id: string): { allowed: true } | { allowed: false; reason: string } {
    return strategyAllowed(id, this.manifest().applied);
  }

  /* --------------------------------- decision ------------------------------ */

  /**
   * Order the approved strategies for one node under one context.
   *
   * The caller passes its own baseline order — what it would do with no learning
   * at all — and gets back an order and the reasons. With an empty state the
   * returned order IS the baseline order (asserted in the policy tests), so this
   * call cannot make a fresh install behave differently from before.
   */
  plan(input: {
    config: ParsedNodeConfig;
    /**
     * The caller's own order — the engines it would try with no learning at all,
     * exactly as the tunnel would pick them.
     *
     * Engines, not strategy ids: the caller has no business knowing how a strategy
     * is keyed, and the ranking compares strategy ids. The translation happens
     * here, once, with the SAME `dnsThroughTunnel` flag the strategies were built
     * with — otherwise the baseline lookup would miss, every strategy would look
     * equally "not in the baseline list", and the tie-break would quietly reorder
     * a fresh install alphabetically instead of leaving it alone. That is a real
     * bug this line exists to prevent (it is asserted in the engine tests).
     */
    baselineOrder: readonly ProxyEngineId[];
    profile?: ScanProfileId;
    attemptBudget?: number;
  }): AdaptivePlan {
    const signals = this.signals(input.profile);
    const context = contextBucketOf(signals);
    const dnsThroughTunnel = this.deps.settings.get().vpn?.dnsThroughVpn !== false;
    const strategies = approvedStrategiesFrom(
      this.installedEngines(),
      input.config,
      dnsThroughTunnel,
      this.manifest().applied,
    );

    if (!this.enabled()) {
      return {
        status: 'disabled',
        context,
        contextSummary: describeContextBucket(context),
        order: [],
        decisions: [],
        preferred: null,
        exploratory: null,
        note: 'Adaptive ordering is switched off — the default engine order is used.',
        signals,
      };
    }

    if (strategies.length === 0) {
      return {
        status: 'no-approved-strategy',
        context,
        contextSummary: describeContextBucket(context),
        order: [],
        decisions: [],
        preferred: null,
        exploratory: null,
        note: 'No installed core can dial this configuration, so the engine has nothing to decide.',
        signals,
      };
    }

    const decisions = rankStrategies({
      state: this.state(),
      context,
      strategies,
      baselineOrder: input.baselineOrder.map((engine) => strategyIdFor(engine, dnsThroughTunnel)),
      now: this.now(),
      options: { ...this.policy(), explorationShare: this.explorationEnabled() ? this.policy().explorationShare : 0 },
      ...(input.attemptBudget != null ? { attemptBudget: input.attemptBudget } : {}),
    });

    const exploratory = decisions.find((d) => d.exploratory) ?? null;
    const first = decisions.find((d) => !d.exploratory) ?? null;
    const learned = decisions.some((d) => d.reason === 'learned-best' || d.reason === 'learned-lower');

    return {
      status: 'active',
      context,
      contextSummary: describeContextBucket(context),
      order: decisions.map((d) => d.engine),
      decisions,
      preferred: first?.engine ?? null,
      exploratory,
      note: learned
        ? `Adaptive order under ${describeContextBucket(context)}: ${decisions
            .slice(0, 3)
            .map((d) => `${d.engine} (${Math.round(d.successProbability * 100)}%)`)
            .join(' → ')}.`
        : `No usable evidence under ${describeContextBucket(context)} yet — the default engine order is kept.`,
      signals,
    };
  }

  /* -------------------------------- observation ---------------------------- */

  /**
   * Fold one real attempt into the state.
   *
   * `ok` MUST come from the tunnel's own verification (an exit IP read through
   * the tunnel), never from "the core started". A failure is classified here, and
   * the classification never concludes censorship.
   */
  observe(outcome: AdaptiveAttemptOutcome): AdaptiveObservation {
    const at = this.now();
    const context = outcome.context ?? contextBucketOf(this.signals());
    const strategyId = strategyIdFor(outcome.engine, this.deps.settings.get().vpn?.dnsThroughVpn !== false);

    const verdict = outcome.ok
      ? null
      : classifyConnectFailure(outcome.failure ?? { stage: 'verify', message: 'tunnel did not carry traffic' });

    const observation: AdaptiveObservation = {
      at,
      context,
      strategyId,
      ok: outcome.ok,
      timeToWorkingMs: outcome.ok && outcome.timeToWorkingMs != null ? outcome.timeToWorkingMs : null,
      failureKind: verdict?.kind ?? null,
      // A caller that already classified the failure (the tunnel knows which
      // stage it failed at) keeps its own, more specific code.
      reasonCode: outcome.failure?.reasonCode ?? verdict?.reasonCode ?? null,
    };

    try {
      this.persist(applyObservation(this.state(), observation, this.policy()));
      if (!outcome.ok && verdict) {
        this.deps.log?.info(`adaptive: ${strategyId} failed under ${context} (${verdict.kind}/${verdict.reasonCode})`);
      }
    } catch (err) {
      this.deps.log?.warn(`adaptive observation not stored: ${message(err)}`);
    }

    return observation;
  }

  /** Failures classified the same way a stored observation was, for the log line. */
  classify(failure: ConnectFailureInput): { kind: FailureKind; reasonCode: string; explanation: string } {
    const verdict = classifyConnectFailure(failure);
    return { kind: verdict.kind, reasonCode: verdict.reasonCode, explanation: verdict.explanation };
  }

  /* ---------------------------------- status ------------------------------- */

  status(profile?: ScanProfileId, sampleConfig?: ParsedNodeConfig): AdaptiveStatus {
    const state = this.state();
    const now = this.now();
    const signals = this.signals(profile);
    const context = contextBucketOf(signals);
    const applied = this.manifest().applied;

    return {
      enabled: this.enabled(),
      exploration: this.explorationEnabled(),
      policy: this.policy(),
      stateVersion: state.version,
      entries: summarizeState(state, now, this.policy()),
      observationsKept: state.observations.length,
      context,
      contextSummary: describeContextBucket(context),
      signals,
      strategies: sampleConfig
        ? PROXY_ENGINE_ORDER.map((engine) => {
            const installed = this.installedEngines().includes(engine);
            const id = strategyIdFor(engine, this.deps.settings.get().vpn?.dnsThroughVpn !== false);
            const allowed = strategyAllowed(id, applied);
            const configOk = engineSupports(engine, sampleConfig.protocol) ? engineSupportsConfig(engine, sampleConfig) : { ok: false as const, error: `this core cannot dial ${sampleConfig.protocol}` };
            const reason = !installed
              ? 'not installed on this machine'
              : !configOk.ok
                ? configOk.error
                : !allowed.allowed
                  ? allowed.reason
                  : null;
            return { id, engine, approved: installed && configOk.ok && allowed.allowed, reason };
          })
        : [],
      censorshipHint: censorshipHintOf(state.observations, now),
      lastResetAt: state.resetAt,
      updatedAt: state.entries.length > 0 ? state.updatedAt : null,
      manifest: {
        installed: applied,
        previousVersion: this.manifest().previous?.version ?? null,
        keyId: this.manifestKeyId(),
      },
    };
  }

  /* --------------------------------- manifest ------------------------------ */

  private manifest(): { applied: AppliedManifest | null; previous: AppliedManifest | null } {
    if (this.manifestCache) return this.manifestCache;
    try {
      const raw = this.deps.store.get(MANIFEST_KEY);
      this.manifestCache = {
        applied: (raw?.['applied'] as AppliedManifest | undefined) ?? null,
        previous: (raw?.['previous'] as AppliedManifest | undefined) ?? null,
      };
    } catch {
      this.manifestCache = { applied: null, previous: null };
    }
    return this.manifestCache;
  }

  private manifestKeyId(): string | null {
    try {
      const raw = this.deps.store.get(MANIFEST_KEY);
      return typeof raw?.['keyId'] === 'string' ? raw['keyId'] : null;
    } catch {
      return null;
    }
  }

  /**
   * Verify, vet and install one signed policy update.
   *
   * Nothing is applied unless the signature verifies against the pinned key,
   * the manifest is current, compatible and on an accepted channel, and it
   * carries a higher version than the installed one. The previous manifest is
   * retained so a rollback is available.
   */
  installManifest(envelope: unknown, opts: { acceptChannels?: readonly ('test' | 'production')[]; appVersion?: string } = {}): {
    ok: boolean;
    code: string;
    reason: string;
    applied?: AppliedManifest;
  } {
    const verify = this.deps.verifySignature;
    const keyId = this.deps.trustedKeyId;
    if (!verify || !keyId) {
      return { ok: false, code: 'no-trust-anchor', reason: 'this build has no policy signing key configured, so no update can be verified' };
    }

    const installed = this.manifest();
    const check: ManifestCheck = verifyAdaptiveManifest(envelope, {
      trustedKeyId: keyId,
      verify,
      now: this.now(),
      appVersion: opts.appVersion ?? this.deps.appVersion ?? null,
      stateVersion: this.state().version,
      acceptChannels: opts.acceptChannels ?? ['production'],
      currentVersion: installed.applied?.version ?? null,
    });
    if (!check.ok) {
      this.deps.events?.record('warn', 'vpn', `Adaptive policy update refused: ${check.reason}`, { code: check.code });
      return { ok: false, code: check.code, reason: check.reason };
    }

    const applied = applyManifestPolicy(check.payload);
    this.manifestCache = { applied, previous: installed.applied };
    try {
      this.deps.store.put(MANIFEST_KEY, {
        keyId: (envelope as AdaptiveManifestEnvelope).keyId,
        version: applied.version,
        applied: applied as unknown as Record<string, unknown>,
        previous: (installed.applied ?? undefined) as unknown as Record<string, unknown> | undefined,
      });
    } catch (err) {
      this.deps.log?.warn(`adaptive policy manifest not persisted: ${message(err)}`);
    }
    this.deps.events?.record('info', 'vpn', `Adaptive policy update ${applied.version} installed`, {
      changed: applied.applied,
      refused: applied.refused,
    });
    return { ok: true, code: 'installed', reason: `policy update ${applied.version} installed`, applied };
  }

  /** Restore the previously installed policy update. */
  rollbackManifest(): { ok: boolean; reason: string; applied: AppliedManifest | null } {
    const { applied, previous } = this.manifest();
    if (!previous) return { ok: false, reason: 'no previous policy update is stored, so there is nothing to roll back to', applied };
    const restored: AppliedManifest = { ...previous, rolledBackFrom: applied?.version ?? null };
    this.manifestCache = { applied: restored, previous: null };
    try {
      this.deps.store.put(MANIFEST_KEY, {
        keyId: this.manifestKeyId(),
        version: restored.version,
        applied: restored as unknown as Record<string, unknown>,
        previous: undefined,
      });
    } catch (err) {
      this.deps.log?.warn(`adaptive policy rollback not persisted: ${message(err)}`);
    }
    this.deps.events?.record('warn', 'vpn', `Adaptive policy update rolled back to ${restored.version}`);
    return { ok: true, reason: `restored policy update ${restored.version}`, applied: restored };
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
