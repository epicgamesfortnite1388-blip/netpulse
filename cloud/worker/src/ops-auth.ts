/**
 * The operator gate, shared by every `/api/v1/ops/*` endpoint.
 *
 * There is exactly one OPS_TOKEN and every operator route must apply the same
 * four rules in the same order, because each one is a security property:
 *
 *   1. FAIL CLOSED when the token is unset or too short — an unconfigured
 *      deployment answers 503, it never falls open.
 *   2. RATE LIMIT by client IP BEFORE comparing the token, so guessing is
 *      bounded even though the token is long random hex (audit F2).
 *   3. COMPARE in constant time, so response timing carries no prefix
 *      information.
 *   4. Never echo the presented value back in the error.
 *
 * It lived in `ops-page.ts` when the status snapshot was the only operator
 * route. Rotating a leaked VPN credential is a second one, and a second copy
 * of these rules would be a second place to get them wrong.
 */

import { rateLimit } from './auth';

import type { Env } from './auth';

/** Brute-force wall for operator tokens: 30 attempts per 5 minutes per IP. */
const OPS_WINDOW_MS = 5 * 60_000;
export const OPS_RATE_LIMIT_MAX = 30;

export function opsJson(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

/** The client address Cloudflare vouches for; `unknown` when absent. */
export function opsClientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip')?.slice(0, 60) ?? 'unknown';
}

/** Constant-time string comparison (hex/token shape, never short-circuits). */
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type OpsAuth = { ok: true } | { ok: false; response: Response };

/**
 * Authorize an operator request. `bucket` scopes the rate-limit counter, so a
 * burst of status reloads cannot throttle an incident-response rotation (and a
 * rotation cannot be used to exhaust the status page's budget).
 */
export async function authorizeOps(
  request: Request,
  env: Env,
  opts: { bucket: string; max?: number; windowMs?: number },
): Promise<OpsAuth> {
  const expected = env.OPS_TOKEN?.trim();
  // Rule 1: fail closed, and do it before touching the limiter (an
  // unconfigured worker should not write rate-limit rows or leak timing).
  if (!expected || expected.length < 16) {
    return { ok: false, response: opsJson(503, { ok: false, error: 'ops_token_not_configured' }) };
  }

  // Rule 2: the wall applies before the comparison.
  const limiter = await rateLimit(env.DB, `${opts.bucket}:${opsClientIp(request)}`, opts.max ?? OPS_RATE_LIMIT_MAX, opts.windowMs ?? OPS_WINDOW_MS);
  if (!limiter.ok) {
    return {
      ok: false,
      response: opsJson(429, { ok: false, error: 'rate_limited' }, { 'Retry-After': String(limiter.retryAfterSec) }),
    };
  }

  // Rule 3: constant-time compare. Rule 4: the failure says only "unauthorized".
  const presented = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  if (!presented || !timingSafeEqualStr(presented, expected)) {
    return { ok: false, response: opsJson(401, { ok: false, error: 'unauthorized' }) };
  }

  return { ok: true };
}
