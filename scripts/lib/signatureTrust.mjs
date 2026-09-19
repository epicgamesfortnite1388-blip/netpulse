/**
 * What an Authenticode signature actually MEANS — one owner, because both the
 * signer and the release gate must agree, and because "signed" is not the same
 * as "Windows will trust it".
 *
 * The distinction that matters to a user: SmartScreen decides on the trust
 * chain of the signing certificate, not on whether a signature is present.
 *
 *   trusted        — the chain ends in a root the OS trust provider knows
 *                    (CA-issued OV/EV, or Azure Trusted Signing). This is the
 *                    only class that can earn SmartScreen reputation.
 *   selfsigned     — cryptographically intact, but the signer IS its own root
 *                    and that root is not distributed. Windows reports this as
 *                    `UnknownError` / `NotTrusted` ("chain terminated in a root
 *                    certificate which is not trusted"); SmartScreen warns.
 *   untrusted-root — signed by a real CA, but the root is not in the trust
 *                    store (private CA, or a missing intermediate).
 *   bad            — a present-but-broken signature (tampered file, bad digest).
 *   missing        — no signature at all (Windows shows "Unknown publisher").
 *
 * Windows PowerShell 5.1 does not surface CRYPT_E_UNTRUSTEDROOT as its own
 * `Status` value — it collapses to `UnknownError`, which is why the message text
 * is what disambiguates a self-signed-but-intact signature from a broken one.
 */

/** How Windows/SmartScreen treats this signature. */
export const TRUST_LEVELS = ['trusted', 'selfsigned', 'untrusted-root', 'bad', 'missing'];

/**
 * Classify one signature observation.
 *
 * @param {{ status?: string|null, statusMessage?: string|null, subject?: string|null, issuer?: string|null }} sig
 * @returns {{ level: string, trusted: boolean, smartScreen: 'ok'|'warns', reason: string }}
 */
export function classifySignature(sig) {
  const status = String(sig?.status ?? '').trim();
  const message = String(sig?.statusMessage ?? '').trim();
  const subject = String(sig?.subject ?? '').trim();
  const issuer = String(sig?.issuer ?? '').trim();

  if (!status || status === 'NotSigned' || !subject) {
    return {
      level: 'missing',
      trusted: false,
      smartScreen: 'warns',
      reason: 'no Authenticode signature — Windows shows "Unknown publisher" and SmartScreen warns',
    };
  }

  // A signer that is its own issuer IS the root; unless it was deliberately
  // trusted on this machine, no other machine will accept it. Compared
  // case/space-insensitively because the two strings are rendered separately.
  const norm = (s) => s.replace(/\s+/g, '').toLowerCase();
  const selfSigned = subject.length > 0 && issuer.length > 0 && norm(subject) === norm(issuer);
  if (selfSigned) {
    return {
      level: 'selfsigned',
      trusted: false,
      smartScreen: 'warns',
      reason:
        'self-signed certificate (the signer is its own root) — the signature and timestamp are intact, but SmartScreen warns on every machine that has not explicitly trusted this root',
    };
  }

  if (status === 'Valid') {
    return { level: 'trusted', trusted: true, smartScreen: 'ok', reason: `trusted chain ending in a root the OS trusts (issuer: ${issuer})` };
  }

  if (/not trusted by the trust provider|root certificate which is not trusted|CRYPT_E_UNTRUSTEDROOT/i.test(message)) {
    return {
      level: 'untrusted-root',
      trusted: false,
      smartScreen: 'warns',
      reason: `the chain is intact but its root is not trusted here (issuer: ${issuer || 'unknown'}) — SmartScreen warns on machines without that root`,
    };
  }

  return {
    level: 'bad',
    trusted: false,
    smartScreen: 'warns',
    reason: `signature is not valid (Windows status ${status}${message ? `: ${message}` : ''}) — the artifact is not safely publishable`,
  };
}

/** Parse one `verify: <file> status=<Status> class=<...>` line from the signer. */
export function parseVerifyLine(line) {
  const m = /^verify: (.+) status=(\w+) class=(\w+)/.exec(String(line ?? '').trim());
  if (!m) return null;
  return { file: m[1], status: m[2], level: m[3] };
}

/**
 * One-line, user-facing statement of what will happen in Windows when this
 * build is downloaded — the sentence the release report must carry.
 */
export function smartScreenReport(level) {
  switch (level) {
    case 'trusted':
      return 'SmartScreen: the publisher chain is trusted — warnings can clear as publisher reputation accrues.';
    case 'selfsigned':
      return 'SmartScreen: WILL warn on every machine ("certificate chain terminated in a root certificate which is not trusted"). A CA-issued or Azure Trusted Signing certificate is required to change this.';
    case 'untrusted-root':
      return 'SmartScreen: WILL warn — the signing root is not trusted by the Windows trust provider.';
    case 'missing':
      return 'SmartScreen: WILL warn with "Unknown publisher" — the artifact is unsigned.';
    default:
      return 'SmartScreen: WILL warn — the signature is broken.';
  }
}

/**
 * Route names for the signer, so a report says HOW an artifact was signed.
 * `store` / `pfx` need a certificate the user supplies; `azure-trusted-signing`
 * is the supported route that does not require a hardware token (§ post-2023
 * OV/EV keys must live in FIPS 140-2 L2 hardware).
 */
export const SIGNING_ROUTES = ['store-thumbprint', 'pfx', 'azure-trusted-signing'];
