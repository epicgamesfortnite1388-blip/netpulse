# NANI Test Report

## Executed
Command: `cd apps/web && npx vitest run src/features/nani`

Result:
```
✓ src/features/nani/naniEvents.test.ts (17 tests)
Test Files  1 passed (1)
Tests       17 passed (17)
```

Command: `cd apps/api && npx vitest run test/nani`

Result:
```
✓ naniReadOnlyDiagnostics.test.ts
✓ naniShadowHealthRoute.test.ts
✓ naniShadowHealthLoop.test.ts (4)
✓ naniShadowAssessment.test.ts (3)
✓ naniRecoveryControls.test.ts (5)
Test Files  5 passed (5)
Tests       26 passed (26)
```

`naniRecoveryControls.test.ts` covers: registered API appears in `listApis`, ready plan step order, unauthorized route refused (`insufficient-evidence`), unknown API rejected, step record without a plan rejected.

Coverage of `naniEvents.test.ts`:
- Tauri envelope normalization + malformed rejection.
- Bus envelope normalization.
- Dedupe by eventId.
- Forward gap detection.
- Late-join detection.
- Out-of-order delivery kept.
- Bounded event buffer (200).
- Activity mapping for real event kinds.
- Unknown kinds do not fabricate activity changes.

## Executed
- `npx tsc --noEmit` → exit 0.
- `npx vite build` → exit 0.

## Rust crate tests (executed)

`cd src-tauri` (requires `WebView2Loader.dll` staged beside the test exe):

```
cargo test network_intelligence::events -- --test-threads=1
  running 10 tests ... test result: ok. 10 passed; 0 failed

cargo test network_intelligence::investigation -- --test-threads=1
  running 7 tests ... test result: ok. 7 passed; 0 failed

cargo test network_intelligence::   →  342 passed; 0 failed
```

New Rust tests (8):
- `replay_since_preserves_sequence_order` — replay is strictly increasing, no duplicates/reordering.
- `replay_since_dedupes_already_seen_events` — reconnect catch-up excludes seen seqs, is idempotent, and head catch-up is empty.
- `replay_session_scopes_events_to_their_owner` — investigation A never receives B's events; scoped catch-up excludes seen.
- `system_events_have_no_investigation_owner` — telemetry/failure events have no session and never leak into a session feed.
- `replay_since_after_eviction_is_ordered_and_signals_the_gap` — after ring-buffer eviction, replay stays ordered, is bounded, keeps the newest event, and exposes the gap (first retained seq > since + 1).
- `replay_session_after_eviction_stays_ordered_and_scoped` — owner-scoped replay across eviction keeps order/scoping, is idempotent at the head, and dedupes from a mid-buffer sequence.
- `cancelling_one_investigation_does_not_affect_another` — manager-level ownership.
- `lifecycle_events_are_owned_by_their_investigation` — every lifecycle event carries its investigation id.

Supporting additions: `Event::investigation_id()`, `EventBus::replay_since()`, `EventBus::replay_session()`; the replay buffer now stores `(seq, Event)`.

Full module run (re-run after the Phase 7 additions): `cargo test network_intelligence::` → **342 passed, 0 failed**. The earlier softmax adversarial failure in `foundation.rs` was fixed at source during Phase 7 and now passes.

## Not executed
- E2E in the packaged app for the Rust event changes (compiled only).
- Backend integration tests for event ordering/ownership.
- E2E flow in the packaged Windows app.
- Component render tests for NaniPage (no RTL/jsdom render harness added).

## Honest assessment
Frontend event logic is covered by pure unit tests. The broader backend/persistence/E2E test matrix required by the phase remains partial and is listed as outstanding.
