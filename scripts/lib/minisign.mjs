/**
 * Minisign verification — the check the Tauri updater itself performs.
 *
 * The update feed's trust anchor is a minisign signature: the app downloads an
 * artifact, verifies it against the public key baked into `tauri.conf.json`,
 * and only then runs the installer. This module is the same verification on the
 * publishing side, so a release cannot advertise an artifact the app would
 * refuse — and, more importantly, cannot advertise one whose signature is
 * broken in a way only the app would discover.
 *
 * It mirrors `minisign-verify` 0.2.5 (the crate `tauri-plugin-updater` calls)
 * exactly, including the part that is easy to miss:
 *
 *   1. the key id embedded in the signature must match the public key's;
 *   2. prehashed signatures ("ED") sign BLAKE2b-512(content), legacy ones
 *      ("Ed") sign the content itself;
 *   3. a SECOND signature must verify over `signature || trusted-comment`
 *      (the comment text only, without its "trusted comment: " prefix).
 *
 * Skipping (3) is the tempting shortcut and it is a real hole: it accepts a
 * signature file whose trusted comment was edited after signing.
 */

import crypto from 'node:crypto';

/** The 12-byte SPKI DER prefix for an Ed25519 public key, so a raw 32-byte key
 *  can be handed to Node's verifier. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export class MinisignError extends Error {}

const lines = (text) => String(text ?? '').split(/\r?\n/);

/**
 * Both encodings exist in the wild and both must be accepted:
 *
 *   - the raw text, as `minisign` itself writes it
 *     (`untrusted comment: …` / base64 / `trusted comment: …` / base64), and
 *   - base64 OF that text, which is what the Tauri CLI writes to `<artifact>.sig`
 *     and `<key>.pub` — and therefore also what `plugins.updater.pubkey` and
 *     latest.json's `signature` field carry, since the plugin base64-decodes
 *     the field before parsing it.
 *
 * Treating either as the other is a silent-publish bug: a double-encoded
 * manifest is rejected by every client, and a raw `.sig` read as encoded fails
 * to parse.
 */
export function toMinisignText(value, what = 'value') {
  const text = String(value ?? '').trim();
  if (!text) throw new MinisignError(`${what}: empty`);
  if (text.startsWith('untrusted comment:')) return text;
  const decoded = Buffer.from(text, 'base64').toString('utf8');
  if (!decoded.trim()) throw new MinisignError(`${what}: not a minisign document (base64 decoded to nothing)`);
  return decoded.trim();
}

/** The base64 form — what belongs in a `pubkey` or `signature` field. */
export function toMinisignField(value, what = 'value') {
  return Buffer.from(toMinisignText(value, what), 'utf8').toString('base64');
}

function decodeBase64(text, what) {
  const buf = Buffer.from(String(text).trim(), 'base64');
  if (buf.length === 0) throw new MinisignError(`${what}: empty base64 payload`);
  return buf;
}

/** A public key in `minisign.pub` format (untrusted comment line + base64). */
export function decodePublicKey(text) {
  const l = lines(toMinisignText(text, 'public key'));
  const payload = decodeBase64(l[1] ?? '', 'public key');
  if (payload.length !== 42) {
    throw new MinisignError(`public key: expected 42 bytes, got ${payload.length}`);
  }
  const alg = payload.subarray(0, 2).toString('latin1');
  if (alg !== 'Ed' && alg !== 'ED') throw new MinisignError(`public key: unsupported algorithm ${JSON.stringify(alg)}`);
  return { keyId: payload.subarray(2, 10).toString('hex'), key: payload.subarray(10, 42) };
}

/** A signature in minisign format (comment, sig, trusted comment, global). */
export function decodeSignature(text) {
  const l = lines(toMinisignText(text, 'signature'));
  const payload = decodeBase64(l[1] ?? '', 'signature');
  if (payload.length !== 74) {
    throw new MinisignError(`signature: expected 74 bytes, got ${payload.length}`);
  }
  const alg = payload.subarray(0, 2).toString('latin1');
  if (alg !== 'Ed' && alg !== 'ED') throw new MinisignError(`signature: unsupported algorithm ${JSON.stringify(alg)}`);

  const trustedLine = l[2] ?? '';
  if (!trustedLine.startsWith('trusted comment: ')) {
    throw new MinisignError('signature: missing "trusted comment:" line');
  }
  const global = decodeBase64(l[3] ?? '', 'global signature');
  if (global.length !== 64) throw new MinisignError(`signature: expected a 64-byte global signature, got ${global.length}`);

  return {
    keyId: payload.subarray(2, 10).toString('hex'),
    signature: payload.subarray(10, 74),
    prehashed: alg === 'ED',
    // The global signature covers the comment AFTER the prefix (minisign-verify
    // slices `trusted_comment[17..]`).
    trustedComment: trustedLine.slice('trusted comment: '.length),
    globalSignature: global,
  };
}

/**
 * Is a secret key password-protected?
 *
 * minisign's secret key payload is `[2 sig-alg][2 kdf-alg][32 kdf-params]…`;
 * an unencrypted key leaves the kdf fields zeroed, while the Tauri CLI writes
 * `Sc` (scrypt) with real parameters when a password was supplied. This matters
 * to a build: signing with an encrypted key and no password makes the signer
 * PROMPT, and a prompt inside a pipeline hangs until something times out.
 * Detecting it up front turns a hang into a one-line, actionable failure.
 */
export function isEncryptedSecretKey(keyFileContent) {
  let text = String(keyFileContent ?? '').trim();
  if (!text) return false;
  if (!text.startsWith('untrusted comment:')) text = Buffer.from(text, 'base64').toString('utf8');
  const payload = lines(text)[1] ?? '';
  let bin;
  try {
    bin = Buffer.from(payload, 'base64');
  } catch {
    return false;
  }
  if (bin.length < 36) return false;
  return bin.subarray(4, 36).some((b) => b !== 0);
}

/**
 * Verify `content` against a minisign signature.
 *
 * @param {Buffer|string} content   the artifact bytes
 * @param {string} signatureText    the `.sig` file's text
 * @param {string} publicKeyText    the `minisign.pub` file's text
 * @returns {{ ok: true, prehashed: boolean, keyId: string } | { ok: false, reason: string }}
 */
export function verifyMinisign(content, signatureText, publicKeyText) {
  let key;
  let sig;
  try {
    key = decodePublicKey(publicKeyText);
    sig = decodeSignature(signatureText);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  if (key.keyId !== sig.keyId) {
    return {
      ok: false,
      reason: `key id mismatch — the signature was made by a different key (signature ${sig.keyId}, trusted key ${key.keyId})`,
    };
  }

  const keyObject = crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, key.key]),
    format: 'der',
    type: 'spki',
  });

  const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const signed = sig.prehashed ? crypto.createHash('blake2b512').update(data).digest() : data;

  let signedOk = false;
  try {
    signedOk = crypto.verify(null, signed, keyObject, sig.signature);
  } catch (err) {
    return { ok: false, reason: `signature check failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!signedOk) {
    return {
      ok: false,
      reason: sig.prehashed
        ? 'artifact does not match its signature (content hash mismatch) — the file was modified after signing'
        : 'artifact does not match its legacy signature',
    };
  }

  const global = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, 'utf8')]);
  let globalOk = false;
  try {
    globalOk = crypto.verify(null, global, keyObject, sig.globalSignature);
  } catch (err) {
    return { ok: false, reason: `global signature check failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!globalOk) {
    return { ok: false, reason: 'the trusted comment does not match its global signature — the signature file was edited' };
  }

  return { ok: true, prehashed: sig.prehashed, keyId: sig.keyId };
}
