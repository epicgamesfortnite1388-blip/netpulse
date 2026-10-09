import { env, SELF } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { renderOpsSnapshot, type NetpulseOpsSnapshot } from '../src/ops-page';

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

// Every test starts with an empty limiter table: SELF.fetch presents one
// shared IP, so without this the 30-attempt wall would leak between tests.
beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM rate_limits`).run();
});

describe('ops snapshot rate limit (audit F2 regression)', () => {
  const clearLimits = () => env.DB.prepare(`DELETE FROM rate_limits`).run();

  it('throttles guessing after 30 attempts from one IP with 429', async () => {
    await clearLimits();
    let last = 0;
    for (let i = 0; i < 30; i++) {
      last = (await authed('/api/v1/ops/netpulse', `guess-${i}`)).status;
      expect(last).toBe(401);
    }
    // 31st attempt: the limiter, not the token check, answers.
    const limited = await authed('/api/v1/ops/netpulse', 'guess-31');
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: string }).error).toBe('rate_limited');
    // And even the CORRECT token is refused while limited — the wall is
    // per-IP, exactly what makes an online brute force non-viable.
    const correctWhileLimited = await authed('/api/v1/ops/netpulse', TOKEN);
    expect(correctWhileLimited.status).toBe(429);
  });

  it('the limiter does not count requests while OPS_TOKEN is unconfigured (fail-closed first)', async () => {
    await clearLimits();
    const { handleNetpulseOpsApi } = await import('../src/ops-page');
    const res = await handleNetpulseOpsApi(
      new Request('https://worker.test/api/v1/ops/netpulse', { headers: { Authorization: `Bearer ${TOKEN}` } }),
      { DB: env.DB } as never,
    );
    expect(res?.status).toBe(503);
    const rows = await env.DB.prepare(`SELECT COUNT(*) AS n FROM rate_limits`).first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it('a fresh window lets the correct token through again', async () => {
    await clearLimits();
    const res = await authed('/api/v1/ops/netpulse', TOKEN);
    expect(res.status).toBe(200);
  });
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

/**
 * The panel's two blind spots. `links` was a count and `inbox` was a status
 * breakdown, while np_links and np_events already held the rows that answer
 * "which links are active" and "what has the bot actually been sending". These
 * assert the rows reach the operator, including the case the count hid: an
 * ACTIVE link whose last entitlement pull failed (netpulse-integration.ts
 * writes the failure code into np_links.last_sync_status).
 */
describe('ops snapshot row-level views', () => {
  it('lists the active links and marks the ones whose sync is failing', async () => {
    const t = Date.now();
    for (const [i, email] of ['roster0@example.com', 'roster1@example.com', 'roster2@example.com'].entries()) {
      await env.DB
        .prepare(`INSERT INTO users (id, email, normalized_email, password_hash, password_algo, password_updated_at, created_at, last_login_at, disabled)
                  VALUES (?, ?, ?, 'x', 'PBKDF2-SHA256', ?, ?, NULL, 0)`)
        .bind(`roster-user-${i}`, email, email, t, t)
        .run();
    }
    // healthy: synced recently · failing: active but the last pull errored ·
    // never: active, has never pulled an entitlement at all (last_synced_at is
    // NOT NULL DEFAULT 0 — "never" is 0, never NULL).
    const links: Array<[string, string, number, string | null]> = [
      ['rosterlink0', 'npa_roster_healthy', t - 60_000, 'success'],
      ['rosterlink1', 'npa_roster_failing', t - 120_000, 'upstream_status_502'],
      ['rosterlink2', 'npa_roster_never', 0, null],
    ];
    for (const [id, accountId, lastSyncedAt, status] of links) {
      await env.DB
        .prepare(
          `INSERT INTO np_links (id, user_id, telegram_user_id, netpulse_account_id, status, initiated_by, linked_at, last_synced_at, last_sync_status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', 'netpulse', ?, ?, ?, ?, ?)`,
        )
        .bind(id, `roster-user-${id.slice(-1)}`, 7700 + Number(id.slice(-1)), accountId, t - 86_400_000, lastSyncedAt, status, t, t)
        .run();
    }

    const res = await authed('/api/v1/ops/netpulse', TOKEN);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { links: { roster: Array<{ accountId: string; lastSyncedAt: number; lastSyncStatus: string | null; failing: boolean; telegramUserId: number | null }> } };
    };
    const byAccount = new Map(data.links.roster.map((r) => [r.accountId, r]));

    // "Which links are active" — by name, not as a count.
    expect(byAccount.has('npa_roster_healthy')).toBe(true);
    expect(byAccount.get('npa_roster_healthy')!.failing).toBe(false);
    expect(byAccount.get('npa_roster_healthy')!.lastSyncedAt).toBe(t - 60_000);

    // The case the count hid: active, but the last pull failed.
    const failing = byAccount.get('npa_roster_failing')!;
    expect(failing.failing).toBe(true);
    expect(failing.lastSyncStatus).toBe('upstream_status_502');

    // Active but never synced: not a failure, but it must not read as healthy.
    const never = byAccount.get('npa_roster_never')!;
    expect(never.failing).toBe(false);
    expect(never.lastSyncedAt).toBe(0);

    // Least-recently-synced first, so the operator sees the problem links at
    // the top of the table instead of scrolling for them.
    const rosterAccounts = data.links.roster.map((r) => r.accountId);
    expect(rosterAccounts.indexOf('npa_roster_never')).toBeLessThan(rosterAccounts.indexOf('npa_roster_healthy'));
  });

  it('breaks the signed inbox down by event type, not only by processing status', async () => {
    const t = Date.now();
    const events: Array<[string, string, number]> = [
      ['roster-evt-1', 'subscription.renewed', t - 1000],
      ['roster-evt-2', 'subscription.renewed', t - 2000],
      ['roster-evt-3', 'subscription.renewed', t - 3000],
      ['roster-evt-4', 'subscription.activated', t - 4000],
      ['roster-evt-5', 'link.confirmed', t - 5000],
    ];
    for (const [id, type, at] of events) {
      await env.DB
        .prepare(
          `INSERT INTO np_events (event_id, event_type, version, telegram_user_id, netpulse_account_id, payload, received_at, processed_status)
           VALUES (?, ?, 1, 7700, 'npa_roster_healthy', '{}', ?, 'applied')`,
        )
        .bind(id, type, at)
        .run();
    }

    const res = await authed('/api/v1/ops/netpulse', TOKEN);
    const { data } = (await res.json()) as {
      data: { inbox: { byType: Array<{ eventType: string; count: number; lastReceivedAt: number }> } };
    };

    // Busiest first: three reneweds beat one activation.
    expect(data.inbox.byType[0]).toEqual({
      eventType: 'subscription.renewed',
      count: 3,
      lastReceivedAt: t - 1000,
    });
    const activated = data.inbox.byType.find((e) => e.eventType === 'subscription.activated');
    expect(activated?.count).toBe(1);
    // Every type that arrived is represented — the mix is the point.
    expect(data.inbox.byType.map((e) => e.eventType)).toContain('link.confirmed');
  });

  it('serves the shell without a second copy of the view', async () => {
    // The shell may still load + token, but it must NOT contain the renderer:
    // a copy living inside a <script> is a copy no test can execute, and that
    // is how an unescaped value reaches this page unnoticed.
    const { opsPageHtml } = await import('../src/ops-page');
    const html = opsPageHtml();
    expect(html).toContain('api/v1/ops/netpulse');
    expect(html).toContain('res.body.html');
    expect(html).not.toContain('function render');
    expect(html).not.toContain("class=\"mono\""); // view markup belongs to the worker, not the page
  });
});

/**
 * The view, executed.
 *
 * These call renderOpsSnapshot() directly and assert on the markup it returns.
 * Before extraction the renderer lived inside the page's inline <script>, so
 * nothing could run it: the empty states and every esc() call were unverified.
 * Each case here is a branch or an escaping decision that must actually run.
 */
describe('ops panel view (renderOpsSnapshot)', () => {
  const NOW = 1_800_000_000_000;

  /** A complete, valid snapshot with no rows — the production-empty shape. */
  const empty = (): NetpulseOpsSnapshot => ({
    generatedAt: NOW,
    links: { active: 0, pending: 0, unlinked: 0, lastSyncedAt: null, roster: [] },
    inbox: { counts: {}, total: 0, byType: [], recent: [] },
    outbound: {
      windowHours: 24,
      total: 0,
      ok: 0,
      failed: 0,
      okRatePct: null,
      byAction: [],
      recentErrors: [],
    },
  });

  const withLink = (over: Partial<NetpulseOpsSnapshot['links']['roster'][number]>, links: Partial<NetpulseOpsSnapshot['links']> = {}) => {
    const s = empty();
    s.links = { ...s.links, active: 1, ...links, roster: [{ accountId: 'npa_x', telegramUserId: 42, linkedAt: NOW - 3_600_000, lastSyncedAt: NOW - 60_000, lastSyncStatus: 'success', failing: false, ...over }] };
    return s;
  };

  it('renders a populated roster and marks the failing link', () => {
    const s = withLink({ accountId: 'npa_broken', lastSyncedAt: NOW - 7_200_000, lastSyncStatus: 'upstream_status_502', failing: true });
    const html = renderOpsSnapshot(s, NOW);

    expect(html).toContain('Active links');
    expect(html).toContain('npa_broken');
    // The failure reason reaches the operator, and the row is flagged red.
    expect(html).toContain('upstream_status_502');
    expect(html).toContain('<span class="r">upstream_status_502</span>');
    // The summary counts it rather than showing a clean green number.
    expect(html).toContain('1 failing sync');
    expect(html).not.toContain('<div class="v g">1</div>');
  });

  it('shows "never synced" distinctly from a healthy link', () => {
    const html = renderOpsSnapshot(withLink({ lastSyncedAt: 0, lastSyncStatus: null, failing: false }), NOW);
    expect(html).toContain('never synced');
    expect(html).toContain('<span class="y">never synced</span>');
    // A never-synced link has no timestamp, so the column reads as a dash.
    expect(html).toContain('<td>-</td>');
    expect(html).not.toContain('failing sync');
  });

  it('renders the "No active links." empty state', () => {
    const html = renderOpsSnapshot(empty(), NOW);
    expect(html).toContain('Active links');
    expect(html).toContain('No active links.');
    // Still shows the table head, so the section reads as a panel, not a gap.
    expect(html).toContain('<th>Account</th>');
    expect(html).toContain('<th>Sync status</th>');
  });

  it('renders the "No events received yet." empty state', () => {
    const html = renderOpsSnapshot(empty(), NOW);
    expect(html).toContain('Inbox traffic by type');
    expect(html).toContain('No events received yet.');
    expect(html).toContain('<th>Event type</th>');
    // The pre-existing empty copy for the recent-events table must survive too.
    expect(html).toContain('No events yet - events arrive when linked customers change entitlement.');
  });

  it('escapes markup in account ids, event types and failure codes', () => {
    const XSS = '"><script>alert(1)</script>';
    const IMG = '<img src=x onerror=alert(2)>';
    const s = empty();
    s.links = {
      active: 1,
      pending: 0,
      unlinked: 0,
      lastSyncedAt: NOW - 1_000,
      roster: [{ accountId: XSS, telegramUserId: 7, linkedAt: NOW, lastSyncedAt: 0, lastSyncStatus: IMG, failing: true }],
    };
    s.inbox = {
      counts: { [IMG]: 1 },
      total: 1,
      byType: [{ eventType: IMG, count: 1, lastReceivedAt: NOW }],
      recent: [{ eventId: 'e1', eventType: XSS, processedStatus: '<b>applied</b>', receivedAt: NOW, detail: null }],
    };

    const html = renderOpsSnapshot(s, NOW);

    // Nothing may reach the DOM as markup. Note the assertion is about LIVE
    // tags, not about the substrings themselves: an escaped
    // `&lt;img src=x onerror=...&gt;` still contains the text `onerror=`, and
    // that is inert. What must not exist is an unescaped `<` opening a tag.
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>applied</b>');
    // …but the text is still shown, escaped, so the operator can read it.
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;');
    // The quote must not escape the class attribute it sits next to.
    expect(html).not.toContain('class="mono"><script');
  });

  it('escapes the outbound action and error strings too', () => {
    const s = empty();
    s.outbound = {
      windowHours: 24,
      total: 1,
      ok: 0,
      failed: 1,
      okRatePct: 0,
      byAction: [{ action: '<b>link.claim</b>', total: 1, failed: 1, lastStatus: 502 }],
      recentErrors: [{ action: '<i>link.claim</i>', error: '<svg onload=alert(3)>', createdAt: NOW }],
    };
    const html = renderOpsSnapshot(s, NOW);
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<i>');
    expect(html).not.toContain('<svg');
    expect(html).toContain('&lt;svg onload=alert(3)&gt;');
  });

  it('is deterministic: same snapshot + same clock, same string', () => {
    const s = withLink({ accountId: 'npa_det' });
    s.inbox.byType = [{ eventType: 'subscription.renewed', count: 3, lastReceivedAt: NOW - 30_000 }];
    expect(renderOpsSnapshot(s, NOW)).toBe(renderOpsSnapshot(s, NOW));
  });

  it('renders the snapshot the endpoint actually returns', async () => {
    // Guards the seam: the response's `html` must come from the same snapshot
    // the JSON carries, or the panel and the data would disagree.
    const res = await authed('/api/v1/ops/netpulse', TOKEN);
    const body = (await res.json()) as { ok: boolean; data: NetpulseOpsSnapshot; html: string };
    expect(body.ok).toBe(true);
    expect(body.html).toBe(renderOpsSnapshot(body.data));
  });
});
