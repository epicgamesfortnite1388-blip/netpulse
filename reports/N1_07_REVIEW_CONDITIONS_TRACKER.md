# N1_07 — Review Conditions Tracker

**Phase:** N1.1 · **Commits:** `5b65737` (C2), `200de54` (C1 + C3 with the N1.1 work)

## C1 — Desktop initialization regression protection: **RESOLVED (automated)**

- The setup call-site is now a named function:
  `InvestigationManager::wire_application_dependencies(manager, registry, bus)`
  (investigation.rs). `main.rs` setup calls exactly this (one call, no inline
  double-lock block).
- Automated coverage: the oracle test and the refusal test both call
  `wire_application_dependencies` and assert its effect via
  `shares_registry_with`/`shares_event_bus_with` Arc-identity
  (`n0_end_to_end_…` asserts identity sharing directly). A future refactor
  that reintroduces an isolated registry or placeholder bus fails these tests.
- **Honest scope statement:** the function's *correctness* is unit-tested; the
  fact that `main.rs` *calls* it is still only provable by the live runtime
  gate (a one-line call cannot be tested from inside the bin's test target
  without a Tauri AppHandle). The permanent release-gate checklist item
  stands: **before every packaged build, run one live investigation and
  require observations > 0 and lifecycle events in the feed** (exact steps in
  N0_REVIEW_01 §M1 / N1_08 §Gate). No over-claim is made: this is automated
  coverage of the wiring mechanism + a manual gate for the call-site line.

## C2 — Reproducible E2E harness: **RESOLVED (committed)**

- Inspected: the only working-tree change to `scripts/e2e-desktop.mjs` was the
  one-line expectation fix for the deliberate `410 Gone` retirement of
  `/nodes/export` (security decision untouched — configs are still never
  served; the route keeps its explanatory message).
- Committed **alone** as `5b65737` ("test(e2e): align /nodes/export
  expectation with the deliberate 410 Gone retirement").
- Verified after commit: `npm run e2e` → **44 passed, 0 failed**. The 44/44
  result is now reproducible at HEAD.

## C3 — Concurrency and panic safety: **RESOLVED (implemented + tested)**

- Bounded concurrency: `MAX_ACTIVE_INVESTIGATIONS = 4`; excess starts rejected
  honestly as failed records + events (no silent queue/drop); capacity
  released by complete/fail/cancel/panic paths.
- Panic safety: lifecycle under `catch_unwind` via `guarded_lifecycle`; panic
  → honest terminal `InvestigationFailed`, slot released, never a completion.
- Tests: `n1_concurrency_limit_rejects_honestly_and_releases`,
  `n1_panic_produces_honest_failure_and_releases_capacity`.
- Isolation: both live in `investigation.rs`; zero contact with the Bayesian
  mathematics.

## N1.3 follow-up recorded (per mission §8)

- **DNS timeout unused:** `probe_dns(host, port, _timeout)` ignores its
  timeout — OS resolver call is unbounded. Registered as part of the probe
  hygiene work; **not touched in N1.1** (no timeout semantics altered). To be
  resolved in N1.3 with actual timeout-behavior tests before the finding can
  be marked resolved.
- Related and newly registered: **NANI-021** (loopback HTTP interception
  corrupts probe layer semantics — HIGH, OPEN): probe integrity needs a
  design decision (direct-path enforcement vs an explicit "intercepted"
  outcome) before or alongside N1.3's timeout work, since both touch the
  probe path.

---

# ADDENDUM — Post-review condition landings (after N1_REVIEW_01)

## K-2 (cap check/insert race): **LANDED** (investigation.rs)

Cap check and `active.insert` are now one critical section in `start()` — two
simultaneous starts can no longer both pass the check and insert. Verified:
full suite 541/0 after the change.

## K-3 (verification prose inverted for reproduced failures): **LANDED** (investigation.rs)

`run_verify_stage` now returns `(verified, failure_reproduced)`, and the
result text is three-way and honest:
- failure **reproduced** on re-measurement → "...reproduced on
  re-measurement (confidence X%); failure confirmed." (never "unverified")
- implicated layer **passed** → "...not reproduced on re-measurement
  (confidence X%); treat as uncertain."
- layer **unmeasured** → "...not verified (implicated layer unmeasured);
  treat as uncertain."
The `verified` boolean and event schema are unchanged (N0/N1 contracts).

## K-1 (ms timestamps into the seconds-calibrated engine, manual-check path): **APPLIED UNCOMMITTED — awaiting the concurrent author's commit**

The one-line conversion (`probe.timestamp /= 1000`, with the K-1/NANI-022
rationale in a comment) is applied in the working tree of
`src-tauri/src/commands/nani.rs` — that file is the concurrent author's
uncommitted WIP and is deliberately NOT staged by this commit; the edit rides
with their next commit. The `for probe in &probes` loop became
`for mut probe in probes` (consumed; same semantics otherwise). Full suite
verified 541/0 with the edit in place. **Do not present `nani_math`
diagnosis output as trustworthy until this lands in a commit.**
