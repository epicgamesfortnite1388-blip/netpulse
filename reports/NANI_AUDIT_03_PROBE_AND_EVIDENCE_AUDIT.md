# NANI_AUDIT_03 — Probe and Evidence Audit (Mission B, evidence half)

## Probe implementation record (each row traced)

| Probe | Implementation | Invocation | Input | Executes? | Bounded? | Failure representation | Enters NANI evidence? | Persisted? | Tests |
|---|---|---|---|---|---|---|---|---|---|
| DNS resolve | `monitor.rs::probe_dns` | `probe_api` ← health-check cmd, MonitorLoop, (investigations: broken link) | real endpoint URL | ✅ | bounded (sync `to_socket_addrs` — no explicit timeout ⚠️) | `LayerResult::Failed` + latency | ✅ per-layer record | registry memory only; PersistenceStore **never written** | monitor/registry unit tests |
| TCP connect | `probe_tcp` (`TcpStream::connect_timeout`) | same | real | ✅ | ✅ explicit timeout | Failed/timeout | ✅ | ❌ | ✅ |
| TLS+HTTP | monitor + `failure_classifier::classify` | same | real | ✅ | bounded | per-category (401 ≠ outage) | ✅ | ❌ | ✅ |
| Web-mode probes | `naniProbeAdapter.ts::runDiagnosticTest` | web NaniService | real | ✅ | ✅ | DiagnosticObservation + sanitized error | ✅ (web engine) | repo tables (web) | ✅ |
| Monitor-loop probe cadence | `api_intelligence/monitor_loop.rs` | spawned main.rs:435 | real (1 API) | ✅ | ✅ circuit breakers + jittered retries | Health enum | ✅ → learning | ❌ (PersistenceStore created, never written — verified: zero production callers of `record_observation`/`set_model_state`) | loop tests |

⚠️ = real defect: `probe_dns` uses blocking `to_socket_addrs` without a timeout — a poisoned resolver stalls the health-check command thread (bounded risk, but a real reliability gap).

## Evidence flow audit

| Question | Answer | Evidence |
|---|---|---|
| Is evidence normalized before inference? | Layers classified per-category; ✅ for the health/monitor path | failure_classifier.rs |
| Is probe evidence double-counted? | Dedupe by (source, hypothesis) in `bayesian_update` (bayesian.rs:190–198) — protection VERIFIED present | prior adversarial tests |
| Correlation-aware updates? | Qualitative only (layer attribution); no quantitative correlation model (documented limitation) | — |
| Stale evidence? | `decay_log_likelihood` exp(−λ·age) + TS half-life — decay machinery exists; **but nothing persists observations, so "stale" is moot on desktop** | bayesian.rs:224 |
| Evidence provenance in UI? | Events carry `source`; Evidence tab derives from the event stream — sees only monitor events (investigation evidence dead) | NaniPage.tsx:1053 |
| Can the user inspect evidence later? | **No.** Nothing durable exists (persistence store unwritten; history in-memory 50) | — |

## Synthetic vs real

- `simulation.rs` (15-condition seeded simulator): test/bench-only — verified no production callers.
- `naniShadowHealthPass` (Node, desktop): advisory-only by design; off in desktop after T-01 plan (not yet executed — still runs today, FABLE-ARCH-001 OPEN).
- No fabricated measurements found anywhere in the probe path (consistent with Phase-1 forensics).
