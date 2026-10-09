/**
 * Redact credential material from error strings before they are persisted to
 * the database, events, or shown in the UI. Cores occasionally echo config
 * lines (or fragments) into startup errors; these patterns cover the common
 * secret shapes found in V2Ray/Xray/sing-box configs:
 *
 *   - UUIDs (vmess/vless id)
 *   - long base64/hex blobs (passwords, keys, Reality privates)
 *   - explicit key=value shapes (id=, uuid=, password=, key=, psk=)
 *
 * The goal is defense-in-depth on the ERROR path — configs themselves are
 * never logged, and secret fields are stored only in the encrypted vault.
 */

import { createHash } from 'node:crypto';

const PATTERNS: RegExp[] = [
  // bare UUIDs
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
  // key=value secret shapes (value ≥ 8 chars)
  /\b(id|uuid|password|passwd|psk|key|privateKey|private_key|secret|token)s?\s*[=:]\s*["']?[^\s"',;]{8,}/gi,
  // long base64-ish runs (≥24 chars of base64 alphabet) — Reality keys, ss passwords
  /\b[A-Za-z0-9+/=_-]{24,}\b/g,
];

/** Replace credential-looking substrings with a marker. Bounded to 512 chars output. */
export function redactSecrets(text: string): string {
  let out = text.slice(0, 1024);
  for (const re of PATTERNS) out = out.replace(re, '[REDACTED]');
  return out.slice(0, 512);
}

/* ------------------------------ source URLs ------------------------------- */

/**
 * A subscription URL IS the configuration: fetch it outside the app and you hold
 * every node's credential. So a stored source URL must never reach a client in
 * the clear — not even for the user who typed it, because the whole point is
 * that nobody can copy the config out.
 *
 * This is the server's answer, not the UI's. Masking the string in a component
 * would leave `GET /api/v1/sources` handing the real thing to anyone who opens
 * the webview console, which is the same non-fix as hiding the button.
 *
 * The mask keeps what identifies a source and drops what fetches one:
 *   - the registrable domain stays, so the user recognises their provider;
 *   - the subdomain is collapsed to `•••`, because panels put the token there
 *     (`https://k7f2ab.my-panel.com/sub`) and a leftmost label is often the
 *     secret rather than a label;
 *   - userinfo, path, query and fragment are dropped entirely;
 *   - an 8-hex digest of the real URL is appended so two URLs on one domain can
 *     still be told apart, and so a user can confirm "this is the one I added".
 *
 * Structural, not pattern-based, on purpose: `redactSecrets` hopes to catch a
 * secret in a blob of text, whereas this parses the URL and keeps only fields
 * that are public by construction.
 */
export function maskSourceUrl(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';

  const fingerprint = createHash('sha256').update(trimmed).digest('hex').slice(0, 8);

  let url: URL;
  try {
    // Registry entries are occasionally stored without a scheme; parse them as
    // https rather than falling through to the opaque branch.
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    // Unparseable: show nothing but the fingerprint, which still lets the user
    // tell two broken entries apart.
    return `•••••• · ${fingerprint}`;
  }

  const scheme = url.protocol.replace(/:$/, '');
  const port = url.port ? `:${url.port}` : '';
  // An IP (or bracketed IPv6) host cannot be a token, so it is shown in full —
  // it is the only thing that identifies a self-hosted source.
  const host = /^\[.*\]$/.test(url.hostname) || /^[\d.]+$/.test(url.hostname) ? url.hostname : registrableDomain(url.hostname);

  const path = url.pathname && url.pathname !== '/' ? '/…' : '';
  return `${scheme}://${host}${port}${path} · ${fingerprint}`;
}

/**
 * The last two labels of a hostname: `a.b.example.com` -> `example.com`.
 * Enough to recognise the provider, not enough to be the credential.
 */
function registrableDomain(hostname: string): string {
  const labels = hostname.split('.');
  if (labels.length <= 2) return hostname;
  return ['•••', ...labels.slice(-2)].join('.');
}
