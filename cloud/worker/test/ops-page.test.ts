import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Operator status page (/ops) + gated snapshot (/api/v1/ops/netpulse).
 * Runs through the real fetch handler against real (miniflare) D1.
 */

const TOKEN = 'test-ops-token-0123456789abcdef';

function authed(path: string, token?: string): Promise<Response> {
  return SELF.fetch(`https://worker.test${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

beforeAll(async () => {
  await env.DB.prepare(`DELETE FROM users`).run();
  await env.DB.prepare(`DELETE FROM np_links`).run();
  await env.DB.prepare(`DELETE FROM np_events`).run();
  await env.DB.prepare(`DELETE FROM np_outbound_log`).run();
  await env.DB.prepare(`DELETE FROM np_entitlements`).run();
  await env.DB.prepare(`DELETE FROM rate_limits`).run();
});

describe('ops page shell', () => {
  it('serves the public HTML shell with a locked-down CSP', async () => {
    const res = await SELF.fetch('https://worker.test/ops');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const csp = res.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    const html = await res.text();
    // Shell carries the UI but no secrets and no data.
    expect(html).toContain('api/v1/ops/netpulse');
    expect(html).not.toContain('test-ops-token');
  });

  it('405s non-GET methods on the JSON endpoint', async () => {
    const res = await SELF.fetch('https://worker.test/api/v1/ops/netpulse', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: '{}',
    });
    expect(res.status).toBe(405);
  });
});

describe('ops snapshot auth (fail-closed + timing-safe)', () => {
  it('rejects a missing token with 401', async () => {
    const res = await authed('/api/v1/ops/netpulse');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('unauthorized');
  });

  it('rejects a wrong token with 401', async () => {
    const res = await authed('/api/v1/ops/netpulse', 'wrong-token-aaaaaaaaaaaaaa');
    expect(res.status).toBe(401);
  });

  it('rejects every request when OPS_TOKEN is unconfigured (503 fail-closed)', async () => {
    const row = await env.DB.prepare(`SELECT 1 AS one`).first();
    expect(row).toBeTruthy(); // DB alive; the check below is env-shape-driven.
    // Direct handler probe with a stripped env: unconfigured token must 503.
    const { handleNetpulseOpsApi } = await import('../src/ops-page');
    const res = await handleNetpulseOpsApi(
      new Request('https://worker.test/api/v1/ops/netpulse', { headers: { Authorization: `Bearer ${TOKEN}` } }),
      { DB: env.DB } as never,
    );
    expect(res?.status).toBe(503);
    expect(((await res!.json()) as { error: string }).error).toBe('ops_token_not_configured');
  });

  it('accepts the correct token (timing-safe compare, no short-circuit)', async () => {
    const res = await authed('/api/v1/ops/netpulse', TOKEN);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });
});

describe('ops snapshot data', () => {
  it('reports an empty-but-honest snapshot when the integration has no traffic', async () => {
    const res = await authed('/api/v1/ops/netpulse', TOKEN);
    const body = (await res.json()) as { data: { links: { active: number }; inbox: { total: number }; outbound: { total: number } } };
    expect(body.data.links.active).toBe(0);
    expect(body.data.inbox.total).toBe(0);
    expect(body.data.outbound.total).toBe(0);
  });

  it('aggregates link counts, recent events, and outbound-call health', async () => {
    const t = Date.now();
    // Real user rows (np_links.user_id is a foreign key).
    await env.DB
      .prepare(`INSERT INTO users (id, email, normalized_email, password_hash, password_algo, password_updated_at, created_at, last_login_at, disabled)
                VALUES (?, ?, ?, 'x', 'PBKDF2-SHA256', ?, ?, NULL, 0)`)
      .bind('ops-user-0', 'ops0@example.com', 'ops0@example.com', t, t)
      .run();
    await env.DB
      .prepare(`INSERT INTO users (id, email, normalized_email, password_hash, password_algo, password_updated_at, created_at, last_login_at, disabled)
                VALUES (?, ?, ?, 'x', 'PBKDF2-SHA256', ?, ?, NULL, 0)`)
      .bind('ops-user-1', 'ops1@example.com', 'ops1@example.com', t, t)
      .run();
    await env.DB
      .prepare(`INSERT INTO users (id, email, normalized_email, password_hash, password_algo, password_updated_at, created_at, last_login_at, disabled)
                VALUES (?, ?, ?, 'x', 'PBKDF2-SHA256', ?, ?, NULL, 0)`)
      .bind('ops-user-2', 'ops2@example.com', 'ops2@example.com', t, t)
      .run();
    // Two active links, one pending.
    for (const [i, status] of ['active', 'active', 'pending'].entries()) {
      await env.DB
        .prepare(
          `INSERT INTO np_links (id, user_id, telegram_user_id, netpulse_account_id, status, initiated_by, linked_at, last_synced_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'netpulse', ?, ?, ?, ?)`,
        )
        .bind(`opslink${i}`, `ops-user-${i}`, 1000 + i, `npa_ops_${i}`, status, status === 'active' ? t : null, t - i * 1000, t, t)
        .run();
    }
    // Events: applied, no_link (warning), applied.
    const events: Array<[string, string, string | null]> = [
      ['ops-evt-1', 'subscription.activated', 'applied'],
      ['ops-evt-2', 'subscription.revoked', 'no_link'],
      ['ops-evt-3', 'link.confirmed', 'applied'],
    ];
    for (const [id, type, status] of events) {
      await env.DB
        .prepare(
          `INSERT INTO np_events (event_id, event_type, version, netpulse_account_id, subscription_ref, payload, received_at, processed_status, detail)
           VALUES (?, ?, 1, 'npa_ops_0', NULL, '{}', ?, ?, ?)`,
        )
        .bind(id, type, t - 1000, status, status === 'no_link' ? 'no active link for account' : null)
        .run();
    }
    // Outbound calls: 3 ok, 1 failed in the window.
    for (const [i, ok] of [1, 1, 1, 0].entries()) {
      await env.DB
        .prepare(
          `INSERT INTO np_outbound_log (id, user_id, action, request_path, status, ok, error, created_at)
           VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(`opsout${i}`, i === 3 ? 'link.claim' : 'link.request', `${'/api/x'}`, i === 3 ? 502 : 200, ok, i === 3 ? 'upstream_status_502' : null, t - i * 60_000)
        .run();
    }

    const res = await authed('/api/v1/ops/netpulse', TOKEN);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        links: { active: number; pending: number; lastSyncedAt: number | null };
        inbox: { total: number; counts: Record<string, number>; recent: Array<{ eventType: string; processedStatus: string }> };
        outbound: { total: number; ok: number; failed: number; okRatePct: number; byAction: Array<{ action: string; failed: number }> };
      };
    };
    const d = body.data;
    expect(d.links.active).toBe(2);
    expect(d.links.pending).toBe(1);
    expect(d.links.lastSyncedAt).toBeTypeOf('number');
    expect(d.inbox.total).toBe(3);
    expect(d.inbox.counts['applied']).toBe(2);
    expect(d.inbox.counts['no_link']).toBe(1);
    expect(d.inbox.recent[0]!.eventType).toBe('link.confirmed'); // newest first
    expect(d.outbound.total).toBe(4);
    expect(d.outbound.ok).toBe(3);
    expect(d.outbound.failed).toBe(1);
    expect(d.outbound.okRatePct).toBe(75);
    expect(d.outbound.byAction[0]!.action).toBe('link.request');
  });
});
