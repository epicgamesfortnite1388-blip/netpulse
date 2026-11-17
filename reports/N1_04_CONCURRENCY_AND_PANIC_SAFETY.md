# N1_04 — Concurrency and Panic Safety (N0-review condition C3)

**Phase:** N1.1 · **Commit:** `200de54` · File: `investigation.rs` only; the
Bayesian mathematics is untouched by this work item.

## Concurrency control

- `pub const MAX_ACTIVE_INVESTIGATIONS: usize = 4` — explicit, documented,
  defined at one place on the manager.
- `start()` checks the cap synchronously under the inner lock **before**
  inserting into `active` (the active map IS the permit — no separate permit
  to leak).
- **Excess starts are rejected honestly:** an immediate terminal
  `InvestigationFailed` record ("Investigation rejected: concurrency limit
  (4) reached.", error "concurrency limit") + `InvestigationFailed` event on
  the canonical bus, recorded in bounded history. The UI sees exactly why
  nothing runs. No silent queue, no silent drop, no signature change to the
  Tauri command.
- Capacity release: every terminal path retires via `retire_from` →
  `active.remove` — complete, fail, cancel, panic (see below), and honest
  rejection (never entered `active`; history push is bounded).

## Panic safety

- The whole lifecycle runs under `catch_unwind` via
  `InvestigationManager::guarded_lifecycle(...)` (a named, directly testable
  function). On unwind:
  - `finish_failed` runs with reason "internal error: the investigation
    panicked and was stopped" — an honest terminal failure, identity
    preserved, **never converted into a completion** (test-asserted).
  - The normal retire path releases the active slot and pushes the bounded
    history record — shared state and capacity cannot leak after a panic.
  - Diagnostic information is not swallowed: lock poisoning is recovered via
    the existing `unwrap_or_else(|p| p.into_inner())` convention throughout,
    and the guard's failure reason is explicit on the record. (The Rust panic
    payload is not stringified into the record — the reason states the class
    of failure; extending it to embed the payload is trivial later if wanted.)
- `lifecycle_stages` was extracted from `run_lifecycle` so the real staged
  body and the guard are separately auditable.

## Tests (all in `investigation.rs::tests`)

- `n1_concurrency_limit_rejects_honestly_and_releases` — 4 starts against a
  hanging endpoint occupy all 4 slots (asserted); starts 5–6 are honestly
  rejected with the limit message while capacity stays 4; two fast-timeout
  investigations reach terminal state and their slots are demonstrably
  released (a third start is not rejected).
- `n1_panic_produces_honest_failure_and_releases_capacity` — injected panic in
  the guarded body: `InvestigationFailed` on the canonical bus, active map
  empty afterward, a fresh start succeeds, and **no `InvestigationCompleted`
  was ever emitted** for the panicked id.
- Existing suites (`history_is_bounded` with 60 sequential starts, two
  concurrent investigations in `lifecycle_events_are_owned…`) pass unchanged
  under the cap.
