import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { AppError } from './util/appError';

export const SESSION_COOKIE = 'netpulse_session';

export interface AuthOptions {
  daemonToken: string;
  sessionTtlMs: number;
  allowedOrigins: string[];
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
  issueSession: (ip: string | undefined) => { cookieName: string; cookieValue: string; expires: Date; ttlMs: number };
  verifyToken: (token: string) => boolean;
}

export function createAuth(opts: AuthOptions): AuthHooks {
  const { daemonToken, sessionTtlMs, allowedOrigins } = opts;

  const verifyToken = (token: string) => safeEqual(token, daemonToken);

  const requireAuth: AuthHooks['requireAuth'] = (req) => {
    const header = req.headers.authorization;
    if (typeof header === 'string') {
      const bearer = header.replace(/^Bearer\s+/i, '').trim();
      if (bearer && verifyToken(bearer)) return;
    }
    const cookie = req.cookies[SESSION_COOKIE];
    if (cookie && verifySessionValue(cookie, daemonToken)) {
      // CSRF hardening: cookie-authenticated mutations must come from an allowed origin
      const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      if (mutating) {
        const origin = req.headers.origin;
        if (typeof origin === 'string' && origin.length > 0 && !allowedOrigins.includes(origin)) {
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

  const issueSession: AuthHooks['issueSession'] = (ip) => {
    if (!isLoopbackRequest(ip)) {
      throw new AppError(
        403,
        'remote_access_denied',
        'Sessions can only be issued to localhost clients',
        'Remote clients must use a daemon token.',
      );
    }
    const { value, expires } = makeSessionValue(sessionTtlMs, daemonToken);
    return { cookieName: SESSION_COOKIE, cookieValue: value, expires, ttlMs: sessionTtlMs };
  };

  return { requireAuth, issueSession, verifyToken };
}
