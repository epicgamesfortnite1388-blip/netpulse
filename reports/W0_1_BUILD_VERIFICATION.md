# W0-1 Build Verification

Commands executed 2026-11-16 22:10–22:25 from the committed baseline (`384f7f9`). Scope: smallest set proving the recovered baseline builds and its tests pass. No remediation work started.

| Verification | Command | Result |
|---|---|---|
| Rust NANI engine tests | `cd src-tauri && cargo test network_intelligence` | **368 passed, 0 failed** (4.52 s) — note: 368 now vs 364 at Phase-1 audit; the committed in-flight work added tests |
| Rust/Tauri compilation (incl. all commands) | `cd src-tauri && cargo check` | 0 errors; finished dev profile |
| Web typecheck | `cd apps/web && npx tsc --noEmit` | exit 0 |
| Shared typecheck | `cd packages/shared && npx tsc --noEmit` | exit 0 |
| API typecheck | `cd apps/api && npx tsc --noEmit` | exit 0 |

## Warnings (recorded, not acted on)

- `cargo check` reports 274 warnings (54 auto-fixable) — the known dead-code/shelf population (`FABLE-RUST-002`, addressed later by T-03). Pre-existing; not introduced by W0-1 (W0-1 changed nothing).
- CRLF line-ending notices from git on Windows — known repo characteristic; no `.gitattributes` change made (out of scope; noted for a future hygiene ticket).

## Conclusion

The committed recovery point **builds and passes its engine test suite from a fresh Git extraction standpoint** (working tree and commit agree; engine files extractable and compiling). W0-1 did not modify any algorithm, connection state, verification semantics, TS services, migrations, or engine behavior.
