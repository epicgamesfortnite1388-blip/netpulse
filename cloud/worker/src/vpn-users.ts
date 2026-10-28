/**
 * Per-user VPN identities.
 *
 * The server used to authenticate every user with one shared UUID/password, so
 * expiry could only stop new provisioning: a config already handed out kept
 * working. Provisioning now allocates a distinct secret per (user, protocol),
 * and the VPS reconciler writes only the currently-entitled secrets into the
 * Xray/Hysteria configs. Removing an entitlement — expiry, revocation, refund —
 * therefore removes the tunnel identity on the next sync.
 *
 * Secrets live in `vpn_credentials` (plaintext, see the migration note): the
 * Worker must be able to rebuild the same config on re-provisioning, and D1 is
 * inside the trust boundary that already holds the server's shared secrets.
 */

import { sha256Hex } from './crypto';
import { parseEntitlementExpiry } from './netpulse-integration';

/** Protocols whose server side can hold a list of distinct client identities. */
export const PER_USER_PROTOCOLS = [
  'xray-vless-reality',
  'xray-vmess-ws',
  'xray-vless-ws-tls',
  'xray-trojan-tls',
  'hysteria2',
] as const;

export type PerUserProtocol = (typeof PER_USER_PROTOCOLS)[number];

export function isPerUserProtocol(protocol: string): protocol is PerUserProtocol {
  return (PER_USER_PROTOCOLS as readonly string[]).includes(protocol);
}

/**
 * UUIDs for the Xray proxies (VMess/VLESS parse them as UUIDs), random hex for
 * Trojan and Hysteria, which treat the credential as an opaque password.
 */
function newSecret(protocol: PerUserProtocol): string {
  if (protocol === 'xray-trojan-tls' || protocol === 'hysteria2') {
    return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return crypto.randomUUID();
}

/**
 * The user's secret for a protocol, creating it on first use.
 *
 * Stable across re-provisioning: a second call returns the same secret, so a
 * user who re-downloads their config keeps the identity the server already
 * holds. A revoked row is reactivated with its **existing** secret — revocation
 * is removed from the server on sync, not by hoping the user reconnects.
 */
export async function ensureVpnCredential(db: D1Database, userId: string, protocol: PerUserProtocol): Promise<string> {
  const existing = await db
    .prepare(`SELECT secret, status FROM vpn_credentials WHERE user_id = ? AND protocol = ?`)
    .bind(userId, protocol)
    .first<{ secret: string; status: string }>();
  if (existing?.status === 'active') return existing.secret;

  const secret = existing?.secret ?? newSecret(protocol);
  const t = Date.now();
  await db
    .prepare(
      `INSERT INTO vpn_credentials (user_id, protocol, secret, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)
       ON CONFLICT(user_id, protocol) DO UPDATE SET
         secret = excluded.secret, status = 'active', updated_at = excluded.updated_at`,
    )
    .bind(userId, protocol, secret, t, t)
    .run();
  return secret;
}

/**
 * Replace an account's VPN secrets — the "a config leaked" action.
 *
 * Rotation is a write, not a revocation: the account keeps its entitlement and
 * its profiles, and only the secret inside them changes. The old value stops
 * being authenticable the moment the row is updated, because the host is told
 * to carry exactly the secrets in this table and nothing else; the host's next
 * reconcile (≤ 1 min) is what removes the old identity from the server config,
 * so a leaked config dies without anyone waiting for the subscription to end.
 *
 * Status is deliberately left alone. Rotating replaces a secret; it never
 * grants access, so an operator-revoked credential stays revoked and cannot be
 * resurrected by a rotation request. (Re-enabling is a separate, explicit act:
 * provisioning reactivates it with the current secret.)
 *
 * All statements go through one `batch`, which D1 runs as a transaction: a
 * partial rotation would leave some protocols on the leaked secret.
 *
 * The new secrets are returned because the caller has to rebuild the stored
 * client configs from them. They are NOT for an HTTP response — the operator
 * gets fingerprints, and the account gets its config from the normal
 * provisioning/sync path.
 */
export interface RotatedVpnCredential {
  protocol: PerUserProtocol;
  /** New secret. Callers may build a config from it; never return it. */
  secret: string;
  /** False when the row was revoked: the secret changed but access did not. */
  active: boolean;
  /** Non-reversible handles so an operator can confirm WHAT changed. */
  previousFingerprint: string;
  fingerprint: string;
}

export async function rotateVpnCredentials(
  db: D1Database,
  userId: string,
  only?: PerUserProtocol,
): Promise<RotatedVpnCredential[]> {
  const rows = await db
    .prepare(`SELECT protocol, secret, status FROM vpn_credentials WHERE user_id = ?`)
    .bind(userId)
    .all<{ protocol: string; secret: string; status: string }>();

  const targets = (rows.results ?? []).filter(
    (row): row is { protocol: PerUserProtocol; secret: string; status: string } =>
      isPerUserProtocol(row.protocol) && (only === undefined || row.protocol === only),
  );
  if (targets.length === 0) return [];

  const now = Date.now();
  const rotated: RotatedVpnCredential[] = [];
  const statements: D1PreparedStatement[] = [];
  for (const row of targets) {
    const secret = newSecret(row.protocol);
    statements.push(
      db
        .prepare(`UPDATE vpn_credentials SET secret = ?, updated_at = ? WHERE user_id = ? AND protocol = ?`)
        .bind(secret, now, userId, row.protocol),
    );
    rotated.push({
      protocol: row.protocol,
      secret,
      active: row.status === 'active',
      previousFingerprint: (await sha256Hex(row.secret)).slice(0, 12),
      fingerprint: (await sha256Hex(secret)).slice(0, 12),
    });
  }
  await db.batch(statements);
  return rotated;
}

export interface ActiveVpnUser {
  id: string;
  protocol: PerUserProtocol;
  /** Stable, non-identifying login name for the server config (email/auth id). */
  username: string;
  secret: string;
  /**
   * Epoch ms at which the entitlement ends, or null when open-ended.
   *
   * The host prunes a client locally at this instant instead of waiting for the
   * next sync, so an unreachable Worker (or a paused cron) cannot extend access
   * past the paid period.
   */
  expiresAt: number | null;
}

/**
 * A short, stable name derived from the user id.
 *
 * Xray writes it into connection logs as the client `email`, and Hysteria logs
 * it as the auth id; a hash keeps `usr_…` account identifiers out of those
 * logs and out of the server config while staying deterministic per user.
 */
export async function vpnUsername(userId: string): Promise<string> {
  return `u_${(await sha256Hex(userId)).slice(0, 12)}`;
}

/**
 * The set the VPN server may authenticate right now: credentials that are
 * active AND belong to an active, unexpired entitlement.
 *
 * Expiry is evaluated here rather than in SQL because `np_entitlements.expires_at`
 * is TEXT in several shapes (see `parseEntitlementExpiry`); SQL string
 * comparison would silently treat `2026-9-1` as later than `2026-10-01`.
 * Fail-closed: an entitlement whose end date cannot be read is excluded.
 *
 * A disabled account is excluded too: disabling is the account-level kill
 * switch (login already refuses it), so its tunnel must close with it rather
 * than keep carrying traffic until the subscription happens to lapse.
 */
export async function listActiveVpnUsers(db: D1Database, nowMs = Date.now()): Promise<ActiveVpnUser[]> {
  const rows = await db
    .prepare(
      `SELECT c.user_id, c.protocol, c.secret, e.status AS entitlement_status, e.expires_at
       FROM vpn_credentials c
       JOIN np_entitlements e ON e.user_id = c.user_id
       JOIN users u ON u.id = c.user_id
       WHERE c.status = 'active' AND e.status = 'active' AND u.disabled = 0`,
    )
    .all<{ user_id: string; protocol: string; secret: string; entitlement_status: string; expires_at: string | null }>();

  const names = new Map<string, string>();
  const active = new Map<string, ActiveVpnUser>();
  for (const row of rows.results ?? []) {
    if (!isPerUserProtocol(row.protocol)) continue;
    const endsAt = parseEntitlementExpiry(row.expires_at);
    // A missing end date is open-ended; an unreadable one is not a licence.
    const openEnded = row.expires_at === null || row.expires_at === undefined || String(row.expires_at).trim() === '';
    if (!openEnded && (endsAt === null || endsAt <= nowMs)) continue;
    let username = names.get(row.user_id);
    if (!username) {
      username = await vpnUsername(row.user_id);
      names.set(row.user_id, username);
    }
    active.set(`${row.user_id}:${row.protocol}`, {
      id: row.user_id,
      protocol: row.protocol,
      username,
      secret: row.secret,
      expiresAt: openEnded ? null : endsAt,
    });
  }
  return [...active.values()].sort((a, b) => (a.id === b.id ? a.protocol.localeCompare(b.protocol) : a.id.localeCompare(b.id)));
}
