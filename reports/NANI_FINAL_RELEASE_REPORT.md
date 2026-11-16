# NANI Final Release Report — NetPulse 3.1.0

**Date:** 2026-11-14
**Status:** Built, installed over 3.0.0, launched, and locally packaged. Not signed; not published.

## Implemented

- Correlated-evidence discount integrated into the Bayesian diagnostic posterior.
- Optional local LLM runtime (`network_intelligence/ai/`), disabled by default, with deterministic explanation fallback.
- Copilot no longer calls cloud AI; it calls local `nani_explain`.
- Default background probes to external AI providers removed.
- Honest `/api/v1/nani/status` route for the NANI reports/engine pages.
- Build-blocking frontend defects repaired.

## Tested

| Suite | Command | Result |
| --- | --- | --- |
| Rust | `cd src-tauri && cargo test` | **419 passed, 0 failed, 2 ignored** |
| API | `cd apps/api && npx vitest run` | **109 files, 1227 passed, 0 failed** |
| Web | `cd apps/web && npx vitest run` | **52 files, 472 passed, 0 failed** |
| Web types | `npx tsc --noEmit` | pass |
| Desktop pipeline | `npm run desktop:verify` | all checks pass; sidecar boot + bearer auth |

## Benchmarked

```
NANI 177/220 = 0.805 (95% CI 0.747..0.852) vs fixed 0.636
Brier 0.152, mean posterior entropy 1.010
bench: update 127.7us, rank 4300.4us, route 0.2us (200 iters, debug)
```

No release-mode or full-app performance claim is made.

## Verified in the installed application

- Registry DisplayVersion: **3.1.0**.
- Installed executable FileVersion/ProductVersion: **3.1.0**.
- Process running, main window `NetPulse`, `Responding: True`.
- Log: `=== NetPulse desktop starting (v3.1.0) ===` from the installed path.
- Log: `sidecar-ready port=47615`; `bootstrap: sidecar answered after 7154 ms`.
- Unauthenticated `GET /api/v1/health` returns **401**.
- Database: 45 tables, 18 VPN profiles, 5 settings, `PRAGMA quick_check` = `ok`.
- Settings marker SHA-256 unchanged (`cff08e28…`).

The database file hash changed from the pre-install backup (`fae50add…` → `8b9ef402…`) because the app opened it and completed SQLite WAL/checkpoint and schema work. Content checks above confirm data is intact; the pre-upgrade backup remains at `E:\Code\Project\backups\NetPulse-pre-V3-20261114-160428`.

## Installed

Yes. Silent NSIS upgrade from 3.0.0 to 3.1.0; the old process was already stopped by the installer. Installation exit code 0.

## Packaged

- `E:\Code\Project\releases\NetPulse-V3.1.0\installer\NetPulse-V3.1.0-setup.exe`
  SHA-256 `243ba79314d7ba967b95e79105206d875172844075b787983046c64825e2c5a4`
- `application/netpulse-desktop.exe`
  SHA-256 `e76531183db128a2194fca3ff4b8c1f9d97ac913630e39e9b853799639db130b`
- Documentation including `LOCAL_LLM.md`.
- Reports including all 14 required NANI reports.

## Deferred / blocked

- **Local LLM model evaluation: BLOCKED.** No llama.cpp-compatible binary or GGUF model is installed, so no model was benchmarked or selected. The runtime adapter, timeout, output validation and deterministic fallback are tested.
- **NANI diagnosis/recovery in the installed UI: NOT TESTED.** Unit/simulation tested only.
- **Live configuration gathering: NOT TESTED.**
- **VPN connect/disconnect: NOT TESTED** in this pass.
- **Cloud account/Telegram flows: NOT TESTED.**
- **Local learning persistence: DEFERRED** (in-memory).
- **Signing: NOT DONE** (no certificate).

## Release status by category

| Category | Status |
| --- | --- |
| Mathematical engine | Implemented, tested, benchmarked |
| Bayesian correlation | Implemented, tested, benchmarked |
| Information theory / robust stats | Implemented, tested (existing modules) |
| Configuration intelligence | Implemented, unit-tested; live NOT TESTED |
| Local learning | Implemented, tested; persistence deferred |
| Local LLM | Implemented, disabled-path tested; real inference BLOCKED |
| AI dependency removal | Implemented and verified in desktop code |
| Performance | Engine micro-benchmark measured; full app NOT TESTED |
| Security | Reviewed; unsigned; 3 moderate npm advisories |
| Build/install/launch | Built, verified, installed, launched |
| Public release | Not published |
