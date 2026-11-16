# FABLE — Remediation Execution Scorecard (live tracking document)

Updated: 2026-11-16 (Phase-2 kickoff). This file is the campaign's status board; it changes with evidence, not with optimism.

## Current baseline (from Phase 1 + re-validation)

| Metric | Value |
|---|---|
| Findings | 22 registered + 1 new (INFRA-002) = 23 |
| Open findings | 21 (MATH-003, DOC-002 closed) |
| Overall score | **8.4/10 (A−)** — frozen until first milestone |
| Weakest parts | Hygiene 5.0 · Bot ecosystem 3.5 · TS NANI services 6.8 · Docs 6.8 |
| Strongest parts | Rust shell 9.4 · VPN stack 9.3 · Web shell 8.9 · Test infra 8.8 |

## Ticket board

| Ticket | Status | Gate reached | Evidence |
|---|---|---|---|
| W0-1 baseline commit | **DONE — PASS** (2026-11-16) | Gates A–F complete | commit `384f7f9` (262 files); backup verified 317/317 ×2; engine restorable (54 rs from git-archive); 368 Rust NANI tests + 3× tsc green; reports/W0_1_FINAL_REPORT.md |
| T-01 desktop gate | READY (after W0-1) | contract written | FABLE_T01_EXECUTION_CONTRACT.md |
| T-02 adaptive stopping | READY (after W0-1) | contract from Phase-1 blueprint | — |
| T-03 shelf deletion | POSTPONED (needs T-02) | — | — |
| T-04 noise model | READY (after T-02) | contract from blueprint §T-04 | — |
| T-05 calibration | CONTRACTED | — | FABLE_T05_EXECUTION_CONTRACT.md |
| T-06 taxonomy consolidation | CONTRACTED | — | FABLE_T06_EXECUTION_CONTRACT.md |
| T-07 pin UX + cache force | READY | blueprint §T-07 | — |
| T-08 freshness gate | READY | blueprint §T-08 + plan | FABLE_PACKAGING_SUPPLY_CHAIN_PLAN.md |
| T-09 DB quarantine | READY | blueprint §T-09 | — |
| T-10 docs rehab | PARTIALLY SCOPED (headers/index) | FABLE_T10_DOCUMENTATION_REHABILITATION.md | — |
| T-11 hygiene | MANIFESTED | FABLE_T11_HYGIENE_CLEANUP_MANIFEST.md | corrected per V-3/V-4 |
| T-12 Bot pytest | READY (other repo) | — | — |
| T-13 test-suite split | READY | registered this phase | — |
| M-1 D1 renumber | GATED (remote journal read pending quota) | decision tree written | FABLE_CLOUD_MIGRATION_REMEDIATION.md |
| P-1 Node pin/CVE | READY | plan written | FABLE_PACKAGING_SUPPLY_CHAIN_PLAN.md |
| L-1 ledger audit | PLANNED (read-only) | plan written | FABLE_ABYSTRAL_LEDGER_AUDIT_PLAN.md |

## Score-change ledger (history preserved)

| Date | Event | Score effect |
|---|---|---|
| 2026-11-16 | Phase-1 audit | 8.4/10 (A−) established |
| 2026-11-16 | Phase-2 re-validation | BUILD-001 ↑ CRITICAL; INFRA-002 added; T-10/T-11 scope corrected; **no score change** (no verified remediation yet) |
| 2026-11-16 | **W0-1 executed** | BUILD-001 → RESOLVED (CRITICAL defused); baseline recoverable from Git + external backup; BUILD-004 (CRLF) registered; **no score change yet** (re-rate at milestone) |

## Next action queue

1. ~~User: land W0-1~~ → **DONE** (commit `384f7f9`; unblocker cleared).
2. **User**: after UTC midnight — one read-only `wrangler d1 migrations list --remote` (M-1 gate) + investigate the D1 read-quota consumer.
3. **User**: authorize push of `main` (recovery point currently local + external backup only).
4. **Terra**: T-01 first (safest, smallest, highest-leverage), then T-02.
5. **Gemini**: review T-01 diff on arrival.

## Completion discipline

- A row moves to DONE only with Gate F evidence linked here.
- Scores move only at milestones M1–M3 with a dated re-rate entry.
