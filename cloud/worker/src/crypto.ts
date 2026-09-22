/**
 * NetPulse cloud — crypto primitives.
 *
 * Workers has no node:crypto; everything here uses WebCrypto.
 * Passwords: PBKDF2-SHA256, 210k iterations (OWASP-aligned for SHA-256),
 * 16-byte salt, constant-time digest comparison. Session/reset tokens:
 * 32 random bytes, base64url — only the SHA-256 hash is stored, so a DB
 * leak cannot mint a valid token. All hashes carry their parameters in
 * the stored string so future upgrades can rehash transparently.
 */

const enc = new TextEncoder();

/** Workers' WebCrypto refuses PBKDF2 above 100k iterations (observed live in
 *  production: "iteration counts above 100000 are not supported"), so this is
 *  the platform cap — the strongest the runtime allows. */
export const PBKDF2_ITERATIONS = 100_000;

const toB64url = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromB64url = (s: string): Uint8Array => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

const runtimeCrypto = (): Crypto => {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle) throw new Error('WebCrypto unavailable in this runtime');
  return c;
};

const subtle = (): SubtleCrypto => runtimeCrypto().subtle;

/** `pbkdf2$<iters>$<salt-b64url>$<hash-b64url>` — self-describing. */
export async function hashPassword(password: string): Promise<string> {
  const salt = runtimeCrypto().getRandomValues(new Uint8Array(16));
  const key = await subtle().importKey('raw', enc.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS }, key, 256);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toB64url(salt)}$${toB64url(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 5_000_000) return false;
  const salt = fromB64url(parts[2]);
  const expected = fromB64url(parts[3]);
  const key = await subtle().importKey('raw', enc.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, expected.length * 8);
  const actual = new Uint8Array(bits);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= actual[i]! ^ expected[i]!;
  return diff === 0;
}

export function randomToken(): string {
  return toB64url(runtimeCrypto().getRandomValues(new Uint8Array(32)));
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await subtle().digest('SHA-256', enc.encode(input) as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function newId(prefix: string): string {
  return `${prefix}_${toB64url(runtimeCrypto().getRandomValues(new Uint8Array(12)))}`;
}
