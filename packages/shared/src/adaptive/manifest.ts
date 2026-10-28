import { DEFAULT_ADAPTIVE_POLICY, type AdaptivePolicyOptions } from './types';

/**
 * Signed policy/strategy updates for the adaptive engine.
 *
 * Two update paths exist, and they are deliberately NOT the same one:
 *
 *  - **Local adaptation** (the common case) changes only learned counts. It
 *    downloads nothing, executes nothing, and cannot change what the app is
 *    willing to do. That path is `policy.ts` and needs no signature.
 *  - **Reviewed research updates** (this file) may change the engine's *bounds*
 *    — how much it may explore, how much time cost counts, which strategies are
 *    allowed — and that is a change in behaviour, so it must be authenticated,
 *    versioned, reversible and revocable.
 *
 * What an update can NEVER do: run code, add a binary, add a hostname, embed a
 * credential, or raise its own authority. The payload is data with a closed
 * schema, the bounds below can only be tightened past their defaults, and a
 * manifest is only ever applied to the policy input — the strategy list still
 * comes from installed cores and node compatibility, checked locally.
 *
 * Signature semantics are the same trust model as the release feed (an offline
 * key, a pinned public key, a key id, expiry, revocation) but the encoding is raw
 * Ed25519 over a canonical JSON payload rather than minisign text: this verifier
 * has to run inside the sidecar bundle, and the minisign text format is the
 * installer channel's. The verifier itself is injected (`SignerVerify`) so this
 * module stays dependency-free and usable from the browser bundle.
 */

export type AdaptiveChannel = 'test' | 'production';

/** Hard bounds an update can never move past, whichever channel it came from. */
export const ADAPTIVE_MANIFEST_LIMITS = {
  /** an update may never let the engine explore more than half its budget */
  maxExplorationShare: 0.5,
  maxCostWeight: 0.5,
  /** below this, a strategy could be preferred on noise */
  minMinSamples: 3,
  minHalfLifeMs: 60 * 60 * 1000,
  maxHalfLifeMs: 90 * 24 * 60 * 60 * 1000,
  maxRevocations: 200,
  maxStrategyIds: 32,
} as const;

export interface AdaptivePolicyPatch {
  explorationShare?: number;
  costWeight?: number;
  minSamples?: number;
  halfLifeMs?: number;
  flopThreshold?: number;
}

export interface AdaptiveStrategyDirective {
  /** strategy ids this update allows the engine to consider */
  enable?: string[];
  /** strategy ids this update forbids, whatever else says otherwise */
  disable?: string[];
}

export interface AdaptiveRevocation {
  strategyId: string;
  reason: string;
  at: number;
}

export interface AdaptiveManifestPayload {
  kind: 'adaptive-policy';
  /** strictly increasing; a lower-or-equal version is refused (no silent downgrade) */
  version: number;
  channel: AdaptiveChannel;
  issuedAt: number;
  expiresAt: number;
  /** policy bounds to apply (clamped to ADAPTIVE_MANIFEST_LIMITS) */
  policy: AdaptivePolicyPatch;
  strategies: AdaptiveStrategyDirective;
  /** what the publisher believes it is compatible with */
  compatibility: {
    /** app versions, compared as [major, minor, patch] */
    minAppVersion?: string;
    maxAppVersion?: string;
    /** adaptive state schema versions this policy understands */
    stateVersions: number[];
  };
  revocations: AdaptiveRevocation[];
}

export interface AdaptiveManifestEnvelope {
  payload: AdaptiveManifestPayload;
  /** base64 detached Ed25519 signature over `canonicalManifestPayload(payload)` */
  signature: string;
  /** which pinned key signed it — a signature from an unknown key is refused */
  keyId: string;
}

/** Injected signature check. Node supplies `node:crypto`; tests supply their own. */
export type SignatureVerifier = (message: string, signatureBase64: string) => boolean;

export type ManifestRefusalCode =
  | 'malformed'
  | 'key-mismatch'
  | 'signature-invalid'
  | 'not-yet-valid'
  | 'expired'
  | 'incompatible-app'
  | 'incompatible-state'
  | 'channel-refused'
  | 'not-newer';

export type ManifestCheck =
  | { ok: true; payload: AdaptiveManifestPayload }
  | { ok: false; code: ManifestRefusalCode; reason: string };

/**
 * Canonical JSON of the payload: keys sorted, arrays preserved, no whitespace.
 *
 * The signature covers exactly this string, so a payload that was re-serialized
 * by another tool still verifies while any actual edit does not.
 */
export function canonicalManifestPayload(payload: AdaptiveManifestPayload): string {
  return JSON.stringify(sortValue(payload));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value == null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined) continue;
    out[key] = sortValue(v);
  }
  return out;
}

/** Compare dotted versions; returns null when either side is unparseable. */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string): number[] | null => {
    const m = v.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i += 1) {
    if (pa[i]! !== pb[i]!) return pa[i]! - pb[i]!;
  }
  return 0;
}

export interface ManifestCheckOptions {
  /** the key this install trusts — a matching keyId is required, then a valid signature */
  trustedKeyId: string;
  verify: SignatureVerifier;
  now: number;
  /** the running app version, compared against the payload's compatibility range */
  appVersion?: string | null;
  /** adaptive state schema version this build speaks */
  stateVersion: number;
  /** which channels this build is willing to install from */
  acceptChannels: readonly AdaptiveChannel[];
  /** version of the currently installed manifest, if any (downgrades are refused) */
  currentVersion?: number | null;
}

/**
 * Verify and vet one envelope. Every refusal has a stable code, so the caller can
 * report exactly why an update did or did not install.
 *
 * Order is the security order: provenance first (trusted key id, then the
 * signature), then time, then compatibility, then channel and monotonicity. A
 * manifest whose signature is invalid is never even parsed for its contents
 * beyond the shape needed to check it.
 */
export function verifyAdaptiveManifest(envelope: unknown, options: ManifestCheckOptions): ManifestCheck {
  const shape = readEnvelope(envelope);
  if (!shape.ok) return shape;

  const { payload, signature, keyId } = shape.envelope;
  if (keyId !== options.trustedKeyId) {
    return { ok: false, code: 'key-mismatch', reason: `signed by key "${keyId}", this build trusts "${options.trustedKeyId}"` };
  }
  if (!options.verify(canonicalManifestPayload(payload), signature)) {
    return { ok: false, code: 'signature-invalid', reason: 'the signature does not match the payload' };
  }
  if (payload.issuedAt > options.now) {
    return { ok: false, code: 'not-yet-valid', reason: `issued at ${new Date(payload.issuedAt).toISOString()}, which is in the future` };
  }
  if (payload.expiresAt <= options.now) {
    return { ok: false, code: 'expired', reason: `expired at ${new Date(payload.expiresAt).toISOString()}` };
  }
  if (options.currentVersion != null && payload.version <= options.currentVersion) {
    return { ok: false, code: 'not-newer', reason: `version ${payload.version} is not newer than the installed ${options.currentVersion}` };
  }
  if (!options.acceptChannels.includes(payload.channel)) {
    return { ok: false, code: 'channel-refused', reason: `this build does not install "${payload.channel}" manifests` };
  }

  if (options.appVersion) {
    const { minAppVersion, maxAppVersion } = payload.compatibility;
    if (minAppVersion) {
      const cmp = compareVersions(options.appVersion, minAppVersion);
      if (cmp != null && cmp < 0) {
        return { ok: false, code: 'incompatible-app', reason: `needs app ${minAppVersion} or newer (this build is ${options.appVersion})` };
      }
    }
    if (maxAppVersion) {
      const cmp = compareVersions(options.appVersion, maxAppVersion);
      if (cmp != null && cmp > 0) {
        return { ok: false, code: 'incompatible-app', reason: `targets app ${maxAppVersion} or older (this build is ${options.appVersion})` };
      }
    }
  }
  if (!payload.compatibility.stateVersions.includes(options.stateVersion)) {
    return {
      ok: false,
      code: 'incompatible-state',
      reason: `supports state version(s) ${payload.compatibility.stateVersions.join(', ')}, this build speaks ${options.stateVersion}`,
    };
  }

  return { ok: true, payload };
}

function readEnvelope(envelope: unknown): { ok: true; envelope: AdaptiveManifestEnvelope } | { ok: false; code: 'malformed'; reason: string } {
  if (envelope == null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { ok: false, code: 'malformed', reason: 'manifest is not an object' };
  }
  const e = envelope as Record<string, unknown>;
  if (typeof e.signature !== 'string' || e.signature.length < 16) {
    return { ok: false, code: 'malformed', reason: 'manifest has no signature' };
  }
  if (typeof e.keyId !== 'string' || e.keyId.length === 0) {
    return { ok: false, code: 'malformed', reason: 'manifest names no signing key' };
  }
  const payload = e.payload as Partial<AdaptiveManifestPayload> | undefined;
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, code: 'malformed', reason: 'manifest has no payload object' };
  }
  if (payload.kind !== 'adaptive-policy') {
    return { ok: false, code: 'malformed', reason: `payload kind "${String(payload.kind)}" is not an adaptive policy` };
  }
  if (!Number.isFinite(payload.version) || !Number.isFinite(payload.issuedAt) || !Number.isFinite(payload.expiresAt)) {
    return { ok: false, code: 'malformed', reason: 'payload version/issuedAt/expiresAt must be numbers' };
  }
  if (payload.channel !== 'test' && payload.channel !== 'production') {
    return { ok: false, code: 'malformed', reason: `payload channel "${String(payload.channel)}" is not test or production` };
  }
  if (!Array.isArray(payload.compatibility?.stateVersions) || payload.compatibility.stateVersions.length === 0) {
    return { ok: false, code: 'malformed', reason: 'payload declares no compatible state versions' };
  }
  if (!Array.isArray(payload.revocations) || payload.revocations.length > ADAPTIVE_MANIFEST_LIMITS.maxRevocations) {
    return { ok: false, code: 'malformed', reason: `payload must carry at most ${ADAPTIVE_MANIFEST_LIMITS.maxRevocations} revocations` };
  }
  return { ok: true, envelope: envelope as AdaptiveManifestEnvelope };
}

/* --------------------------------- applying -------------------------------- */

export interface AppliedManifest {
  version: number;
  channel: AdaptiveChannel;
  options: AdaptivePolicyOptions;
  /** strategy ids the update allows (empty = whatever is installed and compatible) */
  enabledStrategyIds: string[];
  /** strategy ids the update forbids */
  disabledStrategyIds: string[];
  revocation: AdaptiveRevocation[];
  /** what actually changed, for the UI/log */
  applied: string[];
  /** things the update asked for that were clamped or ignored, with the reason */
  refused: string[];
  /** set when this manifest was restored by a rollback: the version rolled back FROM */
  rolledBackFrom?: number | null;
}

/**
 * Turn a verified payload into concrete policy input.
 *
 * Every numeric field is clamped into `ADAPTIVE_MANIFEST_LIMITS` rather than
 * trusted, and a clamped field is reported in `refused` — so a publisher that
 * asks for more exploration than the app permits gets "clamped to 0.5", not a
 * silent change in behaviour.
 */
export function applyManifestPolicy(payload: AdaptiveManifestPayload): AppliedManifest {
  const limits = ADAPTIVE_MANIFEST_LIMITS;
  const options: AdaptivePolicyOptions = { ...DEFAULT_ADAPTIVE_POLICY };
  const applied: string[] = [];
  const refused: string[] = [];

  const clampNumber = (value: unknown, min: number, max: number, name: string): number | null => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    const clamped = Math.min(max, Math.max(min, value));
    if (clamped !== value) refused.push(`${name} clamped to ${clamped} (limits ${min}–${max})`);
    return clamped;
  };

  const patch = payload.policy ?? {};
  const exploration = clampNumber(patch.explorationShare, 0, limits.maxExplorationShare, 'explorationShare');
  if (exploration != null) {
    options.explorationShare = exploration;
    applied.push(`explorationShare=${exploration}`);
  }
  const costWeight = clampNumber(patch.costWeight, 0, limits.maxCostWeight, 'costWeight');
  if (costWeight != null) {
    options.costWeight = costWeight;
    applied.push(`costWeight=${costWeight}`);
  }
  const minSamples = clampNumber(patch.minSamples, limits.minMinSamples, 200, 'minSamples');
  if (minSamples != null) {
    options.minSamples = Math.round(minSamples);
    applied.push(`minSamples=${options.minSamples}`);
  }
  const halfLife = clampNumber(patch.halfLifeMs, limits.minHalfLifeMs, limits.maxHalfLifeMs, 'halfLifeMs');
  if (halfLife != null) {
    options.halfLifeMs = Math.round(halfLife);
    applied.push(`halfLifeMs=${options.halfLifeMs}`);
  }
  const flop = clampNumber(patch.flopThreshold, 1, 20, 'flopThreshold');
  if (flop != null) {
    options.flopThreshold = Math.round(flop);
    applied.push(`flopThreshold=${options.flopThreshold}`);
  }

  const enabled = normalizeIds(payload.strategies?.enable, refused);
  const disabled = normalizeIds(payload.strategies?.disable, refused);
  const revocation = (payload.revocations ?? []).filter((r) => typeof r?.strategyId === 'string' && r.strategyId.length > 0);
  if (revocation.length > 0) applied.push(`${revocation.length} strategy revocation(s)`);

  return {
    version: payload.version,
    channel: payload.channel,
    options,
    enabledStrategyIds: enabled,
    disabledStrategyIds: disabled,
    revocation,
    applied,
    refused,
  };
}

function normalizeIds(ids: unknown, refused: string[]): string[] {
  if (ids == null) return [];
  if (!Array.isArray(ids)) {
    refused.push('strategy id list was not an array');
    return [];
  }
  const out: string[] = [];
  for (const id of ids.slice(0, ADAPTIVE_MANIFEST_LIMITS.maxStrategyIds)) {
    if (typeof id === 'string' && /^[a-z0-9][a-z0-9.\-+]{0,63}$/i.test(id)) out.push(id);
    else refused.push(`ignored invalid strategy id "${String(id)}"`);
  }
  if (ids.length > ADAPTIVE_MANIFEST_LIMITS.maxStrategyIds) {
    refused.push(`only the first ${ADAPTIVE_MANIFEST_LIMITS.maxStrategyIds} strategy ids are read`);
  }
  return out;
}

/**
 * Whether a strategy may be used at all: revoked by any installed manifest, or
 * forbidden by the active one, outranks everything else — including local
 * evidence that it works, because revocation is how a compromised or broken
 * strategy is taken out.
 */
export function strategyAllowed(strategyId: string, applied: AppliedManifest | null): { allowed: true } | { allowed: false; reason: string } {
  if (!applied) return { allowed: true };
  const revoked = applied.revocation.find((r) => r.strategyId === strategyId);
  if (revoked) return { allowed: false, reason: `revoked: ${revoked.reason}` };
  if (applied.disabledStrategyIds.includes(strategyId)) return { allowed: false, reason: 'disabled by the active policy update' };
  if (applied.enabledStrategyIds.length > 0 && !applied.enabledStrategyIds.includes(strategyId)) {
    return { allowed: false, reason: 'not enabled by the active policy update' };
  }
  return { allowed: true };
}

/**
 * Rollback: keep the previous manifest and re-apply it. Returns the manifest to
 * install, or the current one when there is nothing to roll back to.
 */
export function rollbackManifest(
  current: AppliedManifest | null,
  previous: AppliedManifest | null,
): { applied: AppliedManifest | null; rolledBack: boolean; reason: string } {
  if (!previous) {
    return {
      applied: current,
      rolledBack: false,
      reason: 'no previous policy update is stored, so there is nothing to roll back to',
    };
  }
  return {
    applied: { ...previous, rolledBackFrom: current?.version ?? null },
    rolledBack: true,
    reason: `restored policy update ${previous.version}${current ? ` over ${current.version}` : ''}`,
  };
}
