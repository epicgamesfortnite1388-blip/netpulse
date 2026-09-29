/**
 * NetPulse cloud — password-reset email transport.
 *
 * The reset token is a bearer credential for exactly one account, so it must
 * never appear in the audit log (that log previously carried `token:<raw>` —
 * the defect this module removes). Delivery goes through Resend's HTTP API
 * when RESEND_API_KEY is configured; without it no token is delivered anywhere
 * and the audit event records `mail_unconfigured` honestly.
 *
 * Two test seams, each single-purpose: `setMailer` swaps the transport (so
 * handler branching is testable without network), `setMailPost` captures the
 * raw HTTP call (so the real Resend request shape is testable offline).
 */
import type { Env } from './auth';

export interface MailResult {
  delivered: boolean;
  reason: string;
}

export interface ResetMailer {
  configured(env: Env): boolean;
  send(env: Env, to: string, token: string, origin: string): Promise<MailResult>;
}

type Post = (url: string, init: RequestInit) => Promise<Response>;
let post: Post = (url, init) => fetch(url, init);

/** Test seam: swap the HTTP transport used by the real Resend sender. */
export function setMailPost(p: Post | null): void {
  post = p ?? ((url, init) => fetch(url, init));
}

/** Minimal HTML entity encoder — only covers the characters that matter for
 * attribute and text content injection. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

const resendMailer: ResetMailer = {
  configured: (env) => typeof env.RESEND_API_KEY === 'string' && env.RESEND_API_KEY.length > 0,
  send: async (env, to, token, origin) => {
    const key = env.RESEND_API_KEY;
    if (!key) return { delivered: false, reason: 'mail_unconfigured' };
    const from = env.MAIL_FROM;
    if (!from) return { delivered: false, reason: 'mail_from_missing' };
    // Guard: reject attacker-controlled origins. Only send to the expected domain.
    const expected = env.EXPECTED_ORIGIN;
    if (expected && origin !== expected) {
      return { delivered: false, reason: `origin_mismatch: expected ${expected}, got ${origin}` };
    }
    // URL-encode the token so it cannot break out of the href attribute.
    const encodedToken = encodeURIComponent(token);
    const link = `${origin}/reset?token=${encodedToken}`;
    // HTML-encode the token for display inside <code> and in the link text.
    const htmlToken = escapeHtml(token);
    const html =
      `<p>A password reset was requested for your NetPulse account.</p>` +
      `<p><a href="${link}">Reset your password</a> (valid for 30 minutes), ` +
      `or enter this code on the reset page: <code>${htmlToken}</code></p>` +
      `<p>If you did not request this, ignore this email — your password is unchanged.</p>`;
    try {
      const res = await post('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject: 'NetPulse password reset', html }),
      });
      return res.ok ? { delivered: true, reason: 'mail_sent' } : { delivered: false, reason: `mail_http_${res.status}` };
    } catch {
      return { delivered: false, reason: 'mail_error' };
    }
  },
};

let mailer: ResetMailer = resendMailer;

/** Test seam: swap the whole transport (pass null to restore the Resend one). */
export function setMailer(m: ResetMailer | null): void {
  mailer = m ?? resendMailer;
}

export function mailConfigured(env: Env): boolean {
  return mailer.configured(env);
}

export async function sendResetEmail(env: Env, to: string, token: string, origin: string): Promise<MailResult> {
  return mailer.send(env, to, token, origin);
}
