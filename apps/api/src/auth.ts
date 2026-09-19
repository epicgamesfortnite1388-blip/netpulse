import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { AppError } from './util/appError';

export const SESSION_COOKIE = 'netpulse_session';

export interface AuthOptions {
  daemonToken: string;
  sessionTtlMs: number;
  allowedOrigins: string[];
  /**
   * Desktop mode (security follow-up to H1): the Tauri shell injects a
   * per-launch ephemeral secret (memory-only) into the webview (typed IPC)
   * and this process (stdin). Cookies are then REMOVED from the trust chain:
   * `/auth/session` refuses to mint one unless the caller presents the launch
   * secret, and `requireAuth` no longer accepts cookies. Result: no credential
   * that satisfies the local API can exist anywhere a browser can request one —
   * the only accepted credential is the secret the shell injected this launch.
   * Web/dev mode (no shell) keeps the origin-gated cookie session.
   */
  desktopMode: boolean;
}

function sha256(value: string): Buffer {
  return crypto.createHash('sha256').update(value).digest();
}

function safeEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function sign(value: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function makeSessionValue(ttlMs: number, secret: string): { value: string; expires: Date } {
  const exp = Date.now() + ttlMs;
  const payload = `v1.${exp}`;
  return { value: `${payload}.${sign(payload, secret)}`, expires: new Date(exp) };
}

function verifySessionValue(cookie: string, secret: string): boolean {
  const parts = cookie.split('.');
  if (parts.length !== 3) return false;
  const [version, expRaw, sig] = parts as [string, string, string];
  if (version !== 'v1') return false;
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const payload = `v1.${expRaw}`;
  return safeEqual(sig, sign(payload, secret));
}

function isLoopbackIp(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

export function ensureDaemonToken(tokenFile: string): string {
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  try {
    const existing = fs.readFileSync(tokenFile, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    // generate below
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenFile, `${token}\n`);
  return token;
}

export function isLoopbackRequest(ip: string | undefined): boolean {
  return ip !== undefined && isLoopbackIp(ip);
}

export interface AuthRequestLike {
  headers: Record<string, unknown>;
  cookies: Record<string, string | undefined>;
  method: string;
  ip?: string;
}

export interface AuthHooks {
  requireAuth: (req: AuthRequestLike) => void;
  issueSession: (req: AuthRequestLike) => { cookieName: string; cookieValue: string; expires: Date; ttlMs: number };
  verifyToken: (token: string) => boolean;
}

/**
 * Session issuance is browser-origin gated (security finding H1), and in
 * desktop mode additionally REQUIRES the shell-injected launch secret.
 *
 * The hole: a session cookie could be minted by ANY caller that reached the
 * loopback port, so a page the user merely visited could POST here and walk away
 * with a cookie that satisfies every mutating route for the whole session TTL.
 *
 * The gate, in order:
 *
 *   0. DESKTOP ONLY: the caller must present the per-launch ephemeral secret
 *      (Bearer header) the Tauri shell injected. A web page — in the webview's
 *      browser context or any other browser — cannot read it, so on the
 *      installed product no session cookie can be minted by anything the user
 *      did not deliberately run as themselves with shell access.
 *   1. an `Origin` header, when present, must be allowlisted OR be this same
 *      origin (`Origin` host === `Host`). A cross-site page always sends its own
 *      origin, which matches neither — and a same-origin request cannot be an
 *      attacker, because serving it would require already controlling the API.
 *   2. no `Origin` but browser fetch metadata (`Sec-Fetch-*`) or a form content
 *      type means a browser that withheld the origin anyway (legacy form POST,
 *      sandboxed frame). Refuse: the same-origin signal is absent.
 *   3. neither marker means a non-browser client (our own tooling, tests,
 *      scripts). Allowed in web mode, and stated plainly: such a caller runs as
 *      the user and can read the daemon token directly, so an Origin check is
 *      not what stops it — the loopback bind and the token are.
 */

/** Form content types a cross-site <form> can send without a preflight. */
const FORM_CONTENT_TYPES = ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'];

function headerString(req: AuthRequestLike, name: string): string | null {
  const raw = req.headers[name];
  if (typeof raw === 'string') return raw.trim();
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0].trim();
  return null;
}

function isSameOrigin(origin: string, host: string | null): boolean {
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * THE origin policy, used by session issuance and by the CSRF check on
 * cookie-authenticated mutations. One owner on purpose: when the two disagreed,
 * a deployment whose own origin was not in CORS_ORIGINS could read but not
 * write, and a reviewer could not tell which rule was intended.
 *
 * An origin is acceptable when it is configured, OR when it is the same origin
 * as the request's own Host — the latter cannot be forged cross-site, because a
 * browser always sends the attacker's origin, which by definition is not ours.
 */
export function isAllowedOrigin(origin: string, host: string | null, allowedOrigins: string[]): boolean {
  if (allowedOrigins.includes(origin)) return true;
  return isSameOrigin(origin, host);
}

/**
 * Why this request may not be given a session, or null when it may.
 * Exported for tests: the policy must be assertable without a live server.
 */
export function sessionOriginRefusal(req: AuthRequestLike, allowedOrigins: string[]): string | null {
  const origin = headerString(req, 'origin');
  if (origin) {
    if (isAllowedOrigin(origin, headerString(req, 'host'), allowedOrigins)) return null;
    return 'This request came from a different site than the app, so no session was issued.';
  }

  const hasFetchMetadata = Object.keys(req.headers).some((h) => h.toLowerCase().startsWith('sec-fetch-'));
  const contentType = (headerString(req, 'content-type') ?? '').toLowerCase();
  const looksLikeForm = FORM_CONTENT_TYPES.some((t) => contentType.includes(t));
  if (hasFetchMetadata || looksLikeForm) {
    return 'This looked like a browser request with no origin the app recognises, so no session was issued.';
  }

  return null;
}

export function createAuth(opts: AuthOptions): AuthHooks {
  const { daemonToken, sessionTtlMs, allowedOrigins, desktopMode } = opts;

  const verifyToken = (token: string) => safeEqual(token, daemonToken);

  const requireAuth: AuthHooks['requireAuth'] = (req) => {
    const header = req.headers.authorization;
    if (typeof header === 'string') {
      const bearer = header.replace(/^Bearer\s+/i, '').trim();
      if (bearer && verifyToken(bearer)) return;
    }
    // Desktop mode: the launch secret is the ONLY credential. Cookies are not
    // consulted at all, so even a leaked/stale cookie grants nothing.
    if (desktopMode) {
      throw new AppError(
        401,
        'unauthorized',
        'Authentication required',
        'Pass the per-launch launch secret as a Bearer header.',
      );
    }
    const cookie = req.cookies[SESSION_COOKIE];
    if (cookie && verifySessionValue(cookie, daemonToken)) {
      // CSRF hardening: cookie-authenticated mutations must come from an origin
      // this app recognises (configured, or the request's own origin).
      const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      if (mutating) {
        const origin = headerString(req, 'origin');
        if (origin !== null && origin.length > 0 && !isAllowedOrigin(origin, headerString(req, 'host'), allowedOrigins)) {
          throw new AppError(403, 'csrf_rejected', 'Request origin is not allowed');
        }
      }
      return;
    }
    throw new AppError(
      401,
      'unauthorized',
      'Authentication required',
      'Open NetPulse from localhost, or pass a daemon token as a Bearer header.',
    );
  };

  const issueSession: AuthHooks['issueSession'] = (req) => {
    if (!isLoopbackRequest(req.ip)) {
      throw new AppError(
        403,
        'remote_access_denied',
        'Sessions can only be issued to localhost clients',
        'Remote clients must use a daemon token.',
      );
    }
    // Desktop gate (replaces the old "any loopback caller may mint" policy):
    // without the shell-injected launch secret, no cookie is minted at all.
    if (desktopMode) {
      const header = req.headers.authorization;
      const bearer = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '').trim() : '';
      if (!bearer || !verifyToken(bearer)) {
        throw new AppError(
          403,
          'launch_secret_required',
          'Session issuance requires the per-launch secret injected by the desktop shell',
          'The desktop UI authenticates with Bearer launch secret and never needs a cookie.',
        );
      }
    }
    const refusal = sessionOriginRefusal(req, allowedOrigins);
    if (refusal) {
      throw new AppError(
        403,
        'origin_not_allowed',
        refusal,
        "Open the app's own UI, or pass a daemon token as a Bearer header.",
      );
    }
    const { value, expires } = makeSessionValue(sessionTtlMs, daemonToken);
    return { cookieName: SESSION_COOKIE, cookieValue: value, expires, ttlMs: sessionTtlMs };
  };

  return { requireAuth, issueSession, verifyToken };
}
