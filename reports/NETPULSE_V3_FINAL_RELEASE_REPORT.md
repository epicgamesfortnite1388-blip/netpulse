# NetPulse V3 — Final Independent Release Report

**Release:** 3.0.0
**Date:** 2026-11-14

## Verdict

The release was built, inspected, installed over the existing 1.5.1 installation, launched, and packaged. It is **not signed** and several live workflows were not exercised. This is a usable internal release candidate, not a verified public distribution.

## Category status

| # | Question | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Source corresponds to packaged version? | PASS | All six version locations are 3.0.0; installed executable reports 3.0.0 |
| 2 | Package contains the latest production build? | PASS | Installer built after the final source edits at 16:07; installed at 16:13 |
| 3 | Executable version correct? | PASS | FileVersion/ProductVersion 3.0.0 |
| 4 | Installer works? | PASS | Silent install exit 0; registry reports 3.0.0 |
| 5 | Installed application launches? | PASS | Window created, responding; sidecar ready |
| 6 | Preserves data? | PASS | 340 MB DB and settings hash unchanged; backup verified |
| 7 | Functions without remote AI? | PARTIAL | Core is local; Copilot returns honest configuration error. Installed UI not clicked through |
| 8 | NANI works? | NOT TESTED | Only unit/integration tests; installed UI not exercised |
| 9 | Configuration gatherer works? | PARTIAL | Implemented and unit-tested; live retrieval not run |
| 10 | Security controls intact? | PASS | CSP, loopback-only sidecar, bearer auth (401), no secrets in bundle |
| 11 | Checksums correct? | PASS | `installer/SHA256SUMS.txt` generated from the packaged files |
| 12 | Release notes accurate? | PASS | Limitations documented below and in `KNOWN_LIMITATIONS.md` |
| 13 | Free of developer secrets? | PASS | No `.env`, keys, tokens found in staged backend or web dist |
| 14 | Another person can install from docs? | PASS | `INSTALLATION.md` documents the installer, per-user install and SmartScreen warning |
| 15 | Known limitations disclosed? | PASS | See `KNOWN_LIMITATIONS.md` |

## Verification totals

- Rust: 416 passed, 0 failed, 2 ignored.
- TypeScript/JS: 2034 passed, 0 failed across shared (209), API (1227), web (472), cloud worker (126).
- Web typecheck: pass.
- Desktop pipeline verification: all checks pass, including sidecar boot and auth.
- npm audit: 3 moderate, no high/critical.

## Defects fixed during delivery

1. Copilot routed to non-existent local `/ai/ask` and `/ai/usage`; route-wiring test failed. Fixed by using the authenticated cloud endpoint and removing the unused call.
2. Client device registration hard-coded app version `1.0.2`; now injected from the release version.
3. `release.mjs` did not update `Cargo.toml` on CRLF manifests; fixed.

## Remaining issues

- Artifacts are unsigned; SmartScreen will warn.
- 3 moderate npm advisories remain.
- Installed UI workflows (NANI, gatherer, cloud account) were not click-through tested.
- Graceful exit via tray Quit was not automated; close-to-tray is confirmed.
- Installer `CompanyName` metadata is blank.

## Distribution

The package exists locally at `E:\Code\Project\releases\NetPulse-V3.0.0` and has **not** been published to any release destination.
