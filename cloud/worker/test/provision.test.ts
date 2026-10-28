import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const PLAN_PROFILES = ['xray-vless-reality', 'xray-vmess-ws', 'hysteria2'];

async function register(): Promise<{ token: string; userId: string }> {
  const res = await SELF.fetch('https://worker.test/api/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `prov-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`, password: 'Sup3rSecurePass' }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { accessToken: string; user: { id: string } };
  return { token: body.accessToken, userId: body.user.id };
}

async function seedEntitlement(
  userId: string,
  opts: { expiresAt?: string | null; status?: string; subscriptionId?: number } = {},
): Promise<void> {
  const t = Date.now();
  const expiresAt = opts.expiresAt === undefined ? String(t + 86_400_000) : opts.expiresAt;
  await env.DB.prepare(
    `INSERT INTO plans (id, code, name, default_profiles, default_nodes, default_scan_profile, preferred_proxy_engine, updated_at)
     VALUES ('plan_pro', 'pro', 'Pro', ?, '[]', 'balanced', 'auto', ?)
     ON CONFLICT (id) DO UPDATE SET default_profiles = excluded.default_profiles, updated_at = excluded.updated_at`,
  )
    .bind(JSON.stringify(PLAN_PROFILES), t)
    .run();
  await env.DB.prepare(
    `INSERT INTO np_entitlements (subscription_id, user_id, netpulse_account_id, plan_code, status, started_at, expires_at,
       auto_renew, total_gb, used_gb, ip_limit, config_updated_at, event_id, updated_at)
     VALUES (?, ?, 'NP-TEST', 'pro', ?, ?, ?, 1, 100, 0, 3, NULL, NULL, ?)`,
  )
    .bind(opts.subscriptionId ?? 9001, userId, opts.status ?? 'active', String(t), expiresAt, t)
    .run();
}

async function profileCount(userId: string): Promise<number> {
  const row = await env.DB
    .prepare(`SELECT COUNT(*) AS n FROM vpn_profiles WHERE user_id = ? AND deleted_at IS NULL`)
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Response code the worker uses for a refused provision (`{error: {code}}`). */
async function errorCode(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: { code?: string } | string };
  return typeof body.error === 'string' ? body.error : (body.error?.code ?? '');
}

async function provision(token: string): Promise<Response> {
  return SELF.fetch('https://worker.test/api/v1/provision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: '{}',
  });
}

describe('plan provisioning', () => {
  it('refreshes existing profiles on a second call instead of failing the unique index', async () => {
    const { token, userId } = await register();
    await seedEntitlement(userId);

    const first = await provision(token);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      ok: boolean;
      provisioned: Array<{ id: string; protocol: string; config: string }>;
      errors: unknown[];
    };
    expect(firstBody.ok).toBe(true);
    expect(firstBody.errors).toHaveLength(0);
    expect(firstBody.provisioned.map((p) => p.protocol).sort()).toEqual([...PLAN_PROFILES].sort());

    // A retry (duplicate click, restored network) must not 500 or duplicate.
    const second = await provision(token);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      ok: boolean;
      provisioned: Array<{ id: string; protocol: string; config: string }>;
      errors: unknown[];
    };
    expect(secondBody.ok).toBe(true);
    expect(secondBody.errors).toHaveLength(0);
    expect(secondBody.provisioned.map((p) => p.id).sort()).toEqual(firstBody.provisioned.map((p) => p.id).sort());

    const rows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM vpn_profiles WHERE user_id = ? AND deleted_at IS NULL`)
      .bind(userId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(PLAN_PROFILES.length);
  });

  it('issues a distinct per-user identity instead of the shared server secret', async () => {
    const { token, userId } = await register();
    await seedEntitlement(userId);

    const res = await provision(token);
    const body = (await res.json()) as { provisioned: Array<{ protocol: string; config: string }> };
    const reality = body.provisioned.find((p) => p.protocol === 'xray-vless-reality');
    expect(reality).toBeTruthy();
    const realityId = JSON.parse(reality!.config).id as string;
    expect(realityId).not.toBe(env.VPN_REALITY_UUID);
    expect(realityId).toMatch(/^[0-9a-f-]{36}$/);

    // The identity is the one persisted for THIS user, and the server will
    // receive exactly that value through the sync endpoint.
    const stored = await env.DB
      .prepare(`SELECT secret FROM vpn_credentials WHERE user_id = ? AND protocol = 'xray-vless-reality'`)
      .bind(userId)
      .first<{ secret: string }>();
    expect(stored?.secret).toBe(realityId);

    // Re-provisioning returns the SAME identity (a re-download must not lock
    // the user out of the client already installed).
    const again = (await (await provision(token)).json()) as { provisioned: Array<{ protocol: string; config: string }> };
    const againId = JSON.parse(again.provisioned.find((p) => p.protocol === 'xray-vless-reality')!.config).id;
    expect(againId).toBe(realityId);

    const hysteria = body.provisioned.find((p) => p.protocol === 'hysteria2');
    expect(hysteria).toBeTruthy();
    const hysteriaConfig = JSON.parse(hysteria!.config);
    expect(hysteriaConfig.password).not.toBe(env.VPN_HYSTERIA_PASSWORD);
    // Hysteria userpass: `<username>:<password>` is the client's auth string.
    expect(hysteriaConfig.password).toMatch(/^u_[0-9a-f]{12}:[0-9a-f]{32}$/);
    expect(hysteriaConfig.tls.serverName).toBe('206-1-96-89.sslip.io');
    expect(hysteriaConfig.tls.insecure).toBeUndefined();
  });

  it('issues nothing for a protocol whose server only knows a shared password', async () => {
    const { token, userId } = await register();
    await seedEntitlement(userId);
    await env.DB
      .prepare(`UPDATE plans SET default_profiles = ? WHERE code = 'pro'`)
      .bind(JSON.stringify([...PLAN_PROFILES, 'xray-shadowsocks-2022']))
      .run();

    const raw = await (await provision(token)).text();
    const body = JSON.parse(raw) as {
      provisioned: Array<{ protocol: string }>;
      skipped: Array<{ protocol: string; reason: string }>;
    };

    // Shadowsocks 2022 has no per-user identity on this server, so a config for
    // it could never be revoked: it is skipped rather than handed the shared
    // server password that every expired account would keep using.
    expect(body.skipped).toContainEqual({ protocol: 'xray-shadowsocks-2022', reason: 'no_per_user_identity' });
    expect(body.provisioned.map((p) => p.protocol)).not.toContain('xray-shadowsocks-2022');
    expect(raw).not.toContain(env.VPN_SS2022_PASSWORD);
  });

  /**
   * WhiteDNS has no per-user identity yet: the delegated zone and its public
   * key are one shared tunnel, so an account that lapsed would keep resolving
   * through it forever. Until per-user zones exist it must be withheld rather
   * than issued as if it were an entitlement — a `whitedns-soar` row in a plan
   * is a request, not a licence.
   */
  it('withholds WhiteDNS while its tunnel identity is shared', async () => {
    const { token, userId } = await register();
    await seedEntitlement(userId);
    await env.DB
      .prepare(`UPDATE plans SET default_profiles = ? WHERE code = 'pro'`)
      .bind(JSON.stringify([...PLAN_PROFILES, 'whitedns-soar']))
      .run();

    const raw = await (await provision(token)).text();
    const body = JSON.parse(raw) as {
      provisioned: Array<{ protocol: string }>;
      skipped: Array<{ protocol: string; reason: string }>;
    };

    expect(body.skipped).toContainEqual({ protocol: 'whitedns-soar', reason: 'no_per_user_identity' });
    expect(body.provisioned.map((p) => p.protocol)).not.toContain('whitedns-soar');
    // Neither half of the shared tunnel identity may reach the client.
    expect(raw).not.toContain('soar.abystral.dpdns.org');
    expect(raw).not.toContain('HRLjqBdOuVIByX8E95m+cd2Ah7weaD2azWHu2d24WMU=');
  });

  it('gives two users different identities', async () => {
    const a = await register();
    const b = await register();
    await seedEntitlement(a.userId, { subscriptionId: 9201 });
    await seedEntitlement(b.userId, { subscriptionId: 9202 });

    const idOf = async (token: string): Promise<string> => {
      const body = (await (await provision(token)).json()) as { provisioned: Array<{ protocol: string; config: string }> };
      return JSON.parse(body.provisioned.find((p) => p.protocol === 'xray-vless-reality')!.config).id;
    };

    expect(await idOf(a.token)).not.toBe(await idOf(b.token));
  });
});

/**
 * The entitlement gate, in the shapes `np_entitlements.expires_at` really
 * holds. The column is TEXT and the bot writes a datetime string; the gate
 * used to do `Number(value)`, which is `NaN` for every such value, so
 * `NaN < now` was false and an expired subscription could still be
 * provisioned. These cases pin every format the bot can write.
 */
describe('provision entitlement gate', () => {
  it('refuses an expired SQL datetime (the bot’s normal format)', async () => {
    const { token, userId } = await register();
    await seedEntitlement(userId, { expiresAt: '2020-01-01 00:00:00' });

    const res = await provision(token);

    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('entitlement_expired');
    expect(await profileCount(userId)).toBe(0);
  });

  it('refuses an expired ISO timestamp', async () => {
    const { token, userId } = await register();
    await seedEntitlement(userId, { expiresAt: new Date(Date.now() - 3_600_000).toISOString() });

    const res = await provision(token);

    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('entitlement_expired');
    expect(await profileCount(userId)).toBe(0);
  });

  it('refuses an expired epoch in seconds', async () => {
    const { token, userId } = await register();
    await seedEntitlement(userId, { expiresAt: String(Math.floor((Date.now() - 3_600_000) / 1000)) });

    const res = await provision(token);

    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('entitlement_expired');
  });

  it('allows a future SQL datetime and provisions the plan', async () => {
    const { token, userId } = await register();
    await seedEntitlement(userId, { expiresAt: '2099-01-01 00:00:00' });

    const res = await provision(token);

    expect(res.status).toBe(200);
    expect(await profileCount(userId)).toBe(PLAN_PROFILES.length);
  });

  it('allows an open-ended entitlement (no end date)', async () => {
    const { token, userId } = await register();
    await seedEntitlement(userId, { expiresAt: null });

    expect((await provision(token)).status).toBe(200);
  });

  it('fails closed on an unreadable end date', async () => {
    const { token, userId } = await register();
    await seedEntitlement(userId, { expiresAt: 'whenever' });

    const res = await provision(token);

    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('entitlement_expiry_unreadable');
    expect(await profileCount(userId)).toBe(0);
  });

  it('refuses a revoked or expired status even with a future end date', async () => {
    const { token, userId } = await register();
    await seedEntitlement(userId, { expiresAt: '2099-01-01 00:00:00', status: 'revoked' });

    const res = await provision(token);

    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('entitlement_not_active');
    expect(await profileCount(userId)).toBe(0);
  });
});

/** The VPN host pulls this set; it is the only source of server-side identities. */
async function syncUsers(authorization = `Bearer ${env.VPS_SYNC_SECRET}`): Promise<Response> {
  return SELF.fetch('https://worker.test/api/v1/internal/vpn-users', { headers: { Authorization: authorization } });
}

describe('VPN host sync', () => {
  it('fails closed without the sync token', async () => {
    const missing = await SELF.fetch('https://worker.test/api/v1/internal/vpn-users');
    expect(missing.status).toBe(401);

    const wrong = await syncUsers('Bearer definitely-not-the-token');
    expect(wrong.status).toBe(401);
    expect(JSON.stringify(await wrong.json())).not.toContain('users');
  });

  it('returns only identities backed by an active, unexpired entitlement', async () => {
    const active = await register();
    const expired = await register();
    const unlicensed = await register();
    await seedEntitlement(active.userId, { expiresAt: '2099-01-01 00:00:00', subscriptionId: 9101 });
    await seedEntitlement(expired.userId, { expiresAt: '2099-01-01 00:00:00', subscriptionId: 9102 });
    expect((await provision(active.token)).status).toBe(200);
    expect((await provision(expired.token)).status).toBe(200);

    // The entitlement lapses AFTER the config was issued — the exact case the
    // old shared-credential model could not revoke.
    await env.DB
      .prepare(`UPDATE np_entitlements SET expires_at = '2020-01-01 00:00:00' WHERE user_id = ?`)
      .bind(expired.userId)
      .run();

    const res = await syncUsers();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: string;
      users: Array<{ id: string; protocol: string; username: string; secret: string; expiresAt: number | null }>;
    };

    const ids = new Set(body.users.map((u) => u.id));
    expect(ids.has(active.userId)).toBe(true);
    expect(ids.has(expired.userId)).toBe(false);
    expect(ids.has(unlicensed.userId)).toBe(false);
    // One identity per per-user protocol in the seeded plan (PLAN_PROFILES).
    expect(body.users).toHaveLength(PLAN_PROFILES.length);
    expect(new Set(body.users.map((u) => u.protocol))).toEqual(new Set(PLAN_PROFILES));
    for (const u of body.users) expect(u.username).toMatch(/^u_[0-9a-f]{12}$/);
    // The host prunes locally at this instant, so the deadline must travel with
    // the identity instead of depending on a reachable Worker.
    const deadline = Date.parse('2099-01-01T00:00:00Z');
    for (const u of body.users) expect(u.expiresAt).toBe(deadline);
    // The pull must never carry account data, only opaque ids + secrets.
    expect(JSON.stringify(body)).not.toContain('@example.com');

    const again = (await (await syncUsers()).json()) as { version: string };
    expect(again.version).toBe(body.version);
  });

  it('drops a credential an operator revoked', async () => {
    const { token, userId } = await register();
    await seedEntitlement(userId, { expiresAt: '2099-01-01 00:00:00' });
    expect((await provision(token)).status).toBe(200);

    await env.DB.prepare(`UPDATE vpn_credentials SET status = 'revoked' WHERE user_id = ?`).bind(userId).run();

    const body = (await (await syncUsers()).json()) as { users: Array<{ id: string }> };
    expect(body.users.some((u) => u.id === userId)).toBe(false);
  });

  it('drops a disabled account even while its entitlement is still active', async () => {
    const { token, userId } = await register();
    await seedEntitlement(userId, { expiresAt: '2099-01-01 00:00:00' });
    expect((await provision(token)).status).toBe(200);

    await env.DB.prepare(`UPDATE users SET disabled = 1 WHERE id = ?`).bind(userId).run();

    const body = (await (await syncUsers()).json()) as { users: Array<{ id: string }> };
    expect(body.users.some((u) => u.id === userId)).toBe(false);
  });

  it('treats an open-ended entitlement as entitled', async () => {
    const { token, userId } = await register();
    await seedEntitlement(userId, { expiresAt: null });
    expect((await provision(token)).status).toBe(200);

    const body = (await (await syncUsers()).json()) as { users: Array<{ id: string }> };
    expect(body.users.some((u) => u.id === userId)).toBe(true);
  });
});
