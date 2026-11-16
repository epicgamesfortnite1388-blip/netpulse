# NANI Performance Benchmarks

## Methodology
- `cargo test` (debug profile) for correctness and timing.
- No criterion harness configured; micro-benchmarks are embedded in unit tests.

## Measured
- Full Rust test suite: 322 passed, 2 ignored, ~4.7s (debug).
- Network intelligence module tests: 159 passed, ~0.8s (debug).
- Build: `cargo build` success, ~0.4s incremental.

## Not measured
- Idle/active CPU, RAM, UI frame rate (no frontend NANI panels yet).
- Inference latency (no local model).
- Observation throughput under load.

## Status
Performance claims are not yet validated; targets (60 FPS, bounded memory) remain goals.
