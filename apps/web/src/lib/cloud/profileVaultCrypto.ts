/**
 * E2E encrypted profile backup — client-side crypto.
 *
 * Threat model: the cloud (D1, Worker logs, backups) must never see a VPN
 * config or credential in the clear. Everything here runs in the webview:
 *  - Key: PBKDF2-SHA256(account password, per-user salt, 310k) -> AES-GCM
 *    256. The salt is public (stored as an ordinary cloud preference); the
 *    password never leaves the webview.
 *  - Blob: `v1.<iv>.<ciphertext>`, base64, AES-GCM with additionalData =
 *    "<userId>:<profileId>" — a blob copied to another profile or another
 *    account fails authentication instead of decrypting to garbage.
 *  - Key cache: the derived raw key is kept in localStorage so the silent
 *    refresh path (app restart without a password entry) can still sync.
 *    Local storage is the same trust boundary that already holds the
 *    session refresh token; a local attacker there owns the machine's vault
 *    file anyway.
 */

export class VaultCryptoError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'VaultCryptoError';
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const PBKDF2_ITERATIONS = 310_000;

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** ArrayBuffer-backed view — WebCrypto's BufferSource rejects SharedArrayBuffer-backed arrays. */
function buf(u: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(u.length));
  out.set(u);
  return out;
}

function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Fresh per-account salt for the PBKDF2 derivation (public — not secret). */
export function randomSaltB64(): string {
  return toB64(crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16))));
}

/** Raw 256-bit key material from the account password + salt. */
export async function deriveRawKey(password: string, saltB64: string): Promise<Uint8Array<ArrayBuffer>> {
  const base = await crypto.subtle.importKey('raw', buf(enc.encode(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromB64(saltB64), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base,
    256,
  );
  return new Uint8Array(bits);
}

export async function importRawKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', buf(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptProfileBlob(key: CryptoKey, userId: string, profileId: string, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: buf(enc.encode(`${userId}:${profileId}`)) },
    key,
    buf(enc.encode(plaintext)),
  );
  return `v1.${toB64(iv)}.${toB64(new Uint8Array(ct))}`;
}

export async function decryptProfileBlob(key: CryptoKey, userId: string, profileId: string, blob: string): Promise<string> {
  const [tag, ivB64, ctB64] = blob.split('.');
  if (!ivB64 || !ctB64 || tag !== 'v1') throw new VaultCryptoError('bad_blob', 'Unrecognized vault blob format');
  try {
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(ivB64), additionalData: buf(enc.encode(`${userId}:${profileId}`)) },
      key,
      fromB64(ctB64),
    );
    return dec.decode(pt);
  } catch {
    throw new VaultCryptoError('decrypt_failed', 'Wrong password or corrupted blob');
  }
}
