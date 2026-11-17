# N1_2_01 — Timestamp Contract and K-1 Fix

**Phase:** N1.2 · **Commits:** `d46ece9` · **Baseline:** `c7fe33b` (N1-review conditions landed)

## 1. Complete caller map (mission §3, verified by grep at HEAD `c7fe33b` + working tree)

Every production entry point that can move a `DiagnosticEngine`:

| # | Caller | File / symbol | Engine | Unit before N1.2 | Unit now |
|---|---|---|---|---|---|
| 1 | Investigation lifecycle (observe) | `investigation.rs` `run_observe_stage` | per-investigation | seconds (N1.1 call-site conversion) | **seconds via `observe_diagnostic_probes`** |
| 2 | Investigation lifecycle (verify) | `investigation.rs` `run_verify_stage` | per-investigation | seconds (N1.1 call-site conversion) | **seconds via `observe_diagnostic_probes_matching`** |
| 3 | Manual health-check command | `commands/nani.rs` ~L313 (concurrent author's WIP) | shared `state.math` | **milliseconds — the K-1 bug** | seconds (conversion applied in working tree, see §4) |
| 4 | Monitor loop | `monitor_loop.rs` | — (does NOT feed the engine; `record_probe` only) | n/a | n/a |
| 5 | `nani_context_observe` | `commands/nani.rs:258` | — (NetworkContext, not the DiagnosticEngine) | n/a | n/a |
| 6 | foundation/diagnosis `observe` calls | `foundation.rs:1389`, `diagnosis.rs:1362` | — (tests only) | n/a | n/a |

Exactly **two** production feeders. No third path exists.

## 2. The contract, made structural

`monitor.rs` now owns the boundary:

- `observe_diagnostic_probes(engine, &outcome)` — THE canonical feed.
- `observe_diagnostic_probes_matching(engine, &outcome, keep)` — the filtered
  form (verification targets one claim); **identical conversion**, asserted by test.

Both perform `probe.timestamp /= 1000` exactly once, with the rationale in the
doc comment (ms delta of 5000 → `mix = exp(-5000)` ≈ 0 → ~100% of the
posterior erased). The engine's mathematics are **unchanged** — `git diff`
touches no line of `diagnosis.rs`/`math.rs`.

The investigation paths were refactored to route through the boundary, so the
conversion can no longer drift between them.

## 3. Regression tests (all committed, all green)

- `k1_helper_converts_ms_to_seconds` — the engine's clock receives the second
  value (`1_700_000_000`), never the raw ms stamp.
- `k1_five_second_delta_preserves_the_posterior` — a confirming probe 5 s
  later does not weaken the belief; the accumulated posterior survives.
- `k1_millisecond_delta_would_erase_the_posterior` — **comparative tripwire**:
  ten identical confirming probes 5 s apart reach ~0.42 through the converted
  boundary vs ~0.24 when ms deltas leak through — the 1000× error materially
  degrades accumulation. If this stops holding, the boundary or the kernel
  calibration changed.
- `k1_filtered_helper_uses_the_same_conversion` — the verification path's
  filtered feed applies the same unit conversion, and filtered-out probes do
  not observe at all.
- `k1_zero_elapsed_time_is_an_identity_predict` — zero delta follows the
  engine's identity-predict contract.

Out-of-order / invalid timestamps: the engine's existing contract stands
unchanged (a non-advancing timestamp is not predicted on; NaN-style garbage
cannot occur through u64 stamps). Type-level enforcement was considered and
**deferred**: a newtype would touch every `ProbeResult` consumer for
marginal gain now that exactly one boundary owns the conversion (recorded as
the durable option in NANI-022).

## 4. Coordination status for the concurrent author's file (honest)

`commands/nani.rs` is the concurrent author's **uncommitted** work — the
manual health-check feature itself does not exist at HEAD, so a K-1 commit
cannot be isolated from their feature. Resolution, per the mission's
coordination rule:

- The one-line conversion (`probe.timestamp /= 1000` + rationale comment,
  loop adjusted to consume `probes`) is **applied in the working tree** of
  their file, byte-preserving all of their other edits (verified: the diff
  contains only the feed-loop change).
- It is **deliberately NOT staged** by the N1.2 commits; it rides with their
  next commit. The N1_07 addendum and this report document it.
- **K-1 is therefore PARTIAL-by-coordination, not BLOCKED**: the working tree
  (what the developer actually runs) is correct; the committed tree still
  lacks the manual-check feature entirely, so the committed binary has no
  ms-feeder at all. Full suite verified 552/0 **with** the working-tree edit
  in place.

## 5. NANI-022 status (accurate, not over-claimed)

- Fixed: both production call sites now use seconds (one committed, one in
  the author's working tree).
- Still open: the engine's internal unit ambiguity (`delta_seconds` parameter
  vs `CORRELATION_WINDOW_MS` in ms) — unchanged by design in N1.2, tracked.
