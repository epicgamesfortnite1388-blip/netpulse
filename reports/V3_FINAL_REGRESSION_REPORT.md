# NetPulse V3 — Final Regression Report

All commands were run from `E:\Code\Project\Vpn_app` on 2026-11-14 unless stated.

## Rust

```
cd src-tauri && cargo test
```

Result: **416 passed, 0 failed, 2 ignored** (exit 0). Ignored tests require a real webview/tauri-driver and were not run.

The suite covers the NANI engine, evidence pipeline, correlation model, learning engine, persistence/compaction, diagnosis, recovery, configuration intelligence, survival and changepoint modules.

## Frontend and workspaces

```
npm run test:all
```

Result: **2034 tests, 1 failed**, exit 1.

| Workspace | Result | Tests |
| --- | --- | --- |
| `@netpulse/shared` | PASS | 209 |
| `@netpulse/api` | FAIL | 1227, 1 failed |
| `@netpulse/web` | PASS | 472 |
| `@netpulse/cloud-worker` | PASS | 126 |

Failure:

```
test/routeWiring.test.ts > every frontend fetch path has a registered backend route
missing: ["/ai/ask (aiApi.ts)", "/ai/usage (aiApi.ts)"]
```

This was a genuine defect, not a flaky test: the Copilot posted to routes the sidecar does not implement. It was fixed by routing Copilot through the authenticated cloud client and deleting the unused usage call.

Re-run after the fix:

```
cd apps/api && npx vitest run test/routeWiring.test.ts
```

Result: **3/3 passed**.

```
cd apps/web && npx vitest run
```

Result: **472/472 passed**.

A full API re-run after the fix: **109 files, 1227/1227 tests passed, exit 0**. The combined workspace total after the fix is therefore **2034/2034 passing**.

## TypeScript

```
cd apps/web && npx tsc --noEmit
```

Result: exit 0.

## Production build

```
npm run desktop:build
```

Result: exit 0. Frontend built by Vite; Rust release binary and NSIS installer generated.

```
npm run desktop:verify
```

Result: all checks passed, including:

- staged backend and portable `node.exe`
- Tauri resources (`backend/`, `WebView2Loader.dll`)
- icons and web `dist`
- sidecar boot on loopback
- sidecar bearer-auth enforcement

## Security

```
npm audit --omit=dev --audit-level=high
```

Exit 0; 3 moderate advisories, documented in `V3_FINAL_SECURITY_AUDIT.md`.

## Installed application

| Check | Result |
| --- | --- |
| Installer silent install over 1.5.1 | PASS (exit 0) |
| Registry version | PASS — 3.0.0 |
| Installed executable version | PASS — FileVersion/ProductVersion 3.0.0 |
| Window created and responding | PASS — `MainWindowTitle: NetPulse`, `Responding: True` |
| Sidecar started | PASS — log `sidecar-ready port=47615` |
| Unauthenticated API rejected | PASS — HTTP 401 |
| Existing database preserved | PASS — 339,578,880 bytes, unchanged timestamp; backup hash matches |
| Settings marker preserved | PASS — SHA-256 identical before/after |
| Graceful close | PARTIAL — close-to-tray hides the window by design; tray Quit was not automated |

## Not tested

- Click-through of every UI workflow in the installed build.
- Live configuration-source retrieval and endpoint testing over the public internet.
- NANI diagnosis and recovery against a deliberately broken live network.
- Backend cloud sign-in, entitlement refresh and Telegram linking.
- Offline/unavailable-backend behavior in the installed UI.
- Signed-artifact verification (no certificate available).

These are stated as NOT TESTED, not passed.
