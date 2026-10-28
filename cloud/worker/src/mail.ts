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

/**
 * Provider-side rejection detail for the audit log. Resend answers failures
 * with `{ name, message }`; without it the audit only ever says
 * `mail_http_422`, which cannot distinguish a bad sender from a bad recipient
 * (this incident: an unverified `MAIL_FROM` domain read as a bare 422). The
 * message never contains the API key or the reset token, and the result is
 * flattened to one bounded line because the audit trail is line-oriented.
 */
async function resendFailureDetail(res: Response): Promise<string> {
  let detail = `mail_http_${res.status}`;
  try {
    const body = (await res.json()) as { name?: unknown; message?: unknown };
    const name = typeof body?.name === 'string' ? body.name.slice(0, 40) : '';
    const msg = typeof body?.message === 'string' ? body.message.slice(0, 160) : '';
    if (name || msg) detail += `:${name}${name && msg ? '/' : ''}${msg}`;
  } catch {
    // Non-JSON error body: the HTTP status is the whole signal.
  }
  return detail.replace(/[\r\n]+/g, ' ').slice(0, 240);
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
      return { delivered: false, reason: 'origin_mismatch' };
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
      if (res.ok) return { delivered: true, reason: 'mail_sent' };
      return { delivered: false, reason: await resendFailureDetail(res) };
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
