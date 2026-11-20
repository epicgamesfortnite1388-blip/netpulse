# N1_2_REVIEW_04 — K-2 Concurrency and Resource-Safety Audit

**Reviewer:** Kim · **Mode:** read-only + independent test reproduction

## A. State machine (reconstructed from source at HEAD)

```
START: lock inner (Mutex, poison-tolerant unwrap_or_else(into_inner))
  ├─ active.len() >= 4 → rejected=true (no reservation; id allocated from
  │    the same counter — allocator stays exact, rejected ids never reused)
  ├─ else → reservation: active.insert(id, inv_arc)  ← SAME critical section
  └─ lock released (block end) BEFORE event emission / thread spawn
SPAWN: thread::spawn(guarded_lifecycle) — spawn failure = process abort
       (std::thread::spawn panics on allocation failure; honest, documented)
RUN: stages emit events; NO inner lock held during network I/O
TERMINAL PATHS → retire(record): remove from active (release-once, by the
  investigation's own id): complete / fail / cancel / panic guard
     (catch_unwind in guarded_lifecycle) / insufficient-evidence refusal
```

Every mutation of `active` searched: `insert` (one site, admission),
`remove` (one site, `retire`). No other write path exists.

## B. Admission invariant — proven by inspection + stress

Check and reservation are one critical section (committed code verified at
`git show 2a9f825` — see REVIEW run output: `rejected = active.len() >= 4`
immediately followed by `active.insert` before the lock guard drops). No
path checks-without-reserving or reserves-without-checking. Release happens
only at terminal paths, by the owner's own id ⇒ no cross-slot release, no
double-release (single remove site; retire is idempotent-safe but called
once per lifecycle — asserted by the panic/completion tests). A stale entry
after cancellation is impossible: cancellation goes through the same retire.

## C. Independent stress reproduction — **executed fresh, 2 runs**

`k2_hundred_simultaneous_starts_never_exceed_the_cap` (Barrier-synchronized
100 threads, hanging HTTP endpoint on port 1, 60 s outer timeout):
- Run 1: exactly 4 admitted, 96 honest rejections, `next_id == 101`, active==4, PASS.
- Run 2: same, PASS.
Test-design challenge: the Barrier makes contenders genuinely simultaneous;
the test observes the admission results and final counts. It cannot observe
a *transient* mid-section violation directly — none is possible by
construction (single mutex section), which is the stronger argument than
sampling. Full-suite runs (552/0 twice fresh) re-exercised it incidentally.
1000-start variant: not executed (marginal — the mutex section is O(1); no
new failure mode scales). Documented, not hidden.

## D. Lifecycle and release audit (reasoned path-by-path)

Normal completion / probe failure / analysis failure / verification
failure / refusal / cancellation / panic: all funnel to the same terminal
retire (verified by call-graph: `guarded_lifecycle` wraps every stage path;
`catch_unwind` maps panic → honest failure record + retire). Duplicate ID:
impossible — ids come from the same mutex-guarded counter. Spawn failure:
process-fatal (std::thread semantics) — justified limitation, honestly
documented in N1_2_02; recoverable spawn failures don't exist in std.
Concurrent shutdown: no shutdown path mutates `active` (drop-only); noted.

## E. Locking and deadlock analysis

- Lock order: single lock (`inner`) — no nested locks, no ordering hazard.
- Held duration: O(1) map ops; released before event emission and all I/O
  (verified: the `(id, seq, rejected, inv_arc)` block ends before emits).
- No lock across `.await`/network (manager is sync; worker threads do I/O).
- Poisoning: `unwrap_or_else(|p| p.into_inner())` everywhere — panic in a
  worker cannot deadlock admission; catch_unwind prevents poisoning at the
  source anyway.
- Starvation: mutex is fair enough for O(1) sections; the stress test shows
  no starvation at 100 contenders.

## Verdicts

- Admission atomicity: **PASS** · Maximum concurrency (≤4): **PASS**
- Slot ownership: **PASS** · Release correctness (all terminal paths): **PASS**
- Cancellation correctness: **PASS** · Panic correctness: **PASS**
- Duplicate-ID safety: **PASS** · Locking safety: **PASS**
- Stress verification (2 fresh runs + 4 prior): **PASS**
