# EXHAUSTIVE_AUDIT_03 — Evidence integrity

## Final verification window

The final full-workspace run started at `2026-11-20T15:03:14Z` and ended at `2026-11-20T15:11:46Z`. All evidence files are under `reports/EXHAUSTIVE_AUDIT/`.

## Exactly observed results

| Gate | Log | Result |
|---|---|---|
| Full workspace tests | `full-workspace-tests-final.log` | shared 14 files / 212 tests; API 118 files / 1271 tests; web 56 files / 534 tests; cloud 6 files / 126 tests. Total 194 files / 2143 tests, 0 failed |
| Lint | `lint-final.log` | 0 errors; only the existing `MODULE_TYPELESS_PACKAGE_JSON` warning from `eslint.config.js` |
| Rust | `rust-tests-final.log` | 555 passed, 0 failed, 2 ignored; doc test 0 passed, 1 ignored |
| UI contract | `ui-contract-final.log` | 53/53 assertions PASS (`index-VHGwpBlR.css`) |
| Production build | `build-final.log` | API tsup + web tsc/vite PASS in 12.11 s; only the existing >900 kB chunk advisory |
| API typecheck | `api-typecheck-after-nani-fixes.log` | PASS |
| Web typecheck | `web-typecheck-after-nani-fixes.log` | PASS, with the final build repeating `tsc --noEmit` successfully |
| API egress | `api-egress-after-fix.log` | 16/16 PASS |
| Proxy-specific Rust | `rust-proxy-tests.log` | PASS |
| Data-backed visual | `visual-data-backed/manifest.json` | 5 screenshots; `scrollW == clientW == 1138` for each |
| Update feed | `feed-tests-after-scripts-fix.log` | 76/76 PASS |
| Pipeline version gate | `pipeline-version-tests.log` | 3/3 PASS |
| Desktop pipeline | `desktop-verify-after-scripts-fix.log` | All PASS, including `appVersion:"3.2.0"` |

## Visual honesty

The data-backed screenshots were captured from a real API sidecar on port 8791 with an isolated data directory. The Dashboard showed measured values together with the explicit qualifier "Based on 2 of 8 components"; the connection console showed "not verified" / "not measured" rather than invented status. Settings rendered real controls and all seven tabs. No screenshot was synthesized or edited.

## Evidence caveats, stated plainly

- `cargo clippy` is not installed for the active toolchain (`cargo-clippy-baseline.log` records the failure). Rust correctness was checked with `cargo test` and targeted source review, not Clippy.
- The sandbox blocked `reg.exe`; API tests still passed because the code now treats registry access as best effort. This is an environment limitation, not a hidden test failure.
- One earlier API run was terminated by the command timeout, not by a test assertion; the rerun with an extended timeout passed.
- `mapClusterPerf` failed once under heavy parallel load and passed in isolated and final runs. It is a load-sensitive timing guard, not a source regression.
- Two intermediate build attempts caught files while external contributors were writing them; those attempts are not final evidence. The final build and all final gates ran after the observed edits settled.
