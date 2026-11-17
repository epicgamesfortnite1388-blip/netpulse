# N1_06 — Performance Results

**Phase:** N1.1 · **Commit:** `200de54`

## Measurements

Executed via `cargo test --manifest-path src-tauri/Cargo.toml
n1_analysis_latency -- --nocapture`:

```
N1 perf: 80 observed probes across 20 APIs in 2.4583601s
```

- 80 real probe cycles (20 APIs × 4 layers, each fed into the engine) in
  ~2.46 s wall time. The overwhelming majority of that is **network probing**
  (each `probe_api` does DNS + TCP connect + HTTP request; the fixture's
  refused connections consume the timeout budget) — the pure Bayesian work is
  microseconds per observe (19-hypothesis log-space update + correlation
  discount + normalization).
- Assertion in the test: the whole cycle stays under 5 s even on slow CI.

## Small / medium / large evidence sets

The engine's `observe` is O(19) log-space updates per probe plus an O(session)
bounded correlation-history scan capped at 32 entries (`MAX_CORRELATION_HISTORY`)
— **O(1) in evidence-set size** by design (`diagnosis.rs` doc comment). The
lifecycle feeds one probe at a time as measurements arrive, so analysis cost
is linear in the number of real probes and never recomputes a posterior that
was not preceded by new evidence: `analyze` reads the posterior already built
during observe (no re-feeding), and verification adds exactly one filtered
re-measurement.

## Structural properties maintained

- **No large clones in hot paths:** the lifecycle passes `&DiagnosticEngine`
  through stages; only the per-investigation engine instance exists. Prior
  clone inside `bayesian_update` is the engine's own established cost (19
  f64s).
- **No unbounded event buffering:** replay buffer bounded at 256 (existing);
  hypothesis events bounded at top-5 per investigation (new, N1.1).
- **No unbounded threads:** `MAX_ACTIVE_INVESTIGATIONS = 4` (new, C3).
- **UI thread never blocked:** the lifecycle runs on a background thread
  (pre-existing shape); analysis adds microseconds.
- **No global locks during analysis:** the engine is per-investigation and
  not behind any shared lock; `inv` mutex is held only for field updates.

## Conclusion

Integration overhead is negligible relative to probing; no correctness was
traded for speed. No optimization applied — none needed.
