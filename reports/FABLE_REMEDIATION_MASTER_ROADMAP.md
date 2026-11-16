# FABLE — Remediation Master Roadmap (Phase 2)

Sequencing derived from the dependency graph (implementation-verified) and the corrected findings status. Every item carries its gate chain (A–F) and its evidence duty.

## Wave R0 — Baseline integrity (BLOCKING)

| # | Item | Ticket | Gate focus | Owner |
|---|---|---|---|---|
| R0-1 | Commit/branch the in-flight work (39 modified + 187 untracked incl. the whole uncommitted NANI engine) | W0-1 | evidence: clean status; engine files tracked | **User (with Terra's help if asked)** |
| R0-2 | Doc-status headers + `reports/INDEX.md` (T-10 scope A) | T-10 part 1 | diff touches headers only | Gemini-assisted Terra |
| R0-3 | Tracked-junk cleanup (4 zips + verified scratch/log items) | T-11 | per-file manifest compliance | Terra |
| R0-4 | D1 remote journal read (post-quota) → INFRA-001 branch decision | M-1 gate | read-only | User |

## Wave R1 — Single NANI authority (the priority campaign)

| # | Item | Ticket | Depends | Verify |
|---|---|---|---|---|
| R1-1 | Desktop gate for Node NANI loops | T-01 | R0-1 | gate tests + desktop manual run |
| R1-2 | Adaptive stopping wired (flag-gated) | T-02 | R0-1 | simulator probe-count test; `cargo test` |
| R1-3 | Shelf deletion (post-consumption) | T-03 | R1-2 | zero dead-code warnings |
| R1-4 | Mixture likelihood noise model | T-04 | R1-2 | property tests + calibration floor |
| R1-5 | Continuous calibration (Rust-sourced) | T-05 | R1-1, R1-4 | `nani_math_calibration`; UI label rule |

## Wave R2 — Consolidation & transparency

| # | Item | Ticket | Depends | Verify |
|---|---|---|---|---|
| R2-1 | Taxonomy consolidation + CI parity check | T-06 | R1-5 (single-writer on shared) | parity script + golden fixtures |
| R2-2 | Pin UX + version-cache force | T-07 | R0-1 | component tests |
| R2-3 | SQLite corruption quarantine | T-09 | R0-1 | fault-injection test |
| R2-4 | Packaging freshness gate | T-08 | R0-1 | staleness test |
| R2-5 | Node pin/CVE policy + provenance manifest | P-1 | R0-1 | RELEASING.md section + runtime.json in build |

## Wave R3 — Performance/ergonomics + ecosystem

| # | Item | Ticket | Verify |
|---|---|---|---|
| R3-1 | Test-suite split | T-11's successor (T-11 ID reused for hygiene only; keep T-ID discipline: call it T-13 — **new ID, see note**) | suite timing |
| R3-2 | Bot pytest fix | T-12 | pytest green |
| R3-3 | Abystral-ledger audit | L-1 | audit report per plan |

> Note on IDs: Phase-1 defined T-11 as the test-suite split; Phase-2 redefined T-11 as the hygiene manifest (per the mission's numbering: T-10 docs, T-11 hygiene). Resolution: **T-11 = hygiene** (mission numbering wins); the test-suite split becomes **T-13** (new ID, registered).

## Milestones & evidence duties

- **M1 (Single authority)**: R1-1..R1-5 complete → ARCH-001, RUST-001, MATH-001, MATH-002 evidence-closed. Recalculation: NANI/adaptive TS services (6.8) re-rated only after T-06 closes too.
- **M2 (Transparency)**: R2-1..R2-5 → VPN-001, SEC-001, BUILD-003 closed; hygiene score re-rates after R0-3.
- **M3 (Ergonomics/ecosystem)**: R3-x → TEST-001, ECO-001, ECO-002 verdicts.
- Score recalculation happens **only** at milestones, only with Gate F evidence (Fable's rule; no per-commit churn).

## Deferred to post-campaign (not dropped)

- Tunnel-verify loop into Rust (needs measured justification).
- Aether-masque/provision work streams if the user resumes them.
- Web NANI capability expansion (explicitly out of scope; web stays a labeled subset).
