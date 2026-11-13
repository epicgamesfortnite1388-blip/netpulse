import type { AppContext } from '../routes/context';

/**
 * Mission Control: one read-only answer to "what does this process actually know?"
 *
 * The rule this file exists to enforce is that a status is a claim, and every
 * claim needs a class:
 *
 *   verified    — a measurement this process performed, and can point at
 *   observed    — real state that was read (config, stored rows), not a test
 *   not_tested  — no test evidence exists in this process
 *   unavailable — the capability is absent here (no engine, no payment surface)
 *   blocked     — an external dependency or permission is missing
 *
 * There is deliberately no `ok`/`healthy` field. A subsystem is never "fine";
 * it is verified, or it is something weaker, and the UI is forced to say which.
 * Nothing in this module writes, connects, scans, or probes the network: it
 * reads services that already hold state, so opening the dashboard can never
 * change the machine it is describing.
 */

export type MissionState = 'verified' | 'observed' | 'not_tested' | 'unavailable' | 'blocked';

export interface MissionSubsystem {
  id: string;
  label: string;
  state: MissionState;
  /** The real fact, in one line — counts, ids, flags. Never a grade. */
  headline: string;
  /** What that fact means, and what it does not prove. */
  detail: string;
  /** Which service/route produced it, so the row is traceable. */
  source: string;
  checkedAt: number;
}

export interface MissionActivity {
  id: number;
  ts: number;
  level: 'info' | 'warn' | 'error';
  category: string;
  message: string;
}

export interface MissionSnapshot {
  generatedAt: number;
  summary: {
    state: MissionState;
    counts: Record<MissionState, number>;
    headline: string;
    detail: string;
  };
  subsystems: MissionSubsystem[];
  adaptive: {
    enabled: boolean;
    exploration: boolean;
    observationsKept: number;
    contextSummary: string;
    approvedStrategies: number;
    learned: Array<{
      contextSummary: string;
      strategyId: string;
      successProbability: number;
      confidence: 'none' | 'low' | 'medium' | 'high';
      successes: number;
      failures: number;
      meanSuccessMs: number | null;
    }>;
    refused: Array<{ id: string; reason: string }>;
    trustAnchor: { configured: boolean; keyId: string | null };
    policyVersion: number | null;
  } | null;
  activity: MissionActivity[];
  /** Stated verbatim so the page cannot imply more than was measured. */
  limits: string[];
}

/** Run one composition step; a throwing service degrades its own row, never the page. */
function safe<T>(fn: () => T): { value: T } | { error: string } {
  try {
    return { value: fn() };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function unavailableRow(
  id: string,
  label: string,
  source: string,
  detail: string,
  now: number,
): MissionSubsystem {
  return { id, label, state: 'unavailable', headline: 'unreadable', detail, source, checkedAt: now };
}

export async function buildMissionSnapshot(ctx: AppContext, now = Date.now()): Promise<MissionSnapshot> {
  const subsystems: MissionSubsystem[] = [];
  const limits: string[] = [];

  /* ------------------------------- adaptive ------------------------------- */

  const adaptiveResult = safe(() => ctx.services.adaptive.status());
  let adaptive: MissionSnapshot['adaptive'] = null;

  if ('error' in adaptiveResult) {
    subsystems.push(
      unavailableRow(
        'adaptive',
        'Adaptive strategy selection',
        'AdaptiveEngine.status()',
        `Learning state could not be read: ${adaptiveResult.error}. The engine keeps the default core order while unreadable.`,
        now,
      ),
    );
  } else {
    const status = adaptiveResult.value;
    const learnedRows = status.entries.filter((e) => e.confidence !== 'none');
    const approved = status.strategies.filter((s) => s.approved);
    const refused = status.strategies.filter((s) => !s.approved);

    adaptive = {
      enabled: status.enabled,
      exploration: status.exploration,
      observationsKept: status.observationsKept,
      contextSummary: status.contextSummary,
      approvedStrategies: approved.length,
      learned: learnedRows.map((e) => ({
        contextSummary: e.contextSummary,
        strategyId: e.strategyId,
        successProbability: e.successProbability,
        confidence: e.confidence,
        successes: e.successes,
        failures: e.failures,
        meanSuccessMs: e.meanSuccessMs,
      })),
      refused: refused.map((s) => ({ id: s.id, reason: s.reason ?? 'not usable for this node' })),
      trustAnchor: {
        configured: Boolean(ctx.config.adaptivePolicyKeyId && ctx.config.adaptivePolicyPublicKey),
        keyId: ctx.config.adaptivePolicyKeyId ?? null,
      },
      policyVersion: status.manifest.installed?.version ?? null,
    };

    subsystems.push({
      id: 'adaptive',
      label: 'Adaptive strategy selection',
      state: status.enabled ? (learnedRows.length > 0 ? 'verified' : 'observed') : 'unavailable',
      headline: status.enabled
        ? `${learnedRows.length} learned · ${status.observationsKept} observations · ${approved.length}/${status.strategies.length} strategies usable`
        : 'ordering off — default core order in use',
      detail:
        learnedRows.length > 0
          ? 'Rankings come from this machine’s own recorded outcomes. They reorder installed, compatible cores only; they are not a DPI conclusion.'
          : 'No strategy has enough evidence under a context yet, so nothing is reordered. One attempt is not a pattern.',
      source: 'AdaptiveEngine.status()',
      checkedAt: status.updatedAt ?? now,
    });
  }

  /* --------------------------------- VPN --------------------------------- */

  const vpnStatusResult = safe(() => ctx.services.vpnSelfTest.lastResult());
  const vpnResult = safe(() => ctx.vpn.listProfiles());
  let profiles = 0;
  if ('value' in vpnResult) profiles = vpnResult.value.filter((p) => p.providerId !== 'custom').length;

  // The registry's status is async (it may consult the OS for interface state).
  // A throw here degrades this one row rather than failing the whole snapshot.
  let status: Awaited<ReturnType<typeof ctx.vpn.status>> | null = null;
  let statusError: string | null = null;
  try {
    status = await ctx.vpn.status();
  } catch (err) {
    statusError = err instanceof Error ? err.message : String(err);
  }

  if (statusError !== null || status === null) {
    subsystems.push(
      unavailableRow(
        'vpn',
        'VPN tunnel',
        'VpnRegistry.status()',
        `Tunnel state could not be read: ${statusError ?? 'no status returned'}. No state is reported rather than reporting "disconnected".`,
        now,
      ),
    );
  } else {
    // A connect that was never identity-checked is `observed`, not `verified`:
    // the interface existing is not the same claim as traffic leaving through it.
    const verified = status.connected && status.verification === 'verified';
    subsystems.push({
      id: 'vpn',
      label: 'VPN tunnel',
      state: status.connected ? (verified ? 'verified' : 'observed') : 'not_tested',
      headline: status.connected
        ? `${status.providerId ?? 'provider'} · ${status.protocol ?? 'protocol unknown'}${status.verifiedPublicIp ? ` · exit ${status.verifiedPublicIp}` : ''}`
        : 'no tunnel up in this session',
      detail: status.connected
        ? verified
          ? 'The tunnel is up and the exit IP was measured through it.'
          : `Connected, but identity was not verified${status.verificationNote ? `: ${status.verificationNote}` : ''}. A handshake is not proof of routing.`
        : `${profiles} stored profile(s). Nothing was dialled by this page, so there is no result to show.`,
      source: 'VpnRegistry.status()',
      checkedAt: status.since ?? now,
    });
  }

  /* -------------------------------- engines ------------------------------- */

  const selfTest = 'value' in vpnStatusResult ? vpnStatusResult.value : null;
  const engines = selfTest?.engines ?? null;
  const present = engines ? Object.entries(engines).filter(([, v]) => v).map(([k]) => k) : [];

  subsystems.push({
    id: 'engines',
    label: 'VPN / proxy engines',
    state: engines ? (present.length > 0 ? 'observed' : 'unavailable') : 'not_tested',
    headline: engines
      ? present.length > 0
        ? `${present.join(', ')} detected`
        : 'no engine binary installed'
      : 'no dry-run self-test in this process',
    detail: engines
      ? `Detection only — nothing was executed. Last self-test: ${selfTest?.detail ?? 'no detail'}.`
      : 'Engine availability is only reported after the VPN self-test runs. Until then it is unknowable, not "fine".',
    source: 'VpnSelfTestService.lastResult()',
    checkedAt: selfTest?.checkedAt ?? now,
  });

  /* -------------------------------- WHITEDNS ------------------------------ */

  const whitednsResult = safe(() => ctx.services.whitedns.config());
  if ('error' in whitednsResult) {
    subsystems.push(
      unavailableRow('whitedns', 'WhiteDNS', 'WhitednsService.config()', `Configuration unreadable: ${whitednsResult.error}`, now),
    );
  } else {
    const cfg = whitednsResult.value;
    const configured = Boolean(cfg.zone && cfg.server);
    subsystems.push({
      id: 'whitedns',
      label: 'WhiteDNS',
      state: configured ? 'observed' : 'unavailable',
      headline: configured
        ? `zone ${cfg.zone} · resolver ${cfg.server} · ${cfg.hasPubkey ? 'public key present' : 'no public key'}`
        : 'not configured on this host',
      detail: configured
        ? 'Configuration is present, but the tunnel server and its zone delegation lived on the retired provider host — treat a stored zone/server pair as stale config, not a working DNS path. The data plane is only proven by a tunnel test, which this page does not run.'
        : 'WHITEDNS_ZONE / WHITEDNS_SERVER are unset, so no DNS entitlement can be exercised from this machine.',
      source: 'WhitednsService.config()',
      checkedAt: now,
    });
    limits.push(
      'WhiteDNS readiness is reported from configuration only, and its hosting was retired with the provider host; no authoritative-DNS or tunnel-data test is performed by Mission Control.',
    );
  }

  /* --------------------------- external subsystems ------------------------ */

  // These live outside this process. They are listed so the ledger is complete,
  // and each one is BLOCKED on an observation this application cannot make —
  // which is different from being broken, and is said that way.
  subsystems.push({
    id: 'entitlements',
    label: 'Subscription entitlements',
    state: 'not_tested',
    headline: 'mirrored by the Cloud Worker, not polled here',
    detail:
      'Entitlements arrive over the signed Telegram → Worker channel and are enforced server-side. This process holds no live reading, so none is shown.',
    source: 'cloud/worker (out of process)',
    checkedAt: now,
  });

  subsystems.push({
    id: 'host-provisioning',
    label: 'Host provisioning & revocation',
    state: 'unavailable',
    headline: 'provider host retired 2026-11-02',
    detail:
      'The single VPN host that ran the 60 s reconciler is gone, so there is no host-side identity set to reconcile and no server-issued config to rotate or revoke. Configs now come from Aether (no server) or the free-source catalog; neither is covered by this row.',
    source: 'reports/accounting/VPS_LOSS_ACCOUNTING_2026-11-02.md',
    checkedAt: now,
  });

  subsystems.push({
    id: 'payments',
    label: 'Payments',
    state: 'blocked',
    headline: 'no payment surface in this application',
    detail:
      'Purchases are owned by the Telegram commerce service. This application neither charges nor verifies payments, so it cannot report a payment result.',
    source: '—',
    checkedAt: now,
  });

  /* ------------------------------- activity ------------------------------- */

  const activityResult = safe(() => ctx.services.events.list({ limit: 60 }));
  const activity: MissionActivity[] = 'value' in activityResult
    ? activityResult.value.map((e) => ({
        id: e.id,
        ts: e.ts,
        level: e.level,
        category: e.category,
        message: e.message,
      }))
    : [];
  if ('error' in activityResult) {
    limits.push(`Event history could not be read: ${activityResult.error}`);
  }

  /* -------------------------------- summary ------------------------------- */

  const counts: Record<MissionState, number> = {
    verified: 0,
    observed: 0,
    not_tested: 0,
    unavailable: 0,
    blocked: 0,
  };
  for (const s of subsystems) counts[s.state] += 1;

  // The overall state is the WEAKEST claim in the ledger, never the strongest:
  // four verified rows cannot outvote a subsystem that is blocked or untested.
  const state: MissionState =
    counts.blocked > 0 ? 'blocked' : counts.unavailable > 0 ? 'unavailable' : counts.not_tested > 0 ? 'not_tested' : counts.observed > 0 ? 'observed' : 'verified';

  limits.push(
    'A Verification here means this process observed it. Nothing on this page was measured on an Iranian ISP unless a field run recorded it separately.',
  );
  limits.push('Mission Control is read-only: it never connects, scans, provisions or revokes anything.');

  return {
    generatedAt: now,
    summary: {
      state,
      counts,
      headline: `${counts.verified} verified · ${counts.observed} observed · ${counts.not_tested} not tested · ${counts.unavailable} unavailable · ${counts.blocked} blocked`,
      detail:
        'The overall state is the weakest claim in the ledger, not the strongest. A subsystem is verified only when a measurement in this process supports it.',
    },
    subsystems,
    adaptive,
    activity,
    limits,
  };
}
