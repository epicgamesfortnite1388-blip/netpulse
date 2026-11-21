import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { ensureVpnCredential } from '../src/vpn-users';

import type { PerUserProtocol } from '../src/vpn-users';

/** Create the FK parent so vpn_credentials can be written in isolation. */
async function seedUser(userId: string): Promise<void> {
  const t = Date.now();
  await env.DB.prepare(
    `INSERT INTO users (id, email, normalized_email, password_hash, password_updated_at, created_at, disabled)
     VALUES (?, ?, ?, 'x', ?, ?, 0)`,
  )
    .bind(userId, `${userId}@example.com`, `${userId}@example.com`, t, t)
    .run();
}

/**
 * DD-012 regression: two concurrent first-time provisions for the same
 * (user, protocol) used to both SELECT "no row", generate DIFFERENT secrets,
 * and clobber each other with `ON CONFLICT ... SET secret = excluded.secret`.
 * The loser returned a secret baked into a config that the reconciler would
 * never publish. The fix makes the get-or-create atomic and returns the
 * PERSISTED value via RETURNING.
 */

describe('ensureVpnCredential concurrency', () => {
  it('concurrent first-time provisions converge on ONE persisted secret', async () => {
    const userId = `race-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await seedUser(userId);
    const protocol: PerUserProtocol = 'hysteria2';

    const [a, b] = await Promise.all([
      ensureVpnCredential(env.DB, userId, protocol),
      ensureVpnCredential(env.DB, userId, protocol),
    ]);

    // Every caller must receive the value the server actually persists.
    expect(a).toBe(b);
    const row = await env.DB.prepare(
      `SELECT secret FROM vpn_credentials WHERE user_id = ? AND protocol = ?`,
    )
      .bind(userId, protocol)
      .first<{ secret: string }>();
    expect(row?.secret).toBe(a);
  });

  it('the persisted secret is never clobbered by a later create attempt', async () => {
    const userId = `race2-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await seedUser(userId);
    const protocol: PerUserProtocol = 'hysteria2';
    const first = await ensureVpnCredential(env.DB, userId, protocol);
    const second = await ensureVpnCredential(env.DB, userId, protocol);
    expect(second).toBe(first);
  });
});
