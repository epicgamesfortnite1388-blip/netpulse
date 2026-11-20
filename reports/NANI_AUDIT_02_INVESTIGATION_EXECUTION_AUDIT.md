# NANI_AUDIT_02 — Investigation Execution Audit (Mission B)

Verdict up front: **NANI cannot currently investigate network problems.** The lifecycle machinery runs; every connection it needs to do real work is severed. Evidence per stage:

## Stage-by-stage audit

| Stage | Code | Executes? | Real input? | Meaningful result? |
|---|---|---|---|---|
| Start | `commands/nani.rs:121` → `InvestigationManager::start` (investigation.rs:202) | ✅ bg thread spawned | query validated (trim, ≤500 chars) but **the query is never used to target anything** | id returned |
| Observe | `run_observe_stage` investigation.rs:528 | runs, but iterates `registry.ids()` of an **empty** registry → loop body never executes | — | **0 observations, always** |
| Probe | `probe_api` (api_intelligence/monitor.rs) — real DNS (`to_socket_addrs`), TCP (`TcpStream::connect_timeout`), TLS/HTTP with bounded timeouts | ✅ implemented (proven by health-check path) | real | — but **unreachable from investigations** |
| Analyze | `run_analyze_stage` investigation.rs:637 | ✅ | empty observations | `insufficient=true`, top=None, confidence 0.0 — honest emptiness, but produced by a **frequency counter, not the Bayesian engine** |
| Hypotheses | per-layer failure ratios ("dns", "tcp"… with confidence = fail share) | ⚠️ naive | real (when probes exist) | layer names ≠ hypotheses; no competing-explanation machinery; the 12-hypothesis taxonomy + likelihoods are never consulted |
| Verify | `run_verify_stage` :716 | returns `false` immediately (`api_ids.is_empty()`) | — | never verifies anything |
| Complete | status recorded | ✅ | — | "Completed" with empty evidence — the exact user complaint |
| Events | all lifecycle events | ❌ placeholder bus (no AppHandle) — never reach `nani:event` channel or the replay buffer | — | UI live view + event-derived Evidence/Hypotheses tabs structurally blind |
| Persistence | `max_history: 50` in memory (investigation.rs:191) | ❌ no disk write | — | all history lost on restart |

## Probe inventory (what exists vs what the product needs)

| Probe | Exists? | Where | Reached by investigations? |
|---|---|---|---|
| DNS resolution | ✅ | monitor.rs `probe_dns` (real, bounded) | ❌ (empty registry) |
| TCP connect | ✅ | `probe_tcp` | ❌ |
| TLS / HTTP layer | ✅ | failure_classifier + monitor | ❌ |
| Web-mode equivalents | ✅ | naniProbeAdapter.ts | n/a (web mode, separate engine) |
| DNS consistency across resolvers | ❌ | — | — |
| Packet loss / jitter | partial (stabilityService, node tests — Node side) | not NANI | ❌ |
| Interface/route/gateway state | ❌ in NANI (exists in Node `systemProxy`/`tunClaim` services, not wired) | — | ❌ |
| Proxy/VPN-tunnel detection | ❌ not wired into NANI inputs | — | ❌ |
| MTU | ❌ (simulator condition only) | — | ❌ |
| Endpoint-specific connectivity | partial (node test probes — Node side) | not NANI | ❌ |

## False-diagnostic behavior check

- No hardcoded diagnoses found; the empty-result path is honest (`insufficient`).
- **But**: with the Bayesian engine bypassed, the system *would* present `confidence = failure_ratio` as a hypothesis confidence if probes existed — an uncalibrated frequency presented in the same UI slot that `nani_math_hypothesis_view` renders with Bayesian posteriors. Two different "confidence" semantics share one UI surface (mission §4 violation of concept separation).
- Health of the one registered API (netpulse-cloud) is currently poisoned by the **D1 read-quota exhaustion** (error 7500 verified in W0-1/Phase-2) — the monitor will classify the cloud as failing for reasons that are *billing*, not network. NANI has no concept for that; the diagnosis would be misleading by construction.

## What an investigation CAN conclude today

`InvestigationStage`/`InvestigationOutcome` semantics are honest: Completed / Failed / Cancelled; `insufficient` flag exists; cancel is cooperative. The machinery for honest uncertainty is present. It just never receives data.
