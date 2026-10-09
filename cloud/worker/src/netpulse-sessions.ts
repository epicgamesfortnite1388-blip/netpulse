/**
 * NetPulse ↔ Abystral — signed-in devices, NetPulse side.
 *
 * The bot half of this integration is Abystral's: it owns every Telegram
 * screen, menu and inline button. What lives here is the *other* half of that
 * contract — the surface the bot calls when a person acts on one of its
 * buttons. Without it, "where am I signed in?" and "sign that device out" are
 * things the user can only answer with the desktop app in front of them, even
 * though the app already does both.
 *
 * This is the session capability the app already ships (GET
 * /api/v1/account/sessions and POST /api/v1/account/sessions/revoke in
 * cloud/worker/src/index.ts), exposed to the bot. Nothing new is invented; the
 * same rows, the same `listSessions`/`revokeSession` helpers, the same
 * isolation rule.
 *
 *   GET    /api/internal/netpulse/v1/session?netpulseAccountId=<npa_…>
 *   DELETE /api/internal/netpulse/v1/session/<sessionId>   { netpulseAccountId }
 *
 * Both are HMAC-signed with NETPULSE_SERVICE_SECRET exactly like the event
 * inbox (np-auth.ts), and both fail closed when it is unset.
 *
 * Identity: the bot proves *which NetPulse account* with `netpulseAccountId` —
 * the stable per-account id the bot already holds from `link.request`, and the
 * one `np_links` already indexes. A Telegram id is never accepted here, and
 * neither is a NetPulse user id: an unlinked or revoked link resolves to
 * nothing, so the surface cannot be pointed at an arbitrary account.
 *
 * Deliberately absent: "sign out everywhere". The app has it, and it is one
 * tap away in Telegram, where a mis-tap has no undo. Revoking one named device
 * is the action a person actually wants and can verify.
 */

import { listSessions, rateLimit, revokeSession, audit, type Env } from './auth';
import { verifyServiceRequest } from './np-auth';

const MAX_BODY_BYTES = 8 * 1024;

/** List cap mirrors the app's own session list. */
const LIST_LIMIT = 50;

export const NP_SESSION_BASE = '/api/internal/netpulse/v1';

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** The safe session view: never a token, never a hash, never the user id. */
function sessionView(s: { id: string; device_name: string | null; os: string | null; app_version: string | null; created_at: number; last_seen_at: number; expires_at: number }) {
  return {
    sessionId: s.id,
    deviceName: s.device_name ?? null,
    os: s.os ?? null,
    appVersion: s.app_version ?? null,
    createdAt: s.created_at,
    lastSeenAt: s.last_seen_at,
    expiresAt: s.expires_at,
  };
}

/**
 * Resolve the NetPulse account behind a bot call.
 *
 * `status = 'active'` is the whole authorization: a link the user revoked is
 * not a key any more, so the bot cannot keep reading or killing sessions for
 * an account that has opted out.
 */
async function resolveLinkedUserId(db: D1Database, netpulseAccountId: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT user_id FROM np_links WHERE netpulse_account_id = ? AND status = 'active' LIMIT 1`)
    .bind(netpulseAccountId)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

/**
 * Handle the bot's device-management calls. Returns null for any other path so
 * the main router falls through; otherwise ALWAYS responds — including on a
 * rejected signature, so a caller never sees a different shape for "not
 * allowed" than for "no such route".
 */
export async function handleNetpulseSessionApi(request: Request, env: Env, ip: string): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  // GET <base>/session, or DELETE <base>/session/<sessionId>
  const deleteMatch = path.match(new RegExp(`^${NP_SESSION_BASE}/session/([^/]+)$`));
  const isList = path === `${NP_SESSION_BASE}/session` && request.method === 'GET';
  const isRevoke = Boolean(deleteMatch) && request.method === 'DELETE';
  if (!isList && !isRevoke) return null;

  const respond = (status: number, body: unknown): Response => json(status, body);

  const bodyText = isRevoke ? await request.text().catch(() => '') : '';
  if (bodyText.length > MAX_BODY_BYTES) return respond(413, { ok: false, error: 'payload_too_large' });

  // Signature is verified over the RAW bytes before anything is parsed, and the
  // canonical string covers the query string — so `netpulseAccountId` in a GET
  // query is authenticated, not merely read.
  const verify = await verifyServiceRequest(request, bodyText, env);
  if (!verify.ok) {
    await audit(env.DB, `np.sessions.rejected:${verify.reason}`, null, ip, isRevoke ? 'revoke' : 'list').catch(() => {});
    return respond(verify.status, { ok: false, error: verify.reason });
  }

  // Identify the account from the signed request — never from a query the
  // signature did not cover, and never from a Telegram id.
  let netpulseAccountId: string | null = null;
  if (isList) {
    netpulseAccountId = url.searchParams.get('netpulseAccountId');
  } else {
    try {
      const parsed = JSON.parse(bodyText || '{}') as { netpulseAccountId?: unknown };
      netpulseAccountId = typeof parsed.netpulseAccountId === 'string' ? parsed.netpulseAccountId : null;
    } catch {
      return respond(400, { ok: false, error: 'invalid_json' });
    }
  }
  if (!netpulseAccountId || netpulseAccountId.length > 80) {
    return respond(400, { ok: false, error: 'missing_netpulse_account_id' });
  }

  // Brute-force wall on the account key, same shape as the ops gate.
  const limiter = await rateLimit(env.DB, `np_sessions:${netpulseAccountId}`, 30, 300_000);
  if (!limiter.ok) {
    return respond(429, { ok: false, error: 'rate_limited' });
  }

  const userId = await resolveLinkedUserId(env.DB, netpulseAccountId);
  if (!userId) {
    // Not an error the bot should surface as "broken" — the link is simply not
    // active. 404 keeps the answer identical for a wrong id and an unlinked one.
    return respond(404, { ok: false, error: 'not_linked' });
  }

  if (isList) {
    const rows = await listSessions(env.DB, userId);
    const sessions = rows.slice(0, LIST_LIMIT).map(sessionView);
    await audit(env.DB, 'np.sessions.listed', userId, ip, `count:${sessions.length}`).catch(() => {});
    return respond(200, { ok: true, data: { sessions } });
  }

  // Revoke exactly one session, scoped to this user by the helper itself — a
  // session id belonging to another account changes nothing.
  const sessionId = (deleteMatch as RegExpMatchArray)[1];
  const revoked = await revokeSession(env.DB, sessionId, userId, 'telegram-device-revoke');
  if (!revoked) {
    return respond(404, { ok: false, error: 'not_found' });
  }
  await audit(env.DB, 'np.sessions.revoked', userId, ip, `session:${sessionId.slice(0, 24)}`).catch(() => {});
  return respond(200, { ok: true, data: { revoked: true } });
}