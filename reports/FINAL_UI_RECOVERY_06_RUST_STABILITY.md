# FINAL_UI_RECOVERY_06_RUST_STABILITY

## Final result

Command:

```bash
cargo test --manifest-path /e/Code/Project/Vpn_app/src-tauri/Cargo.toml
```

Final output:

```text
test result: ok. 552 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 13.28s
test result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

Full log: `reports/FINAL_UI_visual_recovery/rust-final-2.log`.

## Investigation chronology

| Stage | Result | Interpretation |
|---|---|---|
| Prior mission (context only) | 549 passed / 3 failed / 2 ignored was reported earlier; no log retained in this recovery evidence set, so it is not used as gate evidence |
| First captured full suite in this recovery | 550 passed / 2 failed / 2 ignored — N0 timeout and N1 oracle divergence remained |
| After N0/N1 diagnosis | 552 passed / 0 failed / 2 ignored — both remaining failures were test-side |

## Root cause 1 — fixture timeout exceeded test wait cap

`ApiEntry::new` defaults to `timeout_ms = 10_000`, but the test helper `wait_terminal` waits at most 6 s (`600 × 10 ms`).

The following fixtures were shortened to 50 ms across the recovery investigation:

- `n0-test-api` (healthy localhost leg).
- `n0-failing-api` (closed loopback port, verify leg).
- `n0-late-api` (late healthy registration leg).
- `n1-fail-api` (N1 oracle closed-port fixture).
- `n1-old-api` (old-path guard closed-port fixture).

At the final diagnostic step, the last two still using the 10 s default were `n0-failing-api` and `n0-late-api`.

Diagnostic evidence:

```text
investigation nani-investigation-2 did not reach a terminal state in 6s; last status:
Some(InvestigationStatus {
  query: "failing endpoint check",
  stage: "verify",
  outcome: None,
  observation_count: 8,
  hypothesis_count: 5,
  top_hypothesis: Some("ipv4"),
  confidence: 0.24244923232455667,
  ...
})
```

This proved the first (“n0 integration check”) leg had passed and the timeout was in the failing-endpoint verify leg.

**Fix:** set `entry.timeout_ms = 50` on the remaining N0 loopback fixtures. This changes only how long a deterministic closed-port/local-server test waits; it does not change production timeouts.

## Root cause 2 — stale N1 oracle

Failure:

```text
assertion `left == right` failed
  left: Some("ipv4")
 right: Some("quic_udp_failure")
```

At the failing assertion, `ev_top` came from `AnalysisCompleted`, which is emitted **before** verification. `status.top_hypothesis` is recomputed from the engine **after** the verification probe is observed (N1.1). Production code comment:

```rust
// N1.1: the verification probe is real evidence — the authoritative
// engine has absorbed it, so the FINAL verdict comes from the updated
// posterior, not from the pre-verification snapshot.
```

The test was asserting that two intentionally different lifecycle snapshots must be equal.

**Fix:**

```rust
// `AnalysisCompleted` is deliberately the PRE-verification posterior.
// The final status is recomputed after the verification probe is fed
// into the same engine (N1.1), so these two labels may legitimately
// differ. Compare each artifact to its own contract.
assert_eq!(ev_top, pre_verify_top);
```

The final status remains compared to the post-verification reference posterior earlier in the same test.

## What was not changed

- No likelihood table values.
- No calibration algorithm.
- No evaluation threshold.
- No probe implementation.
- No event semantics.
- No production assertion.

## Conclusion

F-15 is **CLOSED** for deterministic test behavior. The earlier claim that a posterior mismatch was caused by F-01 remains **unproven** and is not repeated as fact.
