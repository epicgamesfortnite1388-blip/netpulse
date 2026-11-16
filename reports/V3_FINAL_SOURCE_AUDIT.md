# NetPulse V3 — Final Source Audit

**Date:** 2026-11-14
**Scope:** `E:\Code\Project\Vpn_app` (production repository). Other workspace directories were inventoried only; none were modified.

## Repository inventory

| Path | State | Role |
| --- | --- | --- |
| `E:\Code\Project\Vpn_app` | Git repository, branch `main` | NetPulse desktop, web UI, API, shared engine. **Release source.** |
| `E:\Code\Project\Abystral` | Present | Separate Abystral project. Not inspected for this release and not modified. |
| `E:\Code\Project\Abystral-ledger` | Present | Separate project. Not modified. |
| `E:\Code\Project\abystral-agent` | Present | Separate project. Not modified. |
| `E:\Code\Project\Bot\Abystral` | Present | Bot project. Not modified. |
| `E:\Code\Project\reports` | Present | Separate report area. Not modified. |

The release repository is self-contained: the desktop app, its bundled Node sidecar, the API and the shared NANI/config engine all build from `Vpn_app`. No cross-repository build dependency was found.

## Revision

- Commit: `76133c54bd4c710fc34bb2fd9dd5ed2154e8e05e` (`76133c5`, "Deploy all changes to netpulse repository")
- Branch: `main`
- Latest tag before release: `v1.1.1`
- Working tree: **dirty** — 68 changed/untracked paths at audit time, including the NANI Phase 4 work, new copilot wiring and release-version changes. Nothing was reverted or stashed.

## Version state at audit

The source tree reported **1.1.1** in `package.json`, `tauri.conf.json` and `Cargo.toml`, while the installed application and prior bundled installers were **1.5.1**. The release target is **3.0.0**.

Defect found: `scripts/release.mjs` used an LF-only regex for `Cargo.toml`. Both manifests use CRLF, so every release bump silently left the Rust crate version behind. The regex was corrected in this release; `node scripts/release.mjs 3.0.0` then updated all six version locations consistently.

## Dependencies and build system

- Node `v24.18.0`, npm `12.0.2`; engines require Node >= 22.
- Rust `1.98.1`, Cargo `1.98.1`; MSVC Windows target.
- `package-lock.json` and `src-tauri/Cargo.lock` are present and committed.
- Tauri v2, NSIS bundle, per-user install (`currentUser`), WebView2 bootstrapper embedded.
- Build chain: `npm run desktop:build` → version sync → API desktop bundle → `prepare-desktop.mjs` (backend staging, portable `node.exe`, pruned modules, Drizzle migrations) → `tauri build` (web build, release Rust, NSIS installer).

## Integrated functionality verified in source

- NANI mathematical engine and `LearningEngine` are constructed in `NaniState` and `LearningEngine` is called by the live `MonitorLoop` for every API probe.
- NANI Tauri commands are registered (`nani_learning_status`, `nani_learning_drift`, `nani_learning_reset`).
- Configuration gatherer routes and UI are present; route-wiring tests verify every frontend fetch path has a backend route.
- Deterministic diagnosis is independent of the optional LLM; the Copilot is a cloud-proxied feature and returns an honest configuration error when no AI backend is configured.

## Defects found and resolved during delivery

1. **Copilot called routes that did not exist locally.** `aiApi.ts` posted to `/ai/ask` and `/ai/usage` on the sidecar, which has neither. The route-wiring test failed on exactly those two paths. Copilot now calls the authenticated cloud endpoint `/api/v1/ai/ask`; the unused usage call and the non-functional local SSE attempt were removed.
2. **Stale client app version.** Device registration hard-coded `1.0.2`. The release version is now injected at build time (`__APP_VERSION__`) from the single source of truth.
3. **Cargo version drift** described above.
4. **NSIS installer has no CompanyName metadata** (`publisher` is set in Tauri config, but the installer's `VersionInfo.CompanyName` is blank). Non-blocking; recorded in artifact inspection.

## Release blockers at audit

| Blocker | Status |
| --- | --- |
| Copilot route-wiring failure | Fixed; targeted test passes |
| Version inconsistency (`1.1.1` source vs `1.5.1` installed) | Fixed; all locations now 3.0.0 |
| Cargo version not bumped by release script | Fixed |
| Installer unsigned | Not a build blocker; SmartScreen warning expected |

No other build or test blocker remained. The build completed and the installer was produced.
