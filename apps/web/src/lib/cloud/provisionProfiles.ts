import { api } from '@/lib/api';
import { toShareLink } from '@netpulse/shared';

import type { ImportSummary, ProvisionedProfile } from '@netpulse/shared';

export { PROFILE_NAME_PREFIX, describeImport, toShareLink } from '@netpulse/shared';
export type { ImportSummary, LinkConversion, LinkImport, ProvisionedProfile } from '@netpulse/shared';

/**
 * Turn provisioned cloud configs into nodes the app can connect with.
 *
 * Why this exists: `POST /api/v1/provision` returns each entitlement's client
 * config, and the Account page used to only display it for copying. That left
 * the app's Connect button pointing at whatever the user had imported by hand —
 * which, after the move to per-user credentials, is a config the server no
 * longer accepts. The tunnel then failed with no explanation, because the
 * profile itself looked fine.
 *
 * Nodes (not sing-box profiles) are the target because `POST /v1/vpn/tunnel/start`
 * dials a node with the bundled xray core, and that core is the one that
 * completes REALITY against the deployed server.
 *
 * `POST /v1/nodes/import` deduplicates by config fingerprint, so refreshing the
 * Account page repeatedly converges on the same node instead of accumulating
 * copies; a per-user credential is stable for as long as the account stays
 * entitled. A duplicate therefore means "already in the app", not a failure.
 */
export async function importProvisionedConfigs(provisioned: ProvisionedProfile[]): Promise<ImportSummary> {
  const summary: ImportSummary = { imported: 0, present: 0, skipped: [], failed: [] };
  const links: string[] = [];

  for (const profile of provisioned) {
    const conversion = toShareLink(profile);
    if (!conversion.ok) {
      summary.skipped.push({ protocol: conversion.protocol, reason: conversion.reason });
      continue;
    }
    links.push(conversion.request.link);
  }
  if (links.length === 0) return summary;

  try {
    const res = await api.post<{ imported: number; duplicates: number; invalid: number }>('/nodes/import', { configs: links });
    summary.imported = res.imported;
    summary.present = res.duplicates;
    if (res.invalid > 0) {
      // The batch endpoint does not say which entry was rejected; naming one
      // protocol would be a guess. One honest entry is better than four wrong
      // ones.
      summary.failed.push({ protocol: 'batch', reason: `${res.invalid} generated link(s) were rejected` });
    }
  } catch (err) {
    summary.failed.push({ protocol: 'batch', reason: err instanceof Error ? err.message : 'import failed' });
  }
  return summary;
}
