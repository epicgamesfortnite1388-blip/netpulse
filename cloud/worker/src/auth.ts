/**
 * NetPulse cloud — sessions, rate limiting, audit.
 *
 * Sessions: opaque bearer token + separate refresh token, both stored only
 * as SHA-256 hashes. Access tokens are short-lived (30 min); refresh tokens
 * rotate on use (the old hash is replaced — replaying a rotated refresh
 * token is detectable because its hash no longer exists, which revokes the
 * whole session chain). Identity is ALWAYS derived from the verified
 * session row, never from a client-supplied user id.
 */
import { newId, randomToken, sha256Hex } from './crypto';

export const ACCESS_TTL_MS = 30 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;
export const RESET_TTL_MS = 30 * 60 * 1000;

export interface Env {
  DB: D1Database;
  AUTH_SECRET: string;
  RESET_PEPPER: string;
  /** Optional mail transport (Resend). Absent = reset emails are disabled. */
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  /** Abystral bot service auth (NetPulse ↔ bot integration). Never committed. */
  NETPULSE_SERVICE_SECRET?: string;
  /** Bot worker's public origin for outbound signed calls. Absent = integration outbound disabled. */
  TELEGRAM_BOT_BASE_URL?: string;
  /** Operator status page token (GET /ops + /api/v1/ops/netpulse). Never committed. */
  OPS_TOKEN?: string;
  /** The deployment origin used to validate reset link hostnames, preventing
   * attacker-controlled reset URLs. Set in wrangler.toml as a string binding. */
  EXPECTED_ORIGIN?: string;
}

export interface SessionRow {
  id: string;
  user_id: string;
  device_name: string | null;
  os: string | null;
  app_version: string | null;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
}

const now = (): number => Date.now();

/* ------------------------------- sessions -------------------------------- */

export interface CreatedSession {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  session: {
    id: string;
    deviceName: string | null;
    os: string | null;
    appVersion: string | null;
    createdAt: number;
    lastSeenAt: number;
    expiresAt: number;
    current: true;
  };
}

export async function createSession(
  db: D1Database,
  userId: string,
  device: { name?: string; os?: string; appVersion?: string } | undefined,
): Promise<CreatedSession> {
  const t = now();
  const sessionId = newId('sess');
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const deviceName = device?.name?.slice(0, 80) ?? 'Desktop';
  const deviceOs = device?.os?.slice(0, 60) ?? null;
  const appVersion = device?.appVersion?.slice(0, 40) ?? null;

  await db
    .prepare(
      `INSERT INTO sessions (id, user_id, token_hash, refresh_hash, device_name, os, app_version, created_at, last_seen_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(sessionId, userId, await sha256Hex(accessToken), await sha256Hex(refreshToken), deviceName, deviceOs, appVersion, t, t, t + REFRESH_TTL_MS)
    .run();

  // Device roster upsert (device identity is informational, never a credential).
  const deviceId = await sha256Hex(`${userId}:${deviceName.toLowerCase()}`).then((h) => `dev_${h.slice(0, 20)}`);
  await db
    .prepare(
      `INSERT INTO devices (id, user_id, name, os, app_version, first_seen_at, last_active_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, name) DO UPDATE SET last_active_at = excluded.last_active_at, app_version = excluded.app_version`,
    )
    .bind(deviceId, userId, deviceName, deviceOs, appVersion, t, t)
    .run();

  return {
    sessionId,
    accessToken,
    refreshToken,
    session: { id: sessionId, deviceName, os: deviceOs, appVersion, createdAt: t, lastSeenAt: t, expiresAt: t + REFRESH_TTL_MS, current: true },
  };
}

/** Verify a bearer token; returns the live session or null. Expired == invalid. */
export async function sessionByAccessToken(db: D1Database, token: string): Promise<SessionRow | null> {
  const t = now();
  const row = await db
    .prepare(
      `SELECT id, user_id, device_name, os, app_version, created_at, last_seen_at, expires_at, revoked_at
       FROM sessions WHERE token_hash = ? LIMIT 1`,
    )
    .bind(await sha256Hex(token))
    .first<SessionRow>();
  if (!row) return null;
  if (row.revoked_at !== null || row.expires_at <= t) return null;
  if (t - row.last_seen_at > 60_000) {
    await db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`).bind(t, row.id).run();
  }
  return row;
}

/** Rotate a refresh token. Reuse of an already-rotated token revokes the session. */
export async function rotateRefreshToken(
  db: D1Database,
  refreshToken: string,
): Promise<{ ok: true; session: CreatedSession } | { ok: false; reason: 'invalid' | 'expired' | 'revoked' | 'reused' }> {
  const t = now();
  const hash = await sha256Hex(refreshToken);
  const row = await db
    .prepare(`SELECT id, user_id, device_name, os, app_version, created_at, revoked_at, expires_at FROM sessions WHERE refresh_hash = ? LIMIT 1`)
    .bind(hash)
    .first<{ id: string; user_id: string; device_name: string | null; os: string | null; app_version: string | null; created_at: number; revoked_at: number | null; expires_at: number }>();
  if (!row) {
    // Not a live refresh token — but if it is a ROTATED one, this is replay:
    // kill the whole session chain (token theft response).
    const tombstone = await db.prepare(`SELECT session_id FROM rotated_refresh_hashes WHERE hash = ? LIMIT 1`).bind(hash).first<{ session_id: string }>();
    if (tombstone) {
      await db.prepare(`UPDATE sessions SET revoked_at = ?, revoked_reason = 'refresh-token-reuse' WHERE id = ? AND revoked_at IS NULL`).bind(t, tombstone.session_id).run();
      return { ok: false, reason: 'reused' };
    }
    return { ok: false, reason: 'invalid' };
  }
  if (row.revoked_at !== null) return { ok: false, reason: 'reused' };
  if (row.expires_at <= t) return { ok: false, reason: 'expired' };

  const newAccess = randomToken();
  const newRefresh = randomToken();
  // Tombstone the old refresh hash so replaying it is DETECTABLE (not merely
  // 'invalid'): a reused refresh token revokes the whole session chain.
  await db
    .prepare(`INSERT INTO rotated_refresh_hashes (hash, session_id, rotated_at) VALUES (?, ?, ?)`)
    .bind(hash, row.id, t)
    .run();
  await db
    .prepare(`UPDATE sessions SET token_hash = ?, refresh_hash = ?, last_seen_at = ?, expires_at = ? WHERE id = ?`)
    .bind(await sha256Hex(newAccess), await sha256Hex(newRefresh), t, t + REFRESH_TTL_MS, row.id)
    .run();
  return {
    ok: true,
    session: {
      sessionId: row.id,
      accessToken: newAccess,
      refreshToken: newRefresh,
      session: {
        id: row.id,
        deviceName: row.device_name,
        os: row.os,
        appVersion: row.app_version,
        createdAt: row.created_at,
        lastSeenAt: t,
        expiresAt: t + REFRESH_TTL_MS,
        current: true,
      },
    },
  };
}

export async function revokeSession(db: D1Database, sessionId: string, userId: string, reason: string): Promise<boolean> {
  const t = now();
  const res = await db
    .prepare(`UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`)
    .bind(t, reason, sessionId, userId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function revokeAllSessions(db: D1Database, userId: string, reason: string, exceptSessionId?: string): Promise<number> {
  const t = now();
  const res = await db
    .prepare(
      `UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL ${exceptSessionId ? 'AND id != ?' : ''}`,
    )
    .bind(...(exceptSessionId ? [t, reason, userId, exceptSessionId] : [t, reason, userId]))
    .run();
  return res.meta.changes ?? 0;
}

export async function listSessions(db: D1Database, userId: string): Promise<Array<SessionRow & { current: boolean }>> {
  const t = now();
  const rows = await db
    .prepare(
      `SELECT id, user_id, device_name, os, app_version, created_at, last_seen_at, expires_at, revoked_at FROM sessions
       WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen_at DESC LIMIT 50`,
    )
    .bind(userId, t)
    .all<SessionRow>();
  return (rows.results ?? []).map((r) => ({ ...r, current: false }));
}

/* ----------------------------- rate limiting ----------------------------- */

/**
 * D1-backed fixed-window limiter — survives Worker isolate restarts, no DO
 * needed at this traffic level. One row per (bucket, window); count via
 * INSERT ON CONFLICT, read back.
 */
export async function rateLimit(db: D1Database, bucket: string, max: number, windowMs: number): Promise<{ ok: boolean; retryAfterSec: number }> {
  const t = now();
  const windowStart = Math.floor(t / windowMs) * windowMs;
  const key = `${bucket}:${windowStart}`;
  const res = await db
    .prepare(
      `INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)
       ON CONFLICT (key) DO UPDATE SET count = count + 1`,
    )
    .bind(key, windowStart)
    .run();
  const row = await db.prepare(`SELECT count FROM rate_limits WHERE key = ?`).bind(key).first<{ count: number }>();
  const count = row?.count ?? Number(res.meta.changes ?? 1);
  if (count > max) return { ok: false, retryAfterSec: Math.ceil((windowStart + windowMs - t) / 1000) };
  return { ok: true, retryAfterSec: 0 };
}

/* -------------------------------- audit ---------------------------------- */

export async function audit(db: D1Database, kind: string, userId: string | null, ip: string | null, detail?: string): Promise<void> {
  await db
    .prepare(`INSERT INTO audit_events (user_id, kind, at, ip, detail) VALUES (?, ?, ?, ?, ?)`)
    .bind(userId, kind, now(), ip, detail ?? null)
    .run();
}

/** Delete stale rate-limit windows + expired sessions/tokens (called lazily). */
export async function sweepExpired(db: D1Database): Promise<void> {
  const t = now();
  await db.prepare(`DELETE FROM rate_limits WHERE window_start < ?`).bind(t - 3600_000).run();
  await db.prepare(`UPDATE sessions SET revoked_at = ?, revoked_reason = 'expired' WHERE expires_at <= ? AND revoked_at IS NULL`).bind(t, t).run();
  await db.prepare(`DELETE FROM rotated_refresh_hashes WHERE rotated_at < ?`).bind(t - REFRESH_TTL_MS).run();
}
