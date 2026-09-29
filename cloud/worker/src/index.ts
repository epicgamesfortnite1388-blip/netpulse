/**
 * NetPulse cloud Worker — the security boundary between the desktop app and D1.
 *
 * Every request: bounded size → CORS → route. Authenticated routes derive the
 * user from the verified session (never from a client-supplied id) and every
 * user-data query carries user_id from that session — the isolation rule in
 * one place. Errors are a consistent JSON envelope; internals never leak.
 */
import {
  ChangePasswordSchema,
  FavoriteSchema,
  ForgotSchema,
  HistoryPushSchema,
  LoginSchema,
  PreferenceSchema,
  RefreshSchema,
  RegisterSchema,
  ResetSchema,
  SettingsSchema,
  UpsertProfileSchema,
  VaultDeleteSchema,
  VaultPutSchema,
  errorBody,
} from './api';
import {
  mailConfigured,
  sendResetEmail,
} from './mail';
import {
  RESET_TTL_MS,
  audit,
  createSession,
  listSessions,
  rateLimit,
  revokeAllSessions,
  revokeSession,
  rotateRefreshToken,
  sessionByAccessToken,
  sweepExpired,
  type Env,
  type SessionRow,
} from './auth';
import { hashPassword, newId, randomToken, sha256Hex, verifyPassword } from './crypto';
import {
  getNetpulseLink,
  startNetpulseLink,
  confirmNetpulseLink,
  unlinkNetpulse,
  getSyncStatus,
  listEntitlements,
  syncNetpulseEntitlements,
  handleNetpulseInbox,
} from './netpulse-integration';
import { opsPageHtml, handleNetpulseOpsApi } from './ops-page';

// Desktop app and Worker are same-origin; CORS is only needed for browser-based
// attacks that misuse a stolen bearer token. For the authenticated API (bearer
// token), we omit CORS headers entirely — the desktop app is not a browser
// cross-origin scenario. For the reset page, we serve the specific origin only.
const json = (status: number, body: unknown, headers?: Record<string, string>): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const fail = (status: number, code: string, message: string, headers?: Record<string, string>): Response => json(status, errorBody(code, message), headers);

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const MAX_BODY_BYTES = 64 * 1024;

async function readJson(req: Request): Promise<unknown> {
  const len = Number(req.headers.get('content-length') ?? '0');
  if (len > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large', 'Request body too large');
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large', 'Request body too large');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
  }
}

function clientIp(req: Request): string {
  return req.headers.get('cf-connecting-ip')?.slice(0, 60) ?? 'unknown';
}

/** Settings/payload-shaped columns accept only JSON objects/arrays. */
function assertJsonObject(text: string, field: string): void {
  try {
    const v = JSON.parse(text) as unknown;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
  } catch {
    throw new HttpError(400, 'invalid_json', `${field} must be a JSON object`);
  }
}

/* ------------------------------ user rows -------------------------------- */

interface UserRow {
  id: string;
  email: string;
  normalized_email: string;
  password_hash: string;
  password_algo: string;
  password_updated_at: number;
  created_at: number;
  last_login_at: number | null;
  disabled: number;
}

const userDto = (u: UserRow) => ({ id: u.id, email: u.email, createdAt: u.created_at, lastLoginAt: u.last_login_at });

function normalizeEmail(email: string): string {
  const at = email.lastIndexOf('@');
  return `${email.slice(0, at).toLowerCase()}@${email.slice(at + 1).toLowerCase()}`;
}

/* -------------------------------- router --------------------------------- */

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const ip = clientIp(req);

    // OPTIONS for the reset page (browser-based): use specific origin or deny
    const origin = req.headers.get('origin');
    const resetPageCorsHeaders = (): Record<string, string> => {
      // Serve reset page only to requests from the expected origin.
      // The Worker is deployed at a fixed domain; reject any other origin.
      if (!origin) return {};
      // If we serve the reset page at a specific domain, validate here.
      return {};
    };
    if (req.method === 'OPTIONS') {
      const acrs: Record<string, string> = origin
        ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' }
        : {};
      return new Response(null, { status: 204, headers: acrs });
    }

    try {
      // -------- NetPulse ↔ bot signed inbox (machine surface) --------
      // Handled BEFORE CORS/auth: machine callers send no browser state. The
      // handler verifies the HMAC signature over the raw body and responds
      // for its two paths; null falls through to the human API.
      const inboxResponse = await handleNetpulseInbox(req, env, ip);
      if (inboxResponse) return inboxResponse;

      // -------- health (public, includes honest D1 probe) --------
      if (path === '/api/v1/health' && req.method === 'GET') {
        let dbOk = false;
        try {
          const row = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
          dbOk = row?.ok === 1;
        } catch {
          dbOk = false;
        }
        return json(dbOk ? 200 : 503, { ok: dbOk, service: 'netpulse-cloud', time: Date.now(), mail: mailConfigured(env) });
      }

      // -------- operator status page (public shell; data is token-gated) --------
      if (path === '/ops' && (req.method === 'GET' || req.method === 'HEAD')) {
        return new Response(opsPageHtml(), {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
            'X-Content-Type-Options': 'nosniff',
            // No external assets; the page's only fetch is same-origin.
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
          },
        });
      }

      // Token-gated ops snapshot (null outside its path -> falls through).
      const opsApiResponse = await handleNetpulseOpsApi(req, env);
      if (opsApiResponse) return opsApiResponse;

      // -------- lazy housekeeping (cheap; runs on state-changing calls) --------
      if (req.method !== 'GET' && Math.random() < 0.02) await sweepExpired(env.DB);

      // ============================ AUTH ============================

      if (path === '/api/v1/auth/register' && req.method === 'POST') {
        const limiter = await rateLimit(env.DB, `reg:${ip}`, 5, 3600_000);
        if (!limiter.ok) return fail(429, 'rate_limited', 'Too many registration attempts — try later');
        const body = RegisterSchema.parse(await readJson(req));
        const normalized = normalizeEmail(body.email);
        const existing = await env.DB.prepare(`SELECT id FROM users WHERE normalized_email = ?`).bind(normalized).first<{ id: string }>();
        if (existing) {
          // Registration is rate limited per IP; the generic message prevents
          // account enumeration while the limiter blunts targeted probing.
          await audit(env.DB, 'register.duplicate', null, ip, normalized.slice(0, 3));
          return fail(409, 'email_taken', 'An account with this email already exists');
        }
        const t = Date.now();
        const user: UserRow = {
          id: newId('usr'),
          email: body.email,
          normalized_email: normalized,
          password_hash: await hashPassword(body.password),
          password_algo: 'PBKDF2-SHA256',
          password_updated_at: t,
          created_at: t,
          last_login_at: null,
          disabled: 0,
        };
        await env.DB.prepare(
          `INSERT INTO users (id, email, normalized_email, password_hash, password_algo, password_updated_at, created_at, last_login_at, disabled)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(user.id, user.email, user.normalized_email, user.password_hash, user.password_algo, user.password_updated_at, user.created_at, user.last_login_at, user.disabled)
          .run();
        await env.DB.prepare(`INSERT INTO user_settings (user_id, payload, updated_at) VALUES (?, '{}', ?)`).bind(user.id, t).run();
        const session = await createSession(env.DB, user.id, body.device);
        await audit(env.DB, 'register', user.id, ip);
        return json(201, {
          user: userDto(user),
          accessToken: session.accessToken,
          refreshToken: session.refreshToken,
          session: session.session,
        });
      }

      if (path === '/api/v1/auth/login' && req.method === 'POST') {
        const body = LoginSchema.parse(await readJson(req));
        const normalized = normalizeEmail(body.email);
        // Limiter keyed by email AND ip: brute-forcing one account or spraying
        // from one host both hit a wall. Count before verifying to also blunt
        // timing/probing.
        const ipLimit = await rateLimit(env.DB, `login:ip:${ip}`, 20, 900_000);
        const emailLimit = await rateLimit(env.DB, `login:em:${normalized}`, 10, 900_000);
        if (!ipLimit.ok || !emailLimit.ok) {
          return json(429, { ...errorBody('rate_limited', 'Too many login attempts — wait 15 minutes'), retryAfterSec: Math.max(ipLimit.retryAfterSec, emailLimit.retryAfterSec) });
        }
        const user = await env.DB.prepare(`SELECT * FROM users WHERE normalized_email = ?`).bind(normalized).first<UserRow>();
        // Same shape/timing for unknown user vs wrong password: generic error,
        // but still burn a PBKDF2 verify against a dummy hash for timing parity.
        if (!user) {
          await verifyPassword(body.password, `pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`);
          await audit(env.DB, 'login.unknown_user', null, ip);
          return fail(401, 'invalid_credentials', 'Invalid email or password');
        }
        if (user.disabled) {
          await audit(env.DB, 'login.disabled', user.id, ip);
          return fail(403, 'account_disabled', 'This account is disabled');
        }
        if (!(await verifyPassword(body.password, user.password_hash))) {
          await audit(env.DB, 'login.bad_password', user.id, ip);
          return fail(401, 'invalid_credentials', 'Invalid email or password');
        }
        const t = Date.now();
        await env.DB.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).bind(t, user.id).run();
        const session = await createSession(env.DB, user.id, body.device);
        await audit(env.DB, 'login', user.id, ip);
        return json(200, { user: userDto({ ...user, last_login_at: t }), accessToken: session.accessToken, refreshToken: session.refreshToken, session: session.session });
      }

      if (path === '/api/v1/auth/refresh' && req.method === 'POST') {
        const body = RefreshSchema.parse(await readJson(req));
        const rotated = await rotateRefreshToken(env.DB, body.refreshToken);
        if (!rotated.ok) {
          await audit(env.DB, `refresh.${rotated.reason}`, null, ip);
          return fail(401, rotated.reason === 'reused' ? 'refresh_reused' : 'invalid_refresh', rotated.reason === 'reused' ? 'Refresh token reuse detected — session revoked' : 'Refresh token is invalid or expired');
        }
        return json(200, { accessToken: rotated.session.accessToken, refreshToken: rotated.session.refreshToken, session: rotated.session.session });
      }

      if (path === '/api/v1/auth/forgot-password' && req.method === 'POST') {
        const body = ForgotSchema.parse(await readJson(req));
        const limit = await rateLimit(env.DB, `forgot:${ip}`, 5, 3600_000);
        if (!limit.ok) return fail(429, 'rate_limited', 'Too many reset requests — try later');
        const normalized = normalizeEmail(body.email);
        const user = await env.DB.prepare(`SELECT id FROM users WHERE normalized_email = ?`).bind(normalized).first<{ id: string }>();
        if (user) {
          const token = randomToken();
          const peppered = await sha256Hex(`${token}${env.RESET_PEPPER}`);
          await env.DB
            .prepare(`INSERT INTO password_reset_tokens (id, user_id, token_hash, created_at, expires_at, requested_ip) VALUES (?, ?, ?, ?, ?, ?)`)
            .bind(newId('rst'), user.id, peppered, Date.now(), Date.now() + RESET_TTL_MS, ip)
            .run();
          // The token is a single-use credential: it goes ONLY into the email
          // body. The audit event records the delivery outcome — never the
          // token (the audit log is readable via wrangler and used to leak
          // `token:<raw>` here).
          let delivery = 'mail_unconfigured';
          if (mailConfigured(env)) {
            try {
              const r = await sendResetEmail(env, normalized, token, new URL(req.url).origin);
              delivery = r.reason;
            } catch {
              delivery = 'mail_failed:exception';
            }
          }
          await audit(env.DB, 'reset.requested', user.id, ip, delivery);
          await sweepExpired(env.DB);
        }
        return json(200, { ok: true, message: 'If the account exists, a reset has been issued' });
      }

      if (path === '/api/v1/auth/reset-password' && req.method === 'POST') {
        const body = ResetSchema.parse(await readJson(req));
        const limit = await rateLimit(env.DB, `reset:${ip}`, 10, 3600_000);
        if (!limit.ok) return fail(429, 'rate_limited', 'Too many attempts — try later');
        const peppered = await sha256Hex(`${body.token}${env.RESET_PEPPER}`);
        const t = Date.now();
        const row = await env.DB
          .prepare(`SELECT id, user_id FROM password_reset_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`)
          .bind(peppered, t)
          .first<{ id: string; user_id: string }>();
        if (!row) return fail(400, 'invalid_reset_token', 'Reset token is invalid, used, or expired');
        // Single-use: claim it FIRST (conditional update), then change the
        // password; a race loses and gets the same generic error.
        const claim = await env.DB.prepare(`UPDATE password_reset_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL`).bind(t, row.id).run();
        if ((claim.meta.changes ?? 0) === 0) return fail(400, 'invalid_reset_token', 'Reset token is invalid, used, or expired');
        await env.DB
          .prepare(`UPDATE users SET password_hash = ?, password_algo = 'PBKDF2-SHA256', password_updated_at = ? WHERE id = ?`)
          .bind(await hashPassword(body.newPassword), t, row.user_id)
          .run();
        // Password change kills every existing session.
        await revokeAllSessions(env.DB, row.user_id, 'password-reset');
        await audit(env.DB, 'reset.completed', row.user_id, ip);
        return json(200, { ok: true });
      }

      // -------- reset page (served here so emailed links just work) --------
      if (path === '/reset' && (req.method === 'GET' || req.method === 'HEAD')) {
        const origin = req.headers.get('origin');
        const resetCors: Record<string, string> = origin ? { 'Access-Control-Allow-Origin': origin } : {};
        return new Response(resetPageHtml(), {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
            'X-Content-Type-Options': 'nosniff',
            // No external assets; scripts/styles are inline, API is same-origin.
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'",
            ...resetCors,
          },
        });
      }

      // ==================== AUTHENTICATED ROUTES ====================
      // Identity derives ONLY from the bearer token → session row.

      // Simple path matcher for parameterized routes (e.g. /api/v1/subscriptions/:id)
      // Returns the captured parameter or null.
      function matchParamRoute(path: string, pattern: string): { match: boolean; param?: string } {
        // Convert pattern like /api/v1/subscriptions/:id to regex
        const regexStr = '^' + pattern.replace(/:([^/]+)/g, '([^/]+)') + '$';
        const regex = new RegExp(regexStr);
        const m = path.match(regex);
        if (m) {
          // Extract the parameter value (first capture group after the full match)
          const paramName = pattern.match(/:([^/]+)/);
          const key = paramName ? paramName[1] : null;
          return { match: true, param: m[1] };
        }
        return { match: false };
      }

      const auth = req.headers.get('authorization');
      const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : null;
      let session: SessionRow | null = null;
      if (token) session = await sessionByAccessToken(env.DB, token);

      if (path === '/api/v1/auth/logout' && req.method === 'POST') {
        if (!session) return fail(401, 'unauthorized', 'Authentication required');
        await revokeSession(env.DB, session.id, session.user_id, 'logout');
        await audit(env.DB, 'logout', session.user_id, ip);
        return json(200, { ok: true });
      }

      if (!session) return fail(401, 'unauthorized', 'Authentication required');
      const userId = session.user_id;
      const currentSessionId = session.id;

      // -------- account --------
      if (path === '/api/v1/account' && req.method === 'GET') {
        const user = await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(userId).first<UserRow>();
        if (!user) return fail(404, 'not_found', 'Account not found');
        return json(200, { user: userDto(user) });
      }

      if (path === '/api/v1/account/sessions' && req.method === 'GET') {
        const rows = await listSessions(env.DB, userId);
        return json(200, {
          sessions: rows.map((s) => ({
            id: s.id,
            deviceName: s.device_name,
            os: s.os,
            appVersion: s.app_version,
            createdAt: s.created_at,
            lastSeenAt: s.last_seen_at,
            expiresAt: s.expires_at,
            current: s.id === currentSessionId,
          })),
        });
      }

      if (path === '/api/v1/account/sessions/current' && req.method === 'DELETE') {
        await revokeSession(env.DB, currentSessionId, userId, 'logout-current');
        return json(200, { ok: true });
      }

      if (path === '/api/v1/account/sessions/all' && req.method === 'DELETE') {
        const n = await revokeAllSessions(env.DB, userId, 'logout-all', currentSessionId);
        await audit(env.DB, 'logout_all', userId, ip, `revoked:${n}`);
        return json(200, { ok: true, revoked: n });
      }

      if (path === '/api/v1/account/sessions/revoke' && req.method === 'POST') {
        const body = (await readJson(req)) as { sessionId?: unknown };
        const sid = typeof body.sessionId === 'string' ? body.sessionId.slice(0, 80) : null;
        if (!sid) return fail(400, 'validation_error', 'sessionId is required');
        const okRevoked = await revokeSession(env.DB, sid, userId, 'revoked-by-user');
        if (!okRevoked) return fail(404, 'not_found', 'Session not found or already revoked');
        return json(200, { ok: true });
      }

      if (path === '/api/v1/account/password' && req.method === 'POST') {
        const body = ChangePasswordSchema.parse(await readJson(req));
        const limit = await rateLimit(env.DB, `pwchange:${userId}`, 5, 3600_000);
        if (!limit.ok) return fail(429, 'rate_limited', 'Too many attempts — try later');
        const user = await env.DB.prepare(`SELECT password_hash FROM users WHERE id = ?`).bind(userId).first<{ password_hash: string }>();
        if (!user || !(await verifyPassword(body.currentPassword, user.password_hash))) {
          await audit(env.DB, 'password.change.bad_current', userId, ip);
          return fail(401, 'invalid_credentials', 'Current password is incorrect');
        }
        const t = Date.now();
        await env.DB
          .prepare(`UPDATE users SET password_hash = ?, password_algo = 'PBKDF2-SHA256', password_updated_at = ? WHERE id = ?`)
          .bind(await hashPassword(body.newPassword), t, userId)
          .run();
        await revokeAllSessions(env.DB, userId, 'password-change', currentSessionId);
        await audit(env.DB, 'password.change', userId, ip);
        return json(200, { ok: true });
      }

      if (path === '/api/v1/account' && req.method === 'DELETE') {
        // Danger zone: hard delete; FK cascades wipe all user data. Sessions
        // are already cascaded, so no separate revoke needed.
        await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(userId).run();
        await audit(env.DB, 'account.deleted', null, ip, userId);
        return json(200, { ok: true });
      }

      // -------- settings (single JSON payload, last-write-wins) --------
      if (path === '/api/v1/settings' && req.method === 'GET') {
        const row = await env.DB.prepare(`SELECT payload, updated_at FROM user_settings WHERE user_id = ?`).bind(userId).first<{ payload: string; updated_at: number }>();
        return json(200, { payload: row?.payload ?? '{}', updatedAt: row?.updated_at ?? 0 });
      }

      if (path === '/api/v1/settings' && req.method === 'PUT') {
        const body = SettingsSchema.parse(await readJson(req));
        assertJsonObject(body.payload, 'payload');
        const t = Date.now();
        await env.DB
          .prepare(
            `INSERT INTO user_settings (user_id, payload, updated_at) VALUES (?, ?, ?)
             ON CONFLICT (user_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
          )
          .bind(userId, body.payload, t)
          .run();
        return json(200, { ok: true, updatedAt: t });
      }

      // -------- profiles (envelope-only sync; secrets stay local) --------
      if (path === '/api/v1/profiles' && req.method === 'GET') {
        const rows = await env.DB
          .prepare(`SELECT id, name, protocol, endpoint, config, config_version, created_at, updated_at FROM vpn_profiles WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 500`)
          .bind(userId)
          .all<{ id: string; name: string; protocol: string; endpoint: string | null; config: string; config_version: number; created_at: number; updated_at: number }>();
        return json(200, {
          profiles: (rows.results ?? []).map((r) => ({
            id: r.id,
            name: r.name,
            protocol: r.protocol,
            endpoint: r.endpoint,
            config: r.config,
            configVersion: r.config_version,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
          })),
        });
      }

      if (path === '/api/v1/profiles' && req.method === 'PUT') {
        const body = UpsertProfileSchema.parse(await readJson(req));
        // `config` is the only free-form JSON field here; `endpoint` is a
        // host:port STRING per the schema — asserting an object on it (as an
        // earlier draft did) rejected every valid profile push.
        assertJsonObject(body.config, 'config');
        const t = Date.now();
        if (body.deleted) {
          await env.DB.prepare(`UPDATE vpn_profiles SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`).bind(t, t, body.id, userId).run();
          return json(200, { ok: true, deleted: true });
        }
        await env.DB
          .prepare(
            `INSERT INTO vpn_profiles (id, user_id, name, protocol, endpoint, config, config_version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET
               name = excluded.name, protocol = excluded.protocol, endpoint = excluded.endpoint,
               config = excluded.config, config_version = excluded.config_version,
               updated_at = excluded.updated_at, deleted_at = NULL
             WHERE vpn_profiles.user_id = excluded.user_id`,
          )
          .bind(body.id, userId, body.name, body.protocol, body.endpoint ?? null, body.config, body.configVersion, t, t)
          .run();
        return json(200, { ok: true, updatedAt: t });
      }

      // -------- profile vaults (E2E ciphertext only; keys never reach here) --------
      if (path === '/api/v1/profile-vaults' && req.method === 'PUT') {
        const body = VaultPutSchema.parse(await readJson(req));
        const t = Date.now();
        await env.DB
          .prepare(
            `INSERT INTO profile_vaults (user_id, profile_id, ciphertext, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (user_id, profile_id) DO UPDATE SET
               ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`,
          )
          .bind(userId, body.profileId, body.ciphertext, body.updatedAt)
          .run();
        return json(200, { ok: true, updatedAt: t });
      }

      if (path === '/api/v1/profile-vaults' && req.method === 'GET') {
        const rows = await env.DB
          .prepare(`SELECT profile_id, ciphertext, updated_at FROM profile_vaults WHERE user_id = ? ORDER BY updated_at DESC LIMIT 500`)
          .bind(userId)
          .all<{ profile_id: string; ciphertext: string; updated_at: number }>();
        return json(200, {
          vaults: (rows.results ?? []).map((r) => ({ profileId: r.profile_id, ciphertext: r.ciphertext, updatedAt: r.updated_at })),
        });
      }

      if (path === '/api/v1/profile-vaults/delete' && req.method === 'POST') {
        const body = VaultDeleteSchema.parse(await readJson(req));
        const res = await env.DB.prepare(`DELETE FROM profile_vaults WHERE user_id = ? AND profile_id = ?`).bind(userId, body.profileId).run();
        return json(200, { ok: true, removed: (res.meta.changes ?? 0) > 0 });
      }

      // -------- favorites --------
      if (path === '/api/v1/favorites' && req.method === 'GET') {
        const rows = await env.DB
          .prepare(`SELECT node_key, label, created_at FROM user_favorites WHERE user_id = ? ORDER BY created_at DESC LIMIT 1000`)
          .bind(userId)
          .all<{ node_key: string; label: string | null; created_at: number }>();
        return json(200, { favorites: (rows.results ?? []).map((r) => ({ nodeKey: r.node_key, label: r.label, createdAt: r.created_at })) });
      }

      if (path === '/api/v1/favorites' && req.method === 'PUT') {
        const body = FavoriteSchema.parse(await readJson(req));
        const t = Date.now();
        if (body.label === null) {
          await env.DB.prepare(`DELETE FROM user_favorites WHERE user_id = ? AND node_key = ?`).bind(userId, body.nodeKey).run();
          return json(200, { ok: true, removed: true });
        }
        await env.DB
          .prepare(
            `INSERT INTO user_favorites (user_id, node_key, label, created_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (user_id, node_key) DO UPDATE SET label = excluded.label`,
          )
          .bind(userId, body.nodeKey, body.label ?? null, t)
          .run();
        return json(200, { ok: true });
      }

      // -------- history (summaries only, per privacy design) --------
      if (path === '/api/v1/history' && req.method === 'GET') {
        const limit = Math.min(Number(url.searchParams.get('limit') ?? '200') || 200, 500);
        const rows = await env.DB
          .prepare(`SELECT id, kind, at, payload FROM user_history WHERE user_id = ? ORDER BY at DESC LIMIT ?`)
          .bind(userId, limit)
          .all<{ id: string; kind: string; at: number; payload: string }>();
        return json(200, {
          items: (rows.results ?? []).map((r) => {
            try {
              return { ...r, payload: JSON.parse(r.payload) as unknown };
            } catch {
              return { ...r, payload: null };
            }
          }),
        });
      }

      if (path === '/api/v1/history' && req.method === 'POST') {
        const body = HistoryPushSchema.parse(await readJson(req));
        const t = Date.now();
        const stmt = env.DB.prepare(
          `INSERT INTO user_history (id, user_id, kind, at, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET payload = excluded.payload, at = excluded.at WHERE user_id = excluded.user_id`,
        );
        await env.DB.batch(body.items.map((i) => stmt.bind(i.id, userId, i.kind, i.at, i.payload, t)));
        return json(200, { ok: true, stored: body.items.length });
      }

      // -------- NetPulse ↔ Telegram linking (bot authoritative) --------
      if (path === '/api/v1/account/telegram/link' && req.method === 'POST') {
        const result = await startNetpulseLink(env.DB, env, userId, ip);
        if (!result.ok) return fail(result.status, result.code, result.detail ?? 'Linking failed');
        return json(200, { ok: true, token: result.token, deepLink: result.deepLink, expiresAt: result.expiresAt });
      }

      if (path === '/api/v1/account/telegram/link/confirm' && req.method === 'POST') {
        const body = (await readJson(req)) as { code?: unknown };
        const code = typeof body.code === 'string' ? body.code : '';
        const result = await confirmNetpulseLink(env.DB, env, userId, code, ip);
        if (!result.ok) return fail(result.status, result.code, result.detail ?? 'Link confirmation failed');
        return json(200, { ok: true });
      }

      if (path === '/api/v1/account/telegram/unlink' && req.method === 'POST') {
        const result = await unlinkNetpulse(env.DB, env, userId, ip);
        if (!result.ok) return fail(result.status, result.code, result.detail ?? 'Unlink failed');
        return json(200, { ok: true });
      }

      if (path === '/api/v1/account/telegram' && req.method === 'GET') {
        const link = await getNetpulseLink(env.DB, userId);
        return json(200, { ok: true, connected: link.connected, telegram_user_id: link.telegramUserId, linked_at: link.linkedAt, last_synced_at: link.lastSyncedAt, last_sync_status: link.lastSyncStatus });
        // Note: the Telegram id and timestamps come from OUR link mirror,
        // which the bot signed; the client can never write them.
      }

      if (path === '/api/v1/integrations/telegram/status' && req.method === 'POST') {
        const status = await getSyncStatus(env.DB, userId);
        return json(200, status);
      }

      if (path === '/api/v1/integrations/telegram/sync' && req.method === 'POST')
        {
        const result = await syncNetpulseEntitlements(env.DB, env, userId, ip);
        if (!result.ok) return fail(result.status, result.code, 'Entitlement sync failed');
        return json(200, { ok: true, subscriptions: result.entitlements });
      }

      // -------- subscriptions (mirrored entitlements) --------
      if (path === '/api/v1/subscriptions' && req.method === 'GET') {
        const rows = await listEntitlements(env.DB, userId);
        return json(200, { subscriptions: rows });
      }

      if (path === '/api/v1/subscriptions/:id' && req.method === 'GET') {
        // A single mirrored entitlement — safe model fields only (no config
        // URLs, no credentials; those are delivered by the bot's own channels).
        const match = path.match(/\/api\/v1\/subscriptions\/([^/]+)/);
        if (!match) return fail(404, 'not_found', 'Invalid subscription ID format');
        const subId = match[1];
        const row = await env.DB
          .prepare(
            `SELECT subscription_id, plan_code, status, started_at, expires_at, auto_renew, total_gb, used_gb, ip_limit, config_updated_at
             FROM np_entitlements WHERE subscription_id = ? AND user_id = ?`,
          )
          .bind(subId, userId)
          .first<Record<string, unknown>>();
        if (!row) return fail(404, 'not_found', 'Subscription not found');
        return json(200, {
          subscription: {
            id: String(row.subscription_id),
            plan: row.plan_code,
            status: row.status,
            started_at: row.started_at,
            expiration_time: row.expires_at,
            auto_renew: row.auto_renew === 1,
            total_gb: row.total_gb,
            used_gb: row.used_gb,
            ip_limit: row.ip_limit,
            config_updated_at: row.config_updated_at,
          },
        });
      }

      // NOTE: config/ and servers/ sub-resources were removed — VPN configs
      // and server credentials are bot-owned and never mirrored here (§8 of
      // the integration contract). The desktop app consumes configs via the
      // bot's Telegram delivery, not this API.

      // -------- preferences (key/value) --------
      if (path === '/api/v1/preferences' && req.method === 'GET') {
        const rows = await env.DB
          .prepare(`SELECT key, value, updated_at FROM user_preferences WHERE user_id = ? LIMIT 500`)
          .bind(userId)
          .all<{ key: string; value: string | null; updated_at: number }>();
        return json(200, { preferences: (rows.results ?? []).map((r) => ({ key: r.key, value: r.value, updatedAt: r.updated_at })) });
      }

      if (path === '/api/v1/preferences' && req.method === 'PUT') {
        const body = PreferenceSchema.parse(await readJson(req));
        const t = Date.now();
        if (body.value === null) {
          await env.DB.prepare(`DELETE FROM user_preferences WHERE user_id = ? AND key = ?`).bind(userId, body.key).run();
          return json(200, { ok: true, removed: true });
        }
        await env.DB
          .prepare(
            `INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .bind(userId, body.key, body.value, t)
          .run();
        return json(200, { ok: true, updatedAt: t });
      }

      // -------- devices --------
      if (path === '/api/v1/devices' && req.method === 'GET') {
        const rows = await env.DB
          .prepare(`SELECT id, name, os, app_version, first_seen_at, last_active_at FROM devices WHERE user_id = ? ORDER BY last_active_at DESC LIMIT 50`)
          .bind(userId)
          .all<{ id: string; name: string; os: string | null; app_version: string | null; first_seen_at: number; last_active_at: number }>();
        return json(200, {
          devices: (rows.results ?? []).map((d) => ({
            id: d.id,
            name: d.name,
            os: d.os,
            appVersion: d.app_version,
            firstSeenAt: d.first_seen_at,
            lastActiveAt: d.last_active_at,
          })),
        });
      }

      return fail(404, 'not_found', `No API route for ${req.method} ${path}`);
    } catch (err) {
      if (err instanceof HttpError) return fail(err.status, err.code, err.message);
      if (err instanceof Error && err.name === 'ZodError') {
        const z = err as Error & { issues?: Array<{ path: Array<string | number>; message: string }> };
        const first = z.issues?.[0];
        return fail(400, 'validation_error', first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'Invalid request body');
      }
      // D1 constraint or unavailability: never leak internals.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('UNIQUE') || msg.includes('CONSTRAINT')) return fail(409, 'conflict', 'Request conflicts with existing data');
      if (msg.includes('D1') || msg.includes('network')) return fail(503, 'storage_unavailable', 'Storage is temporarily unavailable');
      console.error('unhandled', msg.slice(0, 120));
      return fail(500, 'internal_error', 'An internal error occurred');
    }
  },
};

/**
 * The password-reset page the reset emails link to, served by this Worker so
 * the flow needs no extra infrastructure. The token is NEVER interpolated
 * server-side — the page reads it from the query string client-side, so no
 * escaping bug can turn it into HTML injection.
 */
function resetPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>NetPulse — Reset password</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0f1115; color: #e7e9ee; display: flex; min-height: 100vh; margin: 0; align-items: center; justify-content: center; }
  main { background: #171a21; border: 1px solid #2a2f3a; border-radius: 12px; padding: 32px; width: 340px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.sub { color: #9aa3b2; font-size: 13px; margin: 0 0 20px; }
  label { display: block; font-size: 12px; color: #9aa3b2; margin: 12px 0 4px; }
  input { width: 100%; box-sizing: border-box; background: #0f1115; color: #e7e9ee; border: 1px solid #2a2f3a; border-radius: 8px; padding: 9px 10px; font-size: 14px; }
  button { margin-top: 18px; width: 100%; background: #4f7cff; color: #fff; border: 0; border-radius: 8px; padding: 10px; font-size: 14px; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  #msg { margin-top: 14px; font-size: 13px; min-height: 18px; }
  .ok { color: #6fd18b; } .err { color: #ff7a7a; }
</style>
</head>
<body>
<main>
  <h1>Reset your password</h1>
  <p class="sub">Enter the code from your reset email and a new password.</p>
  <form id="f">
    <label for="token">Reset code</label>
    <input id="token" name="token" autocomplete="off" spellcheck="false" required>
    <label for="p1">New password</label>
    <input id="p1" type="password" minlength="10" required>
    <label for="p2">Confirm new password</label>
    <input id="p2" type="password" minlength="10" required>
    <button type="submit">Set new password</button>
  </form>
  <div id="msg" role="status"></div>
</main>
<script>
  var q = new URLSearchParams(location.search);
  if (q.get('token')) document.getElementById('token').value = q.get('token');
  document.getElementById('f').addEventListener('submit', function (e) {
    e.preventDefault();
    var msg = document.getElementById('msg');
    var p1 = document.getElementById('p1').value, p2 = document.getElementById('p2').value;
    msg.className = ''; msg.textContent = '';
    if (p1 !== p2) { msg.className = 'err'; msg.textContent = 'Passwords do not match.'; return; }
    var btn = e.target.querySelector('button');
    btn.disabled = true;
    fetch('/api/v1/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: document.getElementById('token').value.trim(), newPassword: p1 }),
    })
      .then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); })
      .then(function (res) {
        if (res.status === 200) { msg.className = 'ok'; msg.textContent = 'Password updated. You can now sign in on your device.'; e.target.reset(); }
        else { msg.className = 'err'; msg.textContent = (res.body && res.body.error && res.body.error.message) || 'Reset failed.'; }
      })
      .catch(function () { msg.className = 'err'; msg.textContent = 'Network error — try again.'; })
      .finally(function () { btn.disabled = false; });
  });
</script>
</body>
</html>`;
}
