# NANI Final Architecture Audit

**Date:** 2026-11-14
**Repository:** `E:\Code\Project\Vpn_app`
**Status:** Audit complete. Findings below describe the code that was actually present and changed.

## AI dependency inventory

| Component | Current implementation | AI dependency | Mathematical alternative | Action taken |
| --- | --- | --- | --- | --- |
| Diagnostics | `network_intelligence/diagnosis.rs`: dynamic Bayesian posterior, likelihood table, transition model | None | Bayesian inference, information gain | Wired correlated-evidence discount into `observe` |
| Failure classification | `api_intelligence/failure_classifier.rs` and `api_model.rs` | None | Structural rules + logistic model | Unchanged |
| Network scoring | `route.rs`: multi-objective scoring, Pareto, CVaR, LCB | None | Optimization | Unchanged |
| Configuration parsing | `apps/api` parsers (VLESS/VMess/Trojan/SS/WireGuard/OpenVPN) | None | Deterministic parsing | Unchanged |
| Configuration scoring | `config_intelligence.rs` | None | Confidence-aware scoring | Unchanged; audits below |
| Configuration discovery | API source registry + gatherer | None in the core path | Source reputation, validation states | Unchanged |
| API health | `api_intelligence/`: multi-layer probes, circuit breaker | None | Independent health models | Default registry reduced to NetPulse Cloud only |
| Recovery decisions | `recovery.rs`: ranked, authorized actions | None | Decision theory, safety constraints | Unchanged |
| Learning | `learning.rs`: profiles, hierarchical reliability, drift, episodes | None | Online statistics | Unchanged; in-memory |
| Copilot / natural language | was `apps/web/src/features/copilot` → cloud `/api/v1/ai/ask` | **Cloud AI (mandatory)** | Deterministic explanation + optional local model | Replaced with local `nani_explain`; cloud call removed |
| Natural-language input | Copilot page | Local model only, optional | Deterministic templates | Implemented `ai/` runtime, disabled by default |

## Dependency classification

1. **Essential language functionality:** optional local LLM explanation (`ai/`). Not required.
2. **Replaceable deterministic functionality:** Copilot explanation — now deterministic first.
3. **Replaceable mathematical functionality:** none found; diagnosis/scoring already mathematical.
4. **Unnecessary AI functionality:** default background probes to `xkiro` and `deepseek` in the desktop registry and API registry. Removed.
5. **External cloud AI dependency:** cloud worker `/api/v1/ai/ask` and `/api/v1/ai/stream` still exist as an optional external integration, but the desktop no longer calls them and no core function depends on them.

## Verified structure

- 38 Rust modules under `network_intelligence/`, including probability, Bayesian inference, information theory, robust statistics, change-point detection, time series, graph, survival, optimization, sequential testing, recovery and persistence.
- The engine is constructed in `main.rs`; `LearningEngine` is called by the live `MonitorLoop` after every API probe.
- Tauri IPC exposes NANI status, learning status/drift/reset, health checks, and now local explanation/status.
- The frontend's Copilot no longer performs any HTTP AI request.

## Defects found

1. Correlated probes multiplied the posterior as independent evidence. Fixed in `diagnosis.rs` with a bounded, confidence-gated discount.
2. The entropy test expected 15 hypotheses while the space contains 17; the test was hard-coded. Corrected to derive `n` from `Hypothesis::all()`.
3. `AdaptiveRecoveryCard.tsx` contained an orphaned, malformed JSX block appended after the component's closing `return` and referenced fields that do not exist on `AdaptiveStatusDto`. Removed; this blocked the production TypeScript build.
4. No local LLM runtime existed despite earlier reports claiming one. Implemented.
5. External AI provider endpoints were probed by default. Removed from default registries.

## Remaining architectural limits

- Local learning state is in memory and does not survive restart.
- The local model has no bundled weights and no runtime binary; model benchmarking is blocked (see `NANI_LOCAL_LLM.md`).
- Diagnosis is wired to simulated/manual probes, not to a single unified NANI orchestrator that owns every live diagnostic path.
- `apps/api` still has an optional cloud AI proxy; it is not used by the desktop.
