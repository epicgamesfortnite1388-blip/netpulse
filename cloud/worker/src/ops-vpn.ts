/**
 * Operator action: rotate one account's VPN credentials.
 *
 * This is the incident-response path for a leaked config. The account keeps
 * its entitlement; the per-user secrets it authenticates with are replaced,
 * and the configs already stored for it are rebuilt so the legitimate user's
 * app syncs a working identity instead of the leaked one.
 *
 * `POST /api/v1/ops/vpn/rotate`, `Authorization: Bearer <OPS_TOKEN>`:
 *
 *   { "email": "customer@example.com" }             every protocol
 *   { "userId": "usr_…" }                           every protocol
 *   { "email": "…", "protocol": "xray-vmess-ws" }   one protocol
 *
 * Deliberately NOT a session-authenticated `/admin` route: the token also
 * works when the operator cannot sign in (locked out, bot down), which is
 * exactly when a leaked config needs killing. It is deliberately not a
 * user-facing route either — a customer must not be able to rotate their way
 * around an entitlement decision.
 *
 * What the operator gets back contains fingerprints, never secrets: the new
 * credential reaches the customer through the normal profile sync. Revocation
 * is immediate in D1; the VPN host removes the old identity on its next pull
 * (`syncWindowSeconds`, the systemd timer's period), so the leaked config
 * stops authenticating within that window rather than at subscription expiry.
 *
 * A revoked credential is rotated but stays revoked (`active: false`): this
 * endpoint replaces secrets, it never re-grants access.
 */

import { z } from 'zod';

import { EmailSchema } from './api';
import { audit } from './auth';
import { authorizeOps, opsClientIp, opsJson } from './ops-auth';
import { generateVpnConfig } from './vpn-config';
import { isPerUserProtocol, rotateVpnCredentials, vpnUsername, PER_USER_PROTOCOLS } from './vpn-users';

import type { Env } from './auth';

/**
 * How long the VPN host may keep the old identity in its config. The host
 * reconciles from a 60s systemd timer (scripts/vps-sync-vpn-users.py): the
 * Worker cannot push, so this is the honest upper bound, not a promise of an
 * instant cut-off. It is returned to the operator so the incident note can say
 * when the leaked config is certainly dead.
 */
export const HOST_SYNC_WINDOW_SECONDS = 60;

const RotateRequestSchema = z
  .object({
    email: EmailSchema.optional(),
    userId: z.string().trim().min(1).max(80).optional(),
    protocol: z.string().trim().min(1).max(64).optional(),
  })
  // Exactly one identifier: accepting both would silently pick one and rotate
  // the wrong account when they disagree.
  .refine((v) => (v.email ? 1 : 0) + (v.userId ? 1 : 0) === 1, {
    message: 'provide exactly one of email or userId',
  });

interface AccountRow {
  id: string;
  email: string;
  disabled: number;
}

/**
 * Handle POST /api/v1/ops/vpn/rotate. Returns null for other paths so the
 * router falls through; otherwise ALWAYS answers (including 405/503/401).
 */
export async function handleOpsVpnRotate(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname.replace(/\/+$/, '') !== '/api/v1/ops/vpn/rotate') return null;
  if (request.method !== 'POST') {
    return opsJson(405, { ok: false, error: 'method_not_allowed' }, { Allow: 'POST' });
  }

  // A rotation is a destructive mutation, so it gets its own (tighter) budget
  // rather than sharing the status page's counter.
  const auth = await authorizeOps(request, env, { bucket: 'ops-rotate', max: 10 });
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return opsJson(400, { ok: false, error: 'invalid_json' });
  }
  const parsed = RotateRequestSchema.safeParse(body);
  if (!parsed.success) {
    return opsJson(400, { ok: false, error: 'invalid_request', message: parsed.error.issues[0]?.message ?? 'invalid body' });
  }
  const { email, userId, protocol } = parsed.data;

  if (protocol !== undefined && !isPerUserProtocol(protocol)) {
    return opsJson(400, {
      ok: false,
      error: 'unsupported_protocol',
      message: `${protocol} has no per-user credential to rotate`,
      allowed: [...PER_USER_PROTOCOLS],
    });
  }
  const only = protocol as (typeof PER_USER_PROTOCOLS)[number] | undefined;

  // Look up the canonical normalized address, not the display column: rows
  // created before normalization (or by an operator) can keep mixed case in
  // `email`, and failing to find the account is not acceptable in an incident.
  // `EmailSchema` already lowercases what reaches here.
  const account = email
    ? await env.DB.prepare(`SELECT id, email, disabled FROM users WHERE normalized_email = ?`).bind(email).first<AccountRow>()
    : await env.DB.prepare(`SELECT id, email, disabled FROM users WHERE id = ?`).bind(userId).first<AccountRow>();
  if (!account) return opsJson(404, { ok: false, error: 'account_not_found' });
  // A disabled account is refused rather than rotated: its tunnel is already
  // supposed to be closed, and an operator should re-enable it deliberately
  // (which is the action that should mint a new identity) rather than treat a
  // disabled account as a normal rotation target.
  if (account.disabled === 1) return opsJson(409, { ok: false, error: 'account_disabled' });

  const rotated = await rotateVpnCredentials(env.DB, account.id, only);
  if (rotated.length === 0) {
    if (only) return opsJson(404, { ok: false, error: 'credential_not_found', message: `This account has no ${only} credential` });
    return opsJson(409, {
      ok: false,
      error: 'no_credentials',
      message: 'This account has no per-user VPN credentials yet — provision it first',
    });
  }

  // Rebuild the STORED client configs with the new secrets. Without this the
  // app would keep syncing the leaked identity until its next provision call,
  // which is precisely the config the operator is trying to kill.
  const now = Date.now();
  let profilesUpdated = 0;
  for (const row of rotated) {
    // Hysteria authenticates with `user:password`; the app passes the whole
    // string through as the client's auth value (see proxyCores).
    const credential = row.protocol === 'hysteria2' ? `${await vpnUsername(account.id)}:${row.secret}` : row.secret;
    const gen = generateVpnConfig(row.protocol, env, credential);
    if (!gen.ok) continue;
    // Only the rows provisioning created (`vpn_${newId('vp')}`), not the
    // `np-local-…` envelopes the desktop mirrors (those deliberately carry
    // `config: '{}'` and are overwritten by the app on every sync anyway).
    const profiles = await env.DB
      .prepare(`SELECT id FROM vpn_profiles WHERE user_id = ? AND protocol = ? AND deleted_at IS NULL AND id GLOB 'vpn_vp_*'`)
      .bind(account.id, row.protocol)
      .all<{ id: string }>();
    const ids = profiles.results ?? [];
    if (ids.length === 0) continue;
    await env.DB.batch(
      ids.map((p) =>
        env.DB
          .prepare(`UPDATE vpn_profiles SET config = ?, config_version = config_version + 1, updated_at = ? WHERE id = ? AND user_id = ?`)
          .bind(JSON.stringify(gen.config), now, p.id, account.id),
      ),
    );
    profilesUpdated += ids.length;
  }

  // The audit row names the TARGET account (that is whose identity changed)
  // and records the actor in the detail, because the ops token has no user id.
  await audit(
    env.DB,
    'vpn.credentials.rotated',
    account.id,
    opsClientIp(request),
    `by:ops-token protocols:${rotated.map((r) => r.protocol).join(',')} profiles:${profilesUpdated}`,
  );

  return opsJson(200, {
    ok: true,
    account: { id: account.id, email: account.email },
    rotated: rotated.map((r) => ({
      protocol: r.protocol,
      previousFingerprint: r.previousFingerprint,
      fingerprint: r.fingerprint,
      // `false` means the row was already revoked: the secret changed, but the
      // host still will not accept this identity (a rotation grants nothing).
      active: r.active,
    })),
    profilesUpdated,
    syncWindowSeconds: HOST_SYNC_WINDOW_SECONDS,
  });
}
