/**
 * NetPulse ↔ Abystral service authentication — NetPulse side.
 *
 * MUST stay byte-identical to the bot worker's lib/netpulse-auth.ts canonical
 * string: `v1\nts\nnonce\nMETHOD\npath-with-query\nsha256(body)`, HMAC-SHA256
 * hex, headers x-np-timestamp / x-np-nonce / x-np-request-id / x-np-signature,
 * ±5 min skew. Shared secret: NETPULSE_SERVICE_SECRET on BOTH workers
 * (`wrangler secret put`), never committed.
 *
 * Differences from the bot side are platform-only: this worker has no KV
 * namespace, so single-use nonces live in D1 (rate_limits-style table,
 * migration 0003). A nonce is inserted BEFORE the signature compare — the
 * UNIQUE constraint makes replay a hard failure even under concurrent
 * duplicates. A failed insert returns `replayed` without ever comparing
 * signatures, so a replayed request cannot probe verification behavior.
 *
 * Nothing here logs the secret, a signature, or signed material — failures
 * surface as stable reason codes only.
 */

const SIG_VERSION = 'v1';

/** Maximum clock skew between the two workers (±5 minutes). */
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Nonce replay-window TTL — must exceed the clock-skew window. */
export const NONCE_TTL_MS = 15 * 60 * 1000;

/** Signed header names (identical to the bot's NP_SERVICE_HEADERS). */
export const NP_SERVICE_HEADERS = {
  timestamp: 'x-np-timestamp',
  nonce: 'x-np-nonce',
  requestId: 'x-np-request-id',
  signature: 'x-np-signature',
} as const;

/** ─── Primitives ─────────────────────────────────────────────────────────── */

/** SHA-256 hex digest of a UTF-8 string. */
export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Cryptographically random hex string of `bytes` entropy (2 chars/byte). */
export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Test-only exposure of the raw HMAC primitive (same derivation the signer
 * uses) so tests can craft deterministically-timestamped signed requests
 * without racing real time.
 */
export async function hmacHexForTest(secret: string, message: string): Promise<string> {
  return hmacHex(secret, message);
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Canonical string-to-sign. Path is the URL path WITH query string (the full
 * request target) so query parameters are authenticated too. Identical to the
 * bot worker's canonicalString().
 */
export function canonicalString(ts: string, nonce: string, method: string, path: string, bodyHash: string): string {
  return [SIG_VERSION, ts, nonce, method.toUpperCase(), path, bodyHash].join('\n');
}

/** ─── Outbound (NetPulse → bot integration API) ──────────────────────────── */

/**
 * Build the signed headers for an outbound service request to the bot.
 * `path` must start with `/`; `body` is the exact bytes that will be sent.
 */
export async function signServiceRequest(
  secret: string,
  method: string,
  path: string,
  body: string,
): Promise<Record<string, string>> {
  const ts = String(Date.now());
  const nonce = randomHex(16);
  const bodyHash = await sha256Hex(body);
  const signature = await hmacHex(secret, canonicalString(ts, nonce, method, path, bodyHash));
  return {
    [NP_SERVICE_HEADERS.timestamp]: ts,
    [NP_SERVICE_HEADERS.nonce]: nonce,
    [NP_SERVICE_HEADERS.requestId]: crypto.randomUUID(),
    [NP_SERVICE_HEADERS.signature]: signature,
  };
}

/** ─── Inbound (bot → NetPulse event inbox) ───────────────────────────────── */

export type VerifyResult =
  | { ok: true }
  | { ok: false; status: number; reason: string };

/**
 * Verify a signed inbound request and burn its nonce atomically.
 * Fail-CLOSED: an unconfigured secret rejects every request (a half-deployed
 * integration must never degrade into unsigned trust).
 *
 * Order of checks: config → header presence → timestamp window → replay
 * (nonce burn) → signature. Every failure returns a STABLE reason.
 */
export async function verifyServiceRequest(
  request: Request,
  bodyText: string,
  env: { NETPULSE_SERVICE_SECRET?: string; DB: D1Database },
  opts?: { skewMs?: number; nowMs?: number },
): Promise<VerifyResult> {
  const secret = env.NETPULSE_SERVICE_SECRET;
  if (!secret) {
    return { ok: false, status: 503, reason: 'service_auth_not_configured' };
  }

  const ts = request.headers.get(NP_SERVICE_HEADERS.timestamp);
  const nonce = request.headers.get(NP_SERVICE_HEADERS.nonce);
  const signature = request.headers.get(NP_SERVICE_HEADERS.signature);
  if (!ts || !nonce || !signature) {
    return { ok: false, status: 401, reason: 'missing_signature_headers' };
  }

  const tsNum = Number(ts);
  const now = opts?.nowMs ?? Date.now();
  if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > (opts?.skewMs ?? MAX_CLOCK_SKEW_MS)) {
    return { ok: false, status: 401, reason: 'timestamp_out_of_window' };
  }

  const url = new URL(request.url);
  // Sign the RAW request target (path + query) — never a re-normalized one.
  const pathWithQuery = `${url.pathname}${url.search}`;

  // Replay guard: burn the nonce BEFORE the signature compare. The UNIQUE
  // index makes a duplicate insert fail even under concurrent replays, and
  // burning first means a replayed request can never reach verification.
  const bodyHash = await sha256Hex(bodyText);
  try {
    await env.DB.prepare(
      `INSERT INTO service_nonces (nonce, expires_at, created_at) VALUES (?, ?, ?)`,
    )
      .bind(nonce, now + NONCE_TTL_MS, now)
      .run();
  } catch {
    return { ok: false, status: 401, reason: 'nonce_replayed' };
  }

  const expected = await hmacHex(secret, canonicalString(ts, nonce, request.method, pathWithQuery, bodyHash));
  if (!timingSafeEqualHex(expected, signature)) {
    return { ok: false, status: 401, reason: 'invalid_signature' };
  }
  return { ok: true };
}

/** Constant-time hex comparison — never short-circuits on the first byte. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Remove expired nonces. Called opportunistically after successful verifies
 * (cheap single DELETE, no dedicated cron needed on this worker).
 */
export async function sweepNonces(db: D1Database, nowMs = Date.now()): Promise<void> {
  await db.prepare(`DELETE FROM service_nonces WHERE expires_at < ?`).bind(nowMs).run();
}
