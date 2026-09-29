import { env, SELF } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { canonicalString, hmacHexForTest, sha256Hex } from '../src/np-auth';

/**
 * Integration contract tests for the NetPulse <-> Abystral (Telegram) worker.
 * Everything runs through the real fetch handler against real (miniflare) D1.
 * The bot worker's signed API is mocked at the outbound fetch seam (tests run
 * INSIDE the worker isolate, so the global fetch override reaches the client);
 * responses use the EXACT envelope shapes from docs/netpulse-integration.md,
 * so these tests double as living contract documentation.
 */

const SECRET = 'test-np-service-secret';
const INBOX = '/api/internal/netpulse/v1';
const BOT = 'https://bot.test';

async function register(email: string, password = 'Sup3rSecurePass'): Promise<{ token: string; userId: string }> {
  const res = await SELF.fetch('https://worker.test/api/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, device: { name: 'T', os: 'Windows', appVersion: '1.0.2' } }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { accessToken: string; user: { id: string } };
  return { token: body.accessToken, userId: body.user.id };
}

function authed(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`https://worker.test${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

/** Machine inbox errors are flat {error}; session routes nest {error:{code}}. */
async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: string | { code?: string } };
  if (typeof body.error === 'string') return body.error;
  return body.error?.code ?? '';
}

/** Sign + POST to the machine inbox exactly like the bot's drainer would. */
async function signedInbox(
  path: string,
  body: unknown,
  opts?: { ts?: number; nonce?: string; tamper?: boolean },
): Promise<Response> {
  const bodyText = JSON.stringify(body);
  const ts = String(opts?.ts ?? Date.now());
  const nonce = opts?.nonce ?? `n${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
  const sig = await hmacHexForTest(SECRET, canonicalString(ts, nonce, 'POST', path, await sha256Hex(bodyText)));
  return SELF.fetch(`https://worker.test${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-np-timestamp': ts,
      'x-np-nonce': nonce,
      'x-np-request-id': 'test-req',
      'x-np-signature': opts?.tamper ? `f${sig.slice(1)}` : sig,
    },
    body: bodyText,
  });
}

const entitlement = (id: number, status = 'active') => ({
  subscriptionId: id,
  planCode: 'pro',
  status,
  startedAt: '2026-09-01 00:00:00',
  expiresAt: '2026-10-01 00:00:00',
  autoRenew: true,
  totalGb: 50,
  usedGb: 3.5,
  ipLimit: 3,
  configUpdatedAt: '2026-09-20 10:00:00',
});

/** Bot-side one-time code issued by the mocked /link/request. */
const BOT_CODE = 'nplink_abc123def456';

/** Counters asserted per test: every mocked bot route MUST be consumed. */
const botCalls: Record<string, number> = {};

/**
 * Mock of the bot worker's integration API on the outbound fetch seam.
 * Restored by afterEach. Shapes mirror docs/netpulse-integration.md exactly.
 */
function mockBot(opts?: { claimError?: { status: number; error: string } }): void {
  botCalls.request = 0; botCalls.claim = 0; botCalls.entitlement = 0; botCalls.unlink = 0;
  const ok = (data: unknown): Response =>
    new Response(JSON.stringify({ success: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (path === `${INBOX}/link/request` && method === 'POST') {
      botCalls.request++;
      expect(body.netpulseAccountId).toMatch(/^npa_/);
      return ok({ requestId: 'req_1', code: BOT_CODE, expiresAt: Date.now() + 900_000, deepLink: `https://t.me/AbystralBot?start=${BOT_CODE}` });
    }
    if (path === `${INBOX}/link/claim` && method === 'POST') {
      botCalls.claim++;
      if (opts?.claimError) {
        return new Response(JSON.stringify({ success: false, error: opts.claimError.error }), { status: opts.claimError.status });
      }
      expect(body.code).toBe(BOT_CODE);
      return ok({ requestId: 'req_2', linked: true, botUserId: 987654321, linkId: 42 });
    }
    if (path.startsWith(`${INBOX}/entitlement/`) && method === 'GET') {
      botCalls.entitlement++;
      return ok({ botUserId: 987654321, linkedAt: 1758000000000, subscriptions: [entitlement(501), entitlement(502, 'expired')], configVersion: 1 });
    }
    if (path.startsWith(`${INBOX}/link/`) && method === 'DELETE') {
      botCalls.unlink++;
      return ok({ unlinked: true });
    }
    return new Response(JSON.stringify({ success: false, error: 'unmocked_bot_path' }), { status: 404 });
  }) as typeof fetch;
}

beforeAll(async () => {
  await env.DB.prepare(`DELETE FROM users`).run();
  await env.DB.prepare(`DELETE FROM np_links`).run();
  await env.DB.prepare(`DELETE FROM np_events`).run();
  await env.DB.prepare(`DELETE FROM np_entitlements`).run();
  await env.DB.prepare(`DELETE FROM np_outbound_log`).run();
  await env.DB.prepare(`DELETE FROM rate_limits`).run();
});

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe('netpulse inbox - service auth', () => {
  it('rejects unsigned deliveries', async () => {
    const res = await SELF.fetch(`https://worker.test${INBOX}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: 'e1', eventType: 'subscription.activated' }),
    });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('missing_signature_headers');
  });

  it('rejects stale timestamps outside the skew window', async () => {
    const res = await signedInbox(`${INBOX}/events`, { eventId: 'e2', eventType: 'subscription.activated' }, { ts: Date.now() - 6 * 60_000 });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('timestamp_out_of_window');
  });

  it('rejects tampered bodies (signature binds the exact bytes)', async () => {
    const res = await signedInbox(`${INBOX}/events`, { eventId: 'e3', eventType: 'subscription.activated' }, { tamper: true });
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('invalid_signature');
  });

  it('rejects replayed requests (single-use nonce) even when signed', async () => {
    const body = { eventId: `e-replay-${Math.random()}`, eventType: 'subscription.activated', netpulseAccountId: 'npa_x', payload: {} };
    const first = await signedInbox(`${INBOX}/events`, body, { nonce: 'replaymenonce42' });
    expect(first.status).toBe(200);
    const replay = await signedInbox(`${INBOX}/events`, body, { nonce: 'replaymenonce42' });
    expect(replay.status).toBe(401);
    expect(await errorCode(replay)).toBe('nonce_replayed');
  });

  it('validates event type and version', async () => {
    const badType = await signedInbox(`${INBOX}/events`, { eventId: `et-${Math.random()}`, eventType: 'wallet.credited', version: 1, payload: {} });
    expect(badType.status).toBe(422);
    const badVersion = await signedInbox(`${INBOX}/events`, { eventId: `ev-${Math.random()}`, eventType: 'subscription.activated', version: 99, payload: {} });
    expect(badVersion.status).toBe(422);
  });

  it('acks processed events', async () => {
    const res = await signedInbox(`${INBOX}/events/ack`, { eventId: 'whatever' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });
});

describe('netpulse inbox - idempotent ingest', () => {
  it('accepts an event for an unknown account and parks it as no_link', async () => {
    const eventId = `e-noLink-${Math.random()}`;
    const res = await signedInbox(`${INBOX}/events`, {
      eventId, eventType: 'subscription.activated', version: 1, netpulseAccountId: 'npa_ghost', payload: { subscription: entitlement(777) },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { duplicate: boolean }).duplicate).toBe(false);
    const row = await env.DB.prepare(`SELECT processed_status FROM np_events WHERE event_id = ?`).bind(eventId).first<{ processed_status: string }>();
    expect(row?.processed_status).toBe('no_link');
    const ghost = await env.DB.prepare(`SELECT * FROM np_entitlements WHERE subscription_id = 777`).first();
    expect(ghost).toBeNull();
  });

  it('redelivery of the same eventId is a 200 no-op (never a duplicate row)', async () => {
    const eventId = `e-dup-${Math.random()}`;
    const payload = { eventId, eventType: 'subscription.activated', version: 1, netpulseAccountId: 'npa_ghost2', payload: { subscription: entitlement(778) } };
    expect((await signedInbox(`${INBOX}/events`, payload)).status).toBe(200);
    const second = await signedInbox(`${INBOX}/events`, payload);
    expect(second.status).toBe(200);
    expect(((await second.json()) as { duplicate: boolean }).duplicate).toBe(true);
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM np_events WHERE event_id = ?`).bind(eventId).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('applies entitlement events to the linked account; older snapshots never regress newer state', async () => {
    mockBot();
    const { token, userId } = await register(`np-linker-${Math.random()}@example.com`);
    const start = await authed('/api/v1/account/telegram/link', token, { method: 'POST', body: '{}' });
    expect(start.status).toBe(200);
    const started = (await start.json()) as { token: string };
    const confirm = await authed('/api/v1/account/telegram/link/confirm', token, { method: 'POST', body: JSON.stringify({ code: started.token }) });
    expect(confirm.status).toBe(200);

    const status = await authed('/api/v1/account/telegram', token);
    const link = (await status.json()) as { connected: boolean; telegram_user_id: number | null };
    expect(link.connected).toBe(true);
    expect(link.telegram_user_id).toBe(987654321);

    // Deliver events against the REAL account id this user linked with.
    const linkRow = await env.DB
      .prepare(`SELECT netpulse_account_id FROM np_links WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`)
      .bind(userId)
      .first<{ netpulse_account_id: string }>();
    const accountId = linkRow?.netpulse_account_id ?? 'npa_missing';

    const applied = await signedInbox(`${INBOX}/events`, {
      eventId: `e-apply-${Math.random()}`, eventType: 'subscription.activated', version: 1, netpulseAccountId: accountId,
      payload: { subscription: { ...entitlement(900), configUpdatedAt: '2026-09-20 10:00:00' } },
    });
    expect(applied.status).toBe(200);

    // An out-of-order OLDER snapshot must NOT regress the newer state.
    const stale = await signedInbox(`${INBOX}/events`, {
      eventId: `e-stale-${Math.random()}`, eventType: 'subscription.updated', version: 1, netpulseAccountId: accountId,
      payload: { subscription: { ...entitlement(900), status: 'paused', configUpdatedAt: '2026-09-19 00:00:00' } },
    });
    expect(stale.status).toBe(200);
    const row = await env.DB.prepare(`SELECT status, plan_code FROM np_entitlements WHERE subscription_id = 900`).first<{ status: string; plan_code: string }>();
    expect(row?.status).toBe('active');
    expect(row?.plan_code).toBe('pro');

    // The mirror is visible through the session API.
    const subs = await authed('/api/v1/subscriptions', token);
    expect(subs.status).toBe(200);
    const list = ((await subs.json()) as { subscriptions: Array<{ id: string; plan: string }> }).subscriptions;
    expect(list.some((s) => s.id === '900' && s.plan === 'pro')).toBe(true);
  });
});

describe('netpulse linking flow (session-authed, bot mocked)', () => {
  it('runs start -> confirm -> status -> pull-sync -> unlink end to end', async () => {
    mockBot();
    const { token } = await register(`np-flow-${Math.random()}@example.com`);

    // Start: returns the bot's one-time code + its deep link (user opens it).
    const start = await authed('/api/v1/account/telegram/link', token, { method: 'POST', body: '{}' });
    expect(start.status).toBe(200);
    const started = (await start.json()) as { ok: boolean; token: string; deepLink: string };
    expect(started.ok).toBe(true);
    expect(started.token).toMatch(/^nplink_/);
    expect(started.deepLink).toContain('https://t.me/');

    // Confirm: presents the code; the bot does the atomic bind.
    const confirm = await authed('/api/v1/account/telegram/link/confirm', token, { method: 'POST', body: JSON.stringify({ code: started.token }) });
    expect(confirm.status).toBe(200);

    // Status: connected, with the bot-verified Telegram id.
    const status = await authed('/api/v1/account/telegram', token);
    const link = (await status.json()) as { connected: boolean; telegram_user_id: number | null };
    expect(link.connected).toBe(true);
    expect(link.telegram_user_id).toBe(987654321);

    // Pull-sync: replaces the mirror with the bot's authoritative view.
    const sync = await authed('/api/v1/integrations/telegram/sync', token, { method: 'POST' });
    expect(sync.status).toBe(200);
    const synced = (await sync.json()) as { ok: boolean; subscriptions: unknown[] };
    expect(synced.ok).toBe(true);
    expect(synced.subscriptions).toHaveLength(2);

    const subs = await authed('/api/v1/subscriptions', token);
    const list = ((await subs.json()) as { subscriptions: Array<{ id: string }> }).subscriptions;
    expect(list.map((s) => s.id).sort()).toEqual(['501', '502']);

    // Unlink: bot side revoked first, then the mirror is wiped.
    const unlink = await authed('/api/v1/account/telegram/unlink', token, { method: 'POST' });
    expect(unlink.status).toBe(200);
    expect(botCalls.unlink).toBe(1);
    const after = (await (await authed('/api/v1/account/telegram', token)).json()) as { connected: boolean };
    expect(after.connected).toBe(false);
    const remaining = await env.DB.prepare(`SELECT COUNT(*) AS n FROM np_entitlements`).first<{ n: number }>();
    expect(remaining?.n).toBe(0);
  });

  it('refuses to start a second link while one is active', async () => {
    mockBot();
    const { token } = await register(`np-dup-${Math.random()}@example.com`);
    const first = await authed('/api/v1/account/telegram/link', token, { method: 'POST', body: '{}' });
    const started = (await first.json()) as { token: string };
    await authed('/api/v1/account/telegram/link/confirm', token, { method: 'POST', body: JSON.stringify({ code: started.token }) });
    const again = await authed('/api/v1/account/telegram/link', token, { method: 'POST', body: '{}' });
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe('already_linked');
  });

  it('propagates the bot claim rejection for a bad code', async () => {
    mockBot({ claimError: { status: 404, error: 'invalid_or_expired' } });
    const { token } = await register(`np-badcode-${Math.random()}@example.com`);
    const start = await authed('/api/v1/account/telegram/link', token, { method: 'POST', body: '{}' });
    const started = (await start.json()) as { token: string };
    const confirm = await authed('/api/v1/account/telegram/link/confirm', token, { method: 'POST', body: JSON.stringify({ code: started.token }) });
    expect(confirm.status).toBe(400);
    expect(await errorCode(confirm)).toBe('invalid_or_expired');
  });

  it('rate limits link attempts (5/hour per account)', async () => {
    mockBot();
    const { token } = await register(`np-rl-${Math.random()}@example.com`);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await authed('/api/v1/account/telegram/link', token, { method: 'POST', body: '{}' })).status);
    }
    expect(statuses[5]).toBe(429);
  });

  it('requires a session for every linking route', async () => {
    for (const [path, init] of [
      ['/api/v1/account/telegram', {}],
      ['/api/v1/account/telegram/link', { method: 'POST' }],
      ['/api/v1/account/telegram/unlink', { method: 'POST' }],
      ['/api/v1/integrations/telegram/sync', { method: 'POST' }],
    ] as const) {
      const res = await SELF.fetch(`https://worker.test${path}`, init);
      expect(res.status, path).toBe(401);
    }
  });
});

describe('account isolation (multi-account)', () => {
  it('one event for account A never writes into account B\'s mirror', async () => {
    mockBot();
    // Two independent app accounts, each linked to its own bot-side account.
    const a = await register(`iso-a-${Math.random()}@example.com`);
    const b = await register(`iso-b-${Math.random()}@example.com`);
    for (const u of [a, b]) {
      const start = await authed('/api/v1/account/telegram/link', u.token, { method: 'POST', body: '{}' });
      expect(start.status).toBe(200);
      const started = (await start.json()) as { token: string };
      const confirm = await authed('/api/v1/account/telegram/link/confirm', u.token, { method: 'POST', body: JSON.stringify({ code: started.token }) });
      expect(confirm.status).toBe(200);
    }
    const accountIdOf = async (userId: string): Promise<string> => {
      const row = await env.DB
        .prepare(`SELECT netpulse_account_id FROM np_links WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`)
        .bind(userId)
        .first<{ netpulse_account_id: string }>();
      return row?.netpulse_account_id ?? 'npa_missing';
    };
    const accountA = await accountIdOf(a.userId);
    const accountB = await accountIdOf(b.userId);
    expect(accountA).not.toBe(accountB);

    // An entitlement event addressed to A lands ONLY in A's mirror.
    const applied = await signedInbox(`${INBOX}/events`, {
      eventId: `iso-${Math.random()}`, eventType: 'subscription.activated', version: 1, netpulseAccountId: accountA,
      payload: { subscription: entitlement(950) },
    });
    expect(applied.status).toBe(200);
    const aHas = await env.DB.prepare(`SELECT COUNT(*) AS n FROM np_entitlements WHERE subscription_id = 950 AND user_id = ?`).bind(a.userId).first<{ n: number }>();
    expect(aHas?.n).toBe(1);
    const bHas = await env.DB.prepare(`SELECT COUNT(*) AS n FROM np_entitlements WHERE subscription_id = 950 AND user_id = ?`).bind(b.userId).first<{ n: number }>();
    expect(bHas?.n).toBe(0);

    // B's session API never sees A's entitlement.
    const bSubs = ((await (await authed('/api/v1/subscriptions', b.token)).json()) as { subscriptions: Array<{ id: string }> }).subscriptions;
    expect(bSubs.some((s) => s.id === '950')).toBe(false);

    // Per-user event delivery to B's account does not leak into A's mirror either.
    const appliedB = await signedInbox(`${INBOX}/events`, {
      eventId: `iso-b-${Math.random()}`, eventType: 'subscription.activated', version: 1, netpulseAccountId: accountB,
      payload: { subscription: entitlement(951) },
    });
    expect(appliedB.status).toBe(200);
    const aSees951 = await env.DB.prepare(`SELECT COUNT(*) AS n FROM np_entitlements WHERE subscription_id = 951 AND user_id = ?`).bind(a.userId).first<{ n: number }>();
    expect(aSees951?.n).toBe(0);
  });

  it('cannot tamper with a foreign mirror row through the session API', async () => {
    mockBot();
    const a = await register(`tamper-a-${Math.random()}@example.com`);
    const b = await register(`tamper-b-${Math.random()}@example.com`);
    for (const u of [a, b]) {
      const start = await authed('/api/v1/account/telegram/link', u.token, { method: 'POST', body: '{}' });
      const started = (await start.json()) as { token: string };
      await authed('/api/v1/account/telegram/link/confirm', u.token, { method: 'POST', body: JSON.stringify({ code: started.token }) });
    }
    const row = await env.DB.prepare(`SELECT subscription_id FROM np_entitlements WHERE user_id = ? LIMIT 1`).bind(a.userId).first<{ subscription_id: number }>();
    expect(row).toBeTruthy();
    const foreignSubId = row!.subscription_id;
    // B reads A's subscription id by id: 404 (user_id is part of every query).
    const foreign = await authed(`/api/v1/subscriptions/${foreignSubId}`, b.token);
    expect(foreign.status).toBe(404);
    // B's own list stays isolated.
    const bSubs = ((await (await authed('/api/v1/subscriptions', b.token)).json()) as { subscriptions: Array<{ id: string }> }).subscriptions;
    expect(bSubs.every((s) => s.id !== String(foreignSubId))).toBe(true);
  });
});
