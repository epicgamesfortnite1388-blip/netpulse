# v1.1.0 — Cloud accounts, sync, and end-to-end encrypted profile backup

*Everything since v1.0.2: the app becomes a real multi-user product, without
giving up local-first operation.*

## Cloud account system

- **Accounts on Cloudflare Workers + D1** (`netpulse-cloud`): register, sign
  in, sign out, silent re-login across restarts (30-minute access tokens,
  rotating refresh tokens with reuse detection that kills the whole session
  chain), session/device roster with per-device and sign-out-everywhere
  revocation, password change. Every user-data query carries the user id
  derived from the verified session — never from the client.
- **Sync, local-first**: settings (section-wise last-write-wins), favorites,
  UI preferences, and profile metadata mirror to the cloud; offline changes
  queue and flush later; the VPN never depends on the cloud being reachable.
  Signed out or offline, everything local keeps working.
- **End-to-end encrypted profile backup** — the headline of this release.
  Full configs (with credentials) are encrypted in the app (PBKDF2-310k from
  your account password → AES-GCM-256; blobs bound to account+profile so they
  cannot be replayed elsewhere) and uploaded as opaque ciphertext the cloud
  cannot read. Restore is one click: decrypt, re-import, and the cloud backup
  follows the new profile. Devices without the key show an honest "locked"
  state with a password unlock. The cloud schema has *no plaintext field at
  all* — even a hostile client cannot stash unencrypted configs there.
- **Password reset by email** (Resend transport): single-use 30-minute
  tokens, hashed in D1, never logged — and the audit trail records the
  delivery outcome, closing the old `token:<raw>` audit leak. Without a mail
  key configured, no token is delivered anywhere (honest `mail_unconfigured`),
  and an operator-recovery path is documented.
- **Account UI**: welcome gate (sign in / create account / continue offline),
  account dashboard with profile, security, sessions, devices, sync status,
  encrypted-backup card, and a danger zone. The desktop app remains fully
  usable offline without an account.
- **Security plumbing**: the Tauri CSP now allows exactly the one Worker
  origin (found by live drive — without it the desktop could not reach the
  cloud at all); Workers-side rate limits, audit events, and consistent error
  envelopes cover every new route.

Verified against the production Worker: two-account data isolation
(cross-user reads, overwrites, session revocation, forged ids all refused),
silent re-login across an app restart, and the full encrypted roundtrip —
seal → upload → ciphertext-only at rest → decrypt → restore.

## Platform

- **Typed service graph** in the route context; the node measurement /
  scoring / view policy split into pure, unit-owned modules.
- Local update feed refinements (deflate zip writer replacing
  Compress-Archive, pipeline verification of the artifact + signature).

## Known limitations

- Email delivery is optional and currently unconfigured — reset tokens are
  issued but delivered nowhere until `RESEND_API_KEY` is set (operator
  recovery documented in `cloud/worker/README.md`).
- The installers remain self-signed pending the Azure Trusted Signing
  provisioning (`docs/AZURE_SIGNING_SETUP.md`); SmartScreen still shows the
  publisher as unverified.
- Cloud sync carries profile metadata and encrypted backups only — ping /
  packet telemetry stays local by design.
