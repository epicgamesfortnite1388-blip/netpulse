import fs from 'node:fs';

import type { VpnRegistry } from '../vpn/vpnService';

/**
 * Profile bundle export — everything needed to recreate a profile from its
 * full config, for end-to-end encrypted cloud backup.
 *
 * The stored profile on disk is SANITIZED (credential replaced with a
 * placeholder, see each provider's import) and the credential lives in the
 * file vault. This module reassembles importable config text: sanitized
 * config + vault credential, exactly mirroring each provider's own
 * materialization step. The result goes to the webview only, which encrypts
 * it before anything leaves the machine — the cloud never sees plaintext.
 */

export interface ProfileBundle {
  profileId: string;
  providerId: string;
  name: string;
  protocol: string;
  endpoint: string | null;
  configText: string;
  updatedAt: number;
}

export class BundleError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BundleError';
  }
}

/** Rebuild importable config text from the sanitized file + vault credential. */
function reconstructConfigText(
  providerId: string,
  sanitized: string,
  secret: string,
): string {
  if (providerId === 'wireguard') {
    // Vault holds "key" or "key\npsk" (see WireGuardProvider.importProfile).
    const [privateKey, preshared] = secret.split('\n');
    let text = sanitized.replace('PrivateKey = <stored in vault>', `PrivateKey = ${privateKey}`);
    if (preshared) text = text.replace('PresharedKey = <stored in vault>', `PresharedKey = ${preshared}`);
    return text;
  }
  if (providerId === 'openvpn') {
    // Vault holds the inner text of the <auth> block.
    return sanitized.replace('<auth>stored in vault</auth>', `<auth>${secret}</auth>`);
  }
  if (providerId === 'singbox') {
    // Vault holds uuid/password; the sanitized doc's first outbound carries
    // the placeholder. Re-export the outbound object — the import path
    // accepts a bare outbound JSON (`outbounds[0] ?? doc`).
    const doc = JSON.parse(sanitized) as { outbounds?: Array<Record<string, unknown>> };
    const outbound = doc.outbounds?.[0];
    if (!outbound) throw new BundleError('bundle_unsupported', 'The stored sing-box profile has no outbound to export');
    const field = 'uuid' in outbound ? 'uuid' : 'password';
    if (outbound[field] !== '<stored in vault>') throw new BundleError('bundle_unsupported', 'The stored profile does not match the expected sanitized shape');
    return JSON.stringify({ ...outbound, [field]: secret });
  }
  throw new BundleError('bundle_unsupported', `Profile bundles are not supported for the "${providerId}" engine`);
}

/**
 * Build the restore bundle for one profile, or throw a BundleError with the
 * honest reason (missing profile, missing credential, unsupported engine).
 */
export function buildProfileBundle(registry: VpnRegistry, profileId: string): ProfileBundle {
  const profile = registry.getProfile(profileId);
  if (!profile) throw new BundleError('not_found', `Profile "${profileId}" not found`);
  const secretRef = 'secretRef' in profile ? profile.secretRef : null;
  const secret = secretRef ? registry.getSecretForCheck(secretRef) : null;
  if (!secret) throw new BundleError('credential_missing', 'The profile credential is no longer in the vault');
  let sanitized: string;
  try {
    sanitized = fs.readFileSync(profile.configPath, 'utf8');
  } catch {
    throw new BundleError('config_missing', 'The stored profile config file is missing on disk');
  }
  return {
    profileId: profile.id,
    providerId: profile.providerId,
    name: profile.name,
    protocol: profile.protocol,
    endpoint: profile.endpoint,
    configText: reconstructConfigText(profile.providerId, sanitized, secret),
    updatedAt: profile.createdAt,
  };
}
