# NANI Test Results

**Date:** 2026-11-14
**Source:** `E:\Code\Project\Vpn_app`

## Rust

```
cd src-tauri
cargo test
```

Result: **419 passed, 0 failed, 2 ignored** (exit 0).

The two ignored tests require a real webview/tauri-driver and were not run. Added tests cover:

- Correlated-evidence weight selection.
- Integration of the discount into `DiagnosticEngine::observe`.
- Repeated identical tests keeping full weight.
- Local LLM disabled/missing-file behaviour, output validation and boolean parsing.
- Deterministic explanation structure and prompt grounding.

## API

```
cd apps/api
npx vitest run
```

Result: **109 files, 1227 passed, 0 failed** (exit 0).

This includes configuration parsing/validation/scoring tests and the frontend/backend route-wiring test. That test initially failed twice in this pass:

1. Copilot called local `/ai/ask` and `/ai/usage` that did not exist → fixed by removing the cloud call.
2. Concurrent NANI pages requested `/api/v1/nani/status` through a client that already prefixes `/api/v1`, and the API had no status route → fixed the double prefix and added an honest `/nani/status` route with `lastDiagnosis: null` until a diagnosis exists.

## Web

```
cd apps/web
npx tsc --noEmit
npx vitest run
```

Result: typecheck exit 0; **52 files, 472 passed, 0 failed** (exit 0).

Two build-blocking frontend defects from concurrent edits were repaired:

- `AdaptiveRecoveryCard.tsx` contained an orphaned malformed JSX block after the component return and referenced fields absent from its DTO. Removed.
- `EngineManagerPage.tsx` had a duplicated `<Card` open tag and a `CardHeader` wrapping a `CardBody`. Repaired.

## Benchmarks

```
cargo test network_intelligence::evaluation::tests::nani_beats -- --nocapture
```

```
NANI 177/220 = 0.805 (95% CI 0.747..0.852) vs fixed 0.636, Brier 0.152, H 1.010
```

```
cargo test network_intelligence::evaluation::tests::benchmarks_are_within_budget -- --nocapture
```

```
bench: update 127.7us, rank 4300.4us, route 0.2us (200 iters)
```

## Not tested

- Real local LLM inference (no runtime or model installed) — BLOCKED.
- Live configuration source retrieval and endpoint testing.
- Installed-app click-through of NANI diagnosis/recovery.
- VPN connect/disconnect (not exercised in this pass).
- Release-mode performance and full-app resource usage.
