# NANI_AUDIT_05 — Reporting and Persistence Audit (Mission G)

## What exists

| Capability | Status | Evidence |
|---|---|---|
| Investigation record (in-memory) | ✅ real | `InvestigationRecord` — id, query, stage, outcome, observations, hypotheses, confidence, result; `list()` bounded to 50 |
| Investigation list/status commands | ✅ wired | `nani_investigations`, `nani_investigation_status` (real reads) |
| UI "Recent investigations" cards | ✅ reads real list | NaniPage.tsx:484–525 |
| PersistenceStore (observations journal + model state) | ⚠️ **created but never written by any production path** | main.rs:431 constructs; zero production callers of `record_observation`/`set_model_state` (grep-verified) |
| Report generation (structured diagnostic report) | ❌ **does not exist** | no report builder anywhere in the tree; the only "report" is the status DTO |
| Report retrieval/history UI | ❌ `features/nani-reports/` is unrouted/unimported dead UI | Phase-1 finding stands |
| Export | ❌ none for NANI (VPN configs have export; NANI doesn't) |
| Restart survival | ❌ investigations AND learning-windowed state lost (learning engine reloads model state from persistence — which is never written, so effectively cold every boot) |

## Consequence

A completed investigation leaves no durable, user-accessible artifact. The mission's report contract (19 fields) has **zero** current implementation. This is the second-largest product gap after the investigation wiring itself.

## What a report must be built from (all inputs already exist in memory at completion)

`InvestigationRecord` + per-layer `LayerResult`s + registry probe history + `NaniMathEngine` posterior/calibration state + verify outcome + event log. A report builder is a pure function over data the lifecycle already computes — the gap is persistence + assembly + retrieval + UI, not data availability.

## Contract for the target report (to be implemented in N2, not now)

Stored as `data/nani/reports/<id>.json` (versioned, additive schema), containing all 19 mission fields; each numeric field tagged `verified | observed | not_tested | unavailable` (missionControl taxonomy); posterior values labeled scores until calibration thresholds pass (T-05 rule); `result` never upgrades unverified conclusions.
