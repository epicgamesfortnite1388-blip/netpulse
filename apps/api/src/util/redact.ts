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
