# NANI Health & Recovery Report

## Health checks (implemented)
- Desktop: Rust `nani_health_check_all` (probes every registered API, records outcomes).
- Web: `POST /nani/check` per registered API.
- UI: Overview → "Run health check" shows the real result or error.

## Interactive recovery controls (implemented this phase)
New `apps/web/src/features/nani/RecoveryControls.tsx`, exposed as the **Recovery** tab.

Wired to real endpoints (`apps/api/src/routes/nani.ts`):
| UI action | Endpoint |
|---|---|
| Register API | `POST /nani/apis` |
| Plan recovery | `POST /nani/recovery/plan` |
| Next step | `GET /nani/recovery/next` |
| Mark succeeded / failed / skip | `POST /nani/recovery/step` |
| Reset runtime (2-step confirm) | `POST /nani/recovery/reset` |

Safety:
- Planning is read-only and shows the engine's real `status` (`ready` / `requires-permission` / `insufficient-evidence`), steps and rejected routes.
- An unauthorized route is never planned as ready — `filterCandidates` yields `insufficient-evidence` (verified by test).
- TLS verification is always sent as `true`.
- Recording a step outcome is a real state change (a succeeded verify marks the route activated), so it is gated behind an explicit "Record … as succeeded?" confirmation panel. The plan actions are never triggered by an LLM.
- Reset runtime is a two-step confirm.

## Bug fixed
`NaniService.registerApi` did not create runtime state, so `GET /nani/apis` stayed empty until a health check ran — a freshly registered provider was invisible. Fixed by materialising `getRuntimeState(registered)` on registration.

## Verified
- Backend tests: `naniRecoveryControls.test.ts` — 5 passed (registration visibility, ready plan steps, unauthorized refusal, unknown API, no-plan step rejection).
- Desktop: planned a real recovery for `netpulse-backend` (status `ready`, steps `probe` / `activate` / `verify`), opened the confirmation gate, and cancelled (no state mutated). Screenshots `16`–`18`.

## Not implemented
- No automated route rollback UI beyond `POST /nani/recovery/reset`.
- No bulk/multi-route planning surface.
