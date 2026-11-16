# NANI — Release Build, NSIS Installer & Installed-Build Verification

Date: 2026-11-15
Repository: `E:\Code\Project\Vpn_app` (this is where the Tauri/NANI app lives; the currently selected
folder, Abystral, contains a different Worker project).

## 1. Artifacts produced

| Artifact | Path | Size | SHA-256 |
|---|---|---|---|
| NSIS installer | `src-tauri/target/release/bundle/nsis/NetPulse_3.2.0_x64-setup.exe` | 37,270,492 B | `1118B5D4804A2F41E184CBD7E2C00955777764F10473FEA3FDF735456152D25D` |
| Release binary (built) | `src-tauri/target/release/netpulse-desktop.exe` | — | — |
| Installed binary | `%LOCALAPPDATA%\NetPulse\netpulse-desktop.exe` | 7,209,984 B | `A27F107C9C005B8D261F65387E5B53B6384963F32A151AA16EBA29F5E35F3202` |

File/Product version on the installed exe: **3.2.0**; ProductName `NetPulse`; CompanyName `NetPulse`.

Build command used (deliberately **not** `npm run desktop:build`, which runs `release:version` and would
have bumped the version/CHANGELOG as a side effect):

```
npm run build:desktop-backend && npx tauri build
```

Result: `Finished release profile in 4m 33s`, `Built application at: ...target\release\netpulse-desktop.exe`,
`Finished 1 bundle`, `EXIT:0`. Full log: `tmp/release-build.log`.

Signing was not performed: `createUpdaterArtifacts` is `false` and no signing step was requested, so the
installer is unsigned (Windows SmartScreen will warn on other machines).

## 2. Installation

Silent per-user install (NSIS `currentUser` mode, as configured):

```
NetPulse_3.2.0_x64-setup.exe /S   →  exit code 0
```

Registry entry: `HKCU\...\Uninstall\*` → `DisplayName: NetPulse`, `DisplayVersion: 3.2.0`,
`InstallLocation: C:\Users\RADIN\AppData\Local\NetPulse`.

The installed tree contains `backend/`, `WebView2/`, `WebView2Loader.dll`, `netpulse-desktop.exe`,
`uninstall.exe`, `data/`, `logs/`, `releases/`, `signing/`.

## 3. Launch and verification method

Launched the **installed** binary (not the build output) with WebView2 remote debugging enabled:

```
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9444'
Start-Process "$env:LOCALAPPDATA\NetPulse\netpulse-desktop.exe"
```

PID 13444, started 22:54:01. CDP reported `Edg/157.0.4341.46`.

Verified it is the release bundle, not the dev server: the rendered URL is
`http://tauri.localhost/nani` (bundled `frontendDist` assets), not `http://localhost:5173`.

Screenshots and captured text: `reports/nani-release/` (scripts `tmp/cdp-release.mjs`,
`tmp/cdp-release-action.mjs`).

## 4. Results

### 4.1 Shell and navigation
- App launched, SPA mounted, NANI reachable via the sidebar link.
- All 9 NANI tabs render and switch: Overview, Live Investigation, Recovery, AI Workspace, Hypotheses,
  Evidence, Network Intel, Learning, History, Settings — each click succeeded and produced a screenshot.
- **0 console errors** recorded across the whole run.

### 4.2 Engine state (real backend data)
Overview showed live values from the bundled Rust/API engine, not placeholders:

```
HEALTHY APIS 0 | TOTAL APIS 1 | EVENTS (SEQ) 35 | RECOVERY 1
event stream connected
```

### 4.3 Live action — health check
Clicking **Run health check** in the installed build:

```
SEQ_BEFORE 1   →   SEQ_AFTER 35
health_check_complete: 0/1 healthy
```

Recent-events list then showed real sequenced events: `CircuitBreakerTripped` (#26–#37),
`RecoveryCompleted` (#28), `RecoveryStarted` (#30), `RecoveryStepCompleted` (#27) — i.e. the engine
tripped its breaker on the `netpulse-cloud` endpoint, attempted recovery, and reported the failure.

This verifies the failure path end-to-end in the release build: the UI reports **0/1 healthy** and a
tripped breaker rather than inventing success.

### 4.4 Learning tab (persisted across app restarts)
```
ACCEPTED 678 → 722 (during the session) | REJECTED 0 | RELIABILITY 50.0% | Drift events: 16
```
Counters changed while the app ran, so background ingestion is live in the installed build, and the state
is persisted to the installed `data/` directory.

### 4.5 Empty states are honest
- Hypotheses: "No hypotheses yet — Hypotheses appear when NANI emits a diagnosis update."
- Network Intel: "No measurements yet — Run a health check to collect real latency and status data."

No fabricated charts or numbers were rendered.

## 5. Findings

1. **The cloud API endpoint (`netpulse-cloud`) is unreachable from this machine**, so health checks
   return `0/1 healthy` and the circuit breaker trips. This is real reported state, not a UI defect; it
   does mean the "healthy" path could not be observed end-to-end.
2. **Network Intel stays empty after a failed health check.** Its copy tells the user to "run a health
   check to collect real latency", but a check that fails at the circuit-breaker stage produces no
   measurement events, so the tab remains empty with no explanation. Minor copy/logic gap worth fixing
   (state the reason: "last health check failed before measurement").
3. **Hypotheses tab is never populated** by a health check — it needs a diagnosis event, which the failing
   cloud endpoint prevents. The empty state is accurate but the dependency is undiscoverable from the UI.
4. **Phase 7 mathematics are still not surfaced**: no posteriors, priors, information gain or correlation
   data appear in the installed build's Hypotheses/Evidence tabs (the `nani_math_*` commands exist but no
   UI consumes them). Consistent with the Phase 7 report.
5. Installer is **unsigned**; no updater artifacts were produced.

## 6. Not verified
- VPN connect / tunnel establishment (not attempted; outside this verification).
- Success path of the health check (cloud endpoint down).
- Uninstall, upgrade-over-existing-version, and installation on a clean machine.
- Code signing / SmartScreen reputation.

## 7. Conclusion

The release build and NSIS installer are produced, install cleanly for the current user, and the
installed application launches, renders the NANI command center from bundled assets, streams real events,
executes a real health check, persists learning state, and reports failure honestly. The remaining gaps are
the unavailable cloud endpoint and the still-unwired Phase 7 mathematical display.
