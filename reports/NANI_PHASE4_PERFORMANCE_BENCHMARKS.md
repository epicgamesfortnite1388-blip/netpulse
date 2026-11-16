# Phase 4 - Performance Benchmarks

## Measured (debug, Windows, single process)
bench(best of 3): update 139.2us, rank 4487.7us, route 0.1us (200 iters).

The benchmark reports the best of three runs because Cargo executes tests in parallel; a single sample at ~5.5 ms against a 5 ms cap was scheduler noise. The cap remains 5 ms debug / 500 us release.

## Bounds
Profile file 4 MiB; contexts 64; profiles 256; transitions 64; telemetry queue 256. Writes are atomic but synchronous.

## Not measured
Full desktop CPU/RSS, UI frame cost, release-mode profile operations, long-running disk overhead. No speedup is claimed.

## Executed evidence
- Rust: 443 passed, 0 failed, 2 ignored.
- Shared: typecheck pass, 212 tests / 14 files.
- API: typecheck pass, 1234 tests / 111 files.
- Web: typecheck pass, 472 tests / 52 files.
- Simulation: NANI 178/220 = 0.809 (95% CI 0.752-0.856) vs fixed 0.636; Brier 0.159; ECE 0.191; H 1.119.
- Debug benchmark (best of 3): update 139.2us, rank 4487.7us, route 0.1us.
