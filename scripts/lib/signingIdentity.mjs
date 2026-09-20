/**
 * Signing-identity resolution — ONE owner, because three callers must agree on
 * what "we have a signing cert" means: `sign-release.mjs` (signs artifacts),
 * `package-signed.mjs` (resolves once for its child signers + makensis env) and
 * `sign-uninstall.ps1` (re-signs the NSIS-generated uninstaller, reading the
 * resolved values out of its environment).
 *
 * Routes, first match wins:
 *   store-thumbprint        a certificate already in Cert:\CurrentUser\My
 *   azure-trusted-signing   Azure Trusted Signing via signtool (no hardware token)
 *   pfx                     a PFX file (CA-issued or self-signed) + password
 *
 * The two failure kinds are deliberately separate: NOTHING CONFIGURED returns
 * `{ route: null }` (a machine without a cert may still build unsigned), while a
 * CONFIGURED BUT UNUSABLE route throws — a broken Azure profile must never read
 * as "no cert here, shipping unsigned".
 *
 * Post-June-2023 a purchased OV/EV key must live in FIPS 140-2 Level 2 hardware,
 * which is why the token-free purchase routes are Azure Trusted Signing and a
 * cloud HSM — not a downloadable PFX from a public CA.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Signals "cannot sign, and here is why" with the lines a user needs to read. */
export class SigningIdentityError extends Error {
  constructor(message, hints = [], code = 2) {
    super(message);
    this.name = 'SigningIdentityError';
    this.hints = hints;
    this.code = code;
  }
}

export const NO_IDENTITY_HINTS = [
  'Provide one of:',
  '  NETPULSE_SIGN_THUMBPRINT        a CA-issued cert already in Cert:\\CurrentUser\\My',
  '  NETPULSE_SIGN_AZURE_DLIB        Azure Trusted Signing (no hardware token needed)',
  '  NETPULSE_SIGN_PFX(+_PASSWORD)   any PFX, CA-issued or self-signed',
  'A self-signed cert cannot stop SmartScreen from warning — see RELEASING.md "Code signing".',
];

/** signtool ships with the Windows SDK; the Azure Trusted Signing dlib signs through it. */
export function findSigntool(env = process.env) {
  if (env.NETPULSE_SIGNTOOL && fs.existsSync(env.NETPULSE_SIGNTOOL)) return env.NETPULSE_SIGNTOOL;
  const found = [];
  // Per-user install (no elevation): the repo's documented NuGet layout —
  // RELEASING.md "Code signing" — drops signtool here.
  if (env.LOCALAPPDATA) {
    const perUser = path.join(env.LOCALAPPDATA, 'NetPulse', 'signing', 'signtool-x64', 'signtool.exe');
    if (fs.existsSync(perUser)) found.push(perUser);
  }
  for (const root of [env['ProgramFiles(x86)'], env['ProgramFiles']].filter(Boolean)) {
    const base = path.join(root, 'Windows Kits', '10', 'bin');
    if (!fs.existsSync(base)) continue;
    for (const version of fs.readdirSync(base)) {
      for (const arch of ['x64', 'x86']) {
        const exe = path.join(base, version, arch, 'signtool.exe');
        if (fs.existsSync(exe)) found.push(exe);
      }
    }
  }
  // Newest SDK wins when several are installed (per-user entry sorts first —
  // there is at most one).
  found.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return found[0] ?? null;
}

/**
 * Resolve the signing identity from an environment.
 *
 * @returns {{ route: string|null, env: Record<string,string> }} `route` is null when
 *   nothing is configured; `env` is a copy with everything the signers need
 *   already resolved (PFX password read, signtool located, Azure metadata
 *   materialized, `NETPULSE_SIGN_AZURE_*` filled in).
 * @throws {SigningIdentityError} when a route IS configured but unusable.
 */
export function resolveSigningIdentity({ env = process.env, repoRoot = process.cwd(), log = () => {} } = {}) {
  const out = { ...env };

  if (out.NETPULSE_SIGN_THUMBPRINT) {
    log('sign-release: identity route store-thumbprint');
    return { route: 'store-thumbprint', env: out };
  }

  if (out.NETPULSE_SIGN_AZURE_DLIB) {
    const dlib = path.resolve(out.NETPULSE_SIGN_AZURE_DLIB);
    if (!fs.existsSync(dlib)) {
      throw new SigningIdentityError(`Azure Trusted Signing dlib not found: ${dlib}`, [
        'Install the Trusted Signing client tools (Azure.CodeSigning.Dlib.dll) and point NETPULSE_SIGN_AZURE_DLIB at it.',
      ]);
    }
    const signtool = findSigntool(out);
    if (!signtool) {
      throw new SigningIdentityError('signtool.exe not found (Windows SDK) — Azure Trusted Signing signs through it.', [
        'Install the Windows SDK, or set NETPULSE_SIGNTOOL to an existing signtool.exe.',
      ]);
    }
    out.NETPULSE_SIGNTOOL = signtool;
    out.NETPULSE_SIGN_AZURE_DLIB = dlib;

    if (out.NETPULSE_SIGN_AZURE_METADATA) {
      const metadata = path.resolve(out.NETPULSE_SIGN_AZURE_METADATA);
      if (!fs.existsSync(metadata)) throw new SigningIdentityError(`Azure signing metadata not found: ${metadata}`);
      out.NETPULSE_SIGN_AZURE_METADATA = metadata;
    } else {
      // Generate the metadata from the four values the Azure resource defines,
      // so the profile is configuration rather than a file to hand-write.
      const needed = {
        NETPULSE_SIGN_AZURE_ENDPOINT: 'e.g. https://eus.codesigning.azure.net/',
        NETPULSE_SIGN_AZURE_ACCOUNT: 'the Trusted Signing account name',
        NETPULSE_SIGN_AZURE_PROFILE: 'the certificate profile name',
        NETPULSE_SIGN_AZURE_CERTIFICATE: 'the certificate name inside the profile',
      };
      const missing = Object.keys(needed).filter((k) => !out[k]);
      if (missing.length) {
        throw new SigningIdentityError('Azure Trusted Signing needs either NETPULSE_SIGN_AZURE_METADATA, or all four:', [
          ...Object.entries(needed).map(([k, what]) => `  ${k} — ${what}`),
          `Missing: ${missing.join(', ')}`,
        ]);
      }
      const metadata = path.join(os.tmpdir(), `np-azure-signing-${process.pid}-${Date.now()}.json`);
      fs.writeFileSync(
        metadata,
        JSON.stringify(
          {
            Endpoint: out.NETPULSE_SIGN_AZURE_ENDPOINT,
            CodeSigningAccountName: out.NETPULSE_SIGN_AZURE_ACCOUNT,
            CertificateProfileName: out.NETPULSE_SIGN_AZURE_PROFILE,
            CertificateName: out.NETPULSE_SIGN_AZURE_CERTIFICATE,
            ExcludeCredentials: [],
          },
          null,
          2,
        ),
        'utf8',
      );
      out.NETPULSE_SIGN_AZURE_METADATA = metadata;
    }

    log(`sign-release: identity route azure-trusted-signing (profile "${out.NETPULSE_SIGN_AZURE_PROFILE ?? 'from metadata'}")`);
    log(`sign-release: signtool ${out.NETPULSE_SIGNTOOL}`);
    return { route: 'azure-trusted-signing', env: out };
  }

  const pfx = out.NETPULSE_SIGN_PFX ?? path.join(repoRoot, 'certs', 'netpulse-release.pfx');
  if (fs.existsSync(pfx)) {
    out.NETPULSE_SIGN_PFX = pfx;
    if (!out.NETPULSE_SIGN_PFX_PASSWORD) {
      const pwFile = out.NETPULSE_SIGN_PW_FILE ?? path.join(os.homedir(), '.netpulse-signing-pw');
      if (!fs.existsSync(pwFile)) {
        throw new SigningIdentityError(`PFX found (${pfx}) but no password.`, [
          'Set NETPULSE_SIGN_PFX_PASSWORD, or NETPULSE_SIGN_THUMBPRINT for a store cert.',
        ]);
      }
      out.NETPULSE_SIGN_PFX_PASSWORD = fs.readFileSync(pwFile, 'ascii').trim();
    }
    log('sign-release: identity route pfx');
    return { route: 'pfx', env: out };
  }

  // Nothing configured at all — the caller decides whether that is acceptable.
  return { route: null, env: out };
}

/**
 * The signtool argv that signs one file through Azure Trusted Signing.
 * Shared so the artifact signer and the NSIS uninstaller helper sign identically.
 */
export function azureSignArgs(file, env) {
  return [
    'sign',
    '/v',
    '/fd',
    'SHA256',
    '/tr',
    'http://timestamp.digicert.com',
    '/td',
    'SHA256',
    '/dlib',
    env.NETPULSE_SIGN_AZURE_DLIB,
    '/dmdf',
    env.NETPULSE_SIGN_AZURE_METADATA,
    file,
  ];
}
