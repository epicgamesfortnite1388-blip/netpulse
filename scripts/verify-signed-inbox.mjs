#!/usr/bin/env node
/**
 * Live verification of the signed Telegram-bot -> NetPulse event inbox.
 *
 * The inbox is fail-CLOSED and every failure code is stable, which lets this
 * script prove real production behaviour in two modes:
 *
 *  - **no secret available** (the normal state on a dev machine — Cloudflare
 *    secrets are write-only): proves the deployed verifier is ARMED, not
 *    merely unconfigured (a signature under a *wrong but well-formed* key is
 *    401 `invalid_signature`, never 503), and that the single-use nonce guard
 *    burns nonces in PRODUCTION before the signature compare (replaying that
 *    same request is 401 `nonce_replayed`). Also proves the canonical string
 *    binds the request target and the clock window.
 *  - **with `NP_SERVICE_SECRET` / `NP_SERVICE_SECRET_FILE`**: additionally
 *    proves the ACCEPT path — a correctly signed request reaches event
 *    validation (422 `unknown_event_type:__probe__`) — plus replay and
 *    tamper rejection on a request the worker would otherwise accept.
 *
 * The probe payload uses an unknown event type on purpose: acceptance is
 * proven by reaching 422, so no `np_events` / `np_entitlements` row is ever
 * written for a test. The only side effect is one `service_nonces` row per
 * accepted request, which the worker sweeps after 15 minutes.
 *
 * The secret is used as an HMAC key only: never printed, logged, echoed in a
 * URL, or included in an error message.
 *
 * usage:
 *   node scripts/verify-signed-inbox.mjs
 *   NP_SERVICE_SECRET_FILE=/secure/path node scripts/verify-signed-inbox.mjs
 *   NP_SERVICE_SECRET=… node scripts/verify-signed-inbox.mjs
 */

import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BASE = (process.env.NP_BASE ?? 'https://netpulse-cloud.shuridehradin.workers.dev').replace(/\/+$/, '');
const INBOX = '/api/internal/netpulse/v1';

/** Must match cloud/worker/src/np-auth.ts `canonicalString`. */
const canonicalString = (ts, nonce, method, path, bodyHash) =>
  ['v1', ts, nonce, method.toUpperCase(), path, bodyHash].join('\n');

const sha256Hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const hmacHex = (key, msg) => createHmac('sha256', key).update(msg, 'utf8').digest('hex');

function loadSecret() {
  const file = process.env.NP_SERVICE_SECRET_FILE;
  if (file) {
    try {
      const v = readFileSync(file, 'utf8').trim();
      return v.length >= 32 ? { value: v, from: `file ${file}` } : null;
    } catch {
      return null;
    }
  }
  const v = (process.env.NP_SERVICE_SECRET ?? '').trim();
  return v.length >= 32 ? { value: v, from: 'NP_SERVICE_SECRET' } : null;
}

/** A structurally valid signed request, built with whatever key is supplied. */
function signed(key, { path = `${INBOX}/events`, body, ts = Date.now(), nonce = randomBytes(16).toString('hex') } = {}) {
  const bodyText = JSON.stringify(body);
  const tsStr = String(ts);
  const signature = hmacHex(key, canonicalString(tsStr, nonce, 'POST', path, sha256Hex(bodyText)));
  return {
    path,
    nonce,
    bodyText,
    headers: {
      'Content-Type': 'application/json',
      'x-np-timestamp': tsStr,
      'x-np-nonce': nonce,
      'x-np-request-id': randomUUID(),
      'x-np-signature': signature,
    },
  };
}

async function post({ path, bodyText, headers }) {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: bodyText });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* non-JSON error page */
  }
  const code = typeof parsed?.error === 'string' ? parsed.error : (parsed?.error?.code ?? '');
  return { status: res.status, code, raw: text.slice(0, 200) };
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
}

/** `__probe__` is deliberately not a known event type: acceptance = 422. */
const probeBody = { eventId: `verify-${randomBytes(8).toString('hex')}`, eventType: '__probe__', version: 1, payload: {} };
const UNKNOWN = 'unknown_event_type:__probe__';

async function main() {
  console.log(`verify-signed-inbox: base=${BASE}`);

  const health = await fetch(`${BASE}/api/v1/health`).catch(() => null);
  if (!health || health.status !== 200) {
    console.log(`BLOCKED: the worker is not reachable/healthy (status=${health?.status ?? 'network'}).`);
    process.exit(2);
  }

  // 1. Fail-closed on an unsigned delivery.
  const unsigned = await post({ path: `${INBOX}/events`, bodyText: JSON.stringify(probeBody), headers: { 'Content-Type': 'application/json' } });
  check('unsigned delivery refused', unsigned.status === 401 && unsigned.code === 'missing_signature_headers', `${unsigned.status} ${unsigned.code}`);

  // 2. Armed verifier: a well-formed signature under the WRONG key is refused
  //    as `invalid_signature`. A 503 here means the deployed secret is missing
  //    and the integration is not deployed, which is a different failure.
  const wrongKey = randomBytes(32).toString('hex');
  const wrong = signed(wrongKey, { body: probeBody });
  const wrongRes = await post(wrong);
  if (wrongRes.status === 503) {
    check('deployed verifier is configured', false, `503 ${wrongRes.code} — NETPULSE_SERVICE_SECRET is not set on the worker`);
  } else {
    check('well-formed signature under a wrong key refused', wrongRes.status === 401 && wrongRes.code === 'invalid_signature', `${wrongRes.status} ${wrongRes.code}`);
  }

  // 3. Replay guard, live in production: the nonce was burned by request 2
  //    BEFORE the signature compare, so replaying the identical request is
  //    `nonce_replayed` — not another signature comparison.
  const replay = await post(wrong);
  check('replayed nonce refused (burned before the signature compare)', replay.status === 401 && replay.code === 'nonce_replayed', `${replay.status} ${replay.code}`);

  // 4. Clock window, checked before any nonce is burned.
  const stale = signed(wrongKey, { body: probeBody, ts: Date.now() - 6 * 60_000 });
  const staleRes = await post(stale);
  check('stale timestamp refused', staleRes.status === 401 && staleRes.code === 'timestamp_out_of_window', `${staleRes.status} ${staleRes.code}`);

  // 5. The canonical string binds the request target: a signature made for
  //    /events does not authorise a different path.
  const crossed = signed(wrongKey, { path: `${INBOX}/events`, body: probeBody });
  const crossedRes = await post({ ...crossed, path: `${INBOX}/events/ack` });
  check('signature does not transfer to another path', crossedRes.status === 401 && crossedRes.code === 'invalid_signature', `${crossedRes.status} ${crossedRes.code}`);

  // 6. The accept path — only possible with the real shared secret.
  const secret = loadSecret();
  if (!secret) {
    console.log('\nBLOCKED  accept path + replay of an accepted request: no shared secret available here');
    console.log('         (Cloudflare secrets are write-only; supply NP_SERVICE_SECRET_FILE to run it).');
  } else {
    console.log(`\ninfo: using the shared secret from ${secret.from}`);
    const good = signed(secret.value, { body: probeBody });
    const goodRes = await post(good);
    check('correctly signed request accepted (reaches event validation)', goodRes.status === 422 && goodRes.code === UNKNOWN,
      `${goodRes.status} ${goodRes.code}`);

    const goodReplay = await post(good);
    check('replay of an ACCEPTED request refused', goodReplay.status === 401 && goodReplay.code === 'nonce_replayed',
      `${goodReplay.status} ${goodReplay.code}`);

    const tampered = signed(secret.value, { body: probeBody });
    const tamperedRes = await post({ ...tampered, bodyText: tampered.bodyText.replace('__probe__', '__probe___') });
    check('body tampered after signing refused', tamperedRes.status === 401 && tamperedRes.code === 'invalid_signature',
      `${tamperedRes.status} ${tamperedRes.code}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${secret ? '' : ' (armed-verifier mode)'}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`verify-signed-inbox: unexpected error: ${err?.message ?? err}`);
  process.exit(2);
});
