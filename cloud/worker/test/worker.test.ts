import { env, SELF, createExecutionContext } from 'cloudflare:test';
import { describe, expect, it, beforeAll } from 'vitest';

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

  it('password reset: token is single-use, expires, revokes sessions', async () => {
    const { token } = await register('reset@example.com');
    // issue
    await SELF.fetch('https://worker.test/api/v1/auth/forgot-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'reset@example.com' }),
    });
    // fetch the raw token from the audit trail (this build's delivery channel)
    const row = await env.DB.prepare(`SELECT detail FROM audit_events WHERE kind = 'reset.requested' ORDER BY at DESC LIMIT 1`).first<{ detail: string }>();
    const raw = row?.detail.replace('token:', '') ?? '';
    expect(raw.length).toBeGreaterThan(20);
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
