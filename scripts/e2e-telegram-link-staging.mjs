#!/usr/bin/env node
/**
 * Staging-bot E2E — Telegram link request + claim.
 *
 * The worker suite mocks the bot at the outbound fetch seam, so it cannot prove
 * that a REAL deployment of the bot accepts our signatures, our canonical
 * string, or our claim semantics. This harness does exactly that, against a
 * staging bot, over the signed integration API:
 *
 *   POST /api/internal/netpulse/v1/link/request  { netpulseAccountId }
 *     → { success: true, data: { requestId, code, expiresAt, deepLink } }
 *   POST /api/internal/netpulse/v1/link/claim    { code, netpulseAccountId }
 *     → { success: true, data: { linked: true, botUserId, linkId } }
 *
 * It also asserts the refusals that make those routes safe: unsigned, tampered,
 * stale and replayed requests must be rejected with the shared reason codes, and
 * a claimed code must never bind a second account.
 *
 * Usage:
 *   NP_STAGING_BOT_URL=https://abystral-telegram-staging.<account>.workers.dev \
 *   NETPULSE_SERVICE_SECRET=…                # or NP_SERVICE_SECRET_FILE
 *   npm run e2e:telegram:link:staging
 *
 * Flags:
 *   --wait <seconds>       print the deep link and poll the claim until a human
 *                          (or the bot's staging identity) confirms it
 *   --require-claim        a pending claim is a failure, not an env skip — use
 *                          this in CI against a staging bot that auto-confirms
 *   --cloud <url>          also drive the staging NetPulse worker's link routes
 *                          (registers one throwaway account — see the warning)
 *   --allow-production     permit the known production bot origin
 *
 * Exit codes: 0 pass (environment skips allowed), 1 failure, 2 not run.
 *
 * Signing is re-implemented here on purpose: this harness is the
 * cross-implementation check, so it must not reuse the code it validates. Keep
 * it byte-identical to cloud/worker/src/np-auth.ts:
 *   v1\nts\nnonce\nMETHOD\npath?query\nsha256(body)  → HMAC-SHA256 hex
 * with headers x-np-timestamp / x-np-nonce / x-np-request-id / x-np-signature.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const API = '/api/internal/netpulse/v1';
const HTTP_TIMEOUT_MS = 15_000;
const HTTP_RETRIES = 2;
const SKIP = 2;

/** The documented production bot — pointing a write-capable test at it is a mistake. */
const PRODUCTION_BOT = 'abystral-telegram.radinshurideh.workers.dev';

/* ------------------------------- arguments ------------------------------- */

function flag(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : null;
}

const BOT = (flag('bot') ?? process.env.NP_STAGING_BOT_URL ?? '').trim().replace(/\/+$/, '');
const CLOUD = (flag('cloud') ?? process.env.NP_STAGING_CLOUD_URL ?? '').trim().replace(/\/+$/, '');
const WAIT_S = Math.max(0, Number(flag('wait') ?? process.env.NP_LINK_WAIT_S ?? 0) || 0);
const REQUIRE_CLAIM = process.argv.includes('--require-claim');
const ALLOW_PRODUCTION = process.argv.includes('--allow-production');

/* -------------------------------- reporting ------------------------------- */

let checks = 0;
const failures = [];
const envSkips = [];
const steps = [];
const startedAt = Date.now();

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function check(name, ok, detail) {
  checks++;
  steps.push({ check: name, at: Date.now(), ok, detail });
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${JSON.stringify(detail).slice(0, 240)}` : ''}`);
  if (!ok) failures.push({ name, detail });
  return ok;
}

function envSkip(name, detail) {
  checks++;
  steps.push({ check: name, at: Date.now(), skipped: true, detail });
  envSkips.push({ name, detail });
  log(`  SKIP  ${name} — ${JSON.stringify(detail).slice(0, 240)}`);
}

function maskCode(code) {
  return typeof code === 'string' && code.length > 8 ? `${code.slice(0, 6)}…(${code.length})` : code;
}

function maskDeepLink(link) {
  if (typeof link !== 'string') return link;
  return link.replace(/([?&]start=)([^&]+)/, (_m, p, v) => `${p}${maskCode(v)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------- config -------------------------------- */

/**
 * Shared service secret: env var or a file path (same convention as
 * scripts/e2e-telegram-vpn.mjs). Never printed, never written to evidence.
 */
function loadServiceSecret() {
  const file = process.env.NP_SERVICE_SECRET_FILE;
  if (file) {
    try {
      const value = fs.readFileSync(file, 'utf8').trim();
      return value.length >= 32 ? value : null;
    } catch {
      return null;
    }
  }
  const value = process.env.NETPULSE_SERVICE_SECRET ?? process.env.NP_SERVICE_SECRET;
  return value && value.length >= 32 ? value.trim() : null;
}

const SECRET = loadServiceSecret();

function configProblem() {
  if (!BOT) return 'NP_STAGING_BOT_URL (or --bot) is required';
  if (!SECRET) return 'NETPULSE_SERVICE_SECRET / NP_SERVICE_SECRET_FILE (>= 32 chars) is required — the staging bot must use the SAME value';
  let url;
  try {
    url = new URL(BOT);
  } catch {
    return `NP_STAGING_BOT_URL is not a URL: ${BOT}`;
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !loopback) return 'the staging bot must be reached over https (http is allowed only on loopback)';
  if (url.hostname === PRODUCTION_BOT && !ALLOW_PRODUCTION) return `refusing to run against the production bot (${PRODUCTION_BOT}) — pass --allow-production if that is really intended`;
  return null;
}

/* ---------------------------------- http --------------------------------- */

/**
 * One JSON request. Retries ONLY transport failures (status 0) — a real status
 * is never retried, so a product failure stays distinguishable from a flaky
 * link, and a signed request is never silently re-sent under a new nonce.
 */
async function httpJson(url, init, attempt = 0) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    const raw = await res.text();
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      /* non-JSON (an edge error page, a proxy interstitial) */
    }
    return { status: res.status, body, raw };
  } catch (err) {
    if (attempt < HTTP_RETRIES) {
      await sleep(400 * (attempt + 1));
      return httpJson(url, init, attempt + 1);
    }
    const code = err?.cause?.code ?? err?.name ?? 'transport_error';
    return { status: 0, body: null, raw: '', error: String(code) };
  }
}

/* --------------------------------- signing -------------------------------- */

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Byte-identical to canonicalString() in cloud/worker/src/np-auth.ts. */
function canonicalString(ts, nonce, method, pathWithQuery, bodyHash) {
  return ['v1', ts, nonce, method.toUpperCase(), pathWithQuery, bodyHash].join('\n');
}

function hmacHex(secret, message) {
  return crypto.createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}

/** Flip the last hex char — always differs, unlike prefixing 'f'. */
function tamperHex(hex) {
  return hex.slice(0, -1) + (hex.endsWith('f') ? '0' : 'f');
}

/**
 * Build the signed header set for one request. Returns the exact headers and
 * body so a replay check can re-send the IDENTICAL bytes under the same nonce.
 */
function signRequest(method, pathWithQuery, bodyText, opts = {}) {
  const ts = String(opts.ts ?? Date.now());
  const nonce = opts.nonce ?? crypto.randomBytes(16).toString('hex');
  const signature = hmacHex(SECRET, canonicalString(ts, nonce, method, pathWithQuery, sha256Hex(bodyText)));
  return {
    'x-np-timestamp': ts,
    'x-np-nonce': nonce,
    'x-np-request-id': crypto.randomUUID(),
    'x-np-signature': opts.tamper ? tamperHex(signature) : signature,
  };
}

/**
 * Signed call to the bot. `pathWithQuery` is the request target that is signed
 * (path + query, never the origin), exactly what verifyServiceRequest rebuilds.
 */
async function signedBot(method, pathWithQuery, body, opts = {}) {
  const bodyText = body === undefined ? '' : JSON.stringify(body);
  const headers = signRequest(method, pathWithQuery, bodyText, opts);
  if (bodyText) headers['content-type'] = 'application/json';
  const res = await httpJson(`${BOT}${pathWithQuery}`, {
    method,
    headers,
    ...(bodyText ? { body: bodyText } : {}),
  });
  return { ...res, request: { method, pathWithQuery, bodyText, headers } };
}

/** Re-send a signed request verbatim (same nonce, same bytes). */
async function replayBot(signed) {
  return httpJson(`${BOT}${signed.request.pathWithQuery}`, {
    method: signed.request.method,
    headers: signed.request.headers,
    body: signed.request.bodyText,
  });
}

/* -------------------------------- helpers -------------------------------- */

/** The bot's machine errors are flat `{ success:false, error }`. */
const botError = (res) => (typeof res.body?.error === 'string' ? res.body.error : '');
/** The worker's session errors are nested `{ error: { code } }`. */
const workerError = (res) => (typeof res.body?.error?.code === 'string' ? res.body.error.code : '');

/** Same shape newId('npa') mints: npa_ + base64url(12 random bytes). */
function newAccountId() {
  return `npa_${crypto.randomBytes(12).toString('base64url')}`;
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/* ------------------------------- bot leg --------------------------------- */

async function botLeg() {
  const accountId = newAccountId();
  const requestPath = `${API}/link/request`;
  const claimPath = `${API}/link/claim`;
  const requestBody = { netpulseAccountId: accountId };

  log(`[bot] ${BOT}`);
  log(`[bot] netpulseAccountId ${accountId}`);

  // The route must exist AND fail closed: an unsigned write is never trusted.
  const unsigned = await httpJson(`${BOT}${requestPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  check(
    'bot: unsigned link/request is rejected',
    unsigned.status === 401 && botError(unsigned) === 'missing_signature_headers',
    { status: unsigned.status, error: botError(unsigned) || unsigned.error },
  );
  if (unsigned.status === 404) {
    check('bot: link/request exists on the staging bot', false, {
      status: 404,
      note: 'route not found — wrong NP_STAGING_BOT_URL, or this deployment predates the integration API',
    });
    return { accountId };
  }

  const tampered = await signedBot('POST', requestPath, requestBody, { tamper: true });
  check(
    'bot: tampered signature is rejected',
    tampered.status === 401 && botError(tampered) === 'invalid_signature',
    { status: tampered.status, error: botError(tampered) },
  );

  const stale = await signedBot('POST', requestPath, requestBody, { ts: Date.now() - 10 * 60_000 });
  check(
    'bot: stale timestamp is rejected',
    stale.status === 401 && botError(stale) === 'timestamp_out_of_window',
    { status: stale.status, error: botError(stale) },
  );

  // The signed request the whole flow hangs on.
  const issued = await signedBot('POST', requestPath, requestBody);
  const data = issued.body?.data ?? {};
  const accepted = check('bot: signed link/request is accepted', issued.status === 200 && issued.body?.success === true, {
    status: issued.status,
    error: botError(issued) || issued.error,
    requestId: data.requestId,
  });

  const code = typeof data.code === 'string' ? data.code : '';
  const deepLink = typeof data.deepLink === 'string' ? data.deepLink : '';
  const link = safeUrl(deepLink);
  const botUsername = link && link.hostname === 't.me' ? link.pathname.replace(/^\/+/, '') : '';
  check(
    'bot: response carries a one-time code and a future expiry',
    accepted && code.length > 0 && code.length <= 128 && Number.isFinite(data.expiresAt) && data.expiresAt > Date.now(),
    { code: maskCode(code), expiresAt: data.expiresAt, requestId: data.requestId },
  );
  check('bot: deep link opens Telegram with the issued code', !!link && link.protocol === 'https:' && botUsername !== '' && link.searchParams.get('start') === code, {
    deepLink: maskDeepLink(deepLink),
    bot: botUsername || null,
  });

  // A replay carries a valid signature and the same body; only the nonce store
  // can stop it, so this is the check that the code cannot be re-minted.
  const replay = await replayBot(issued);
  check(
    'bot: replayed signed request is rejected',
    replay.status === 401 && botError(replay) === 'nonce_replayed',
    { status: replay.status, error: botError(replay), note: 'expected a single-use nonce rejection, not a second code' },
  );

  if (!accepted || !code) {
    return { accountId, botUsername, claimed: false, code: '' };
  }

  // Claim with a code that was never issued: the signature must be accepted and
  // the business state rejected (401 here would mean our signer is wrong).
  const unknown = await signedBot('POST', claimPath, {
    code: `nplink_e2e_missing_${crypto.randomBytes(4).toString('hex')}`,
    netpulseAccountId: accountId,
  });
  check(
    'bot: signed claim rejects an unknown code without rejecting the signature',
    unknown.status >= 400 && unknown.status < 500 && unknown.status !== 401,
    { status: unknown.status, error: botError(unknown), body: unknown.body },
  );

  // Claim the code the bot just issued for this account.
  let claimed = await signedBot('POST', claimPath, { code, netpulseAccountId: accountId });
  let claimOk = claimed.status === 200 && claimed.body?.success === true && claimed.body.data?.linked === true && Number.isInteger(claimed.body.data?.botUserId);

  if (!claimOk && WAIT_S > 0) {
    log('');
    log('  ── Telegram confirmation needed ─────────────────────────────────');
    log(`  open: ${deepLink}`);
    log(`  polling the signed claim for up to ${WAIT_S}s (Ctrl-C to stop)…`);
    log('  ────────────────────────────────────────────────────────────────');
    const deadline = Date.now() + WAIT_S * 1000;
    while (!claimOk && Date.now() < deadline) {
      await sleep(5_000);
      claimed = await signedBot('POST', claimPath, { code, netpulseAccountId: accountId });
      claimOk = claimed.status === 200 && claimed.body?.success === true && claimed.body.data?.linked === true;
    }
  }

  if (claimOk) {
    check('bot: claim binds the issued code to this account', true, {
      botUserId: claimed.body.data.botUserId,
      linkId: claimed.body.data.linkId,
    });

    // Security property: a consumed code must not bind a second NetPulse account
    // (the bot owns identity; the app NEVER supplies a Telegram id).
    const cross = await signedBot('POST', claimPath, { code, netpulseAccountId: newAccountId() });
    check(
      'bot: a claimed code cannot bind a second account',
      !(cross.status === 200 && cross.body?.success === true && cross.body.data?.linked === true),
      { status: cross.status, error: botError(cross), body: cross.body },
    );
  } else if (claimed.status === 401) {
    // The signature was refused on the claim path specifically.
    check('bot: claim accepts our signature', false, {
      status: claimed.status,
      error: botError(claimed),
      note: 'canonical string or shared secret mismatch between this harness and the staging bot',
    });
  } else if (WAIT_S > 0) {
    // An explicit wait is a promise the harness made to the operator: if no
    // confirmation arrived in the window, that is a failure, not an env skip.
    check('bot: claim binds the issued code to this account', false, {
      status: claimed.status,
      error: botError(claimed) || claimed.error,
      note: `the code was not confirmed in Telegram within ${WAIT_S}s`,
      deepLink: maskDeepLink(deepLink),
    });
  } else if (REQUIRE_CLAIM) {
    check('bot: claim binds the issued code to this account', false, {
      status: claimed.status,
      error: botError(claimed) || claimed.error,
      note: 'the code is issued but no Telegram identity is bound to it yet (--require-claim)',
      deepLink: maskDeepLink(deepLink),
    });
  } else {
    envSkip('bot: claim binds the issued code to this account', {
      status: claimed.status,
      error: botError(claimed) || claimed.error,
      note: 'the code is issued but no Telegram identity is bound to it yet',
      deepLink: maskDeepLink(deepLink),
      hint: 're-run with --wait 120 and open the deep link, or point at a staging bot with a test identity',
    });
  }

  return {
    accountId,
    botUsername,
    code,
    claimed: claimOk,
    botUserId: claimOk ? claimed.body.data.botUserId : null,
  };
}

/* ------------------------------ worker leg ------------------------------- */

/**
 * Drives the real staging worker's link routes. This is the leg that proves the
 * WORKER signs correctly (not just this harness) and that its
 * TELEGRAM_BOT_BASE_URL points at the staging bot rather than production.
 *
 * WARNING: `[env.staging]` in wrangler.toml reuses the production D1 database,
 * so this registers one throwaway account in real data (docs/app-review-audit
 * finding C7). That is why it is opt-in behind --cloud.
 */
async function workerLeg(botUsername) {
  log('');
  log(`[worker] ${CLOUD}`);
  log('  warning: the cloud leg registers one throwaway account; the staging environment reuses the production D1 database (audit C7)');

  const health = await httpJson(`${CLOUD}/api/v1/health`);
  check('worker: staging worker is healthy', health.status === 200 && health.body?.ok === true, {
    status: health.status,
    ok: health.body?.ok,
  });

  const email = `e2e-tg-link-${Date.now()}-${crypto.randomBytes(3).toString('hex')}@example.invalid`;
  const registered = await httpJson(`${CLOUD}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password: 'Sup3rSecurePassE2E!42',
      device: { name: 'e2e-telegram-link', os: 'Windows', appVersion: '0.0.0-e2e' },
    }),
  });
  const token = registered.body?.accessToken;
  check('worker: throwaway test account created', registered.status === 201 && typeof token === 'string', {
    status: registered.status,
    error: workerError(registered) || registered.error,
    email,
  });
  if (typeof token !== 'string') return;

  const auth = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const start = await httpJson(`${CLOUD}/api/v1/account/telegram/link`, {
    method: 'POST',
    headers: auth,
    body: '{}',
  });
  const workerCode = typeof start.body?.token === 'string' ? start.body.token : '';
  const workerLink = safeUrl(start.body?.deepLink);
  const workerBot = workerLink && workerLink.hostname === 't.me' ? workerLink.pathname.replace(/^\/+/, '') : '';
  check('worker: start-link returns a one-time code and a Telegram deep link', start.status === 200 && !!workerCode && !!workerLink, {
    status: start.status,
    error: workerError(start) || start.error,
    code: maskCode(workerCode),
    deepLink: maskDeepLink(start.body?.deepLink),
  });
  check(
    "worker: its TELEGRAM_BOT_BASE_URL points at the staging bot",
    !!workerBot && (!botUsername || workerBot === botUsername),
    { workerBot: workerBot || null, stagingBot: botUsername || null, note: workerBot && botUsername && workerBot !== botUsername ? 'the worker is linked to a different bot' : undefined },
  );

  if (!workerCode) return;

  const confirm = await httpJson(`${CLOUD}/api/v1/account/telegram/link/confirm`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ code: workerCode }),
  });
  const confirmCode = workerError(confirm);

  if (confirm.status === 200 && confirm.body?.ok === true) {
    const status = await httpJson(`${CLOUD}/api/v1/account/telegram`, { headers: auth });
    check('worker: link status reports connected after the confirm', status.status === 200 && status.body?.connected === true, {
      status: status.status,
      connected: status.body?.connected,
      telegram_user_id: status.body?.telegram_user_id,
    });
    const unlink = await httpJson(`${CLOUD}/api/v1/account/telegram/unlink`, { method: 'POST', headers: auth });
    check('worker: unlink clears the link', unlink.status === 200, { status: unlink.status, error: workerError(unlink) });
    const after = await httpJson(`${CLOUD}/api/v1/account/telegram`, { headers: auth });
    check('worker: link status reports disconnected after the unlink', after.status === 200 && after.body?.connected === false, {
      connected: after.body?.connected,
    });
  } else if (confirm.status === 400) {
    // The bot was reached and answered with its own business refusal. That is
    // proof of a working signed path, not a product failure — the code simply
    // has no confirmed Telegram identity on the staging bot.
    envSkip('worker: confirm updates the link mirror', {
      status: confirm.status,
      error: confirmCode,
      note: 'the worker reached the bot and the bot refused the claim (identity not confirmed); the signed path itself works',
      hint: 'use a staging bot with a test Telegram identity, or confirm the deep link and re-run with --wait',
    });
  } else {
    check('worker: confirm reaches the staging bot', false, {
      status: confirm.status,
      error: confirmCode || confirm.error,
      note:
        confirm.status === 502 || confirm.status === 503
          ? 'the worker could not complete the signed call — check TELEGRAM_BOT_BASE_URL and that NETPULSE_SERVICE_SECRET matches on both deployments'
          : 'unexpected response from the worker confirm route',
    });
  }
}

/* ------------------------------ entry point ------------------------------ */

function writeEvidence(payload) {
  const dir = path.join(os.tmpdir(), 'netpulse-tg-link-e2e');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'telegram-link-staging.json');
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}

try {
  const problem = configProblem();
  if (problem) {
    log('');
    log('============ TELEGRAM LINK → STAGING BOT E2E ============');
    log(`  NOT RUN — ${problem}`);
    log('  see the header of scripts/e2e-telegram-link-staging.mjs for usage');
    log('  verdict:  SKIP (not run — not a pass)');
    log('=========================================================');
    process.exit(SKIP);
  }

  log('============ TELEGRAM LINK → STAGING BOT E2E ============');
  const bot = await botLeg();

  if (CLOUD) {
    let cloudUrl = null;
    try {
      cloudUrl = new URL(CLOUD);
    } catch {
      check('worker: staging worker URL is valid', false, { cloud: CLOUD });
    }
    if (cloudUrl && (cloudUrl.protocol === 'https:' || cloudUrl.hostname === 'localhost' || cloudUrl.hostname === '127.0.0.1')) {
      await workerLeg(bot.botUsername ?? '');
    }
  }

  const executed = checks - envSkips.length;
  const passed = executed - failures.length;
  const verdict = failures.length === 0 ? 'PASS' : 'FAIL';
  const file = writeEvidence({
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    verdict,
    bot: BOT,
    cloud: CLOUD || null,
    accountId: bot.accountId ?? null,
    botUsername: bot.botUsername ?? null,
    claimVerified: bot.claimed === true,
    checks: { total: checks, executed, passed, failed: failures.length, envSkipped: envSkips.length },
    failures,
    environmentSkips: envSkips,
    steps,
  });

  log('');
  log(`  checks:   ${passed}/${executed} executed passed${envSkips.length ? `, ${envSkips.length} env-skipped` : ''}`);
  log(`  failures: ${failures.length}`);
  log(`  evidence: ${file}`);
  log(`  verdict:  ${verdict}${envSkips.length ? ' (with environment skips — the skipped leg did not run)' : ''}`);
  log('=========================================================');

  if (failures.length > 0) {
    for (const f of failures) log(`  ✗ ${f.name} — ${JSON.stringify(f.detail).slice(0, 300)}`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
} catch (err) {
  log(`e2e-telegram-link-staging crashed: ${err?.stack ?? err}`);
  writeEvidence({ timestamp: new Date().toISOString(), verdict: 'ERROR', error: String(err?.stack ?? err), failures, steps });
  process.exit(1);
}
