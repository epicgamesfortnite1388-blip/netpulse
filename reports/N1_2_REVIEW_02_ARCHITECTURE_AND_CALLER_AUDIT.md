# N1_2_REVIEW_02 — Architecture and Caller Audit

**Reviewer:** Kim · **Mode:** read-only, reconstructed from source at HEAD + working tree

## 1. Production call graph (independently traced)

```
probe_api(entry)                                  monitor.rs (unchanged)
├─ probe_dns / probe_tcp / probe_http             (layer measurements)
└─ ProbeOutcomeRecord { layers[], timestamp_ms }

Feeder 1 — INVESTIGATION LIFECYCLE (committed, seconds):
  investigation.rs run_observe_stage
    → observe_diagnostic_probes_matching(engine, &outcome, |_| true)   [monitor.rs]
        → diagnostic_probes(&outcome) → keep? → timestamp /= 1000 → engine.observe
  investigation.rs run_verify_stage
    → observe_diagnostic_probes_matching(engine, &outcome, |id| id == test)
  run_analyze_stage: engine.diagnosis()/ranked()
  run_lifecycle: engine.diagnosis() post-verify → verdict

Feeder 2 — MANUAL HEALTH CHECK:
  AT HEAD (2a9f825):      commands/nani.rs:296-302
      diagnostic_probes(&outcome) → for probe in &probes { math.observe_probe(probe) }
      → foundation.rs observe_probe → diagnosis.observe     ← RAW MS — K-1 LIVE AT HEAD
  WORKING TREE (author WIP + Will's applied conversion):
      same loop, `for mut probe in probes { probe.timestamp /= 1000;
      math.observe_probe_recording(&probe) }`                ← fixed, unstaged

NOT feeders (verified, not assumed):
  monitor_loop.rs — registry.record_probe only; no engine feed.
  nani_context_observe (nani.rs:258) — NetworkContext, different engine.
  foundation.rs:1389 / diagnosis.rs:1362 observe calls — #[cfg(test)] only.
  information_theory.rs — reads the engine, never observes.
```

## 2. Caller inventory (repository-wide symbol search + manual tracing)

Searched: `diagnostic_probes`, `observe_diagnostic_probes`,
`observe_diagnostic_probes_matching`, `observe_probe`,
`observe_probe_recording`, `.observe(`, `.predict(`. Every hit classified:
2 production feeders, 1 committed + 1 working-tree path for feeder 2, tests
otherwise. No wrapper, callback, closure, or trait indirection reaches the
engine from elsewhere (the engine type is concrete, not trait-dispatched; a
repository-wide search for `&mut DiagnosticEngine` parameters finds only the
boundary functions and investigation internals).

## 3. Timestamp contract (complete conversion chain)

```
unix_now_ms (u64, wall-clock, ms)          [probe_api]
  → ProbeOutcomeRecord.timestamp_ms (ms)   [ms]
  → diagnostic_probes: ProbeResult.timestamp = timestamp_ms   [ms]
  → BOUNDARY: observe_diagnostic_probes*: timestamp /= 1000    [→ seconds, EXACTLY ONCE]
  → engine.observe: previous_timestamp/delta in SECONDS
  → predict(delta_seconds): mix = exp(-0.001·Δ)             [calibrated for seconds]
```

- Units at the API boundary are documented in the helper's doc comment (verified at HEAD).
- Conversion occurs **exactly once**: the investigation paths convert only
  inside the helper; the working-tree manual path converts only at its loop.
  No double conversion exists (grep + trace).
- Zero is a valid delta (identity predict — engine contract, test-pinned).
- Out-of-order: `observe` predicts only when `result.timestamp >= prev_ts`
  (diagnosis.rs:636) — non-advancing clocks skip predict, matching the
  engine's established behavior.
- Clock source: wall-clock (`SystemTime`) — a system clock jump backwards is
  skipped for predict; a large forward jump triggers the correlation-window
  clear (at HEAD's ms semantics, 300_000 ms = 5 min — accidental consistency;
  in the seconds path, 300_000 s ≈ 3.5 days — effectively "never" within a
  bounded investigation, which is the intended within-investigation behavior;
  the engine-internal ambiguity remains NANI-022).
- Monotonicity: not enforced by the engine; relied upon from wall clock —
  pre-existing property, unchanged by N1.2.

## 4. Bypass-risk registry

| Risk | Status |
|---|---|
| Third feeder appearing later | Mitigated structurally: the boundary is the only conversion owner and its doc comment mandates use; no compiler-level enforcement — recommend the newtype (NANI-022 durable fix) eventually |
| Filtering changing unit semantics | Closed: `observe_diagnostic_probes_matching` applies the same `/= 1000` after the filter (test `k1_filtered_helper_uses_the_same_conversion`) |
| Double conversion | Closed: single conversion site per path (verified) |
| Test-only code reaching the engine | Bounded to `#[cfg(test)]` modules |
| HEAD/ms-feeder | **OPEN — the committed tree bypasses the boundary** (see REVIEW_01 §3); remediation: surgical committed-tree patch or the author's commit |

## 5. Disagreements with Will's architecture description

One, material: the feeder count is "two production feeders, one of them
committed with the bug" — not "one committed + one working-tree-only."
Everything else (boundary ownership, filter semantics, engine non-touch)
verified as described.
