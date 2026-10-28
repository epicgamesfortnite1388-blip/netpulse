import { api } from '@/lib/api';
import { CloudError, cloudApi } from '@/lib/cloud/client';
import { PROFILE_NAME_PREFIX, toShareLink } from '@netpulse/shared';

import type { NodeView, ProvisionedProfile } from '@netpulse/shared';

/**
 * Repair of subscription profiles whose credential the server no longer accepts.
 *
 * The failure this exists for: a subscription's client configs carry a per-user
 * credential, and the control plane re-issues it (expiry, revocation, a plan
 * change, a re-provision). The app stored the old one in its node vault, so the
 * node still looks healthy in every list — same endpoint, same protocol — while
 * the tunnel dies on authentication. Nothing in the VPN surfaces said why, and
 * the only place that could re-issue a working credential was the Account page,
 * which most users never open.
 *
 * ## What is detectable here, and what is not
 *
 * The app CANNOT tell from a failed probe whether the cause is the credential,
 * the server being down, or the local network. So these surfaces do not claim
 * it: they detect *provisioned profiles that have never (or no longer) carried a
 * probe* and say exactly that. The credential verdict comes from evidence, after
 * the refresh: `POST /nodes/import` reports `credentialsUpdated` — the number of
 * already-known nodes whose stored secret it had to REPLACE because the server
 * issued a different one. Zero means the stored credential was never the
 * difference, and the message says so instead of implying a repair.
 *
 * ## Order of operations
 *
 * 1. Ask the control plane for the current configs (`cloudApi.provision`).
 * 2. Convert each to the share-link shape the tunnel dials (`toShareLink`).
 * 3. Import them: the API replaces a stored credential on this path only
 *    (manual/provider-supplied), which is what makes step 4 possible.
 * 4. Probe the affected nodes so the user is told whether it now works, rather
 *    than being told that something "refreshed".
 */

/** The remark a provisioned profile's node carries: `NetPulse · <profile name>`. */
export const PROVISIONED_MARKER = PROFILE_NAME_PREFIX;

/** Fields the detection needs — a full `NodeView` satisfies this. */
export type ProvisionedNodeShape = Pick<
  NodeView,
  'id' | 'label' | 'remark' | 'consecutiveFailures' | 'testCount' | 'successCount'
>;

/**
 * True when this node came from a NetPulse subscription rather than a list the
 * user pasted out of somewhere else. `label` and `remark` are both checked: the
 * view layer withholds a remark that reads as an endpoint, so the marker can be
 * present in the label while `remark` is null.
 */
export function isProvisionedNode(node: Pick<ProvisionedNodeShape, 'label' | 'remark'>): boolean {
  return (node.remark ?? '').startsWith(PROVISIONED_MARKER) || node.label.startsWith(PROVISIONED_MARKER);
}

/**
 * A provisioned profile that needs attention: it is failing probes now, or it
 * has never passed one. A profile that passes is left alone — a refresh is a
 * server-side re-issue, not routine maintenance, and calling it on healthy
 * profiles would be a button that sometimes breaks working configs.
 */
export function needsCredentialRefresh(node: ProvisionedNodeShape): boolean {
  if (!isProvisionedNode(node)) return false;
  const currentlyFine = node.successCount > 0 && node.consecutiveFailures === 0;
  if (currentlyFine) return false;
  return node.consecutiveFailures > 0 || (node.testCount > 0 && node.successCount === 0);
}

/** The profiles a refresh should be offered for, in list order. */
export function failingProvisionedNodes<T extends ProvisionedNodeShape>(nodes: readonly T[]): T[] {
  return nodes.filter((n) => needsCredentialRefresh(n));
}

/**
 * The one-line statement of what was observed. Deliberately not a diagnosis:
 * "has never passed a probe" and "stopped passing" are facts, "your credential
 * expired" is not known yet.
 */
export function evidenceSummary(nodes: readonly ProvisionedNodeShape[]): string {
  const never = nodes.filter((n) => n.successCount === 0).length;
  const stopped = nodes.length - never;
  const parts: string[] = [];
  if (never > 0) parts.push(`${never} has never passed a probe`);
  if (stopped > 0) parts.push(`${stopped} stopped passing`);
  return parts.join(', ');
}

export interface ProvisionedImportResponse {
  imported: number;
  duplicates: number;
  invalid: number;
  /** Node ids this import created or touched — the candidates to re-probe. */
  nodeIds?: string[];
  /**
   * Already-known nodes whose stored credential the import replaced because the
   * server issued a different one. This is the app's only proof that a stale
   * credential was in play; older APIs do not send it, hence optional.
   */
  credentialsUpdated?: number;
}

export type ProvisionedRefreshOutcome =
  /** The control plane issued a different credential and it was stored. */
  | 'credential-replaced'
  /** The control plane issued the same credential the app already had. */
  | 'credential-unchanged'
  /** The control plane could not be reached, or issued nothing usable. */
  | 'unavailable';

export interface ProvisionedRefreshResult {
  outcome: ProvisionedRefreshOutcome;
  /** Nodes the caller asked about that this refresh actually touched. */
  addressed: string[];
  credentialsUpdated: number;
  imported: number;
  invalid: number;
  /** Probes attempted / passing after the refresh, or null when none ran. */
  probed: { attempted: number; carried: number } | null;
  /** Profiles the Worker or the link converter could not express as a node. */
  unconvertible: number;
  /** One honest, user-facing sentence. */
  message: string;
}

const EMPTY = { credentialsUpdated: 0, imported: 0, invalid: 0, addressed: [] as string[], unconvertible: 0 };

/** Name the cause of a cloud failure the way the account surfaces do. */
function cloudMessageFor(err: unknown): string {
  if (err instanceof CloudError) {
    switch (err.code) {
      case 'entitlement_expired':
        return 'Your subscription has expired, so the server will not issue a working credential.';
      case 'no_active_entitlement':
      case 'entitlement_not_active':
        return 'No active subscription is linked to this account, so there is nothing to re-issue.';
      case 'unauthorized':
      case 'not_authenticated':
      case 'no_session':
        return 'Sign in on the Account page first — the refreshed configs come from your subscription.';
      default:
        return `Could not reach your subscription: ${err.message}`;
    }
  }
  return `Could not reach your subscription: ${err instanceof Error ? err.message : 'unknown error'}`;
}

/**
 * Re-issue the subscription's configs, store them, and probe the nodes that were
 * failing. `concernedIds` is what the surface flagged; a refresh that also
 * produced brand-new nodes probes those instead.
 */
export async function refreshProvisionedCredentials(
  concernedIds: readonly string[] = [],
): Promise<ProvisionedRefreshResult> {
  let provisioned: ProvisionedProfile[];
  let unconvertible = 0;
  try {
    const r = await cloudApi.provision();
    provisioned = r.provisioned;
    // Protocols the Worker itself declined (Hysteria 2 needs obfuscation
    // settings a node link cannot carry) are not failures of this refresh.
    unconvertible += r.skipped.length + r.errors.length;
  } catch (err) {
    return { outcome: 'unavailable', ...EMPTY, probed: null, message: cloudMessageFor(err) };
  }

  if (provisioned.length === 0) {
    return {
      outcome: 'unavailable',
      ...EMPTY,
      probed: null,
      message: 'Your subscription currently issues no configs, so there is nothing to re-issue. The profiles already in the app are the only ones your account has.',
    };
  }

  const links: string[] = [];
  for (const profile of provisioned) {
    const conversion = toShareLink(profile);
    if (conversion.ok) links.push(conversion.request.link);
    else unconvertible++;
  }
  if (links.length === 0) {
    return {
      outcome: 'unavailable',
      ...EMPTY,
      unconvertible,
      probed: null,
      message: `Your subscription's ${unconvertible} config(s) cannot be expressed as a node link, so none of them can be refreshed here. Copy them from the Account page instead.`,
    };
  }

  let stored: ProvisionedImportResponse;
  try {
    stored = await api.post<ProvisionedImportResponse>('/nodes/import', { configs: links });
  } catch (err) {
    return {
      outcome: 'unavailable',
      ...EMPTY,
      unconvertible,
      probed: null,
      message: `The refreshed configs could not be stored: ${err instanceof Error ? err.message : 'unknown error'}. Nothing about your profile changed.`,
    };
  }

  const touched = stored.nodeIds ?? [];
  const asked = concernedIds.length > 0 ? touched.filter((id) => concernedIds.includes(id)) : [];
  // A refresh that created nodes the surface never saw (a new protocol in the
  // plan) still deserves a verdict, so fall back to everything it touched.
  const addressed = asked.length > 0 ? asked : touched;
  const credentialsUpdated = stored.credentialsUpdated ?? 0;

  let probed: ProvisionedRefreshResult['probed'] = null;
  const toProbe = addressed.slice(0, 100);
  if (toProbe.length > 0) {
    try {
      const res = await api.post<{ results: Record<string, { success: boolean }> }>('/nodes/test-batch', {
        nodeIds: toProbe,
        type: 'proxy',
      });
      const results = Object.values(res.results ?? {});
      probed = { attempted: toProbe.length, carried: results.filter((r) => r.success).length };
    } catch {
      // The probe is the confirmation, not the repair. Its absence is reported
      // by omission: the message below then says the credential was replaced
      // without claiming the node works.
      probed = null;
    }
  }

  const carrier = probed ? `${probed.carried} of ${probed.attempted} now carr${probed.carried === 1 ? 'ies' : 'y'} a probe` : 'the node was not probed';
  const tail = unconvertible > 0 ? ` ${unconvertible} config(s) can only be copied from the Account page.` : '';

  if (credentialsUpdated > 0) {
    return {
      outcome: 'credential-replaced',
      addressed,
      credentialsUpdated,
      imported: stored.imported,
      invalid: stored.invalid,
      unconvertible,
      probed,
      message: `The server had issued a different credential — the app replaced the stored one for ${credentialsUpdated} profile(s), and ${carrier}.${tail}`,
    };
  }

  return {
    outcome: 'credential-unchanged',
    addressed,
    credentialsUpdated: 0,
    imported: stored.imported,
    invalid: stored.invalid,
    unconvertible,
    probed,
    message: `Your subscription issued the same credential the app already has, so a stale credential is not the difference here — ${carrier}.${tail}`,
  };
}
