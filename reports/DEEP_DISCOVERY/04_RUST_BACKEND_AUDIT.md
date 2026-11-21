# 04 — Rust Backend Audit

Headline: no P0 in Rust. One P1 (elevation nonce contract) found and repaired this cycle. Baseline is otherwise sound under adversarial reading.

## Correctness and lifecycle

- **Elevation broker (`src-tauri/src/elevation.rs`)** — `validate_op` re-checks action, nonce format, canonical Program-Files `wireguard.exe` allow-list, exact `["/installtunnelservice", config]` shape, config containment under the app data dir, and SHA-256 match. The webview cannot supply an arbitrary path or command. **Defect DD-049:** the IPC command accepted only `op_id` while the sidecar's pending route requires a nonce; the descriptor fetch always returned 400. Fixed by adding `nonce: String` to the command, validating 16-128 alphanumeric chars, and emitting `?opId=&nonce=` via the new testable `pending_op_url()` helper. `cargo test elevation`: **12 passed / 1 ignored** (ignored test pops a real UAC dialog).
- **Sidecar supervision (`sidecar.rs`)** — `stop_sidecar` closes stdin first (backend stdin-EOF = graceful tunnel stop + proxy restore), polls `try_wait` up to 6 s, force-kills only a wedged child. No regression found in re-read.
- **Concurrency (NANI `investigation.rs`)** — cap check and slot insertion share one critical section (`:282-306`); all terminal paths retire (`:1161-1171`); `catch_unwind` guard at `:532-540`; 100-thread barrier test present. Sound except DD-043 (duplicate terminal event on cancel).
- **Panic paths** — no unwrap on untrusted input found in command handlers; `elevation_params` handles empty/one-arg shapes without panicking (tests at :690-739).
- **Platform assumptions** — Windows-specific checks are explicit (`process.platform !== 'win32'` on the API side; `net session` for admin status). No Linux/mac assumptions leaked into the Windows path.

## Resource management

- Bounded: NANI history (32 correlation entries, paged retention), event bus (500 topics), WS tickets (30 s single-use), Rust log rotation moves whole files, buffers sized/clamped, timers cleared. No unbounded-growth path found.
- `spawn_blocking` used for the elevation UAC flow so the IPC runtime is not stalled. Handles from `ShellExecuteExW` are closed on both success and failure paths.

## IPC contract (front/back drift)

~50 commands registered in `main.rs:270` including ~30 `nani_*`, `secret_protect/unprotect`, `data_paths`, `reveal_path`, `open_external`, `save_diagnostic_report`, `restart_backend`, `reset_app_state`, `safe_mode`, and the repaired `vpn_elevation_bridge`. The frontend invoke set is a subset; no orphan handler found. **DD-049 was exactly a contract drift case** (UI/API/Rust disagreed on the nonce argument) and is now pinned by tests on both sides.

## Verification

- `cargo test --manifest-path src-tauri/Cargo.toml`: most recent full run 558 passed / 1 failed / 2 ignored. The single failure was **order/environment-dependent**: the same test passed in isolation and the whole `network_intelligence::diagnosis::tests` module passed serially (`diagnosis-serial-2026-11-21.log`, exit 0). Two separate full runs failed on two *different* tests in that module, and source mtimes advanced mid-run — a concurrent editor was compiling against changing source. No genuine NANI regression was reproducible against stable source.
- `cargo test elevation`: 12 passed / 0 failed / 1 ignored after the repair.
- Rust workspace contains 150+ warnings (mostly dead-code/unused) but no errors; warnings were not suppressed.

## Residual risks

- Concurrent-edit compile race is a process/change-management risk, not a code defect; re-run the full suite against a stable tree before release.
- DD-043 (duplicate terminal event), DD-045 (NaN prior) remain open and are documented in 17.
