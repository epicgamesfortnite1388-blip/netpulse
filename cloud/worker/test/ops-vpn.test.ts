import { env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { handleOpsVpnRotate } from '../src/ops-vpn';

/**
 * Operator credential rotation — the \"this config leaked\" action.
 *
 * Runs through the real fetch handler against real (miniflare) D1, and then
 * checks the consequence that matters: the OLD secret is gone from both the
 * credential table and the set the VPN host pulls. A rotation that left the
 * old identity authenticable would look successful here and change nothing
 * for the leaked config.
 */

const TOKEN = 'test-ops-token-0123456789abcdef';
const PLAN_PROFILES = ['xray-vless-reality', 'xray-vmess-ws', 'hysteria2'];

async function register(): Promise<{ token: string; userId: string; email: string }> {
  const email = `rot-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
  const res = await SELF.fetch('https://worker.test/api/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Sup3rSecurePass' }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { accessToken: string; user: { id: string } };
  return { token: body.accessToken, userId: body.user.id, email };
}

async function seedEntitlement(userId: string, subscriptionId = 9501): Promise<void> {
  const t = Date.now();
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
     VALUES (?, ?, 'NP-TEST', 'pro', 'active', ?, '2099-01-01 00:00:00', 1, 100, 0, 3, NULL, NULL, ?)`,
  )
    .bind(subscriptionId, userId, String(t), t)
    .run();
}

async function provision(token: string): Promise<{ status: number; body: { provisioned: Array<{ protocol: string; config: string }> } }> {
  const res = await SELF.fetch('https://worker.test/api/v1/provision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: '{}',
  });
  return { status: res.status, body: (await res.json()) as { provisioned: Array<{ protocol: string; config: string }> } };
}

async function rotatedAccount(): Promise<{ userId: string; email: string; token: string; secrets: Record<string, string> }> {
  const account = await register();
  await seedEntitlement(account.userId);
  expect((await provision(account.token)).status).toBe(200);

  const rows = await env.DB
    .prepare(`SELECT protocol, secret FROM vpn_credentials WHERE user_id = ?`)
    .bind(account.userId)
    .all<{ protocol: string; secret: string }>();
  const secrets: Record<string, string> = {};
  for (const row of rows.results ?? []) secrets[row.protocol] = row.secret;
  return { ...account, secrets };
}

function rotate(payload: unknown, token = TOKEN): Promise<Response> {
  return SELF.fetch('https://worker.test/api/v1/ops/vpn/rotate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

beforeAll(async () => {
  await env.DB.prepare(`DELETE FROM users`).run();
  await env.DB.prepare(`DELETE FROM np_entitlements`).run();
  await env.DB.prepare(`DELETE FROM rate_limits`).run();
});

// One shared client IP in the harness: without this the rotation budget would
// leak between tests and start answering 429 for the wrong reason.
beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM rate_limits`).run();
});

describe('ops credential rotation: gate', () => {
  it('refuses an unauthenticated or wrong-token request', async () => {
    const missing = await SELF.fetch('https://worker.test/api/v1/ops/vpn/rotate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(missing.status).toBe(401);

    const wrong = await rotate({ email: 'someone@example.com' }, 'not-the-token');
    expect(wrong.status).toBe(401);
  });

  it('fails closed when OPS_TOKEN is not configured', async () => {
    // Direct call: the harness always has a token, but an unconfigured
    // deployment must answer 503 rather than fall open.
    const res = await handleOpsVpnRotate(
      new Request('https://worker.test/api/v1/ops/vpn/rotate', { method: 'POST', body: '{"email":"a@b.co"}' }),
      { ...env, OPS_TOKEN: '' },
    );
    expect(res?.status).toBe(503);
  });

  it('is POST-only', async () => {
    const res = await SELF.fetch('https://worker.test/api/v1/ops/vpn/rotate', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });

  it('rejects ambiguous, empty and unsupported payloads', async () => {
    expect((await rotate({})).status).toBe(400);
    // Both identifiers: which one wins would decide whose config dies.
    expect((await rotate({ email: 'a@b.co', userId: 'usr_x' })).status).toBe(400);
    expect((await rotate({ email: 'not-an-email' })).status).toBe(400);

    const bad = await rotate({ email: 'a@b.co', protocol: 'whitedns-soar' });
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { error: string; allowed: string[] };
    expect(body.error).toBe('unsupported_protocol');
    expect(body.allowed).toContain('xray-vless-reality');
  });

  it('finds the account by its normalized address when the stored one is not', async () => {
    const { userId, email, secrets } = await rotatedAccount();
    // Legacy / operator-inserted shape: mixed case in `email`, canonical in
    // `normalized_email`. An incident lookup must still land on the account.
    await env.DB.prepare(`UPDATE users SET email = ? WHERE id = ?`).bind('Mixed.Case@Example.com', userId).run();

    const res = await rotate({ email: email.toUpperCase() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rotated: Array<{ protocol: string }> };
    expect(body.rotated).toHaveLength(PLAN_PROFILES.length);
    expect(secrets['xray-vless-reality']).toBeTruthy();
  });

  it('404s an unknown account', async () => {
    expect((await rotate({ email: 'nobody-here@example.com' })).status).toBe(404);
    expect((await rotate({ userId: 'usr_does_not_exist' })).status).toBe(404);
  });

  it('refuses a disabled account instead of minting it a fresh identity', async () => {
    const { userId, email } = await rotatedAccount();
    await env.DB.prepare(`UPDATE users SET disabled = 1 WHERE id = ?`).bind(userId).run();

    const res = await rotate({ email });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('account_disabled');
  });

  it('409s an account that has no credentials yet', async () => {
    const { email } = await register();
    const res = await rotate({ email });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('no_credentials');
  });

  it('throttles rotation harder than the status page', async () => {
    const { email } = await rotatedAccount();
    for (let i = 0; i < 10; i++) expect((await rotate({ email })).status).toBe(200);

    const blocked = await rotate({ email });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();

    // The status page has its own bucket and must still work afterwards.
    const snapshot = await SELF.fetch('https://worker.test/api/v1/ops/netpulse', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(snapshot.status).toBe(200);
  });
});

describe('ops credential rotation: effect', () => {
  it('replaces every protocol secret and rebuilds the stored configs', async () => {
    const { userId, email, secrets } = await rotatedAccount();
    const before = await env.DB
      .prepare(`SELECT id, protocol, config, config_version FROM vpn_profiles WHERE user_id = ? AND deleted_at IS NULL`)
      .bind(userId)
      .all<{ id: string; protocol: string; config: string; config_version: number }>();
    const beforeByProtocol = new Map((before.results ?? []).map((r) => [r.protocol, r]));

    const res = await rotate({ email });
    expect(res.status).toBe(200);
    const raw = await res.clone().text();
    const body = (await res.json()) as {
      ok: boolean;
      account: { id: string; email: string };
      rotated: Array<{ protocol: string; previousFingerprint: string; fingerprint: string }>;
      profilesUpdated: number;
      syncWindowSeconds: number;
    };

    expect(body.ok).toBe(true);
    expect(body.account).toEqual({ id: userId, email });
    expect(body.rotated.map((r) => r.protocol).sort()).toEqual([...PLAN_PROFILES].sort());
    expect(body.profilesUpdated).toBe(PLAN_PROFILES.length);
    expect(body.syncWindowSeconds).toBe(60);

    // THE point: the operator response must not contain the new secrets.
    // A config that leaks out of the ops screen would defeat the rotation.
    const after = await env.DB
      .prepare(`SELECT protocol, secret, status FROM vpn_credentials WHERE user_id = ?`)
      .bind(userId)
      .all<{ protocol: string; secret: string; status: string }>();
    const afterSecrets = new Map((after.results ?? []).map((r) => [r.protocol, r.secret]));
    for (const protocol of PLAN_PROFILES) {
      const next = afterSecrets.get(protocol);
      expect(next).toBeTruthy();
      expect(next).not.toBe(secrets[protocol]);
      expect(raw).not.toContain(next);
    }
    // The credential stays usable: this is a rotation, not a revocation.
    for (const r of after.results ?? []) expect(r.status).toBe('active');
    // Fingerprints identify WHAT changed without being the secret.
    for (const r of body.rotated) {
      expect(r.fingerprint).toMatch(/^[0-9a-f]{12}$/);
      expect(r.previousFingerprint).toMatch(/^[0-9a-f]{12}$/);
      expect(r.fingerprint).not.toBe(r.previousFingerprint);
    }

    // Stored profiles now carry the new identity, and a version bump is what
    // makes the customer's app pull them instead of keeping the leaked one.
    const rebuilt = await env.DB
      .prepare(`SELECT protocol, config, config_version FROM vpn_profiles WHERE user_id = ? AND deleted_at IS NULL`)
      .bind(userId)
      .all<{ protocol: string; config: string; config_version: number }>();
    for (const profile of rebuilt.results ?? []) {
      const old = beforeByProtocol.get(profile.protocol);
      expect(profile.config_version).toBe((old?.config_version ?? 0) + 1);
      const config = JSON.parse(profile.config) as { id?: string; password?: string };
      const credentialField = profile.protocol === 'xray-vless-reality' ? config.id : profile.protocol === 'hysteria2' ? config.password : config.id;
      expect(credentialField).toBeTruthy();
      // Hysteria carries `user:password`; the rest carry the secret verbatim.
      const expected = profile.protocol === 'hysteria2'
        ? `${credentialField!.split(':')[0]}:${afterSecrets.get(profile.protocol)}`
        : afterSecrets.get(profile.protocol);
      expect(credentialField).toBe(expected);
      expect(profile.config).not.toContain(secrets[profile.protocol]);
    }

    // Audit row names the account whose identity changed.
    const auditRow = await env.DB
      .prepare(`SELECT user_id, kind, detail FROM audit_events WHERE kind = 'vpn.credentials.rotated' AND user_id = ?`)
      .bind(userId)
      .first<{ user_id: string; kind: string; detail: string }>();
    expect(auditRow?.user_id).toBe(userId);
    expect(auditRow?.detail).toContain('by:ops-token');
  });

  it('stops the VPN host from authenticating the old secret', async () => {
    const { token, userId, secrets } = await rotatedAccount();

    const sync = async (): Promise<{ version: string; users: Array<{ id: string; protocol: string; secret: string }> }> => {
      const res = await SELF.fetch('https://worker.test/api/v1/internal/vpn-users', {
        headers: { Authorization: `Bearer ${env.VPS_SYNC_SECRET}` },
      });
      expect(res.status).toBe(200);
      return (await res.json()) as { version: string; users: Array<{ id: string; protocol: string; secret: string }> };
    };

    const beforeSync = await sync();
    expect((await rotate({ userId })).status).toBe(200);
    const afterSync = await sync();

    // A changed version is how the host knows to rewrite its configs at all.
    expect(afterSync.version).not.toBe(beforeSync.version);
    const mine = afterSync.users.filter((u) => u.id === userId);
    expect(mine).toHaveLength(PLAN_PROFILES.length);
    for (const u of mine) expect(u.secret).not.toBe(secrets[u.protocol]);
    // Nothing anywhere in the pull still carries the leaked values.
    const raw = JSON.stringify(afterSync);
    for (const protocol of PLAN_PROFILES) expect(raw).not.toContain(secrets[protocol]);

    // The account still has a working identity, so this did not kill access.
    expect((await provision(token)).status).toBe(200);
  });

  it('rotates a revoked credential without resurrecting it', async () => {
    const { userId, secrets } = await rotatedAccount();
    await env.DB
      .prepare(`UPDATE vpn_credentials SET status = 'revoked' WHERE user_id = ? AND protocol = 'xray-vmess-ws'`)
      .bind(userId)
      .run();

    const res = await rotate({ userId, protocol: 'xray-vmess-ws' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rotated: Array<{ protocol: string; active: boolean }> };
    // The secret changed (nothing can use the leaked one) and the revocation
    // stands: rotating is not a way to regain access.
    expect(body.rotated).toEqual([{ protocol: 'xray-vmess-ws', active: false, previousFingerprint: expect.any(String), fingerprint: expect.any(String) }]);

    const row = await env.DB
      .prepare(`SELECT secret, status FROM vpn_credentials WHERE user_id = ? AND protocol = 'xray-vmess-ws'`)
      .bind(userId)
      .first<{ secret: string; status: string }>();
    expect(row?.status).toBe('revoked');
    expect(row?.secret).not.toBe(secrets['xray-vmess-ws']);

    const pull = await SELF.fetch('https://worker.test/api/v1/internal/vpn-users', {
      headers: { Authorization: `Bearer ${env.VPS_SYNC_SECRET}` },
    });
    const users = ((await pull.json()) as { users: Array<{ id: string; protocol: string }> }).users;
    expect(users.some((u) => u.id === userId && u.protocol === 'xray-vmess-ws')).toBe(false);
  });

  it('does not rewrite the desktop\'s empty profile envelopes', async () => {
    const { userId, email } = await rotatedAccount();
    // The sync engine mirrors local profiles as `np-local-*` with `config:
    // '{}'`; filling one in would make the Account page show a config under a
    // local profile's name and then flip back on the next sync.
    await env.DB
      .prepare(
        `INSERT INTO vpn_profiles (id, user_id, name, protocol, endpoint, config, config_version, created_at, updated_at)
         VALUES ('np-local-abc', ?, 'Local VLESS', 'xray-vless-reality', NULL, '{}', 1, ?, ?)`,
      )
      .bind(userId, Date.now(), Date.now())
      .run();

    const res = await rotate({ email });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { profilesUpdated: number };
    expect(body.profilesUpdated).toBe(PLAN_PROFILES.length);

    const local = await env.DB
      .prepare(`SELECT config FROM vpn_profiles WHERE id = 'np-local-abc'`)
      .first<{ config: string }>();
    expect(local?.config).toBe('{}');
  });

  it('rotates a single protocol and leaves the others alone', async () => {
    const { userId, email, secrets } = await rotatedAccount();

    const res = await rotate({ email, protocol: 'xray-vmess-ws' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rotated: Array<{ protocol: string }>; profilesUpdated: number };
    expect(body.rotated.map((r) => r.protocol)).toEqual(['xray-vmess-ws']);
    expect(body.profilesUpdated).toBe(1);

    const rows = await env.DB
      .prepare(`SELECT protocol, secret FROM vpn_credentials WHERE user_id = ?`)
      .bind(userId)
      .all<{ protocol: string; secret: string }>();
    for (const row of rows.results ?? []) {
      if (row.protocol === 'xray-vmess-ws') expect(row.secret).not.toBe(secrets['xray-vmess-ws']);
      else expect(row.secret).toBe(secrets[row.protocol]);
    }
  });

  it('404s a protocol the account was never issued', async () => {
    const { email } = await rotatedAccount();
    const res = await rotate({ email, protocol: 'xray-trojan-tls' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('credential_not_found');
  });
});
