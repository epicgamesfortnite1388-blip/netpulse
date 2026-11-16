# NANI Causal Reasoning Report

## Implementation
`src-tauri/src/network_intelligence/causal.rs`, `graph.rs`, `diagnosis.rs`, `evidence/correlation.rs`.

## What is estimated

`CausalTracker::estimate(action, context)` returns `CausalEstimate`:

| Field | Meaning |
|---|---|
| `treated_n`, `control_n` | records in each arm (both restricted to failed-baseline, controlled records in the same context) |
| `treated_success_rate`, `control_success_rate` | `p1`, `p0` (fraction of post-intervention successes) |
| `ate` | `p1 − p0`, the average treatment effect |
| `ci95` | `(p1−p0) ± 1.96·√(p1(1−p1)/n₁ + p0(1−p0)/n₀)` |
| `identifiable` | whether the ATE may be quoted at all |
| `reason` | why it is or is not identifiable |

## Gating (why this is not a correlation-to-causation claim)

An estimate is produced only when **all** of the following hold:

1. The record is `controlled` — the intervention outcome was actually observed after the action.
2. The baseline had already failed (`baseline_success == false`), so the comparison is among failures.
3. Both arms have at least `min_arm_size` observations.
4. `action != CONTROL_ACTION` (the control has, by definition, no treatment effect).

Otherwise `ate = None`, `identifiable = false`, and `reason` says which condition failed
("insufficient controlled observations", "control action has no treatment effect", …). NANI therefore
reports **no** effect rather than a spurious one.

## Observation vs intervention
Observational records are tracked (bounded at `max_records`, default 1000) but cannot produce an ATE.
This is the mechanism that prevents "this endpoint is slow and also blocked, therefore filtering" style
inference: only a controlled comparison against no action in the same context yields an effect.

## Dependency structure
`evidence/correlation.rs` encodes shared causal paths as `CorrelationGroup`s (e.g. resolver, gateway,
TLS chain). `weight_for` discounts later observations on the same path, which is how downstream failures
stop being treated as independent evidence.

`graph.rs` provides `NetworkGraph` / `NodeId` / `NodeType` / `Edge` for the staged model
(interface → resolver → route → TCP → TLS → proxy → endpoint → application), used to reason about which
stage an observation belongs to.

## Contradictory evidence and UNKNOWN
The posterior always includes every hypothesis; when no controlled evidence exists, the highest posterior
is not promoted to a causal claim, and the recovery planner reports `insufficient-evidence` rather than
inventing a cause.

## Tests
`causal.rs` tests cover: unidentifiable with only treated arm, unidentifiable with insufficient arm size,
control action has no effect, identifiable ATE sign and CI containing the point estimate, bounded history.
`evidence/correlation.rs` tests cover independence, correlated discounting and same-test full weight.

All passing in the phase run (`cargo test network_intelligence::` → 340 passed; 0 failed).

## Known limitations
- Difference of proportions assumes independent arms; within-arm dependence is only handled by the
  upstream correlation discount on evidence, not inside this CI.
- No stratification, propensity matching or adjustment for confounders beyond context equality. Context is
  the only matching variable, which is why context is part of the key.
- The CI is a normal approximation and is unreliable for very small arms; the `min_arm_size` gate is what
  keeps it usable.
- `Graph` supports structure; it does not run do-calculus or backdoor adjustment.

## Status
- Implemented: ATE with identifiability gating, CI, bounded record store, dependency groups, graph model.
- Tested: yes.
- Benchmarked: not separately; `estimate()` is `O(n)` over a bounded record list.
- Integrated: `foundation.rs` facade; recovery planning consumes identifiability.
- Verified: unit level.
- Blocked: no UI surface for per-action ATE / dependency graph.
