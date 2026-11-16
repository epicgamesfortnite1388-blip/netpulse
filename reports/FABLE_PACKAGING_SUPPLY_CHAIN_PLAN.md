# FABLE — Packaging & Supply-Chain Plan (FABLE-SEC-001, BUILD-003)

## 1. Current state (verified)

- Sidecar ships as: bundled `node.exe` + `netpulse-backend.js` (esbuild/tsup output) under `src-tauri/backend/`, spawned by `sidecar.rs`.
- Engines: pinned digests (exemplary). Updater: minisign-verified (exemplary).
- Gaps: **no documented Node version pin/CVE policy** for the shipped runtime; **no enforced bundle-freshness gate** in packaging; artifact provenance exists for releases (sign-release/update-feed) but the sidecar runtime's version isn't stated in release notes.

## 2. Node runtime pin policy (target)

| Item | Decision |
|---|---|
| Supported version | Node 22 LTS (matches `engines: ">=22"`; CI installs 22; native `better-sqlite3` constraint documented in `ci.yml` — Windows 2022 runner) |
| Pin mechanism | `engines` floor stays ≥22; ADD `engines.npm`/docs note + **runtime identity check**: `prepare-desktop.mjs` records the bundled `node.exe` version into a `runtime.json` beside the bundle; CI asserts it equals the expected pin |
| Lockfile | `package-lock.json` committed (already); `npm ci` in CI (already) — keep |
| Upgrade policy | bundled Node upgrades are deliberate releases: bump → full desktop build → e2e-desktop + e2e-telegram → release notes entry. Never an incidental dep-audit bump |
| CVE thresholds | release gate: `npm audit --omit=dev` with **high+critical blocks release**; moderate → tracked issue; the bundled node.exe CVE check is a manual release-checklist item against nodejs.org advisories for the pinned line |
| Exceptions | documented in RELEASING.md per release with justification |

## 3. Bundle freshness gate (T-08 implementation contract)

In `scripts/desktop-package.mjs` (and `prepare-desktop.mjs`), before packaging:
1. Collect mtimes: all `apps/api/src/**` + `packages/shared/src/**`.
2. If any mtime > mtime of `src-tauri/backend/netpulse-backend.js` → exit 1 with remediation text (`npm run build:desktop-backend`).
3. Env override `NETPULSE_SKIP_BUNDLE_FRESHNESS=1` for exceptional CI runs; CI does NOT set it (default enforcement).
4. Test: touch one source file → packaging fails with the exact message; `scripts/*.test.mjs` pattern test.

## 4. Windows build reproducibility & provenance

- Release artifacts already signed (sign-release) + feed verified (update-feed tests). Add to the release manifest: bundled Node version + bundle SHA-256 + engine pins — one `provenance.json` per release consumed by `verify-desktop-pipeline.mjs`.
- Reproducibility scope: not bit-identical builds (NSIS/Rust non-repro realities) — provenance is **identity recording**, not reproducibility guarantee. State that honestly in RELEASING.md.

## 5. Dependency update policy

- Monthly scheduled: `npm outdated` + `npm audit` review; security bumps out-of-band.
- Never blind-upgrade: each bump runs the four suites + `cargo test` + desktop build (the CI gates already encode this — the policy formalizes which bumps are allowed without human review: none for runtime deps without a suite run).

## 6. Acceptance criteria

1. `runtime.json` produced by packaging with the bundled Node version; CI asserts freshness+identity.
2. Staleness gate demonstrably fails on a touched source (test evidence).
3. RELEASING.md contains the Node pin/CVE policy section.
4. Provenance manifest present in the next release cut (not retroactive).
5. No dependency upgraded in this phase (constraint §14).
