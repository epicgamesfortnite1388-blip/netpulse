# N0_06 — Frontend Event Compatibility

## Consumers inspected (unchanged — verification only)

| Consumer | Mechanism | Compatible with N0 events? |
|---|---|---|
| `useNaniEvents` → Tauri `listen("nani:event")` | envelope `{seq, event}` parse | ✅ unchanged contract |
| `naniEvents.ts` reducer | kind → activity mapping | ✅ all investigation kinds mapped: InvestigationStarted→Investigating, StageStarted/Completed→Investigating, ProbeStarted/Completed→Testing, ObservationCreated/EvidenceAdded→Observing, HypothesisCreated/Updated→Comparing, AnalysisCompleted→Analyzing, VerificationCompleted→Verifying, Completed/Failed/Cancelled (lines 158–182) |
| `deriveEvidence(events)` | event-derived evidence list | ✅ now receives real `ObservationCreated`/`EvidenceAdded` events (previously structurally starved) |
| `nani_poll_events` fallback | `replay_since` | ✅ replay contains investigation events (tested) |
| Live pipeline panel | matches kind strings incl. `nani:recovery:*` web topics | ✅ kinds unchanged |

## Tests

- Existing: `apps/web` nani suite **34 passed** (live run; includes reducer dedupe/gap/late-join + kind mapping) — no frontend changes were needed or made.
- Backend-side kind names are verified to match the serde tag contract (`#[serde(tag = "kind")]`), and the integration test asserts using those exact serialized names — the same strings the reducer switches on.

## Not done (out of scope, documented)

- No fake sample data; no UI changes. The live pipeline lights up purely because events now arrive.
- The investigation **query** is not yet used for targeting (probes all registered APIs) — N1 concern, unchanged behavior.
