# N1_2_02 — Atomic Concurrency and K-2 Fix

**Phase:** N1.2 · **Commits:** `c7fe33b` (atomic admission), `d46ece9` (stress proof)

## The fix

Admission in `InvestigationManager::start()` is now **one critical section**:
the cap check, the id allocation, and the `active.insert` (the reservation)
all happen under a single acquisition of the manager's existing inner lock.
No new lock types, no global locks, no contention added — the section is
O(1) bookkeeping.

The race Kim identified (thread A checks → thread B checks → both insert) is
structurally impossible now: a second thread cannot observe a non-reserved
slot because the reservation is committed in the same critical section that
checks it.

## Acceptance criteria walked

- Limit remains 4 (`MAX_ACTIVE_INVESTIGATIONS` — the constant Kim's review
  documented; no configuration contract specifies otherwise).
- Concurrent starts cannot exceed it (atomic reservation + stress proof).
- Rejected starts get an explicit truthful result
  ("Investigation rejected: concurrency limit (4) reached.") and are never
  marked running (no `active` entry; terminal `Failed` record + event).
- Admission reserves capacity **before** the background thread spawns.
- Release paths: completion / failure / cancellation → `retire_from` →
  `active.remove`; panic → the `guarded_lifecycle` path (same retire); all
  covered by existing tests re-verified this phase.
- **Thread-spawn failure** (honest note): `std::thread::spawn` aborts the
  process on OOM rather than returning an error, so a spawn failure is
  process-fatal — a permit cannot outlive the process. Not portably
  testable; documented rather than claimed.
- Duplicate ids cannot double-reserve: ids are allocated under the same
  critical section (`next_id` monotone from 1), so one id ↔ one reservation.
- Shutdown: the manager is process-local state; process exit reclaims
  everything. No persistence of reservations exists.

## The stress test (deterministic, no sleeps)

`k2_hundred_simultaneous_starts_never_exceed_the_cap`
(investigation.rs tests):

- 100 threads synchronized on a `std::sync::Barrier(100)` — all start
  calls become simultaneous by construction.
- A hanging endpoint + 60 s probe timeout keeps admitted investigations
  active for the assertion window.
- Asserts: **exactly 4 admitted**, active length == 4 (maximum observed
  concurrency equals the cap), the id allocator issued exactly N identities
  (`next_id == N + 1`; ids allocate from 1 — this off-by-one was caught and
  corrected during development), and every *recoverable* non-active record
  is the honest rejection.
- Bounded-history accounting is documented in the test: rejections land in
  the 50-record history, so early rejection records may be truncated — the
  deterministic invariants are the active count, the allocator total, and
  the marker on every surviving non-active record.

Repeated runs (4× this session): green every time. Admission latency: the
barrier test's entire 100-start cycle completes in ~10–30 ms (measured via
the test's `finished in 0.01–0.02s` timing), i.e. single-digit
microseconds per admission decision.
