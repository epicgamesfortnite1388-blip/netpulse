# N1_2_REVIEW_09 — Performance and Resource Audit

**Reviewer:** Kim · Method: fresh execution + code inspection; no invented numbers.

## Measured (executed by this reviewer, working tree)

| Metric | Result | Command |
|---|---|---|
| Observe-stage latency smoke | 80 probes / 20 APIs in **2.472 s** | `cargo test … n1_analysis_latency -- --nocapture` |
| Full suite wall time | 11.49 s / 6.98 s (two runs) | `cargo test --manifest-path src-tauri/Cargo.toml` |
| Web NANI suite | 34 tests, green | `npx vitest run src/features/nani` |

Consistent with Will's reported 2.46-2.47 s — no regression.

## Estimated / inspected (not invented as measurements)

- **Atomic admission:** the critical section is two O(1) map/counter ops
  (`active.len()`, `active.insert`, `next_id += 1`) — strictly shorter than
  or equal to the old two-acquisition pattern, and the lock is released
  before event emission and thread spawn. The K-2 fix did NOT increase lock
  hold time or serialize I/O (no network call, no await, inside the section).
- **Timestamp conversion:** one integer division per probe per feed —
  negligible; part of the measured smoke.
- **Allocations:** `for mut probe in probes` moves in place; the filtered
  variant allocates one closure — negligible.
- **Event generation:** unchanged by N1.2 (no event-schema code in the diffs).
- **Thread lifecycle:** cap=4 workers; k2 stress shows rejections, not
  queuing — no unbounded thread creation.
- **Memory after completion:** `active.remove` at every terminal path;
  history bounded (max_history=50, exercised by the k2 test's rejection
  accounting: 96 rejections truncated to 50 records — allocator total
  still exact via the counter, which is why the test asserts `next_id`,
  not history length).

## Verdict: Performance/reliability — **PASS**

No measured or structural overhead regression; the admission fix is a
pure-win change (fewer lock acquisitions than the pre-fix pattern).
