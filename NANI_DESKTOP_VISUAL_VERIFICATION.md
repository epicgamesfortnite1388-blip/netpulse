# NANI Desktop Visual Verification

## Status: PERFORMED

The Windows Tauri application was built, launched, and visually inspected.

## Build
- Command: `npx tauri build --debug --no-bundle`
- Result: `EXIT:0`, web bundle rebuilt (NaniPage chunk 28.73 kB), Rust compiled in 2m03s.
- Binary: `src-tauri/target/debug/netpulse-desktop.exe`
- Note: a **debug** build loads `devUrl` (`http://localhost:5173`), so the Vite dev server was started (`npm run dev -w @netpulse/web`) for launch. A release build uses `frontendDist` and does not need it.

## Launch & inspection
- App launched; window title `NetPulse`, content `NetPulse — Network Intelligence`.
- The WebView2 was inspected live over the DevTools protocol (window-specific screenshots, not desktop capture).

## Verified screens (screenshots in `reports/nani-screens/`)
| File | Screen | Result |
|---|---|---|
| `02-overview.png` | Overview | Renders; engine status (healthy/total, seq), health-check button, recent events |
| `03-live-investigation.png` | Live Investigation | Real events listed (#1–#11), pipeline stages PLAN/TEST marked done |
| `04-ai-workspace.png` | AI Workspace | Conversation list + empty state render |
| `05-hypotheses.png` | Hypotheses | Honest empty state (no diagnosis event yet) |
| `06-evidence.png` | Evidence | Honest empty state + filter |
| `07-network-intel.png` | Network Intel | Honest empty state |
| `08-learning.png` | Learning | **Real data**: 100 accepted, 0 rejected, reliability 50.0%, 4 drift events |
| `09-history.png` | History | Renders |
| `10-settings.png` | Settings | Runtime, AI note, history controls |
| `12-workspace-message.png` | Chat reply | Real deterministic explanation (Observed/Inferred/Confidence/Next step) |
| `13-workspace-persisted.png` | After reload | Same conversation restored → persistence works |
| `14-overview-narrow.png` | Overview @ 900px | Sidebar collapses to hamburger; tabs wrap; cards stack |
| `15-workspace-narrow.png` | Workspace @ 900px | Single-column layout holds |
| `16-recovery.png` | Recovery tab | Provider select, route kind, authorization toggle, register form |
| `17-recovery-plan.png` | Recovery plan | Real plan `ready` with probe/activate/verify steps and per-step actions |
| `18-recovery-confirm.png` | Confirmation gate | "Record … as succeeded?" warning with Confirm/Cancel |

## Observed real-backend behavior
- Live Investigation showed genuine Rust events (`RecoveryStarted`, `RecoveryStepCompleted`, `CircuitBreakerTripped`) with sequence numbers — not simulated.
- Chat answer came from `nani_explain` with `source: deterministic`.
- Learning panel numbers came from `nani_learning_status`.
- Conversation survived a full page reload.

## Problems found and fixed
- AI core's floating state label overlapped the description text → added bottom margin.
- Recovery tab showed "No APIs registered" even after registering: `NaniService.registerApi` never created runtime state, so `GET /nani/apis` stayed empty. Fixed; rebuilt the sidecar bundle and re-verified (selects populated, plan `ready`).

## Remaining visual notes (not blocking)
- At very wide windows the content is centred with generous side margins (app-wide convention).
- Long conversation titles truncate.
- The "View live investigation →" link wraps awkwardly at narrow widths.
