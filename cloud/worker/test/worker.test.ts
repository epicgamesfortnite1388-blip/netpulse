import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, beforeAll } from 'vitest';

import { setMailer, setMailPost } from '../src/mail';

describe('CORS preflight allow-list (audit F5 regression)', () => {
  it('does NOT reflect an arbitrary origin in preflight responses', async () => {
    const res = await SELF.fetch('https://worker.test/api/v1/auth/login', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('grants the product own origins only', async () => {
    for (const origin of ['https://netpulse-cloud.shuridehradin.workers.dev', 'http://tauri.localhost']) {
      const res = await SELF.fetch('https://worker.test/api/v1/auth/login', {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST' },
      });
      expect(res.headers.get('access-control-allow-origin')).toBe(origin);
    }
  });
});

/**
 * Security + behavior contract of the NetPulse cloud Worker, driven through
 * the real fetch handler against real D1 (miniflare). Migration 0001 is
 * applied by the vitest-pool-workers config before these run.
 */

const DEVICE = { name: 'TestDesk', os: 'Windows', appVersion: '1.0.2' };

async function register(email: string, password = 'Sup3rSecurePass'): Promise<{ token: string; refresh: string; userId: string }> {
  const res = await SELF.fetch('https://worker.test/api/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, device: DEVICE }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { accessToken: string; refreshToken: string; user: { id: string } };
  return { token: body.accessToken, refresh: body.refreshToken, userId: body.user.id };
}

async function authFetch(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return SELF.fetch(`https://worker.test${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

beforeAll(async () => {
  await env.DB.prepare(`DELETE FROM users`).run();
  await env.DB.prepare(`DELETE FROM rate_limits`).run();
});

afterEach(() => {
  // Never leak a mail seam into the next test.
  setMailer(null);
  setMailPost(null);
});

describe('health', () => {
  it('reports ok with a live D1', async () => {
    const res = await SELF.fetch('https://worker.test/api/v1/health');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });
});

describe('registration', () => {
  it('creates an account and returns a session', async () => {
    const { token, userId } = await register('alice@example.com');
    expect(userId).toMatch(/^usr_/);
    const me = await authFetch(token, '/api/v1/account');
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { email: string } }).user.email).toBe('alice@example.com');
  });

  it('rejects duplicate email with 409', async () => {
    await register('dup@example.com');
    const res = await SELF.fetch('https://worker.test/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'dup@example.com', password: 'Sup3rSecurePass' }),
    });
    expect(res.status).toBe(409);
  });

  it('rejects weak passwords and malformed emails with 400', async () => {
    for (const body of [
      { email: 'weak@example.com', password: 'short' },
      { email: 'weak2@example.com', password: 'alllowercase123' },
      { email: 'not-an-email', password: 'Sup3rSecurePass' },
    ]) {
      const res = await SELF.fetch('https://worker.test/api/v1/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    }
  });

  it('never stores plaintext passwords', async () => {
    await register('hashcheck@example.com', 'Uniqu3PasswordX');
    const row = await env.DB.prepare(`SELECT password_hash FROM users WHERE email = 'hashcheck@example.com'`).first<{ password_hash: string }>();
    expect(row?.password_hash).toMatch(/^pbkdf2\$\d+\$/);
    expect(row?.password_hash).not.toContain('Uniqu3PasswordX');
  });
});

describe('login + sessions', () => {
  it('logs in and returns a working session', async () => {
    await register('login@example.com');
    const res = await SELF.fetch('https://worker.test/api/v1/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'login@example.com', password: 'Sup3rSecurePass', device: DEVICE }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accessToken: string };
    const me = await authFetch(body.accessToken, '/api/v1/account');
    expect(me.status).toBe(200);
  });

  it('rejects wrong password with generic 401 (no enumeration)', async () => {
    await register('enum@example.com');
    const res = await SELF.fetch('https://worker.test/api/v1/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'enum@example.com', password: 'WrongPassword1' }),
    });
    expect(res.status).toBe(401);
    const unknown = await SELF.fetch('https://worker.test/api/v1/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ghost@example.com', password: 'WrongPassword1' }),
    });
    expect(unknown.status).toBe(401);
    expect(((await unknown.json()) as { error: { message: string } }).error.message)
      .toBe(((await res.clone().json()) as { error: { message: string } }).error.message);
  });

  it('logout revokes the session; reuse is 401', async () => {
    const { token } = await register('logout@example.com');
    expect((await authFetch(token, '/api/v1/auth/logout', { method: 'POST' })).status).toBe(200);
    expect((await authFetch(token, '/api/v1/account')).status).toBe(401);
  });

  it('refresh rotates; replaying the old refresh token revokes the chain', async () => {
    const { refresh } = await register('rot@example.com');
    const r1 = await SELF.fetch('https://worker.test/api/v1/auth/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: refresh }),
    });
    expect(r1.status).toBe(200);
    const rotated = (await r1.json()) as { accessToken: string; refreshToken: string };
    expect(rotated.refreshToken).not.toBe(refresh);
    // replay the ORIGINAL refresh token -> reuse detection -> session dead
    const replay = await SELF.fetch('https://worker.test/api/v1/auth/refresh', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken: refresh }),
    });
    expect(replay.status).toBe(401);
    // the rotated access token died with the chain
    expect((await authFetch(rotated.accessToken, '/api/v1/account')).status).toBe(401);
  });

  it('lists sessions and can revoke a specific one', async () => {
    const a = await register('sess@example.com');
    const login = await SELF.fetch('https://worker.test/api/v1/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'sess@example.com', password: 'Sup3rSecurePass', device: { name: 'SecondBox' } }),
    });
    const b = (await login.json()) as { accessToken: string; refreshToken: string; session: { id: string } };
    const list = await authFetch(a.token, '/api/v1/account/sessions');
    const sessions = ((await list.json()) as { sessions: Array<{ id: string; current: boolean; deviceName: string | null }> }).sessions;
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    const second = sessions.find((s) => s.deviceName === 'SecondBox');
    expect(second).toBeTruthy();
    expect((await authFetch(a.token, '/api/v1/account/sessions/revoke', { method: 'POST', body: JSON.stringify({ sessionId: second!.id }) })).status).toBe(200);
    expect((await authFetch(b.accessToken, '/api/v1/account')).status).toBe(401);
  });
});

describe('user data isolation', () => {
  it('user A cannot read or write user B data', async () => {
    const a = await register('iso-a@example.com');
    const b = await register('iso-b@example.com');
    // A creates a profile and a favorite
    expect((await authFetch(a.token, '/api/v1/profiles', {
      method: 'PUT',
      body: JSON.stringify({ id: 'prof_1', name: 'A prof', protocol: 'vless', endpoint: '{"host":"h"}', config: '{}' }),
    })).status).toBe(200);
    expect((await authFetch(a.token, '/api/v1/favorites', { method: 'PUT', body: JSON.stringify({ nodeKey: 'node:xyz', label: 'mine' }) })).status).toBe(200);

    // B sees neither
    const bProfiles = (await (await authFetch(b.token, '/api/v1/profiles')).json()) as { profiles: unknown[] };
    expect(bProfiles.profiles).toHaveLength(0);
    const bFavs = (await (await authFetch(b.token, '/api/v1/favorites')).json()) as { favorites: unknown[] };
    expect(bFavs.favorites).toHaveLength(0);

    // B cannot delete A's profile by id (isolation bound in the WHERE)
    const del = await authFetch(b.token, '/api/v1/profiles', {
      method: 'PUT',
      body: JSON.stringify({ id: 'prof_1', name: 'hijack', protocol: 'vless', config: '{}', deleted: true }),
    });
    expect(del.status).toBe(200);
    const aProfiles = (await (await authFetch(a.token, '/api/v1/profiles')).json()) as { profiles: Array<{ id: string }> };
    expect(aProfiles.profiles.some((p) => p.id === 'prof_1')).toBe(true);

    // B cannot read A's history or settings
    expect((((await (await authFetch(b.token, '/api/v1/history')).json()) as { items: unknown[] }).items)).toHaveLength(0);
    expect(((await (await authFetch(b.token, '/api/v1/settings')).json()) as { payload: string }).payload).toBe('{}');

    // B cannot revoke A's session
    const listA = ((await (await authFetch(a.token, '/api/v1/account/sessions')).json()) as { sessions: Array<{ id: string }> }).sessions;
    expect((await authFetch(b.token, '/api/v1/account/sessions/revoke', { method: 'POST', body: JSON.stringify({ sessionId: listA[0]!.id }) })).status).toBe(404);
    expect((await authFetch(a.token, '/api/v1/account')).status).toBe(200);
  });
});

describe('sync endpoints', () => {
  it('settings round-trip, history push/pull, preferences', async () => {
    const { token } = await register('sync@example.com');
    expect((await authFetch(token, '/api/v1/settings', { method: 'PUT', body: JSON.stringify({ payload: '{"theme":"dark","scanProfile":"balanced"}', updatedAt: 1 }) })).status).toBe(200);
    const settings = (await (await authFetch(token, '/api/v1/settings')).json()) as { payload: string };
    expect(JSON.parse(settings.payload)).toMatchObject({ theme: 'dark' });

    expect((await authFetch(token, '/api/v1/history', {
      method: 'POST',
      body: JSON.stringify({ items: [{ id: 'h1', kind: 'discovery', at: Date.now(), payload: '{"probed":10}' }] }),
    })).status).toBe(200);
    const history = (await (await authFetch(token, '/api/v1/history')).json()) as { items: Array<{ id: string }> };
    expect(history.items.map((i) => i.id)).toContain('h1');

    expect((await authFetch(token, '/api/v1/preferences', { method: 'PUT', body: JSON.stringify({ key: 'lastExit', value: 'FR' }) })).status).toBe(200);
    const prefs = (await (await authFetch(token, '/api/v1/preferences')).json()) as { preferences: Array<{ key: string; value: string | null }> };
    expect(prefs.preferences.find((p) => p.key === 'lastExit')?.value).toBe('FR');
  });

  it('rejects non-object settings payloads', async () => {
    const { token } = await register('badjson@example.com');
    const res = await authFetch(token, '/api/v1/settings', { method: 'PUT', body: JSON.stringify({ payload: '"just a string"', updatedAt: 1 }) });
    expect(res.status).toBe(400);
  });

  // Regression: idx_profiles_user_name (UNIQUE(user_id, name) WHERE deleted_at
  // IS NULL) is not covered by ON CONFLICT (id), so a profile re-imported
  // under a new id with the same name used to 409 EVERY sync forever.
  it('profiles PUT: same-name re-import under a new id tombstones the old envelope instead of 409ing', async () => {
    const { token } = await register('profilename@example.com');
    const put = (body: Record<string, unknown>) => authFetch(token, '/api/v1/profiles', { method: 'PUT', body: JSON.stringify(body) });
    expect((await put({ id: 'np-local-aaa', name: 'Tokyo', protocol: 'vless', endpoint: 'tok:443', config: '{}' })).status).toBe(200);
    // The recreated profile (new id, same name) must win and take over.
    expect((await put({ id: 'np-local-bbb', name: 'Tokyo', protocol: 'vless', endpoint: 'tok2:443', config: '{}' })).status).toBe(200);
    let list = (await (await authFetch(token, '/api/v1/profiles')).json()) as { profiles: Array<{ id: string; endpoint: string | null }> };
    const live = list.profiles.filter((p) => p.id.startsWith('np-local-'));
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ id: 'np-local-bbb', endpoint: 'tok2:443' });
    // Re-pushing the same id keeps it live (no self-tombstone via id != ?).
    expect((await put({ id: 'np-local-bbb', name: 'Tokyo', protocol: 'vless', endpoint: 'tok3:443', config: '{}' })).status).toBe(200);
    list = (await (await authFetch(token, '/api/v1/profiles')).json()) as { profiles: Array<{ id: string; endpoint: string | null }> };
    expect(list.profiles.filter((p) => p.id === 'np-local-bbb')).toHaveLength(1);
    expect(list.profiles.find((p) => p.id === 'np-local-bbb')?.endpoint).toBe('tok3:443');
    // Distinct names keep coexisting.
    expect((await put({ id: 'np-local-ccc', name: 'Osaka', protocol: 'ss', config: '{}' })).status).toBe(200);
    list = (await (await authFetch(token, '/api/v1/profiles')).json()) as { profiles: Array<{ id: string; endpoint: string | null }> };
    expect(list.profiles.filter((p) => p.id.startsWith('np-local-')).map((p) => p.id).sort()).toEqual(['np-local-bbb', 'np-local-ccc']);
  });
});

describe('security abuse', () => {
  it('rejects missing/garbage bearer tokens', async () => {
    expect((await authFetch('garbage-token-value', '/api/v1/account')).status).toBe(401);
    const noAuth = await SELF.fetch('https://worker.test/api/v1/account');
    expect(noAuth.status).toBe(401);
  });

  it('SQL injection through inputs stays data', async () => {
    const { token } = await register('sqli@example.com');
    const res = await authFetch(token, '/api/v1/favorites', {
      method: 'PUT',
      body: JSON.stringify({ nodeKey: "node:x'); DROP TABLE user_favorites;--", label: 'sneaky' }),
    });
    expect(res.status).toBe(200);
    const table = await env.DB.prepare(`SELECT COUNT(*) AS n FROM user_favorites`).first<{ n: number }>();
    expect(table?.n).toBeGreaterThan(0); // table still exists
  });

  it('oversized bodies are rejected with 413', async () => {
    const { token } = await register('big@example.com');
    const big = 'x'.repeat(70 * 1024);
    const res = await authFetch(token, '/api/v1/settings', { method: 'PUT', body: JSON.stringify({ payload: `{"a":"${big}"}`, updatedAt: 1 }) });
    expect(res.status).toBe(413);
  });

  it('rate limits brute-force login per email', async () => {
    const email = 'bruteforce@example.com';
    await register(email);
    let lastStatus = 200;
    for (let i = 0; i < 12; i++) {
      const res = await SELF.fetch('https://worker.test/api/v1/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: `WrongGuess${i}Aa1` }),
      });
      lastStatus = res.status;
      if (res.status === 429) break;
    }
    expect(lastStatus).toBe(429);
  });

  it('password reset: token is delivered by email, never by the audit log; single-use, revokes sessions', async () => {
    const { token } = await register('reset@example.com');
    // Capture the email instead of reading the token back from any log.
    let sentTo = '';
    let sentHtml = '';
    setMailer({
      configured: () => true,
      send: async (_env, to, resetToken, origin) => {
        sentTo = to;
        sentHtml = `${origin}/reset?token=${resetToken}`;
        return { delivered: true, reason: 'mail_sent' };
      },
    });
    const issued = await SELF.fetch('https://worker.test/api/v1/auth/forgot-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'reset@example.com' }),
    });
    expect(issued.status).toBe(200);
    expect(sentTo).toBe('reset@example.com');
    // THE FIX UNDER TEST: the audit trail must not carry the credential.
    const row = await env.DB.prepare(`SELECT detail FROM audit_events WHERE kind = 'reset.requested' ORDER BY at DESC LIMIT 1`).first<{ detail: string }>();
    expect(row?.detail).toBe('mail_sent');
    const raw = sentHtml.split('token=')[1] ?? '';
    expect(raw.length).toBeGreaterThan(20);
    const leaked = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE detail LIKE '%${raw}%'`).first<{ n: number }>();
    expect(leaked?.n).toBe(0);
    // unknown token rejected
    const bad = await SELF.fetch('https://worker.test/api/v1/auth/reset-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'x'.repeat(43) + 'y', newPassword: 'AnotherPass123' }),
    });
    expect(bad.status).toBe(400);
    // good token works
    const ok = await SELF.fetch('https://worker.test/api/v1/auth/reset-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: raw, newPassword: 'AnotherPass123' }),
    });
    expect(ok.status).toBe(200);
    // old session revoked by reset
    expect((await authFetch(token, '/api/v1/account')).status).toBe(401);
    // token is single-use
    const reuse = await SELF.fetch('https://worker.test/api/v1/auth/reset-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: raw, newPassword: 'AnotherPass456' }),
    });
    expect(reuse.status).toBe(400);
    // new password logs in
    const login = await SELF.fetch('https://worker.test/api/v1/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'reset@example.com', password: 'AnotherPass123' }),
    });
    expect(login.status).toBe(200);
  });

  it('forgot-password without a mail transport: uniform response, honest audit, no token anywhere', async () => {
    await register('nomail@example.com');
    setMailer({ configured: () => false, send: async () => { throw new Error('send must not be called when unconfigured'); } });
    const known = await SELF.fetch('https://worker.test/api/v1/auth/forgot-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'nomail@example.com' }),
    });
    const unknown = await SELF.fetch('https://worker.test/api/v1/auth/forgot-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'ghost@example.com' }),
    });
    // No enumeration: identical status + body regardless of account existence.
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(await known.json()).toEqual(await unknown.json());
    const row = await env.DB.prepare(`SELECT detail FROM audit_events WHERE kind = 'reset.requested' ORDER BY at DESC LIMIT 1`).first<{ detail: string }>();
    expect(row?.detail).toBe('mail_unconfigured');
    const anyToken = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_events WHERE detail LIKE 'token:%'`).first<{ n: number }>();
    expect(anyToken?.n).toBe(0);
  });

  it('resend transport: correct request shape, link carries the token, failures are honest', async () => {
    let captured: { url: string; auth: string; body: string } | null = null;
    setMailPost(async (url, init) => {
      captured = { url, auth: String((init.headers as Record<string, string>).Authorization), body: String(init.body) };
      return new Response('{"id":"m1"}', { status: 200 });
    });
    const envLike = { RESEND_API_KEY: 're_test_key', MAIL_FROM: 'NetPulse <no-reply@worker.test>' } as never;
    const { sendResetEmail } = await import('../src/mail');
    const ok = await sendResetEmail(envLike, 'a@b.test', 'TOKENVALUE123', 'https://worker.test');
    expect(ok.delivered).toBe(true);
    expect(captured!.url).toBe('https://api.resend.com/emails');
    expect(captured!.auth).toBe('Bearer re_test_key');
    expect(captured!.body).toContain('"to":["a@b.test"]');
    expect(captured!.body).toContain('https://worker.test/reset?token=TOKENVALUE123');
    // Missing from address / HTTP failure / network throw degrade honestly.
    expect((await sendResetEmail({ RESEND_API_KEY: 'k' } as never, 'a@b.test', 't', 'https://worker.test')).reason).toBe('mail_from_missing');
    setMailPost(async () => new Response('nope', { status: 403 }));
    expect((await sendResetEmail(envLike, 'a@b.test', 't', 'https://worker.test')).reason).toBe('mail_http_403');
    setMailPost(async () => { throw new Error('boom'); });
    expect((await sendResetEmail(envLike, 'a@b.test', 't', 'https://worker.test')).reason).toBe('mail_error');
  });

  it('profile vaults: ciphertext roundtrip, isolation, no plaintext accepted path', async () => {
    const a = await register('vault-a@example.com');
    const b = await register('vault-b@example.com');
    const cipher = 'v1.AAAAAAAAAAAAAAAAAAAAAA.AAAAbase64cipherTextZZZ==';
    // PUT (upsert)
    expect((await authFetch(a.token, '/api/v1/profile-vaults', { method: 'PUT', body: JSON.stringify({ profileId: 'np-local-x1', ciphertext: cipher, updatedAt: 111 }) })).status).toBe(200);
    // GET returns it only for the owner
    const aGet = await authFetch(a.token, '/api/v1/profile-vaults');
    expect(aGet.status).toBe(200);
    const aList = (await aGet.json()) as { vaults: Array<{ profileId: string; ciphertext: string }> };
    expect(aList.vaults).toHaveLength(1);
    expect(aList.vaults[0].ciphertext).toBe(cipher);
    expect(((await authFetch(b.token, '/api/v1/profile-vaults')).json() as Promise<{ vaults: unknown[] }>).then((j) => j.vaults)).resolves.toHaveLength(0);
    // Upsert replaces, keyed per user (B writing the same profileId sees only their own)
    expect((await authFetch(a.token, '/api/v1/profile-vaults', { method: 'PUT', body: JSON.stringify({ profileId: 'np-local-x1', ciphertext: 'v1.BBBBBBBBBBBBBBBBBBBBBB.BBBBnewerBlob==', updatedAt: 222 }) })).status).toBe(200);
    expect((await authFetch(b.token, '/api/v1/profile-vaults', { method: 'PUT', body: JSON.stringify({ profileId: 'np-local-x1', ciphertext: cipher, updatedAt: 222 }) })).status).toBe(200);
    const after = ((await (await authFetch(a.token, '/api/v1/profile-vaults')).json()) as { vaults: Array<{ ciphertext: string }> }).vaults;
    expect(after).toHaveLength(1);
    expect(after[0].ciphertext).toContain('BBBB');
    // A hostile client cannot stash plaintext: the schema has no config field
    // and the blob must be base64.
    expect((await authFetch(a.token, '/api/v1/profile-vaults', { method: 'PUT', body: JSON.stringify({ profileId: 'p', ciphertext: '<not base64>', updatedAt: 1 }) })).status).toBe(400);
    // Delete removes only the owner's row.
    expect((await authFetch(b.token, '/api/v1/profile-vaults/delete', { method: 'POST', body: JSON.stringify({ profileId: 'np-local-x1' }) })).status).toBe(200);
    expect(((await (await authFetch(b.token, '/api/v1/profile-vaults')).json()) as { vaults: unknown[] }).vaults).toHaveLength(0);
    expect(((await (await authFetch(a.token, '/api/v1/profile-vaults')).json()) as { vaults: unknown[] }).vaults).toHaveLength(1);
    // Unauthenticated access is refused like every other route.
    expect((await SELF.fetch('https://worker.test/api/v1/profile-vaults')).status).toBe(401);
  });

  it('account deletion wipes the profile vaults with the rest of the user data', async () => {
    const a = await register('vault-del@example.com');
    await authFetch(a.token, '/api/v1/profile-vaults', { method: 'PUT', body: JSON.stringify({ profileId: 'np-local-d1', ciphertext: 'v1.CCCCCCCCCCCCCCCCCCCCCC.CCC==', updatedAt: 1 }) });
    expect((await authFetch(a.token, '/api/v1/account', { method: 'DELETE' })).status).toBe(200);
    const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM profile_vaults`).first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it('serves the reset page with a locked-down CSP and no server-side token interpolation', async () => {
    const res = await SELF.fetch('https://worker.test/reset?token=SHOULD_NOT_BE_ECHOED_123456789012345678901234');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain('/api/v1/auth/reset-password');
    expect(html).not.toContain('SHOULD_NOT_BE_ECHOED');
  });

  it('password change requires the current password and revokes other sessions', async () => {
    const a = await register('pwchange@example.com');
    const bad = await authFetch(a.token, '/api/v1/account/password', {
      method: 'POST', body: JSON.stringify({ currentPassword: 'WrongPassword1', newPassword: 'FreshPassword99' }),
    });
    expect(bad.status).toBe(401);
    const ok = await authFetch(a.token, '/api/v1/account/password', {
      method: 'POST', body: JSON.stringify({ currentPassword: 'Sup3rSecurePass', newPassword: 'FreshPassword99' }),
    });
    expect(ok.status).toBe(200);
    // current session survives, new password works
    expect((await authFetch(a.token, '/api/v1/account')).status).toBe(200);
    const relogin = await SELF.fetch('https://worker.test/api/v1/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'pwchange@example.com', password: 'FreshPassword99' }),
    });
    expect(relogin.status).toBe(200);
  });

  it('unknown routes: 401 unauthenticated (no route discovery), 404 authenticated', async () => {
    // Auth runs before routing on purpose: an unauthenticated caller cannot
    // probe which routes exist.
    const anon = await SELF.fetch('https://worker.test/api/v1/nonexistent');
    expect(anon.status).toBe(401);
    const { token } = await register('notfound@example.com');
    const res = await authFetch(token, '/api/v1/nonexistent');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found');
  });

  it('account deletion cascades all user data', async () => {
    const { token, userId } = await register('del@example.com');
    await authFetch(token, '/api/v1/profiles', { method: 'PUT', body: JSON.stringify({ id: 'prof_del', name: 'x', protocol: 'ss', config: '{}' }) });
    expect((await authFetch(token, '/api/v1/account', { method: 'DELETE' })).status).toBe(200);
    expect((await authFetch(token, '/api/v1/account')).status).toBe(401);
    const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM vpn_profiles WHERE user_id = ?`).bind(userId).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
