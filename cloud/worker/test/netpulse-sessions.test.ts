import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import { canonicalString, hmacHexForTest, sha256Hex } from '../src/np-auth';

/**
 * The bot half of the NetPulse <-> Telegram boundary is Abystral's: it owns
 * every screen, menu and inline button. These tests pin the half that IS this
 * repo — the signed surface the bot calls when a person acts on one of those
 * buttons, so "where am I signed in?" and "sign that device out" stop
 * requiring the desktop app.
 *
 * It reuses the session capability the app already ships; nothing here is a
 * new product concept, only a second door onto existing rows.
 */

const SECRET = 'test-np-service-secret';
const BASE = '/api/internal/netpulse/v1';
const SESSIONS = `${BASE}/session`;

async function register(email: string, password = 'Sup3rSecurePass'): Promise<{ token: string; userId: string }> {
  const res = await SELF.fetch('https://worker.test/api/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, device: { name: 'Desktop testbox', os: 'Windows', appVersion: '1.0.2' } }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { accessToken: string; user: { id: string } };
  return { token: body.accessToken, userId: body.user.id };
}

/** A live link row, which is the only thing that authorizes this surface. */
async function linkAccount(userId: string, netpulseAccountId: string, status = 'active'): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO np_links (id, user_id, telegram_user_id, netpulse_account_id, status, initiated_by, created_at, updated_at)
       VALUES (?, ?, 4242, ?, ?, 'netpulse', ?, ?)`,
    )
    .bind(`npl_${netpulseAccountId}`, userId, netpulseAccountId, status, Date.now(), Date.now())
    .run();
}

/** Sign and send exactly like the bot does, including the query string. */
async function signed(
  method: 'GET' | 'DELETE',
  pathWithQuery: string,
  body: unknown,
  opts?: { tamper?: boolean },
): Promise<Response> {
  const bodyText = body === undefined ? '' : JSON.stringify(body);
  const ts = String(Date.now());
  const nonce = `n${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
  const sig = await hmacHexForTest(SECRET, canonicalString(ts, nonce, method, pathWithQuery, await sha256Hex(bodyText)));
  return SELF.fetch(`https://worker.test${pathWithQuery}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-np-timestamp': ts,
      'x-np-nonce': nonce,
      'x-np-request-id': 'test-req',
      'x-np-signature': opts?.tamper ? `f${sig.slice(1)}` : sig,
    },
    ...(bodyText ? { body: bodyText } : {}),
  });
}

const errOf = async (res: Response): Promise<string> => ((await res.json()) as { error?: string }).error ?? '';

/** The session row `register` just created — its id is minted by the worker, not by us. */
async function sessionIdOf(userId: string): Promise<string> {
  const row = await env.DB.prepare(`SELECT id FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(userId)
    .first<{ id: string }>();
  expect(row?.id).toBeTruthy();
  return row!.id;
}

beforeAll(async () => {
  await env.DB.prepare(`DELETE FROM users`).run();
  await env.DB.prepare(`DELETE FROM np_links`).run();
  await env.DB.prepare(`DELETE FROM rate_limits`).run();
});

describe('the bot can see a linked account\'s signed-in devices', () => {
  it('lists live sessions for an active link', async () => {
    const { token, userId } = await register('sess-list@example.com');
    await linkAccount(userId, 'npa_list_ok');

    const res = await signed('GET', `${SESSIONS}?netpulseAccountId=npa_list_ok`, undefined);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean; data: { sessions: Array<Record<string, unknown>> } };
    expect(body.ok).toBe(true);
    expect(body.data.sessions).toHaveLength(1);
    expect(body.data.sessions[0]).toMatchObject({
      deviceName: 'Desktop testbox',
      os: 'Windows',
      appVersion: '1.0.2',
    });
    // The bot learns which session to revoke, and nothing else.
    expect(typeof body.data.sessions[0].sessionId).toBe('string');
    // Token material must never cross this boundary.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain(userId);
    expect(serialized).not.toContain(token);
  });

  it('revokes one named device, and only that one', async () => {
    const { userId } = await register('sess-revoke@example.com');
    await linkAccount(userId, 'npa_revoke');
    const sessionId = await sessionIdOf(userId);

    const res = await signed('DELETE', `${SESSIONS}/${sessionId}`, { netpulseAccountId: 'npa_revoke' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, data: { revoked: true } });

    const row = await env.DB.prepare(`SELECT revoked_at, revoked_reason FROM sessions WHERE id = ?`).bind(sessionId).first<{
      revoked_at: number | null;
      revoked_reason: string | null;
    }>();
    expect(row?.revoked_at).toBeGreaterThan(0);
    expect(row?.revoked_reason).toBe('telegram-device-revoke');

    // Revoking twice is a 404, not a second silent success.
    const again = await signed('DELETE', `${SESSIONS}/${sessionId}`, { netpulseAccountId: 'npa_revoke' });
    expect(again.status).toBe(404);
  });

  it('never revokes a session belonging to another account', async () => {
    const victim = await register('sess-victim@example.com');
    const attacker = await register('sess-attacker@example.com');
    await linkAccount(attacker.userId, 'npa_attacker');
    const victimSessionId = await sessionIdOf(victim.userId);

    const res = await signed('DELETE', `${SESSIONS}/${victimSessionId}`, { netpulseAccountId: 'npa_attacker' });
    expect(res.status).toBe(404);

    const row = await env.DB.prepare(`SELECT revoked_at FROM sessions WHERE id = ?`).bind(victimSessionId).first<{
      revoked_at: number | null;
    }>();
    expect(row?.revoked_at).toBeNull();
  });
});

describe('the boundary itself', () => {
  it('refuses an unsigned or tampered call', async () => {
    const { userId } = await register('sess-sig@example.com');
    await linkAccount(userId, 'npa_sig');

    const unsigned = await SELF.fetch(`https://worker.test${SESSIONS}?netpulseAccountId=npa_sig`);
    expect(unsigned.status).toBe(401);

    const tampered = await signed('GET', `${SESSIONS}?netpulseAccountId=npa_sig`, undefined, { tamper: true });
    expect(tampered.status).toBe(401);
  });

  it('binds the account id into the signature', async () => {
    const { userId } = await register('sess-query@example.com');
    await linkAccount(userId, 'npa_query');

    // Sign one query, send another: the canonical string covers the query, so
    // swapping the account under a valid signature must fail.
    const bodyText = '';
    const ts = String(Date.now());
    const nonce = `n${Math.random().toString(16).slice(2)}`;
    const sig = await hmacHexForTest(SECRET, canonicalString(ts, nonce, 'GET', `${SESSIONS}?netpulseAccountId=npa_query`, await sha256Hex(bodyText)));
    const res = await SELF.fetch(`https://worker.test${SESSIONS}?netpulseAccountId=npa_other`, {
      headers: { 'x-np-timestamp': ts, 'x-np-nonce': nonce, 'x-np-request-id': 'r', 'x-np-signature': sig },
    });
    expect(res.status).toBe(401);
  });

  it('serves nothing for a link that is not active', async () => {
    const { userId } = await register('sess-unlinked@example.com');
    await linkAccount(userId, 'npa_revoked', 'unlinked');

    const res = await signed('GET', `${SESSIONS}?netpulseAccountId=npa_revoked`, undefined);
    expect(res.status).toBe(404);
    expect(await errOf(res)).toBe('not_linked');

    // And an id nobody holds gets the same answer — no oracle for valid ids.
    const unknown = await signed('GET', `${SESSIONS}?netpulseAccountId=npa_never_existed`, undefined);
    expect(unknown.status).toBe(404);
    expect(await errOf(unknown)).toBe('not_linked');
  });

  it('needs an account id at all', async () => {
    const res = await signed('GET', SESSIONS, undefined);
    expect(res.status).toBe(400);
    expect(await errOf(res)).toBe('missing_netpulse_account_id');
  });

  it('leaves the human API and the event inbox untouched', async () => {
    // The app-facing routes are bearer-authenticated and must stay that way:
    // a bot signature must never open the human surface.
    const viaBotSig = await signed('GET', '/api/v1/account/sessions', undefined);
    expect(viaBotSig.status).toBe(401);

    // And a call meant for the device surface must not be mistaken for an event.
    const notAnEvent = await signed('GET', `${BASE}/events`, undefined);
    expect(notAnEvent.status).not.toBe(200);
  });
});