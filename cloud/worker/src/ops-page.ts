/**
 * NetPulse cloud worker - operator status page for the Telegram integration.
 *
 * Two surfaces, following the same trust split as the /reset page:
 *
 *   GET /ops                    public HTML shell (no data, no secrets; the
 *                               operator enters the token at runtime)
 *   GET /api/v1/ops/netpulse    JSON snapshot, gated by the OPS_TOKEN secret
 *                               (`Authorization: Bearer <token>`), fail-closed
 *                               when unconfigured, rate-limited, timing-safe
 *
 * The snapshot collates the three integration health views from the D1
 * mirror schema (migration 0003):
 *   - np_links        link counts (active / pending / unlinked) + last sync
 *   - np_events       recent inbox deliveries + processed_status breakdown
 *   - np_outbound_log signed outbound call health (ok rate, last errors)
 *
 * Nothing here exposes user emails, tokens, signatures, or Telegram
 * identities beyond the numeric id already stored in the mirror.
 */

import { rateLimit } from './auth';

import type { Env } from './auth';

/** Failure-sampling window for the outbound-call health view. */
const OUTBOUND_WINDOW_MS = 24 * 60 * 60 * 1000;

/** ─── Snapshot assembly ───────────────────────────────────────────────────── */

export interface NetpulseOpsSnapshot {
  generatedAt: number;
  links: {
    active: number;
    pending: number;
    unlinked: number;
    lastSyncedAt: number | null;
  };
  inbox: {
    counts: Record<string, number>;
    total: number;
    recent: Array<{
      eventId: string;
      eventType: string;
      processedStatus: string;
      receivedAt: number;
      detail: string | null;
    }>;
  };
  outbound: {
    windowHours: number;
    total: number;
    ok: number;
    failed: number;
    okRatePct: number | null;
    byAction: Array<{ action: string; total: number; failed: number; lastStatus: number | null }>;
    recentErrors: Array<{ action: string; error: string; createdAt: number }>;
  };
}

export async function buildNetpulseOpsSnapshot(db: D1Database): Promise<NetpulseOpsSnapshot> {
  const since = Date.now() - OUTBOUND_WINDOW_MS;

  const [linkRows, lastSyncRow, eventCounts, recentEvents, outboundAgg, outboundActions, outboundErrors] =
    await Promise.all([
      db
        .prepare(`SELECT status, COUNT(*) AS n FROM np_links GROUP BY status`)
        .all<{ status: string; n: number }>(),
      db
        .prepare(`SELECT MAX(last_synced_at) AS last FROM np_links WHERE status = 'active'`)
        .first<{ last: number | null }>(),
      db
        .prepare(`SELECT processed_status, COUNT(*) AS n FROM np_events GROUP BY processed_status`)
        .all<{ processed_status: string; n: number }>(),
      db
        .prepare(
          `SELECT event_id, event_type, processed_status, received_at, detail
           FROM np_events ORDER BY received_at DESC, event_id DESC LIMIT 10`,
        )
        .all<{ event_id: string; event_type: string; processed_status: string; received_at: number; detail: string | null }>(),
      db
        .prepare(
          `SELECT COUNT(*) AS total,
                  COALESCE(SUM(ok), 0) AS ok
           FROM np_outbound_log WHERE created_at >= ?`,
        )
        .bind(since)
        .first<{ total: number; ok: number }>(),
      db
        .prepare(
          `SELECT action, COUNT(*) AS total, COALESCE(SUM(ok), 0) AS ok, MAX(status) AS lastStatus
           FROM np_outbound_log WHERE created_at >= ?
           GROUP BY action ORDER BY total DESC LIMIT 10`,
        )
        .bind(since)
        .all<{ action: string; total: number; ok: number; lastStatus: number | null }>(),
      db
        .prepare(
          `SELECT action, error, created_at FROM np_outbound_log
           WHERE created_at >= ? AND ok = 0
           ORDER BY created_at DESC LIMIT 5`,
        )
        .bind(since)
        .all<{ action: string; error: string | null; created_at: number }>(),
    ]);

  const links: NetpulseOpsSnapshot['links'] = { active: 0, pending: 0, unlinked: 0, lastSyncedAt: null };
  for (const r of linkRows.results ?? []) {
    if (r.status === 'active') links.active = r.n;
    else if (r.status === 'pending') links.pending = r.n;
    else links.unlinked += r.n;
  }
  links.lastSyncedAt = lastSyncRow?.last ?? null;

  const counts: Record<string, number> = {};
  let total = 0;
  for (const r of eventCounts.results ?? []) {
    counts[r.processed_status] = r.n;
    total += r.n;
  }

  const outboundTotal = outboundAgg?.total ?? 0;
  const outboundOk = outboundAgg?.ok ?? 0;

  return {
    generatedAt: Date.now(),
    links,
    inbox: {
      counts,
      total,
      recent: (recentEvents.results ?? []).slice(0, 10).map((r) => ({
        eventId: r.event_id,
        eventType: r.event_type,
        processedStatus: r.processed_status,
        receivedAt: r.received_at,
        detail: r.detail,
      })),
    },
    outbound: {
      windowHours: OUTBOUND_WINDOW_MS / 3_600_000,
      total: outboundTotal,
      ok: outboundOk,
      failed: outboundTotal - outboundOk,
      okRatePct: outboundTotal > 0 ? Math.round((outboundOk / outboundTotal) * 1000) / 10 : null,
      byAction: (outboundActions.results ?? []).map((r) => ({
        action: r.action,
        total: r.total,
        failed: r.total - r.ok,
        lastStatus: r.lastStatus,
      })),
      recentErrors: (outboundErrors.results ?? []).map((r) => ({
        action: r.action,
        error: (r.error ?? 'unknown').slice(0, 200),
        createdAt: r.created_at,
      })),
    },
  };
}

/** ─── Gated JSON endpoint ─────────────────────────────────────────────────── */

function json(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** Constant-time string comparison (hex/token shape, never short-circuits). */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Brute-force wall for the ops token. The token is long random hex, but an
 * unthrottled online guesser is still a standing vulnerability (audit F2:
 * live probes showed unlimited 401s). Keyed per IP: 30 guesses per 5 minutes
 * is far above any human operator's retry rate and far below a viable
 * brute-force rate. Checked AFTER the fail-closed config gate so an
 * unconfigured worker still answers 503 without touching the limiter.
 */
const OPS_RATE_LIMIT = { max: 30, windowMs: 5 * 60_000 } as const;

function opsClientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip')?.slice(0, 60) ?? 'unknown';
}

/**
 * Handle GET /api/v1/ops/netpulse. Returns null for other paths/methods so
 * the main router falls through; otherwise ALWAYS responds. Fail-closed:
 * an unconfigured OPS_TOKEN rejects every request with 503.
 */
export async function handleNetpulseOpsApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname.replace(/\/+$/, '') !== '/api/v1/ops/netpulse') return null;
  if (request.method !== 'GET') {
    return json(405, { ok: false, error: 'method_not_allowed' }, { Allow: 'GET' });
  }

  const expected = env.OPS_TOKEN?.trim();
  if (!expected || expected.length < 16) {
    return json(503, { ok: false, error: 'ops_token_not_configured' });
  }

  const limiter = await rateLimit(env.DB, `ops:${opsClientIp(request)}`, OPS_RATE_LIMIT.max, OPS_RATE_LIMIT.windowMs);
  if (!limiter.ok) {
    return json(429, { ok: false, error: 'rate_limited' }, { 'Retry-After': String(limiter.retryAfterSec) });
  }
  const presented = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!presented || !timingSafeEqualStr(presented, expected)) {
    return json(401, { ok: false, error: 'unauthorized' });
  }

  try {
    const snapshot = await buildNetpulseOpsSnapshot(env.DB);
    return json(200, { ok: true, data: snapshot }, { 'Cache-Control': 'no-store' });
  } catch {
    // Never leak internals; the status page renders an honest error state.
    return json(500, { ok: false, error: 'snapshot_failed' });
  }
}

/** ─── Public HTML shell (no data; token entered at runtime) ───────────────── */

export function opsPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>NetPulse - Telegram integration status</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0f1115; color: #e7e9ee; margin: 0; padding: 24px; }
  main { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.sub { color: #9aa3b2; font-size: 13px; margin: 0 0 20px; }
  .bar { display: flex; gap: 8px; margin-bottom: 20px; }
  input { flex: 1; background: #0f1115; color: #e7e9ee; border: 1px solid #2a2f3a; border-radius: 8px; padding: 9px 10px; font-size: 14px; }
  button { background: #4f7cff; color: #fff; border: 0; border-radius: 8px; padding: 9px 16px; font-size: 14px; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; }
  .card { background: #171a21; border: 1px solid #2a2f3a; border-radius: 10px; padding: 14px; }
  .card h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #9aa3b2; margin: 0 0 8px; font-weight: 600; }
  .v { font-size: 22px; font-weight: 700; }
  .d { font-size: 11px; color: #9aa3b2; margin-top: 2px; }
  .g { color: #6fd18b; } .y { color: #e5c15a; } .r { color: #ff7a7a; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; margin-top: 10px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #22262f; }
  th { color: #9aa3b2; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; }
  .mono { font-family: ui-monospace, monospace; font-size: 11.5px; }
  #msg { margin: 10px 0; font-size: 13px; min-height: 18px; }
  .ok { color: #6fd18b; } .err { color: #ff7a7a; }
  section { margin-top: 18px; }
</style>
</head>
<body>
<main>
  <h1>NetPulse - Telegram integration status</h1>
  <p class="sub">Operator view of the bot entitlement mirror. The token is the worker's OPS_TOKEN secret - it is sent only to this origin.</p>
  <div class="bar">
    <input id="token" type="password" placeholder="OPS_TOKEN" autocomplete="off">
    <button id="load">Load status</button>
  </div>
  <div id="msg"></div>
  <div id="content"></div>
</main>
<script>
(function () {
  var KEY = 'np-ops-token';
  var input = document.getElementById('token');
  try { input.value = sessionStorage.getItem(KEY) || ''; } catch (e) {}
  document.getElementById('load').addEventListener('click', load);
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') load(); });

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function tone(ok, warn) { return ok ? 'g' : (warn ? 'y' : 'r'); }
  function ago(ms) {
    if (!ms) return '-';
    var s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return Math.floor(s) + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  function load() {
    var btn = document.getElementById('load');
    var msg = document.getElementById('msg');
    var token = input.value.trim();
    if (!token) { msg.textContent = 'Enter the OPS_TOKEN.'; msg.className = 'err'; return; }
    try { sessionStorage.setItem(KEY, token); } catch (e) {}
    btn.disabled = true; btn.textContent = 'Loading...';
    fetch('/api/v1/ops/netpulse', { headers: { Authorization: 'Bearer ' + token } })
      .then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); })
      .then(function (res) {
        btn.disabled = false; btn.textContent = 'Refresh';
        if (res.status === 401) { msg.textContent = 'Unauthorized - wrong token.'; msg.className = 'err'; return; }
        if (res.status === 503) { msg.textContent = 'OPS_TOKEN is not configured on the worker.'; msg.className = 'err'; return; }
        if (!res.body.ok) { msg.textContent = 'Snapshot failed (' + (res.body.error || res.status) + ').'; msg.className = 'err'; return; }
        msg.textContent = 'Live - refreshed ' + new Date().toLocaleTimeString(); msg.className = 'ok';
        render(res.body.data);
      })
      .catch(function () { btn.disabled = false; btn.textContent = 'Refresh'; msg.textContent = 'Network error.'; msg.className = 'err'; });
  }

  function render(s) {
    var dl = s.links.lastSyncedAt;
    var failedEvents = (s.inbox.counts.failed || 0) + (s.inbox.counts.no_link || 0);
    var ob = s.outbound;
    var h = '';

    h += '<div class="grid">';
    h += '<div class="card"><h2>Linked accounts</h2><div class="v g">' + s.links.active + '</div><div class="d">' + s.links.pending + ' pending / ' + s.links.unlinked + ' unlinked</div></div>';
    h += '<div class="card"><h2>Last entitlement sync</h2><div class="v">' + esc(ago(dl)) + '</div><div class="d">pull-sync across active links</div></div>';
    h += '<div class="card"><h2>Inbox events</h2><div class="v ' + tone(failedEvents === 0, s.inbox.counts.pending || 0 > 0) + '">' + s.inbox.total + '</div><div class="d">' +
      Object.keys(s.inbox.counts).map(function (k) { return k + ': ' + s.inbox.counts[k]; }).join(' - ') + '</div></div>';
    h += '<div class="card"><h2>Outbound calls (' + ob.windowHours + 'h)</h2><div class="v ' + tone(ob.failed === 0 && ob.total > 0, ob.okRatePct !== null && ob.okRatePct < 95) + '">' +
      (ob.okRatePct === null ? 'n/a' : ob.okRatePct + '%') + '</div><div class="d">' + ob.ok + ' ok / ' + ob.failed + ' failed</div></div>';
    h += '</div>';

    h += '<section class="card"><h2>Recent inbox events</h2><table><tr><th>Event</th><th>Status</th><th>Received</th></tr>';
    var recent = s.inbox.recent || [];
    if (!recent.length) h += '<tr><td colspan="3" style="color:#9aa3b2">No events yet - events arrive when linked customers change entitlement.</td></tr>';
    recent.forEach(function (r) {
      var cls = r.processedStatus === 'applied' || r.processedStatus === 'acked' ? 'g' : r.processedStatus === 'no_link' ? 'y' : 'r';
      h += '<tr><td class="mono">' + esc(r.eventType) + '</td><td><span class="' + cls + '">' + esc(r.processedStatus) + '</span></td><td>' + esc(ago(r.receivedAt)) + '</td></tr>';
    });
    h += '</table></section>';

    h += '<section class="card"><h2>Outbound calls by action (' + ob.windowHours + 'h)</h2><table><tr><th>Action</th><th>Total</th><th>Failed</th><th>Last status</th></tr>';
    var acts = ob.byAction || [];
    if (!acts.length) h += '<tr><td colspan="4" style="color:#9aa3b2">No outbound calls yet.</td></tr>';
    acts.forEach(function (a) {
      h += '<tr><td class="mono">' + esc(a.action) + '</td><td>' + a.total + '</td><td class="' + (a.failed > 0 ? 'r' : 'g') + '">' + a.failed + '</td><td>' + (a.lastStatus || '-') + '</td></tr>';
    });
    h += '</table>';
    if ((ob.recentErrors || []).length) {
      h += '<p class="sub" style="margin:10px 0 0">Recent failures: ' + ob.recentErrors.map(function (e) { return esc(e.action + ' - ' + e.error.slice(0, 80)); }).join(' | ') + '</p>';
    }
    h += '</section>';

    document.getElementById('content').innerHTML = h;
  }
})();
</script>
</body>
</html>`;
}
