/**
 * Self-signed certificate for the SOCKS-over-TLS test, generated at test
 * runtime — the repository carries no private key.
 *
 * The old fixture was a throwaway key committed once so the test would not
 * depend on openssl being installed. Generating it here keeps that property
 * (pure node:crypto, no extra dependency, no CLI) while removing the key
 * from the repo. It protects nothing: the test suspends certificate checking
 * while it runs, because what is under test is our TLS handshake over a
 * tunnel, not trust in a certificate.
 *
 * Node can PARSE X.509 (`crypto.X509Certificate`) but cannot CREATE one, so
 * the certificate is assembled as DER by hand and self-signed with
 * RSA-SHA256. An X.509 certificate is a fixed structure — version, serial,
 * signature algorithm, issuer, validity, subject, public key, extensions —
 * and each piece below is a small DER element.
 */
import crypto from 'node:crypto';

/** DER length prefix for a body of `n` bytes (short or long form). */
const derLength = (n: number): number[] => {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  let rest = n;
  while (rest > 0) {
    bytes.unshift(rest % 256);
    rest = Math.floor(rest / 256);
  }
  return [0x80 + bytes.length, ...bytes];
};

/** One DER element: tag byte, length, concatenated body. */
const tlv = (tag: number, ...parts: number[][]): number[] => {
  const body = parts.flat();
  return [tag, ...derLength(body.length), ...body];
};

const seq = (...parts: number[][]): number[] => tlv(0x30, ...parts);

/** DER OBJECT IDENTIFIER from its dotted form (e.g. `2.5.4.3`). */
const oid = (dotted: string): number[] => {
  const arcs = dotted.split('.').map(Number);
  const body: number[] = [40 * (arcs[0] ?? 0) + (arcs[1] ?? 0)];
  for (const arc of arcs.slice(2)) {
    const chunk: number[] = [arc % 128];
    let rest = Math.floor(arc / 128);
    while (rest > 0) {
      chunk.unshift(0x80 | (rest % 128));
      rest = Math.floor(rest / 128);
    }
    body.push(...chunk);
  }
  return tlv(0x06, body);
};

/** An ASN.1 string element with ASCII content (tag byte supplied). */
const ascii = (tag: number, value: string): number[] =>
  tlv(
    tag,
    [...value].map((c) => c.charCodeAt(0)),
  );

/** DER UTCTime (`YYMMDDHHMMSSZ`) for an instant. */
const utcTime = (when: Date): number[] => {
  const p = (n: number): string => String(n).padStart(2, '0');
  return ascii(
    0x17,
    `${p(when.getUTCFullYear() % 100)}${p(when.getUTCMonth() + 1)}${p(when.getUTCDate())}` +
      `${p(when.getUTCHours())}${p(when.getUTCMinutes())}${p(when.getUTCSeconds())}Z`,
  );
};

/** An X.501 Name holding a single commonName attribute. */
const commonName = (value: string): number[] => seq(tlv(0x31, seq(oid('2.5.4.3'), ascii(0x13, value))));

// sha256WithRSAEncryption — the algorithm the signature below is actually
// produced with: crypto.sign('sha256', ...) over an RSA key.
const SIGNATURE_ALGORITHM = seq(oid('1.2.840.113549.1.1.11'), [0x05, 0x00]);

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// The public key arrives as a complete SubjectPublicKeyInfo — exactly the
// DER blob TBSCertificate wants — so it is embedded verbatim.
const subjectPublicKeyInfo: number[] = [...crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' })];

// Serial: positive and non-zero with the sign bit clear, so the INTEGER
// needs no leading padding byte.
const serial = crypto.randomBytes(16);
serial[0] = ((serial[0] ?? 0) & 0x7f) | 0x01;

// basicConstraints cA=FALSE, marked critical. With this the certificate is
// a conformant v3 one (v3 requires the extensions field) instead of a bare
// structure some parsers refuse. Value DER: an empty SEQUENCE.
const basicConstraints = seq(oid('2.5.19.19'), [0x01, 0x01, 0xff], tlv(0x04, seq()));

const issuer = commonName('127.0.0.1'); // self-signed: issuer = subject
const notBefore = new Date(Date.now() - 86_400_000); // a day of clock-skew grace
const notAfter = new Date(Date.now() + 31_536_000_000); // a year out

const toBeSigned = seq(
  tlv(0xa0, tlv(0x02, [2])), // version: v3
  tlv(0x02, [...serial]),
  SIGNATURE_ALGORITHM,
  issuer,
  seq(utcTime(notBefore), utcTime(notAfter)),
  issuer,
  subjectPublicKeyInfo,
  tlv(0xa3, seq(basicConstraints)), // [3] extensions, EXPLICIT
);

const signature = crypto.sign('sha256', Buffer.from(toBeSigned), privateKey);
const der = seq(toBeSigned, SIGNATURE_ALGORITHM, tlv(0x03, [0, ...signature]));
const body = Buffer.from(der)
  .toString('base64')
  .match(/.{1,64}/g)
  ?.join('\n');

export const cert = {
  key: privateKey,
  cert: `-----BEGIN CERTIFICATE-----\n${body ?? ''}\n-----END CERTIFICATE-----\n`,
};
