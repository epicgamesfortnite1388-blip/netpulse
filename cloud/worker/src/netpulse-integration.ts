/**
 * NetPulse ↔ Abystral (Telegram commerce) integration — NetPulse side.
 *
 * Contract: docs/netpulse-integration.md in the Abystral repo.
 * Abystral owns purchases, payments, and subscription entitlements; NetPulse
 * is a linked application surface that RECEIVES signed lifecycle events and
 * may PULL the authoritative entitlement view. This worker never accepts a
 * Telegram identity from a client — linking happens through the bot's signed
 * API and the bot's Telegram deep link, with the bot verifying the Telegram
 * identity from its own authenticated update.
 *
 * Inbound  (bot → here):  POST /api/internal/netpulse/v1/events[/ack]
 * Outbound (here → bot):  /api/internal/netpulse/v1/link/request · link/claim ·
 *                         link/status/:id · link/:id · entitlement/:id
 * Both directions sign with NETPULSE_SERVICE_SECRET (np-auth.ts).
 *
 * Idempotency: events dedup on event_id (INSERT OR IGNORE, replay no-op);
 * entitlement upserts are guarded by config_updated_at; link state changes
 * are guarded by status predicates so retries never double-apply.
 */

import { newId } from './crypto';
import { rateLimit, audit, type Env } from './auth';
import { signServiceRequest, verifyServiceRequest, sweepNonces } from './np-auth';

const MAX_INBOX_BODY_BYTES = 64 * 1024;

/** ─── Inbound signed inbox (bot → here) ──────────────────────────────────── */

/**
 * Handle the bot worker's signed deliveries: POST /events (drainer) and
 * POST /events/ack (late acks). Returns null for non-inbox paths so the main
 * router falls through; otherwise ALWAYS responds. Signature is verified over
 * the raw body bytes BEFORE any parse — a tampered body can never reach the
 * processor, and no error path distinguishes signature failure from replay.
 */
export async function handleNetpulseInbox(request: Request, env: Env, ip: string): Promise<Response | null> {
  const url = new URL(request.url);
  const eventsPath = `${NP_API_BASE}/events`;
  const ackPath = `${NP_API_BASE}/events/ack`;
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path !== eventsPath && path !== ackPath) return null;

  const respond = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  if (request.method !== 'POST') return respond(405, { ok: false, error: 'method_not_allowed' });
  const bodyText = await request.text().catch(() => '');
  if (bodyText.length > MAX_INBOX_BODY_BYTES) return respond(413, { ok: false, error: 'payload_too_large' });

  const verify = await verifyServiceRequest(request, bodyText, env);
  if (!verify.ok) {
    await audit(env.DB, `np.inbox.rejected:${verify.reason}`, null, ip, path === ackPath ? 'ack' : 'event').catch(() => {});
    return respond(verify.status, { ok: false, error: verify.reason });
  }

  let body: unknown = null;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return respond(400, { ok: false, error: 'invalid_json' });
  }

  if (path === ackPath) {
    const eventId = (body as { eventId?: unknown } | null)?.eventId;
    if (typeof eventId !== 'string' || !eventId) return respond(400, { ok: false, error: 'missing_required_fields' });
    const acked = await ackNetpulseEvent(env.DB, eventId);
    return respond(200, { ok: true, acked: acked.ok });
  }

  const result = await ingestNetpulseEvent(env.DB, body, ip);
  if (!result.ok) return respond(result.status, { ok: false, error: result.code });
  // Opportunistic nonce sweep — one indexed DELETE keeps service_nonces small
  // without a dedicated cron on this worker.
  await sweepNonces(env.DB).catch(() => {});
  return respond(200, { ok: true, duplicate: result.duplicate });
}

/** The bot worker's integration API base (mirrors NP_API_BASE on the bot). */
export const NP_API_BASE = '/api/internal/netpulse/v1';

/** Event taxonomy — mirrors NETPULSE_EVENT_TYPES on the bot. */
export const NETPULSE_EVENT_TYPES = [
  'link.confirmed',
  'link.revoked',
  'subscription.activated',
  'subscription.renewed',
  'subscription.extended',
  'subscription.paused',
  'subscription.resumed',
  'subscription.expired',
  'subscription.revoked',
  'subscription.refunded',
  'subscription.updated',
  'subscription.config_regenerated',
] as const;

export type NetpulseEventType = (typeof NETPULSE_EVENT_TYPES)[number];

/** Contract version of the event envelope. */
export const NETPULSE_EVENT_VERSION = 1;

/** ─── Safe entitlement model (the ONLY projection that crosses the wire) ─── */

export interface NetpulseEntitlement {
  subscriptionId: number;
  planCode: string;
  status: string;
  startedAt: string | null;
  expiresAt: string | null;
  autoRenew: boolean;
  totalGb: number;
  usedGb: number;
  ipLimit: number | null;
  configUpdatedAt: string;
}

/**
 * The instant an entitlement ends, or `null` when it has no end date.
 *
 * `np_entitlements.expires_at` is a TEXT column and the bot writes whatever its
 * own database produced: a `YYYY-MM-DD HH:MM:SS` datetime, an ISO string, or
 * a bare epoch (seconds or milliseconds) as text. The provision gate used to
 * call `Number(value)`, which yields `NaN` for every datetime string — and
 * `NaN < now` is false, so a subscription whose bot-side status had not been
 * flipped yet could still be provisioned after it expired. Parsing is therefore
 * explicit here, and an unreadable value is reported as `null` (the caller
 * decides; it fails closed).
 *
 * Space-separated datetimes are pinned to UTC. V8 treats them as local time in
 * some hosts and rejects them in others; the bot stores UTC, and a gate whose
 * answer depends on the server's timezone is not a gate.
 */
export function parseEntitlementExpiry(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return fromEpoch(value);
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return fromEpoch(Number(raw));

  const sql = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/.exec(raw);
  const ms = Date.parse(sql ? `${sql[1]}T${sql[2]}Z` : raw);
  return Number.isNaN(ms) ? null : ms;
}

/** Epoch seconds or milliseconds, never a `0`/negative placeholder. */
function fromEpoch(n: number): number | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  // 1e11 seconds is year 5138; 1e11 milliseconds is 1973. A real timestamp is
  // unambiguous under this threshold, which is the one the UI's parser uses.
  return n > 1e11 ? n : n * 1000;
}

/** ─── Signed outbound client (NetPulse → bot) ────────────────────────────── */

export type BotApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

/**
 * Perform one signed request to the bot's integration API and audit it.
 * Never throws: every failure (including misconfiguration) is a typed result
 * plus an np_outbound_log row. The audit row never carries signature or
 * secret material — action, path, status, error code only.
 */
export async function botApiRequest<T>(
  env: Env,
  db: D1Database,
  action: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  userId: string | null,
  body?: unknown,
): Promise<BotApiResult<T>> {
  const base = env.TELEGRAM_BOT_BASE_URL?.trim().replace(/\/+$/, '');
  const secret = env.NETPULSE_SERVICE_SECRET;
  const t = Date.now();
  const logRow = async (status: number | null, ok: boolean, error?: string): Promise<void> => {
    await db
      .prepare(
        `INSERT INTO np_outbound_log (id, user_id, action, request_path, status, ok, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(newId('npo'), userId, action, path, status, ok ? 1 : 0, error ?? null, t)
      .run();
  };

  if (!base || !secret) {
    await logRow(null, false, 'integration_not_configured');
    return { ok: false, status: 503, error: 'integration_not_configured' };
  }
  const bodyText = body === undefined ? '' : JSON.stringify(body);
  try {
    const headers = await signServiceRequest(secret, method, path, bodyText);
    const response = await fetch(`${base}${path}`, {
      method,
      headers: bodyText ? { 'content-type': 'application/json', ...headers } : headers,
      body: bodyText || undefined,
      signal: AbortSignal.timeout(10_000),
    });
    const parsed = (await response.json().catch(() => null)) as
      | { success: true; data: T }
      | { success: false; error: string }
      | null;
    if (!response.ok || !parsed || parsed.success !== true) {
      const error = parsed && parsed.success === false ? parsed.error : `upstream_status_${response.status}`;
      await logRow(response.status, false, error.slice(0, 120));
      return { ok: false, status: response.status, error };
    }
    await logRow(response.status, true);
    return { ok: true, data: parsed.data };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'network_error';
    await logRow(null, false, error.slice(0, 120));
    return { ok: false, status: 0, error };
  }
}

/** ─── Local link state ───────────────────────────────────────────────────── */

interface NpLinkRow {
  id: string;
  user_id: string;
  telegram_user_id: number | null;
  netpulse_account_id: string;
  status: string;
  linked_at: number | null;
  last_synced_at: number;
  last_sync_status: string | null;
}

async function getLinkRow(db: D1Database, userId: string): Promise<NpLinkRow | null> {
  return (
    (await db
      .prepare(`SELECT * FROM np_links WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`)
      .bind(userId)
      .first<NpLinkRow>()) ?? null
  );
}

/**
 * Stable per-user NetPulse account id (idempotency key for the bot-side
 * link request — retries reuse the SAME account id, never mint a second).
 */
async function ensureNetpulseAccountId(db: D1Database, userId: string): Promise<string> {
  const existing = await getLinkRow(db, userId);
  const t = Date.now();
  if (existing) return existing.netpulse_account_id;
  const accountId = newId('npa');
  try {
    await db
      .prepare(
        `INSERT INTO np_links (id, user_id, telegram_user_id, netpulse_account_id, status, initiated_by, created_at, updated_at)
         VALUES (?, ?, NULL, ?, 'pending', 'netpulse', ?, ?)`,
      )
      .bind(newId('npl'), userId, accountId, t, t)
      .run();
  } catch {
    // Concurrent start: the other insert won; reuse its account id.
  }
  const row = await getLinkRow(db, userId);
  return row?.netpulse_account_id ?? accountId;
}

/** UI-facing link status (GET /api/v1/account/telegram). */
export async function getNetpulseLink(
  db: D1Database,
  userId: string,
): Promise<{ connected: boolean; telegramUserId: number | null; linkedAt: number | null; lastSyncedAt: number | null; lastSyncStatus: string | null }> {
  const row = await getLinkRow(db, userId);
  if (!row || row.status !== 'active') return { connected: false, telegramUserId: null, linkedAt: null, lastSyncedAt: null, lastSyncStatus: null };
  return {
    connected: true,
    telegramUserId: row.telegram_user_id,
    linkedAt: row.linked_at,
    lastSyncedAt: row.last_synced_at || null,
    lastSyncStatus: row.last_sync_status,
  };
}

/** ─── Linking flows (bot is authoritative; this is orchestration) ────────── */

export type StartLinkResult =
  | { ok: true; token: string; deepLink: string; expiresAt: number }
  | { ok: false; status: number; code: string; detail?: string };

/**
 * Flow A: create a one-time link code on the bot for this app account and
 * return the bot's deep link. The USER opens it — Telegram authenticates the
 * user; this server never learns or trusts a Telegram id from the client.
 */
export async function startNetpulseLink(db: D1Database, env: Env, userId: string, ip: string): Promise<StartLinkResult> {
  const limiter = await rateLimit(db, `np_link:${userId}`, 5, 3600_000);
  if (!limiter.ok) return { ok: false, status: 429, code: 'rate_limited', detail: 'Too many linking attempts — try later' };
  const existing = await getLinkRow(db, userId);
  if (existing?.status === 'active') {
    return { ok: false, status: 409, code: 'already_linked', detail: 'This account is already linked to Telegram' };
  }
  const accountId = await ensureNetpulseAccountId(db, userId);
  const result = await botApiRequest<{ requestId: string; code: string; expiresAt: number; deepLink: string }>(
    env, db, 'link.request', 'POST', `${NP_API_BASE}/link/request`, userId, { netpulseAccountId: accountId },
  );
  if (!result.ok) {
    await audit(db, 'np.link.request_failed', userId, ip, result.error.slice(0, 100));
    return { ok: false, status: result.status === 503 ? 503 : 502, code: result.error, detail: 'Could not reach the bot linking service — try again later' };
  }
  return { ok: true, token: result.data.code, deepLink: result.data.deepLink, expiresAt: result.data.expiresAt };
}

export type ConfirmLinkResult = { ok: true } | { ok: false; status: number; code: string; detail?: string };

/**
 * Flow B confirm: present the code the user received from the bot (or typed
 * from the bot's NetPulse screen) to the bot's signed claim endpoint. On
 * success the bot has already bound both identities atomically; we record
 * the active link and pull the initial entitlement snapshot.
 */
export async function confirmNetpulseLink(db: D1Database, env: Env, userId: string, code: string, ip: string): Promise<ConfirmLinkResult> {
  const trimmed = code.trim();
  if (!trimmed || trimmed.length > 128) return { ok: false, status: 400, code: 'invalid_code' };
  const limiter = await rateLimit(db, `np_claim:${userId}`, 10, 3600_000);
  if (!limiter.ok) return { ok: false, status: 429, code: 'rate_limited' };
  const accountId = await ensureNetpulseAccountId(db, userId);
  const result = await botApiRequest<{ linked: boolean; botUserId: number }>(
    env, db, 'link.claim', 'POST', `${NP_API_BASE}/link/claim`, userId, { code: trimmed, netpulseAccountId: accountId },
  );
  if (!result.ok) {
    await audit(db, 'np.link.claim_failed', userId, ip, result.error.slice(0, 100));
    // Pass the bot's stable reason through; a wrong/expired code is 404-ish.
    return { ok: false, status: result.status === 503 ? 503 : result.status >= 400 && result.status < 500 ? 400 : 502, code: result.error, detail: 'Link code invalid or expired' };
  }
  const t = Date.now();
  await db
    .prepare(
      `UPDATE np_links SET status = 'active', telegram_user_id = ?, linked_at = ?, unlinked_at = NULL, updated_at = ?
       WHERE user_id = ? AND status != 'active'`,
    )
    .bind(result.data.botUserId, t, t, userId)
    .run();
  await audit(db, 'np.link.confirmed', userId, ip, `account:${accountId}`);
  await syncNetpulseEntitlements(db, env, userId, ip).catch(() => {
    // Initial pull is best-effort; the bot's snapshot events + reconcile
    // repair any gap.
  });
  return { ok: true };
}

export type UnlinkResult = { ok: true } | { ok: false; status: number; code: string; detail?: string };

/**
 * Unlink: the bot is authoritative, so its side is revoked FIRST (best-effort
 * — upstream 404 'not_linked' still proceeds; unreachable upstream aborts so
 * the mirror cannot drift silently from a still-active bot-side link).
 */
export async function unlinkNetpulse(db: D1Database, env: Env, userId: string, ip: string): Promise<UnlinkResult> {
  const link = await getLinkRow(db, userId);
  if (!link || link.status !== 'active') return { ok: false, status: 404, code: 'not_linked' };
  const result = await botApiRequest<{ unlinked: boolean }>(
    env, db, 'link.unlink', 'DELETE', `${NP_API_BASE}/link/${encodeURIComponent(link.netpulse_account_id)}`, userId,
  );
  if (!result.ok && result.status !== 404 && result.status !== 410) {
    await audit(db, 'np.link.unlink_failed', userId, ip, result.error.slice(0, 100));
    return { ok: false, status: result.status === 503 ? 503 : 502, code: result.error, detail: 'Could not reach the bot — link not removed' };
  }
  const t = Date.now();
  await db.batch([
    db.prepare(`UPDATE np_links SET status = 'unlinked', unlinked_at = ?, updated_at = ? WHERE user_id = ? AND status = 'active'`).bind(t, t, userId),
    db.prepare(`DELETE FROM np_entitlements WHERE user_id = ?`).bind(userId),
  ]);
  await audit(db, 'np.link.unlinked', userId, ip);
  return { ok: true };
}

/** ─── Entitlement mirror (safe model only) ───────────────────────────────── */

function entitlementFromApiRow(s: Record<string, unknown>): NetpulseEntitlement {
  return {
    subscriptionId: Number(s.subscriptionId),
    planCode: String(s.planCode ?? ''),
    status: String(s.status ?? 'unknown'),
    startedAt: (s.startedAt as string | null) ?? null,
    expiresAt: (s.expiresAt as string | null) ?? null,
    autoRenew: s.autoRenew === true,
    totalGb: Number(s.totalGb ?? 0),
    usedGb: Number(s.usedGb ?? 0),
    ipLimit: s.ipLimit === null || s.ipLimit === undefined ? null : Number(s.ipLimit),
    configUpdatedAt: String(s.configUpdatedAt ?? ''),
  };
}

/**
 * Pull the authoritative entitlement view and replace the local mirror in one
 * batch. Replace-not-merge guarantees the mirror converges to the bot's view.
 */
export async function syncNetpulseEntitlements(
  db: D1Database,
  env: Env,
  userId: string,
  ip: string,
): Promise<{ ok: true; entitlements: NetpulseEntitlement[] } | { ok: false; status: number; code: string }> {
  const link = await getLinkRow(db, userId);
  if (!link || link.status !== 'active') return { ok: false, status: 404, code: 'not_linked' };
  const result = await botApiRequest<{ subscriptions: Record<string, unknown>[] }>(
    env, db, 'entitlement.pull', 'GET', `${NP_API_BASE}/entitlement/${encodeURIComponent(link.netpulse_account_id)}`, userId,
  );
  if (!result.ok) {
    await db.prepare(`UPDATE np_links SET last_synced_at = ?, last_sync_status = ? WHERE user_id = ? AND status = 'active'`)
      .bind(Date.now(), result.error.slice(0, 60), userId)
      .run();
    return { ok: false, status: result.status === 503 ? 503 : 502, code: result.error };
  }
  const entitlements = (result.data.subscriptions ?? []).map(entitlementFromApiRow);
  const t = Date.now();
  const statements = [db.prepare(`DELETE FROM np_entitlements WHERE user_id = ?`).bind(userId)];
  for (const e of entitlements) {
    statements.push(
      db
        .prepare(
          `INSERT INTO np_entitlements (subscription_id, user_id, netpulse_account_id, plan_code, status, started_at, expires_at,
             auto_renew, total_gb, used_gb, ip_limit, config_updated_at, event_id, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
           ON CONFLICT(subscription_id) DO UPDATE SET
             plan_code = excluded.plan_code, status = excluded.status, started_at = excluded.started_at,
             expires_at = excluded.expires_at, auto_renew = excluded.auto_renew, total_gb = excluded.total_gb,
             used_gb = excluded.used_gb, ip_limit = excluded.ip_limit, config_updated_at = excluded.config_updated_at,
             updated_at = excluded.updated_at`,
        )
        .bind(e.subscriptionId, userId, link.netpulse_account_id, e.planCode, e.status, e.startedAt, e.expiresAt,
          e.autoRenew ? 1 : 0, e.totalGb, e.usedGb, e.ipLimit, e.configUpdatedAt, t),
    );
  }
  statements.push(
    db.prepare(`UPDATE np_links SET last_synced_at = ?, last_sync_status = 'success' WHERE user_id = ? AND status = 'active'`).bind(t, userId),
  );
  await db.batch(statements);
  await audit(db, 'np.entitlement.synced', userId, ip, `count:${entitlements.length}`);
  return { ok: true, entitlements };
}

/** Mirror rows for the app UI (GET /api/v1/subscriptions). */
export async function listEntitlements(db: D1Database, userId: string): Promise<Record<string, unknown>[]> {
  const rows = await db
    .prepare(
      `SELECT subscription_id, plan_code, status, started_at, expires_at, auto_renew, total_gb, used_gb, ip_limit, config_updated_at, updated_at
       FROM np_entitlements WHERE user_id = ? ORDER BY updated_at DESC`,
    )
    .bind(userId)
    .all<Record<string, unknown>>();
  return (rows.results ?? []).map((r) => ({
    id: String(r.subscription_id),
    plan: r.plan_code,
    status: r.status,
    started_at: r.started_at,
    expiration_time: r.expires_at,
    auto_renew: r.auto_renew === 1,
    total_gb: r.total_gb,
    used_gb: r.used_gb,
    ip_limit: r.ip_limit,
    config_updated_at: r.config_updated_at,
  }));
}

/** ─── Inbound event inbox (bot → here) ───────────────────────────────────── */

export type IngestResult =
  | { ok: true; duplicate: boolean }
  | { ok: false; status: number; code: string };

/**
 * Apply one delivered lifecycle event to the local mirror.
 * Idempotent on event_id; unknown account (link removed bot-side before a
 * straggler delivery) is accepted + parked as 'no_link' so the bot sees 2xx
 * and stops retrying — its reconcile pass re-syncs if the link returns.
 */
export async function ingestNetpulseEvent(db: D1Database, body: unknown, ip: string): Promise<IngestResult> {
  const parsed = body as {
    eventId?: string;
    eventType?: NetpulseEventType;
    version?: number;
    netpulseAccountId?: string | null;
    payload?: { subscription?: Record<string, unknown> } | null;
  } | null;
  if (!parsed || typeof parsed.eventId !== 'string' || typeof parsed.eventType !== 'string') {
    return { ok: false, status: 400, code: 'missing_required_fields' };
  }
  if (!(NETPULSE_EVENT_TYPES as readonly string[]).includes(parsed.eventType)) {
    return { ok: false, status: 422, code: `unknown_event_type:${parsed.eventType}` };
  }
  if ((parsed.version ?? NETPULSE_EVENT_VERSION) !== NETPULSE_EVENT_VERSION) {
    return { ok: false, status: 422, code: `unsupported_event_version:${String(parsed.version)}` };
  }

  const t = Date.now();
  const subscriptionRef =
    parsed.payload?.subscription && Number.isFinite(Number(parsed.payload.subscription.subscriptionId))
      ? String(Number(parsed.payload.subscription.subscriptionId))
      : null;
  const insert = await db
    .prepare(
      `INSERT OR IGNORE INTO np_events (event_id, event_type, version, telegram_user_id, netpulse_account_id, subscription_ref, payload, received_at, processed_status)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'pending')`,
    )
    .bind(parsed.eventId, parsed.eventType, parsed.version ?? NETPULSE_EVENT_VERSION, parsed.netpulseAccountId ?? null,
      subscriptionRef, JSON.stringify(parsed.payload ?? {}), t)
    .run();
  if ((insert.meta.changes ?? 0) === 0) {
    return { ok: true, duplicate: true }; // replayed delivery — already applied
  }

  // Resolve the local account for the event.
  let userId: string | null = null;
  if (parsed.netpulseAccountId) {
    const link = await db
      .prepare(`SELECT user_id FROM np_links WHERE netpulse_account_id = ? AND status = 'active' LIMIT 1`)
      .bind(parsed.netpulseAccountId)
      .first<{ user_id: string }>();
    userId = link?.user_id ?? null;
  }

  if (!userId) {
    await db.prepare(`UPDATE np_events SET processed_at = ?, processed_status = 'no_link' WHERE event_id = ?`).bind(t, parsed.eventId).run();
    await audit(db, 'np.event.no_link', null, ip, `${parsed.eventType}:${parsed.eventId.slice(0, 12)}`);
    return { ok: true, duplicate: false };
  }

  // A bot-side revocation is authoritative and must reach the mirror, not just
  // the console. Without this the app kept reporting "Telegram linked" after
  // the user unlinked in Telegram, and — because the local row stayed active —
  // a fresh link attempt was refused with `already_linked` (409), leaving no
  // way back in short of a reinstall. Clearing the row first is what makes
  // start-linking usable again; the entitlements go with it because they were
  // a projection of a link that no longer exists.
  if (parsed.eventType === 'link.revoked') {
    await db.batch([
      db
        .prepare(`UPDATE np_links SET status = 'unlinked', unlinked_at = ?, updated_at = ? WHERE netpulse_account_id = ? AND status = 'active'`)
        .bind(t, t, parsed.netpulseAccountId),
      db.prepare(`DELETE FROM np_entitlements WHERE user_id = ?`).bind(userId),
    ]);
    await db.prepare(`UPDATE np_events SET processed_at = ?, processed_status = 'applied' WHERE event_id = ?`).bind(t, parsed.eventId).run();
    await audit(db, 'np.event.link_revoked', userId, ip, `${parsed.eventId.slice(0, 12)}`);
    return { ok: true, duplicate: false };
  }

  const sub = parsed.payload?.subscription;
  if (sub && Number.isFinite(Number(sub.subscriptionId))) {
    const e = entitlementFromApiRow(sub);
    // config_updated_at ordering guard: an out-of-order older snapshot must
    // not overwrite a newer state (ISO-ish timestamps sort lexicographically).
    await db
      .prepare(
        `INSERT INTO np_entitlements (subscription_id, user_id, netpulse_account_id, plan_code, status, started_at, expires_at,
           auto_renew, total_gb, used_gb, ip_limit, config_updated_at, event_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(subscription_id) DO UPDATE SET
           plan_code = excluded.plan_code, status = excluded.status, started_at = excluded.started_at,
           expires_at = excluded.expires_at, auto_renew = excluded.auto_renew, total_gb = excluded.total_gb,
           used_gb = excluded.used_gb, ip_limit = excluded.ip_limit, config_updated_at = excluded.config_updated_at,
           event_id = excluded.event_id, updated_at = excluded.updated_at
         WHERE excluded.config_updated_at >= np_entitlements.config_updated_at`,
      )
      .bind(e.subscriptionId, userId, parsed.netpulseAccountId ?? null, e.planCode, e.status, e.startedAt, e.expiresAt,
        e.autoRenew ? 1 : 0, e.totalGb, e.usedGb, e.ipLimit, e.configUpdatedAt, parsed.eventId, t)
      .run();
  }

  await db.prepare(`UPDATE np_events SET processed_at = ?, processed_status = 'applied' WHERE event_id = ?`).bind(t, parsed.eventId).run();
  await audit(db, 'np.event.applied', userId, ip, `${parsed.eventType}:${parsed.eventId.slice(0, 12)}`);
  return { ok: true, duplicate: false };
}

/** Late ack for an already-processed event id (bot-side redelivery safety). */
export async function ackNetpulseEvent(db: D1Database, eventId: string): Promise<{ ok: boolean }> {
  const res = await db
    .prepare(`UPDATE np_events SET processed_status = 'acked' WHERE event_id = ? AND processed_status = 'applied'`)
    .bind(eventId)
    .run();
  return { ok: (res.meta.changes ?? 0) > 0 };
}

/** UI-facing sync status (POST /api/v1/integrations/telegram/status). */
export async function getSyncStatus(db: D1Database, userId: string): Promise<{ ok: boolean; lastSyncAt: number | null; error: string | null }> {
  const row = await getLinkRow(db, userId);
  if (!row || row.status !== 'active') return { ok: true, lastSyncAt: null, error: null };
  return {
    ok: true,
    lastSyncAt: row.last_synced_at || null,
    error: row.last_sync_status && row.last_sync_status !== 'success' ? row.last_sync_status : null,
  };
}
