# Alpha Release-Gate Report

**Report prepared:** 2026-10-12  
**Release decision:** **NO-GO**  
**Basis:** Gates executed and measured in this session on the working tree (Windows 11 build 26200, Node v24.18.0, npm 12.0.2; MSVC Build Tools + Rust msvc toolchain installed 2026-10-12 for the desktop build). Exit codes, test counts, and durations below are measured values from this run, not a supplied summary.

## 1. Section-21 Sign-off

```text
RELEASE: NO-GO (mandatory release gates remain unverified)

P0: NOT VERIFIED / target 0
P1 CORE: NOT VERIFIED / target 0
P2: NOT VERIFIED
P3: NOT VERIFIED

Premium Bypass: NOT VERIFIED / target 0
Cross-Account Leak: NOT VERIFIED / target 0
Unauthorized Engine Start: NOT VERIFIED / target 0
Unauthorized Config Access: NOT VERIFIED / target 0

Account Sync: NOT VERIFIED
Subscription Sync: NOT VERIFIED
VPN Connection Success: NOT VERIFIED
TUN Success: NOT VERIFIED
Crash-Free Sessions: NOT VERIFIED

Windows Install: NOT VERIFIED (installer produced 2026-10-12; install/upgrade/uninstall cycle not run)
Windows EXE: MEASURED PASS 2026-10-12 (netpulse-desktop.exe built; boot smoke test: alive 12s, no crash)
Security Gate: NOT VERIFIED (static scan only; worker service-auth test is flaky)
End-to-End Gate: NOT VERIFIED (no entitlement/purchase E2E run)

FINAL DECISION: NO-GO
```

## 2. Measured Results (executed 2026-10-12)

| Check | Measured result | Evidence/notes |
|---|---|---|
| `@netpulse/api` tests (`vitest run`) | PASS | 93 files; 954/954 passed; exit code 0; duration 108.23s |
| `@netpulse/web` tests (`vitest run`) | PASS | 37 files; 344/344 passed; exit code 0; duration 44.86s |
| `@netpulse/cloud-worker` tests (`vitest run`) | PASS (after debug fixes) | 4 files; 91 tests; exit 0. Two intermittent test bugs (tamper was a no-op when the HMAC already started with `f` — 1/16 probability) were root-caused and fixed in `netpulse-integration.test.ts` and `netpulse-sessions.test.ts`; 0 failures across 22+ full-suite runs after the fix. The service-signature verification itself (`np-auth.ts`) was verified sound. Details: `docs/app-review-audit-2026-10-12.md` |
| API typecheck (`tsc --noEmit`) | PASS | Exit code 0 |
| Web typecheck (`tsc --noEmit`) | PASS | Exit code 0 |
| Worker typecheck (`tsc --noEmit`) | PASS | Exit code 0 |
| `npm run build` (API tsup + web vite) | PASS | Exit code 0; web built in 19.96s; chunk-size >900 kB warnings only |
| `npm run desktop:build` (tauri build) | PASS | Exit code 0; cargo release in 2m42s (first build) and 1m54s (rebuild); produced `netpulse-desktop.exe` (6.27 MB) and `bundle/nsis/NetPulse_1.1.1_x64-setup.exe` (35.15 MB). The 2026-10-13 rebuild includes the DPAPI secret-protection bridge (`src-tauri/src/dpapi.rs`) and the elevation/updater fixes |
| EXE boot smoke test | PASS | `netpulse-desktop.exe` launched; process alive after 12s with no crash; terminated cleanly |
| `npm run desktop:verify` | PASS | 16/16 checks; staged sidecar boots on 127.0.0.1, enforces bearer auth, reports ready |
| Static secret scan | PASS, limited scope | No high-confidence secret patterns (private keys, `AKIA…`, `sk-…`) in `apps/`, `packages/`, `cloud/` sources excluding `node_modules`/`dist` |
| Production localhost check | PASS, limited scope | `apps/web/dist/index.html` contains no `localhost` or `127.0.0.1` reference |

**Measured automated-test total:** 1,389 tests across 134 files (954 API + 344 web + 91 Worker; 93 + 37 + 4 files). All three suites now pass cleanly after the debug fixes recorded in `docs/app-review-audit-2026-10-12.md`.

**Test-quality observation (pre-existing):** `cloud/worker/test/worker.test.ts:401` returns a promise from `expect(actual).resolves.toHaveLength(...)` without awaiting it; Vitest auto-awaits it today but states this will fail under Vitest 3.

## 3. Mandatory Gates Not Verified

| Gate | Status | Reason |
|---|---|---|
| P0/P1 defect count | NOT VERIFIED | No release-focused defect triage/result supplied |
| Premium bypass | NOT VERIFIED | No adversarial premium-enforcement test run |
| Cross-account isolation | NOT VERIFIED | No multi-account security test run |
| Unauthorized engine start | NOT VERIFIED | No desktop/IPC/engine security run |
| Unauthorized config access | NOT VERIFIED | No protected-resource access test run |
| Account and subscription sync | NOT VERIFIED | Requires configured backend and end-to-end execution |
| Telegram purchase/entitlement flow | NOT VERIFIED | No real or controlled purchase E2E run |
| VPN connection success | NOT VERIFIED | Live authorized VPN nodes and desktop runtime not exercised |
| TUN success and cleanup | NOT VERIFIED | Requires Windows/network tests with the actual application |
| Crash-free sessions | NOT VERIFIED | No measured runtime session population supplied |
| Windows installation/upgrade/uninstall | NOT VERIFIED | Installer artifact produced (`NetPulse_1.1.1_x64-setup.exe`); install/upgrade/uninstall lifecycle not executed |
| Security gate | NOT VERIFIED | Static secret scanning alone does not prove runtime security; premium-enforcement and adversarial tests have not been run. The worker service-auth tests are now deterministic after the tamper-test fix |
| End-to-end release gate | NOT VERIFIED | No complete entitlement/purchase-to-VPN workflow executed |
| Performance percentiles | NOT VERIFIED | No timing measurements supplied |
| Proxy/restricted-network behavior | NOT VERIFIED | No proxy-based account/sync scenario reported |

## 4. Environment Blockers

- **MSVC toolchain installed 2026-10-12 (this session):** VS Build Tools 17.14.41 with MSVC 14.44.35207 and Windows SDK 10.0.26100.0 at `D:\VS\BuildTools`; Rust `stable-x86_64-pc-windows-msvc` 1.98.1 (rustup/cargo homes relocated to `D:\rustup` / `D:\cargo`). Desktop EXE build is now reproducible on this machine.
- **Cloudflare production configuration absent:** Worker deployment/secrets were not configured in the workspace (`RESEND`, `OPS_TOKEN`, `RESET_PEPPER`, and `NETPULSE_SERVICE_SECRET` listed as missing).
- **Live VPN test resources unavailable:** live authorized node credentials and physical Windows TUN/network scenarios were not available.
- **Working tree not clean:** measured against the working tree as-is, which carries uncommitted modifications (`cloud/worker/src/crypto.ts`, `cloud/worker/wrangler.toml`, `package.json`) and untracked files.
- **Source edits applied after the measurement pass:** the release-gate measurements were taken on the working tree as it stood; afterward, debug fixes were applied (two cloud-worker test tamper fixes, two Rust fixes in `elevation.rs`/`updater_feed.rs`) and the **DPAPI secret-protection bridge** was implemented (`src-tauri/src/dpapi.rs` + `apps/web/src/lib/cloud/secureStore.ts` — refresh token and vault key now persist DPAPI-protected on desktop). All validated: `cargo check`/`cargo test dpapi` (6/6) green, web suite 349/349, `desktop:verify` PASS, EXE boot smoke test PASS. The desktop EXE artifact was rebuilt with all of the above. See `docs/app-review-audit-2026-10-12.md`.

These are measured environmental limitations, not evidence that those features pass or fail at runtime.

## 5. Release Decision

**NO-GO for general client distribution.**

The measured results provide positive evidence that the API and web automated suites pass (1,298 tests, 130 files, exit 0), the cloud-worker suite passes (91 tests, exit 0) after the debug fixes, all three typechecks pass, the API/web build succeeds, and the desktop EXE is built and passes a boot smoke test. The remaining mandatory gates — installer lifecycle, premium enforcement, account isolation, Telegram purchase flow, real VPN connections, TUN cleanup, Windows installation, and end-to-end workflow — have no measured evidence.

Do not treat an unmeasured gate as passed. The application may be suitable for further controlled engineering validation, but the measured evidence is insufficient for a production/client-release sign-off.

## 6. Minimum Next Actions to Reconsider Release

1. ~~Investigate and fix the flaky `netpulse-integration.test.ts` service-auth test~~ **DONE 2026-10-12:** root cause was a test bug (tamper was a no-op when the HMAC's first hex char was `f`, 1/16 probability); fixed in both `netpulse-integration.test.ts` and `netpulse-sessions.test.ts`; 22+ clean runs since. See `docs/app-review-audit-2026-10-12.md`.
2. ~~Run desktop build and verification on Windows with the full MSVC/VC++ toolchain; produce and smoke-test the actual installer and EXE.~~ **DONE 2026-10-12:** VS Build Tools 17.14.41 (MSVC 14.44.35207, Windows SDK 10.0.26100.0) installed; `npm run desktop:build` produced `netpulse-desktop.exe` + `NetPulse_1.1.1_x64-setup.exe`; `desktop:verify` 16/16 PASS; EXE boot smoke test passed. Remaining: execute the installer and verify install/upgrade/uninstall.
3. Configure a controlled Cloudflare test/staging environment and the required server-side secrets without packaging them into the application.
4. Execute account isolation, free-versus-premium bypass, forged/replayed purchase-event, and protected-config/node access tests.
5. Run the full Telegram purchase → entitlement → desktop sync → authorized node → engine → verified tunnel workflow using test accounts and authorized VPN nodes.
6. Run repeated TUN connect/disconnect, app restart, sleep/wake, and network-change tests; measure failures rather than assuming success.
7. Record measured results, logs, test environment, and any remaining defects; update this report only when each mandatory gate has evidence.

---

**Important:** Sections 2–4 reflect commands executed in this session with captured exit codes and counters. Raw per-test logs were not archived to the repository; rerun the listed commands to reproduce. All gates without measured evidence are marked NOT VERIFIED and must not be read as passed.
