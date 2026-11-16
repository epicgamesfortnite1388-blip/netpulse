# N0_04 — Event Lifecycle Verification

Coverage of every lifecycle event type the current implementation emits (contracts unchanged — no invented kinds):

| Event | Emitted by | Delivered on canonical bus? | Verified by |
|---|---|---|---|
| `InvestigationStarted` | `start()` | ✅ | integration test (replay_session) |
| `InvestigationStageStarted` (observe/analyze/verify) | `run_lifecycle` | ✅ | integration test (kind list) |
| `ProbeStarted` (per layer ×4) | `run_observe_stage` | ✅ | kinds list shows 4× |
| `ProbeCompleted` (per layer) | `run_observe_stage` | ✅ | kinds list shows 4× |
| `ObservationCreated` | `run_observe_stage` | ✅ | kinds list |
| `EvidenceAdded` | observe + verify | ✅ (observe leg + `verify` leg on the failing path) | explicit `EvidenceAdded{kind:"verify"}` assertion |
| `HypothesisCreated`/`HypothesisUpdated` | `run_analyze_stage` | ✅ on failing leg (healthy leg: none — honest) | kinds_f check |
| `AnalysisCompleted` | analyze end | ✅ both legs | assertions |
| `VerificationCompleted` | after verify | ✅ failing leg; **correctly absent** on healthy leg (verify skipped — nothing to verify) | positive + negative assertions |
| `InvestigationStageCompleted` | per stage | ✅ | kinds list |
| `InvestigationCompleted` | finish path | ✅ | assertions |
| `InvestigationFailed` | failure path | existing (not triggered by these fixtures — unit-covered elsewhere) | existing tests |
| `InvestigationCancelled` | cancel path | existing unit tests cover (`start_and_cancel_before_work`, concurrent-scoping tests) | existing, still green |

Ordering: observe (4×started/completed) → stage completed → analyze → (verify) → complete, verified by the ordered kind list in the test output.

Identity: every replayed event's `investigation_id` equals the started id (asserted `all()`).

## What remains out of N0 scope

- The *content* of hypotheses is still the layer-frequency analysis (NANI-003 → N1.1). N0 delivers the events; N1 upgrades their meaning.
- `InvestigationFailed` live-path coverage: no fixture forces an engine failure (cancel path unit-tested); acceptable and documented.
