import type { AppSettings } from '@netpulse/shared';

import type { Logger } from '../../logger';

/**
 * What the NetPulse discovery agent is allowed to do, and what it is not.
 *
 * The agent is not a general assistant with a shell. It is a fixed set of
 * unattended network actions on the user's own machine:
 *
 *   read local node metadata → fetch a public feed → probe a public endpoint
 *   → record what happened → propose a candidate (never connect to it alone)
 *
 * Everything else a normal agent runtime would offer — running commands, reading
 * credentials, writing settings, installing software, elevating — is listed as
 * FORBIDDEN and refused here, in one place, with a reason. Two properties matter:
 *
 *  1. **Settings can narrow autonomy, never widen capability.** `paused` and the
 *     hourly caps come from user settings; the forbidden list lives in this file.
 *     A corrupted or hostile settings blob cannot grant `exec:shell`, because
 *     there is no code path from settings to a grant.
 *
 *  2. **Every decision is bounded and recorded.** Budgets are counted per hour
 *     per capability, per-call counts are capped, and the last decisions are kept
 *     (with denials also logged) so "what did the AI do on its own" is answerable
 *     without trusting a summary.
 *
 * The enforcement points are the agent's real actions: the scheduled probe
 * batch, the scheduled source refresh, and Smart Connect verification. A user
 * clicking a button is `origin: 'user'` and is only budgeted, never paused.
 */

export type AgentCapability =
  | 'read:local-state'
  | 'network:fetch-source'
  | 'network:probe-endpoint'
  | 'network:verify-traffic'
  | 'write:node-record'
  | 'connect:third-party'
  | 'exec:shell'
  | 'exec:elevated'
  | 'read:credential'
  | 'write:settings'
  | 'install:core';

/** Who asked. Unattended work is 'autonomous'; a button press is 'user'. */
export type AgentOrigin = 'autonomous' | 'user';

/**
 * always     — local bookkeeping, no network, no secret
 * budgeted   — network action, allowed within a per-hour allowance
 * user-only  — only ever on an explicit user action, never unattended
 * forbidden  — no setting and no caller can grant it
 */
export type CapabilityTier = 'always' | 'budgeted' | 'user-only' | 'forbidden';

export interface CapabilitySpec {
  id: AgentCapability;
  tier: CapabilityTier;
  title: string;
  /** what it permits, in the user's terms */
  allows: string;
  /** the bound that actually applies */
  bound: string;
  /** which hourly setting caps it, when budgeted */
  budgetField?: 'fetchPerHour' | 'probesPerHour' | 'verifyPerHour';
  /** hard ceiling on one request, independent of the hourly budget */
  maxPerCall?: number;
}

export const AGENT_CAPABILITIES: readonly CapabilitySpec[] = [
  {
    id: 'read:local-state',
    tier: 'always',
    title: 'Read local node metadata',
    allows: 'the stored node list, its test history and its own learning state',
    bound: 'local only; credential fields are never read',
  },
  {
    id: 'network:fetch-source',
    tier: 'budgeted',
    title: 'Fetch a registered public feed',
    allows: 'download a feed that is already in the source registry',
    bound: 'hourly cap, at most 4 feeds per request, https + registered host only',
    budgetField: 'fetchPerHour',
    maxPerCall: 4,
  },
  {
    id: 'network:probe-endpoint',
    tier: 'budgeted',
    title: 'Probe a public endpoint',
    allows: 'a bounded TCP/TLS or proxy check against a published node',
    bound: 'hourly cap, at most 50 endpoints per batch',
    budgetField: 'probesPerHour',
    maxPerCall: 50,
  },
  {
    id: 'network:verify-traffic',
    tier: 'budgeted',
    title: 'Verify traffic through a candidate',
    allows: 'dial a published candidate through a local core and read an HTTP response',
    bound: 'hourly cap, at most 10 candidates per request',
    budgetField: 'verifyPerHour',
    maxPerCall: 10,
  },
  {
    id: 'write:node-record',
    tier: 'always',
    title: 'Record a probe outcome',
    allows: 'write the test row and counters that follow from an allowed probe',
    bound: 'only downstream of an allowed probe; never a new endpoint',
  },
  {
    id: 'connect:third-party',
    tier: 'user-only',
    title: 'Connect through a third-party node',
    allows: 'open a tunnel to a public node',
    bound: 'explicit user action and privacy acceptance; never unattended, never automatic',
  },
  {
    id: 'exec:shell',
    tier: 'forbidden',
    title: 'Run a shell command',
    allows: 'nothing — there is no such path in the agent',
    bound: 'denied for every caller',
  },
  {
    id: 'exec:elevated',
    tier: 'forbidden',
    title: 'Elevate privileges',
    allows: 'nothing — elevation belongs to a user-approved broker action',
    bound: 'denied for every caller',
  },
  {
    id: 'read:credential',
    tier: 'forbidden',
    title: 'Read configuration secrets',
    allows: 'nothing — the vault is not reachable from agent code',
    bound: 'denied for every caller',
  },
  {
    id: 'write:settings',
    tier: 'forbidden',
    title: 'Change user settings',
    allows: 'nothing — autonomy is adjusted by the user through the settings route',
    bound: 'denied for every caller',
  },
  {
    id: 'install:core',
    tier: 'forbidden',
    title: 'Install or replace an engine',
    allows: 'nothing — engine install is a user-initiated, checksum-verified action',
    bound: 'denied for every caller',
  },
] as const;

export type AgentDecisionCode =
  | 'allowed'
  | 'paused'
  | 'requires-user'
  | 'forbidden'
  | 'budget-exhausted'
  | 'unknown-capability'
  | 'invalid-request';

export interface AgentDecision {
  at: number;
  capability: AgentCapability;
  origin: AgentOrigin;
  allowed: boolean;
  code: AgentDecisionCode;
  reason: string;
  count: number;
  /** allowance left this hour after this decision, when the capability is budgeted */
  remaining: number | null;
  /** free-form caller context (e.g. "scheduled TCP batch"); never a secret */
  detail: string | null;
  /** only set when the denial is expected to clear */
  retryAfterMs: number | null;
}

export interface AgentCapabilityState {
  id: AgentCapability;
  tier: CapabilityTier;
  title: string;
  allows: string;
  bound: string;
  /** what a caller would get right now for an unattended request */
  granted: 'always' | 'granted' | 'paused' | 'user-only' | 'forbidden';
  usedThisHour: number;
  limitPerHour: number | null;
  remaining: number | null;
}

export interface AgentPermissionSnapshot {
  version: number;
  paused: boolean;
  capabilities: AgentCapabilityState[];
  /** most recent decisions, newest last; bounded */
  recent: AgentDecision[];
  /** one honest sentence for the UI */
  note: string;
}

export interface AgentPermissionDeps {
  settings: () => AppSettings;
  now?: () => number;
  log?: Logger;
  /** how many decisions to retain for inspection */
  maxRecent?: number;
}

const HOUR = 60 * 60 * 1000;

/**
 * The grant engine. Deliberately small, synchronous and dependency-free: a
 * permission check must never be able to fail open, so it does not await
 * anything, and a settings read failure is treated as "paused" rather than
 * "allowed".
 */
export class AgentPermissions {
  private readonly usage = new Map<string, { hour: number; used: number }>();
  private readonly recent: AgentDecision[] = [];

  constructor(private readonly deps: AgentPermissionDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private policy(): { paused: boolean; fetchPerHour: number; probesPerHour: number; verifyPerHour: number } | null {
    try {
      const agent = this.deps.settings().automation?.agent;
      if (!agent) return null;
      return {
        paused: agent.paused === true,
        // Re-clamped here even though the schema already bounds them: a settings
        // loader that skipped validation must not yield an infinite budget.
        fetchPerHour: bounded(agent.fetchPerHour, 1, 120, 12),
        probesPerHour: bounded(agent.probesPerHour, 1, 600, 60),
        verifyPerHour: bounded(agent.verifyPerHour, 1, 120, 20),
      };
    } catch {
      return null;
    }
  }

  /** The spec for a capability, or null when the caller invented one. */
  spec(id: string): CapabilitySpec | null {
    return AGENT_CAPABILITIES.find((c) => c.id === id) ?? null;
  }

  private limitFor(spec: CapabilitySpec, policy: NonNullable<ReturnType<AgentPermissions['policy']>>): number | null {
    if (spec.tier !== 'budgeted' || !spec.budgetField) return null;
    return policy[spec.budgetField];
  }

  private usedNow(id: AgentCapability): number {
    const bucket = Math.floor(this.now() / HOUR);
    const entry = this.usage.get(id);
    return entry && entry.hour === bucket ? entry.used : 0;
  }

  /**
   * Return reserved-but-unused allowance to the current hour.
   *
   * A caller has to reserve a ceiling before it knows how much it will actually
   * spend: Smart Connect reserves `maxProbes`, then its pool stops at the first
   * verified candidate. Without this, asking for 10 and dialling 2 would burn 10
   * of a 20/hour allowance and punish the user for being conservative.
   *
   * Only the current hour bucket is credited — an allowance never carries over —
   * and the credit can never exceed what this hour actually consumed.
   */
  release(capability: AgentCapability, count: number): number {
    if (!Number.isFinite(count) || count <= 0) return 0;
    const spec = this.spec(capability);
    if (!spec || spec.tier !== 'budgeted') return 0;
    const bucket = Math.floor(this.now() / HOUR);
    const entry = this.usage.get(capability);
    if (!entry || entry.hour !== bucket) return 0;
    const give = Math.min(Math.floor(count), entry.used);
    if (give <= 0) return 0;
    this.usage.set(capability, { hour: bucket, used: entry.used - give });
    return give;
  }

  private consume(id: AgentCapability, count: number): number {
    const bucket = Math.floor(this.now() / HOUR);
    const entry = this.usage.get(id);
    const used = (entry && entry.hour === bucket ? entry.used : 0) + count;
    this.usage.set(id, { hour: bucket, used });
    return used;
  }

  /**
   * Decide one request. Budgets are consumed ONLY when the request is allowed, so
   * a refusal never costs the user part of an allowance.
   */
  authorize(
    capability: AgentCapability,
    request: { origin: AgentOrigin; count?: number; detail?: string | null },
  ): AgentDecision {
    const at = this.now();
    const origin = request.origin === 'user' ? 'user' : 'autonomous';
    const rawCount = request.count ?? 1;
    const detail = typeof request.detail === 'string' ? request.detail.slice(0, 160) : null;
    const spec = this.spec(capability);

    const finish = (d: Omit<AgentDecision, 'at' | 'capability' | 'origin' | 'count' | 'detail'>): AgentDecision => {
      const decision: AgentDecision = { at, capability, origin, count: spec ? rawCount : 0, detail, ...d };
      this.recent.push(decision);
      const keep = Math.max(1, this.deps.maxRecent ?? 40);
      if (this.recent.length > keep) this.recent.splice(0, this.recent.length - keep);
      if (!decision.allowed) {
        this.deps.log?.warn(
          `agent denied ${capability} (${origin}): ${decision.reason}`,
        );
      }
      return decision;
    };

    if (!spec) {
      return finish({
        allowed: false,
        code: 'unknown-capability',
        reason: `"${String(capability)}" is not a capability this agent has`,
        remaining: null,
        retryAfterMs: null,
      });
    }

    if (spec.tier === 'forbidden') {
      return finish({
        allowed: false,
        code: 'forbidden',
        reason: `${spec.title} is permanently denied: ${spec.bound}`,
        remaining: null,
        retryAfterMs: null,
      });
    }

    if (!Number.isFinite(rawCount) || rawCount < 1 || !Number.isInteger(rawCount)) {
      return finish({
        allowed: false,
        code: 'invalid-request',
        reason: 'the requested count must be a whole number of at least 1',
        remaining: null,
        retryAfterMs: null,
      });
    }
    if (spec.maxPerCall != null && rawCount > spec.maxPerCall) {
      return finish({
        allowed: false,
        code: 'invalid-request',
        reason: `at most ${spec.maxPerCall} may be requested at once for ${capability}`,
        remaining: null,
        retryAfterMs: null,
      });
    }

    if (spec.tier === 'user-only' && origin === 'autonomous') {
      return finish({
        allowed: false,
        code: 'requires-user',
        reason: `${spec.title} needs an explicit user action`,
        remaining: null,
        retryAfterMs: null,
      });
    }

    const policy = this.policy();
    if (!policy && spec.tier === 'budgeted') {
      // Unreadable settings must not become an unlimited budget.
      return finish({
        allowed: false,
        code: 'paused',
        reason: 'the agent policy could not be read, so unattended network work is paused',
        remaining: 0,
        retryAfterMs: null,
      });
    }

    const limit = policy ? this.limitFor(spec, policy) : null;
    if (spec.tier === 'budgeted' && origin === 'autonomous' && policy?.paused) {
      return finish({
        allowed: false,
        code: 'paused',
        reason: 'unattended agent work is paused in settings',
        remaining: limit != null ? Math.max(0, limit - this.usedNow(capability)) : null,
        retryAfterMs: null,
      });
    }

    if (limit != null) {
      const used = this.usedNow(capability);
      const remaining = Math.max(0, limit - used);
      if (rawCount > remaining) {
        return finish({
          allowed: false,
          code: 'budget-exhausted',
          reason: `hourly allowance for ${capability} is ${limit}; ${used} used and ${rawCount} requested`,
          remaining,
          retryAfterMs: HOUR - (at % HOUR),
        });
      }
      const total = this.consume(capability, rawCount);
      return finish({
        allowed: true,
        code: 'allowed',
        reason: 'within the agent policy',
        remaining: Math.max(0, limit - total),
        retryAfterMs: null,
      });
    }

    return finish({
      allowed: true,
      code: 'allowed',
      reason: 'always permitted',
      remaining: null,
      retryAfterMs: null,
    });
  }

  /**
   * Non-consuming check, for rendering state.
   *
   * Deliberately NOT `authorize()` with a rollback: a preview that logs and then
   * un-logs leaves a false entry in the audit trail whenever the undo path does
   * not run exactly as expected. This reads the same policy without side effects.
   */
  can(capability: AgentCapability, origin: AgentOrigin): { allowed: boolean; reason: string } {
    const spec = this.spec(capability);
    if (!spec) return { allowed: false, reason: `"${String(capability)}" is not a capability this agent has` };
    if (spec.tier === 'forbidden') return { allowed: false, reason: `${spec.title} is permanently denied` };
    if (spec.tier === 'user-only' && origin === 'autonomous') {
      return { allowed: false, reason: `${spec.title} needs an explicit user action` };
    }
    if (spec.tier === 'budgeted') {
      const policy = this.policy();
      if (!policy) return { allowed: false, reason: 'the agent policy could not be read' };
      if (origin === 'autonomous' && policy.paused) return { allowed: false, reason: 'unattended agent work is paused' };
      const limit = this.limitFor(spec, policy);
      if (limit != null && this.usedNow(capability) >= limit) {
        return { allowed: false, reason: `hourly allowance for ${capability} is used up` };
      }
    }
    return { allowed: true, reason: 'allowed' };
  }

  snapshot(): AgentPermissionSnapshot {
    const policy = this.policy();
    const paused = policy?.paused ?? true;
    const capabilities: AgentCapabilityState[] = AGENT_CAPABILITIES.map((spec) => {
      const limit = policy ? this.limitFor(spec, policy) : null;
      const used = this.usedNow(spec.id);
      return {
        id: spec.id,
        tier: spec.tier,
        title: spec.title,
        allows: spec.allows,
        bound: spec.bound,
        granted:
          spec.tier === 'forbidden'
            ? 'forbidden'
            : spec.tier === 'user-only'
              ? 'user-only'
              : spec.tier === 'always'
                ? 'always'
                : paused
                  ? 'paused'
                  : 'granted',
        usedThisHour: used,
        limitPerHour: limit,
        remaining: limit == null ? null : Math.max(0, limit - used),
      };
    });

    const forbidden = capabilities.filter((c) => c.tier === 'forbidden').length;
    return {
      version: 1,
      paused,
      capabilities,
      recent: [...this.recent],
      note: paused
        ? `Unattended discovery is paused. Manual actions still work. ${forbidden} capabilities are permanently denied.`
        : `Unattended discovery is on within ${policy?.probesPerHour ?? 0} probes, ${policy?.fetchPerHour ?? 0} fetches and ${policy?.verifyPerHour ?? 0} verifications per hour. ${forbidden} capabilities are permanently denied.`,
    };
  }

  /** Test/tooling seam: forget hourly usage (does not change settings). */
  resetUsage(): void {
    this.usage.clear();
    this.recent.length = 0;
  }
}

function bounded(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}
