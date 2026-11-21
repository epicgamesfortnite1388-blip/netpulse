# 10 — Build, Release and Update Audit

Evidence: `scripts/desktop-package.mjs`, `scripts/release.mjs`, `scripts/prepare-desktop.mjs`, `scripts/audit-ci.sh`, `.github/workflows/ci.yml`, `scripts/update-feed.mjs`, `src-tauri/src/updater_feed.rs`, `src-tauri/tauri.conf.json`, `package.json`, plus the new `scripts/build-gate-honesty.test.mjs`.

## Version consistency

| File | Version | Synced? |
|---|---|---|
| `package.json:4` | 3.2.0 | canonical |
| `src-tauri/Cargo.toml:[package]` | 3.2.0 | yes (`release.mjs`) |
| `src-tauri/tauri.conf.json` | 3.2.0 | yes |
| `cloud/worker/package.json` | 1.0.2 | **not synced** (DD-052, P4; worker versioned independently) |

`node scripts/release.mjs` was run this cycle: it reported only the canonical version and produced no unintended file changes.

## Release-gate defects found and repaired

| ID | Defect | Fix | Verification |
|---|---|---|---|
| DD-001 (P2) | `desktop-package.mjs` invoked `update-feed.mjs --optional` with no env override, so a release could complete with a `.zip` but no `.sig`/`latest.json` | release:feed step now sets `NETPULSE_REQUIRE_UPDATER_FEED: '1'`; `update-feed.mjs:65` honors it and exits 1 | `test:build-gates` 10/10; source assertion |
| DD-002 (P2) | CI ran none of test:release, test:signing, test:pipeline, desktop:verify, e2e-desktop | Added signing/release/pipeline/build-gates steps to the `gates` job | All four pass locally (`probe-release-gates.log`: 0/0/0; build-gates 10/10). `desktop:verify`/`e2e` still require a staged sidecar and remain local pre-release gates; documented. |
| DD-003 (P2) | `prepare-desktop.mjs` downgraded portable-node bundling failure to `console.warn` | Now exits non-zero unless `NETPULSE_ALLOW_SYSTEM_NODE_FALLBACK=1` | source assertion + visual review |
| DD-004 (P3) | `audit-ci.sh` printed PASS for ts-prune gates that can never fail | Kim corrected my first fix (`--error` made the gate permanently red): now labeled `ADVISORY (non-gating)` honestly | `test:build-gates` 10/10 pins advisory labeling |
| DD-005 (P3) | Cargo version regex no-op and updater endpoint stamping failure were warn-only | Both now error and exit 1; version check scoped to `[package]` block after Kim P3 | `node scripts/release.mjs` PASS; `test:build-gates` 10/10 |
| DD-050/051 (P4) | `e2e-desktop.mjs` disjunctive status assertions; `verify-desktop-pipeline.mjs` docstring claims freshness but checks existence | Documented OPEN (no installer/sidecar in this environment to safely promote these gates) | code evidence |

## Update integrity

`src-tauri/tauri.conf.json:58-63` pins a minisign public key; `scripts/lib/minisign.mjs:141` verifies key-id, prehash and trusted comment; `scripts/update-feed.mjs:258-264` verifies on publish; `src-tauri/src/updater_feed.rs:145-150` verifies before install. The `dangerousInsecureTransportProtocol: true` flag is currently scoped to a loopback endpoint, so exploitation requires a local attacker who can also bind the fixed feed port; a forged artifact still fails signature verification (DD-008, P4).

## Exit-code propagation

Correct in `desktop-package.mjs:81-88`, `verify-desktop-pipeline.mjs:254-255`, `e2e-desktop.mjs:248-249`. All previously warn-only release paths were converted this cycle.

## Regression guard

`scripts/build-gate-honesty.test.mjs` (wired as `test:build-gates` and a CI step) pins 10 assertions covering every repair above. It is a source-level contract test: orchestration scripts are not importable functions, so reverting any fix makes the suite fail.
