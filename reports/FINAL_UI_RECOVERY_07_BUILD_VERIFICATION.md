# FINAL_UI_RECOVERY_07_BUILD_VERIFICATION

## Commands and results

| Gate | Command | Result |
|---|---|---|
| Web typecheck | `npm --prefix E:/Code/Project/Vpn_app run typecheck -w @netpulse/web` | PASS (`tsc --noEmit`, exit 0) |
| Web tests | `npm --prefix E:/Code/Project/Vpn_app run test -w @netpulse/web` | **55 files / 523 tests PASS** in 40.05 s (isolated final run) |
| UI contract | `npm --prefix E:/Code/Project/Vpn_app run test:ui-contract` | **47/47 PASS** (`index-CRlbLKG2.css`) |
| Rust tests | `cargo test --manifest-path /e/Code/Project/Vpn_app/src-tauri/Cargo.toml` | **552 passed / 0 failed / 2 ignored** |
| Fresh Vite build | `node ...vite/bin/vite.js build --config apps/web/vite.recovery.config.mjs --outDir E:/Code/Project/.final-ui-recovery-build-final2` | **PASS in 1m 6s** |

Logs are in `reports/FINAL_UI_visual_recovery/`:

- `web-typecheck-final.log`
- `web-tests-final.log`
- `ui-contract-final.log`
- `rust-final-2.log`
- `build-final.log`

## Build notes

The default `apps/web/dist` cleanup is blocked by the sandbox’s bulk-delete guard. This is an environment constraint, not a source failure. A fresh output directory was used instead:

```text
E:/Code/Project/.final-ui-recovery-build-final2
```

The isolated config `apps/web/vite.recovery.config.mjs` mirrors the shipped aliases and sets an isolated cache directory. The first visual capture attempt used an incomplete alias set and produced a Vite error overlay; that evidence was discarded and recaptured after the aliases were corrected.

## Bundle warnings

The build still reports chunks larger than 500 kB, notably:

- `LiveMapPage-DVaViwJ4.js` — 1,265.83 kB (gzip 377.61 kB)
- `index-B159liSR.js` — 583.31 kB (gzip 184.19 kB)
- `three.module-CYcuZZqb.js` — 558.22 kB (gzip 142.02 kB)
- `LatencyChart-C5UTWcHx.js` — 350.45 kB (gzip 104.24 kB)

This is a pre-existing performance warning, not introduced by the recovery changes. It remains a non-blocking optimization item.

## Verification conclusion

All executable gates for the authorized recovery scope are green with captured output. No gate result was inferred from a prior run after source changes.
