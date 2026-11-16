# FABLE — 22 Findings Status (post-re-validation)

Registry IDs unchanged; this table records current status and any scope corrections after re-validation (`FABLE_REMEDIATION_SOURCE_VALIDATION.md`). Machine registry: `FABLE_MASTER_FINDINGS.json` (updated same session).

| ID | Sev (current) | Status | Re-validation note |
|---|---|---|---|
| FABLE-ARCH-001 | CRITICAL | OPEN | `app.ts:897` re-verified; dual-engine confirmed. Addressed by T-01 (+T-05/T-06). |
| FABLE-RUST-001 | HIGH | OPEN | Dead sequential symbols re-verified (`sequential.rs` 9 hits, `information_theory.rs` 17 hits). **Caution: these files are themselves untracked** (V-2). Addressed by T-02. |
| FABLE-RUST-002 | MEDIUM | OPEN | Compiler warnings expected stable; re-run `cargo check` at Gate A of T-03. Blocked on W0-1 (do not delete uncommitted files). |
| FABLE-MATH-001 | MEDIUM | OPEN | `bayesian.rs` ll×c heuristic unchanged. Addressed by T-04. |
| FABLE-MATH-002 | MEDIUM | OPEN | Continuous calibration still absent. Addressed by T-05. |
| FABLE-MATH-003 | INFO | **CLOSED** | Verified: Rust `TransitionModel` (time-scaled) covers the TS kernel; TS is a faithful subset. Now a **preservation constraint** on T-05/T-06, not a defect. |
| FABLE-UI-001 | MEDIUM | OPEN | `features/nani-reports/` still present, still unrouted/unimported. **Do not delete until W0-1 lands** (in-flight UI churn active around it). |
| FABLE-UI-002 | LOW | OPEN | `naniApi.ts` parity wording unchanged. |
| FABLE-BUILD-001 | **CRITICAL** (was MEDIUM) | OPEN | **Escalated per V-2**: 21 untracked NANI files/dirs incl. all Tauri commands; 39 modified tracked files (+2,696/−501). Single most urgent item in the campaign. |
| FABLE-BUILD-002 | LOW | OPEN | Manifest corrected: tracked junk = 4 aether zips (+ scratch/logs per manifest); `dist-desktop`/`staging-dist`/`api dist` **removed from manifest** (referenced, gitignored — V-3). |
| FABLE-BUILD-003 | LOW | OPEN | No fingerprint gate yet; T-08 unchanged. |
| FABLE-VPN-001 | MEDIUM | OPEN | Unchanged. |
| FABLE-VPN-002 | LOW | OPEN | Unchanged. |
| FABLE-SEC-001 | MEDIUM | OPEN | Unchanged; addressed by packaging plan (FABLE_PACKAGING_SUPPLY_CHAIN_PLAN.md). |
| FABLE-SEC-002 | LOW | OPEN | `evidence/leak-live-20261112/` untouched; requires user authorization to review contents. |
| FABLE-INFRA-001 | MEDIUM | OPEN | **Partially adjudicated** (V-7): naming convention issue, not schema conflict; local DB has both pending; remote journal read pending (quota). |
| FABLE-TEST-001 | MEDIUM | OPEN | Unchanged. |
| FABLE-ECO-001 | MEDIUM | OPEN | Bot repo untouched this phase (separate workstream; no authorization to edit). |
| FABLE-ARCH-002 | MEDIUM | OPEN | Unchanged. Addressed by T-06. |
| FABLE-PERSIST-001 | MEDIUM | OPEN | Consequence of ARCH-001; addressed by T-01/T-05. |
| FABLE-DOC-001 | LOW | OPEN | Addressed by T-10. |
| FABLE-DOC-002 | INFORMATIONAL | CLOSED (rated) | Subsystem ratings published. |
| **FABLE-INFRA-002** (new) | MEDIUM | OPEN | **D1 free-tier daily row-read quota exhausted** (wrangler error 7500, read-only check). Cause unknown. Remediation = read reduction first (cache/batching), never blind upgrade. |

Severity changes: 1 (BUILD-001 MEDIUM→CRITICAL). New findings: 1 (INFRA-002). Closed: 0 new (MATH-003 was already closed).

## Status discipline

- A finding moves to RESOLVED only after Gate F evidence (see protocols), never on commit alone.
- No finding was closed this phase except the two already closed (MATH-003, DOC-002 informational).
- Score impact of findings is NOT recalculated until verified completion (Section 12 of the mission).
