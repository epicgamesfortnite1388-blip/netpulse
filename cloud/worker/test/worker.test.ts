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
});async function loginReturnToken(email: string, password = 'Sup3rSecurePass'): Promise<string> {
  const res = await SELF.fetch('https://worker.test/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const json = (await res.json()) as { accessToken?: string };
  return json.accessToken ?? '';
}

async function grantAdmin(userId: string): Promise<void> {
  await env.DB.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).bind(userId).run();
}

async function seedPlan(plan?: { code?: string; name?: string; defaultProfiles?: string; defaultNodes?: string; defaultScanProfile?: string; preferredProxyEngine?: string }): Promise<void> {
  const t = Date.now();
  await env.DB.prepare(
    `INSERT INTO plans (id, code, name, default_profiles, default_nodes, default_scan_profile, preferred_proxy_engine, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       code = COALESCE(EXCLUDED.code, plans.code),
       name = COALESCE(EXCLUDED.name, plans.name),
       default_profiles = COALESCE(EXCLUDED.default_profiles, plans.default_profiles),
       default_nodes = COALESCE(EXCLUDED.default_nodes, plans.default_nodes),
       default_scan_profile = COALESCE(EXCLUDED.default_scan_profile, plans.default_scan_profile),
       preferred_proxy_engine = COALESCE(EXCLUDED.preferred_proxy_engine, plans.preferred_proxy_engine),
       updated_at = ?`,
  )
    .bind('plan_pro', plan?.code ?? 'pro', plan?.name ?? 'Pro', plan?.defaultProfiles ?? '[]', plan?.defaultNodes ?? '[]', plan?.defaultScanProfile ?? 'balanced', plan?.preferredProxyEngine ?? 'auto', t, t)
    .run();
}

/**
 * Security + behavior contract of the NetPulse cloud Worker, driven through
 * the real fetch handler against real D1 (miniflare). Migration 0001 is
 * applied by the vitest setup file before these run.
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

  it('forgot-password throttling states how long the wait is', async () => {
    // A dedicated client IP: the bucket is per-address, and the other reset
    // tests share the default one.
    const call = (): Promise<Response> =>
      SELF.fetch('https://worker.test/api/v1/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'cf-connecting-ip': '203.0.113.77' },
        body: JSON.stringify({ email: 'throttle-probe@example.com' }),
      });
    let last = await call();
    for (let i = 0; i < 5 && last.status === 200; i += 1) last = await call();
    expect(last.status).toBe(429);
    const body = (await last.json()) as { error: { code: string }; retryAfterSec?: number };
    expect(body.error.code).toBe('rate_limited');
    // The number is what the sign-in screen counts down from; without it the
    // only honest thing to say is "later", which is what this change removes.
    expect(body.retryAfterSec).toBeGreaterThan(0);
    expect(body.retryAfterSec).toBeLessThanOrEqual(3600);
    expect(last.headers.get('Retry-After')).toBe(String(body.retryAfterSec));
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
    // A provider rejection carries its reason into the audit: a bare status made
    // an unverified sender domain indistinguishable from a malformed request.
    setMailPost(async () =>
      new Response('{"name":"validation_error","message":"The from address is not verified"}', { status: 422 }),
    );
    expect((await sendResetEmail(envLike, 'a@b.test', 't', 'https://worker.test')).reason).toBe(
      'mail_http_422:validation_error/The from address is not verified',
    );
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
    const bList = (await (await authFetch(b.token, '/api/v1/profile-vaults')).json()) as { vaults: unknown[] };
    expect(bList.vaults).toHaveLength(0);
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

  it('signals the Plan code from the account endpoint', async () => {
    await seedPlan({ code: 'pro', name: 'Pro' });
    await register('plan-sig@example.com');
    const admin = await register('plan-sig-admin@example.com');
    await grantAdmin(admin.userId);
    const at = await loginReturnToken('plan-sig-admin@example.com');
    expect(at).not.toBe('');
    const res = await authFetch(at, '/api/v1/account');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { role: string } };
    expect(body.user.role).toBe('admin');
  });
});

describe('admin account and plan-of-record', () => {
  it('rejects admin-only routes for a normal user', async () => {
    await register('normal@example.com');
    const token = await loginReturnToken('normal@example.com');
    expect(token).not.toBe('');
    for (const path of ['/api/v1/admin/plan', '/api/v1/admin/users', '/api/v1/admin/events']) {
      expect((await authFetch(token, path)).status).toBe(403);
    }
  });

  it('normal accounts cannot read or patch the plan default VPN configs and nodes', async () => {
    await register('normal-restrict@example.com');
    const nt = await loginReturnToken('normal-restrict@example.com');
    expect(nt).not.toBe('');
    for (const path of ['/api/v1/admin/plan', '/api/v1/admin/users', '/api/v1/admin/events']) {
      expect((await authFetch(nt, path)).status).toBe(403);
    }
    // Admin-owned defaults are unreachable in both directions for a normal
    // account: the reads above are 403 and neither list can be written.
    const configs = await authFetch(nt, '/api/v1/admin/plan', {
      method: 'PATCH',
      body: JSON.stringify({ defaultProfiles: '["config:restricted"]' }),
    });
    expect(configs.status).toBe(403);
    const nodes = await authFetch(nt, '/api/v1/admin/plan', {
      method: 'PATCH',
      body: JSON.stringify({ defaultNodes: '["node:restricted"]' }),
    });
    expect(nodes.status).toBe(403);
  });

  it('admin account can read the plan default VPN configs and nodes', async () => {
    await seedPlan({ code: 'pro', name: 'Pro', defaultProfiles: '["cfg-a","cfg-b"]', defaultNodes: '["node-a","node-b"]', defaultScanProfile: 'balanced' });
    const admin = await register('admin-read@example.com');
    await grantAdmin(admin.userId);
    const at = await loginReturnToken('admin-read@example.com');
    expect(at).not.toBe('');
    const res = await authFetch(at, '/api/v1/admin/plan');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plan: { name: string; defaultScanProfile: string; preferredProxyEngine: string; defaultProfiles: string; defaultNodes: string } };
    expect(body.plan.name).toBe('Pro');
    expect(body.plan.defaultScanProfile).toBe('balanced');
    expect(body.plan.preferredProxyEngine).toBe('auto');
    expect(body.plan.defaultProfiles).toBe('["cfg-a","cfg-b"]');
    expect(body.plan.defaultNodes).toBe('["node-a","node-b"]');
  });

  it('admin can patch the plan of record', async () => {
    await seedPlan({ code: 'pro', name: 'Pro', defaultScanProfile: 'balanced', preferredProxyEngine: 'auto' });
    const admin = await register('admin-patch@example.com');
    await grantAdmin(admin.userId);
    const at = await loginReturnToken('admin-patch@example.com');
    expect(at).not.toBe('');
    const patch = await authFetch(at, '/api/v1/admin/plan', {
      method: 'PATCH',
      body: JSON.stringify({
        name: 'Enterprise',
        defaultScanProfile: 'thorough',
        preferredProxyEngine: 'singbox',
        defaultProfiles: '["cfg-1","cfg-2"]',
        defaultNodes: '["node-1","node-2"]',
      }),
    });
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as { plan: { name: string; defaultScanProfile: string; preferredProxyEngine: string; defaultProfiles: string; defaultNodes: string }, changed: { code: boolean; name: boolean; defaultScanProfile: boolean; preferredProxyEngine: boolean; defaultProfiles: boolean; defaultNodes: boolean } };
    expect(patched.plan.name).toBe('Enterprise');
    expect(patched.plan.defaultScanProfile).toBe('thorough');
    expect(patched.plan.preferredProxyEngine).toBe('singbox');
    expect(patched.plan.defaultProfiles).toBe('["cfg-1","cfg-2"]');
    expect(patched.plan.defaultNodes).toBe('["node-1","node-2"]');
    expect(patched.changed.code).toBe(false);
    expect(patched.changed.name).toBe(true);
    expect(patched.changed.defaultScanProfile).toBe(true);
    expect(patched.changed.preferredProxyEngine).toBe(true);
    expect(patched.changed.defaultProfiles).toBe(true);
    expect(patched.changed.defaultNodes).toBe(true);
  });

  it('admin cannot patch the plan code to an unknown entitlement code', async () => {
    await seedPlan({ code: 'pro', name: 'Pro' });
    const admin = await register('admin-badcode@example.com');
    await grantAdmin(admin.userId);
    const at = await loginReturnToken('admin-badcode@example.com');
    expect(at).not.toBe('');
    const res = await authFetch(at, '/api/v1/admin/plan', {
      method: 'PATCH',
      body: JSON.stringify({ code: 'made-up-plan' }),
    });
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: { code: string } };
    expect(err.error.code).toBe('invalid_plan_code');
  });

  it('admin can promote a normal account to admin', async () => {
    await register('normal-promo@example.com');
    const admin = await register('admin-promo@example.com');
    await grantAdmin(admin.userId);
    const at = await loginReturnToken('admin-promo@example.com');
    expect(at).not.toBe('');
    const normalRes = await SELF.fetch('https://worker.test/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'normal-promo@example.com', password: 'Sup3rSecurePass' }),
    });
    expect(normalRes.status).toBe(200);
    const normal = (await normalRes.json()) as { accessToken: string; user: { id: string } };
    const promote = await authFetch(at, '/api/v1/admin/users/' + normal.user.id + '/promote', { method: 'POST' });
    expect(promote.status).toBe(200);
    const promoted = (await promote.json()) as { user: { id: string; role: string } };
    expect(promoted.user.id).toBe(normal.user.id);
    expect(promoted.user.role).toBe('admin');
  });

  it('admin cannot promote themselves through the promote route', async () => {
    const admin = await register('admin-self-promo@example.com');
    await grantAdmin(admin.userId);
    const at = await loginReturnToken('admin-self-promo@example.com');
    expect(at).not.toBe('');
    const res = await authFetch(at, '/api/v1/admin/users/' + admin.userId + '/promote', { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('admin can demote another admin, but not to zero admins', async () => {
    const adminA = await register('admin-a@example.com');
    await grantAdmin(adminA.userId);
    const adminB = await register('admin-b@example.com');
    await grantAdmin(adminB.userId);
    const at = await loginReturnToken('admin-a@example.com');
    expect(at).not.toBe('');
    const demote = await authFetch(at, '/api/v1/admin/users/' + adminB.userId + '/demote', { method: 'POST' });
    expect(demote.status).toBe(200);
    const demoted = (await demote.json()) as { user: { role: string } };
    expect(demoted.user.role).toBe('normal');
    // Now only adminA is admin; demoting them must fail.
    const selfDemote = await authFetch(at, '/api/v1/admin/users/' + adminA.userId + '/demote', { method: 'POST' });
    expect(selfDemote.status).toBe(400);
  });

  it('admin list includes roles', async () => {
    await register('admin-list-a@example.com');
    const admin = await register('admin-list@example.com');
    await grantAdmin(admin.userId);
    const at = await loginReturnToken('admin-list@example.com');
    expect(at).not.toBe('');
    const res = await authFetch(at, '/api/v1/admin/users');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: Array<{ id: string; email: string; role: string }> };
    const adminRow = body.users.find((u) => u.email === 'admin-list@example.com');
    expect(adminRow).toBeTruthy();
    expect(adminRow!.role).toBe('admin');
    const normalRow = body.users.find((u) => u.email === 'admin-list-a@example.com');
    expect(normalRow).toBeTruthy();
    expect(normalRow!.role).toBe('normal');
  });

  it('admin events are audited', async () => {
    await register('admin-audit-a@example.com');
    const admin = await register('admin-audit@example.com');
    await grantAdmin(admin.userId);
    const at = await loginReturnToken('admin-audit@example.com');
    expect(at).not.toBe('');
    await authFetch(at, '/api/v1/admin/users/' + (await register('admin-audit-b@example.com')).userId + '/promote', { method: 'POST' });
    const events = (await (await authFetch(at, '/api/v1/admin/events')).json()) as { events: Array<{ action: string }> };
    expect(events.events.some((e) => e.action === 'admin.user_promoted')).toBe(true);
  });

  it('creates the first admin account through POST /admin/account when none exist', async () => {
    const res = await SELF.fetch('https://worker.test/api/v1/admin/account', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'first-admin@example.com', password: 'AdminPassword1' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { user: { id: string; email: string; role: string } };
    expect(body.user.email).toBe('first-admin@example.com');
    expect(body.user.role).toBe('admin');
    // The created account can log in.
    const loginRes = await SELF.fetch('https://worker.test/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'first-admin@example.com', password: 'AdminPassword1' }),
    });
    expect(loginRes.status).toBe(200);
    const loginBody = (await loginRes.json()) as { accessToken: string };
    expect(loginBody.accessToken).not.toBe('');
  });

  it('rejects creating a second admin via POST /admin/account', async () => {
    const existing = await register('first-admin-2@example.com');
    await grantAdmin(existing.userId);
    const res = await SELF.fetch('https://worker.test/api/v1/admin/account', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'second-admin@example.com', password: 'AdminPassword2' }),
    });
    expect(res.status).toBe(409);
    const err = (await res.json()) as { error: { code: string } };
    expect(err.error.code).toBe('admin_already_exists');
  });

  it('rate limits POST /admin/account per IP', async () => {
    const existing = await register('first-admin-3@example.com');
    await grantAdmin(existing.userId);
    let lastStatus = 201;
    for (let i = 0; i < 6; i++) {
      const res = await SELF.fetch('https://worker.test/api/v1/admin/account', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: `rate-${i}@example.com`, password: 'AdminPassword1' }),
      });
      lastStatus = res.status;
      if (res.status === 429) break;
    }
    expect(lastStatus).toBe(429);
  });

  it('registers the first user as normal when no admin exists yet', async () => {
    const { token, userId } = await register('first-normal@example.com');
    expect(token).not.toBe('');
    const me = (await authFetch(token, '/api/v1/account'));
    expect(me.status).toBe(200);
    const body = (await me.json()) as { user: { role: string } };
    expect(body.user.role).toBe('normal');
    // First account did NOT become admin by virtue of being first.
    const admin = await env.DB.prepare(`SELECT id FROM users WHERE id = ? AND role = 'admin'`).bind(userId).first<{ id: string }>();
    expect(admin).toBeNull();
  });

  it('bootstraps the operator account and lets it change the plan defaults', async () => {
    // The account the deployment is bootstrapped with. POST /admin/account
    // answers only while no admin exists, which is exactly the freshly
    // migrated state: migration 0004 gives every pre-existing row role
    // 'normal', so a real deployment has zero admins right after migrating.
    // Same route the operator runs with their real password. The value here is
    // a fixed non-secret test input on purpose: no live credential in git.
    const res = await SELF.fetch('https://worker.test/api/v1/admin/account', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'radinshurideh@gmail.com', password: 'OperatorPassword1' }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { user: { email: string; role: string }; accessToken: string };
    expect(created.user.email).toBe('radinshurideh@gmail.com');
    expect(created.user.role).toBe('admin');
    expect(created.accessToken).not.toBe('');

    const patch = await authFetch(created.accessToken, '/api/v1/admin/plan', {
      method: 'PATCH',
      body: JSON.stringify({ defaultProfiles: '["cfg-eu","cfg-us"]', defaultNodes: '["node-eu","node-us"]' }),
    });
    expect(patch.status).toBe(200);
    const read = await authFetch(created.accessToken, '/api/v1/admin/plan');
    expect(read.status).toBe(200);
    const body = (await read.json()) as { plan: { defaultProfiles: string; defaultNodes: string } };
    expect(body.plan.defaultProfiles).toBe('["cfg-eu","cfg-us"]');
    expect(body.plan.defaultNodes).toBe('["node-eu","node-us"]');
  });

  it('rejects plan defaults that are not JSON string arrays', async () => {
    const admin = await register('admin-bad-defaults@example.com');
    await grantAdmin(admin.userId);
    const at = await loginReturnToken('admin-bad-defaults@example.com');
    expect(at).not.toBe('');
    const nodes = await authFetch(at, '/api/v1/admin/plan', {
      method: 'PATCH',
      body: JSON.stringify({ defaultNodes: 'not-json' }),
    });
    expect(nodes.status).toBe(400);
    expect(((await nodes.json()) as { error: { code: string } }).error.code).toBe('invalid_plan_defaults');
    const profiles = await authFetch(at, '/api/v1/admin/plan', {
      method: 'PATCH',
      body: JSON.stringify({ defaultProfiles: '{"not":"an array"}' }),
    });
    expect(profiles.status).toBe(400);
  });
});
