#!/usr/bin/env node
/**
 * Accepted-event + replay smoke for the signed bot -> NetPulse inbox.
 *
 * `verify-signed-inbox.mjs` proves the verifier without writing anything; this
 * script proves the rest of the channel with a REAL event:
 *
 *   1. first delivery of `subscription.activated`   -> 200 duplicate:false,
 *      parked as `processed_status = 'no_link'` (the account is unlinked, so
 *      no entitlement is written);
 *   2. the same event, fresh nonce                   -> 200 duplicate:true,
 *      exactly one `np_events` row for the eventId;
 *   3. the identical request again (same nonce)      -> 401 nonce_replayed;
 *   4. the same eventId once more, fresh nonce       -> 200 duplicate:true.
 *
 * LOOPBACK ONLY. It refuses any non-loopback base on purpose: an accepted
 * event writes `np_events` rows, and production must not be polluted by a
 * smoke. Run it against `wrangler dev --local` (see reports/infra/
 * SIGNED_INBOX_VERIFICATION_2026-10-24.md).
 *
 * usage:
 *   NP_SERVICE_SECRET_FILE=/path/to/secret node scripts/smoke-signed-event.mjs
 *   NP_BASE=http://127.0.0.1:8792 NP_SERVICE_SECRET_FILE=… node scripts/smoke-signed-event.mjs
 */

import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BASE = (process.env.NP_BASE ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const PATH = '/api/internal/netpulse/v1/events';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function loadSecret() {
  const file = process.env.NP_SERVICE_SECRET_FILE;
  if (file) {
    try {
      const v = readFileSync(file, 'utf8').trim();
      if (v.length >= 32) return v;
    } catch {
      /* fall through to the explicit error below */
    }
  }
  const v = (process.env.NP_SERVICE_SECRET ?? '').trim();
  return v.length >= 32 ? v : null;
}

const sha256Hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const hmacHex = (k, m) => createHmac('sha256', k).update(m, 'utf8').digest('hex');

function signed(secret, bodyText, nonce = randomBytes(16).toString('hex')) {
  const ts = String(Date.now());
  const signature = hmacHex(secret, ['v1', ts, nonce, 'POST', PATH, sha256Hex(bodyText)].join('\n'));
  return {
    headers: {
      'Content-Type': 'application/json',
      'x-np-timestamp': ts,
      'x-np-nonce': nonce,
      'x-np-request-id': randomUUID(),
      'x-np-signature': signature,
    },
    bodyText,
  };
}

async function post(req) {
  const res = await fetch(`${BASE}${PATH}`, { method: 'POST', headers: req.headers, body: req.bodyText });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function main() {
  const url = new URL(BASE);
  if (!LOOPBACK.has(url.hostname)) {
    console.error(`refusing to run against ${url.hostname}: this smoke writes np_events rows and is loopback-only.`);
    process.exit(2);
  }

  const secret = loadSecret();
  if (!secret) {
    console.error('BLOCKED: no shared secret. Set NP_SERVICE_SECRET_FILE (a >= 32 char value) for the local worker.');
    process.exit(2);
  }

  const health = await fetch(`${BASE}/api/v1/health`).catch(() => null);
  if (!health || health.status !== 200) {
    console.error(`BLOCKED: local worker not healthy (status=${health?.status ?? 'network'}) at ${BASE}`);
    process.exit(2);
  }
  console.log(`smoke-signed-event: base=${BASE}`);

  const eventId = `smoke-${randomBytes(8).toString('hex')}`;
  const accountId = `npa_smoke_${randomBytes(6).toString('hex')}`;
  const bodyText = JSON.stringify({
    eventId,
    eventType: 'subscription.activated',
    version: 1,
    netpulseAccountId: accountId,
    payload: {
      subscription: {
        subscriptionId: 9001,
        planCode: 'pro',
        status: 'active',
        startedAt: '2026-10-01 00:00:00',
        expiresAt: '2026-11-01 00:00:00',
        autoRenew: false,
        totalGb: 50,
        usedGb: 0,
        ipLimit: 2,
      },
    },
  });

  const checks = [];
  const check = (name, ok, detail) => {
    checks.push(ok);
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
  };

  // 1. Real event, first delivery.
  const first = await post(signed(secret, bodyText));
  check('accepted event (unknown account parks as no_link)', first.status === 200 && first.body?.duplicate === false,
    `${first.status} ${JSON.stringify(first.body)}`);

  // 2. Same eventId, fresh nonce: idempotent, never a second row.
  const replayNonce = `smoke-replay-${randomBytes(8).toString('hex')}`;
  const sameEvent = await post(signed(secret, bodyText, replayNonce));
  check('same eventId re-sent with a fresh nonce is a duplicate no-op', sameEvent.status === 200 && sameEvent.body?.duplicate === true,
    `${sameEvent.status} ${JSON.stringify(sameEvent.body)}`);

  // 3. Byte-identical request again: the nonce is single-use.
  const replay = await post(signed(secret, bodyText, replayNonce));
  check('replay of the accepted request refused', replay.status === 401 && replay.body?.error === 'nonce_replayed',
    `${replay.status} ${JSON.stringify(replay.body)}`);

  // 4. And still idempotent after the replay attempt.
  const afterReplay = await post(signed(secret, bodyText));
  check('redelivery after a replay attempt stays a no-op', afterReplay.status === 200 && afterReplay.body?.duplicate === true,
    `${afterReplay.status} ${JSON.stringify(afterReplay.body)}`);

  console.log(`\neventId=${eventId}`);
  console.log(`accountId=${accountId}  (no_link, no entitlement written)`);
  console.log(`\n${checks.filter(Boolean).length}/${checks.length} checks passed`);
  process.exitCode = checks.every(Boolean) ? 0 : 1;
}

main().catch((err) => {
  console.error(`smoke-signed-event: unexpected error: ${err?.message ?? err}`);
  process.exitCode = 2;
});
