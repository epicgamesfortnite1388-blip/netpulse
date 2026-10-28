import crypto from 'node:crypto';

/**
 * Signature trust for adaptive policy updates.
 *
 * The same trust model as the release feed — an offline private key, a public key
 * pinned in the build, a key id, expiry and revocation — applied to raw Ed25519
 * detached signatures instead of minisign text.
 *
 * Why not reuse `scripts/lib/minisign.mjs`: that module is the *publishing* side
 * of the installer channel and lives outside this TypeScript project; the check
 * here has to run inside the sidecar bundle on the user's machine. What must not
 * drift is the trust model, not the file format, and the model is asserted by
 * tests that sign real payloads with a real key and tamper with them.
 *
 * A build with no configured key has NO trust anchor, and this module then
 * returns a verifier that refuses everything — the honest direction: an
 * unverifiable update is not an update.
 */

/** The 12-byte SPKI DER prefix that turns a raw 32-byte Ed25519 key into a key object. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export type SignatureVerifier = (message: string, signatureBase64: string) => boolean;

/** Base64 raw (32 bytes) or SPKI PEM → a Node KeyObject, or null when unusable. */
export function parseEd25519PublicKey(value: string): crypto.KeyObject | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  try {
    if (trimmed.includes('-----BEGIN')) {
      const key = crypto.createPublicKey(trimmed);
      return key.asymmetricKeyType === 'ed25519' ? key : null;
    }
    const raw = Buffer.from(trimmed, 'base64');
    if (raw.length !== 32) return null;
    return crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

/**
 * Build the verifier injected into the adaptive engine.
 *
 * Returns `null` when no usable key is configured, so the caller can report
 * "no trust anchor" rather than silently accepting anything.
 */
export function createEd25519Verifier(publicKey: string | undefined): SignatureVerifier | null {
  if (!publicKey) return null;
  const key = parseEd25519PublicKey(publicKey);
  if (!key) return null;

  return (message: string, signatureBase64: string): boolean => {
    try {
      const signature = Buffer.from(signatureBase64, 'base64');
      if (signature.length !== 64) return false;
      // Ed25519 in Node takes the algorithm as null.
      return crypto.verify(null, Buffer.from(message, 'utf8'), key, signature);
    } catch {
      return false;
    }
  };
}

/**
 * Sign a payload the way the publisher does. Kept here (not in a script) so the
 * test that proves verification is not writing its own signer: the publishing
 * and verifying halves share one implementation.
 */
export function signAdaptivePayload(message: string, privateKey: crypto.KeyObject | string): string {
  const key = typeof privateKey === 'string' ? crypto.createPrivateKey(privateKey) : privateKey;
  return crypto.sign(null, Buffer.from(message, 'utf8'), key).toString('base64');
}

/** Generate a fresh keypair for tests and local publishing. */
export function generatePolicyKeyPair(): { publicKeyBase64: string; privateKey: crypto.KeyObject } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  // Strip the fixed SPKI prefix so the stored value is the raw key a publisher
  // can hand out without PEM formatting.
  return { publicKeyBase64: Buffer.from(der.subarray(ED25519_SPKI_PREFIX.length)).toString('base64'), privateKey };
}
