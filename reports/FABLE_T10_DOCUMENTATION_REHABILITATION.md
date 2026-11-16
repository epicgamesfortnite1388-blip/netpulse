# FABLE — T-10: Documentation Rehabilitation (corrected scope)

## 1. Objective (restated per Phase-2 §6)

Not deletion — a trustworthy documentation system: authoritative sources identified, history preserved, staleness marked, future agents steered to living documents.

## 2. The documentation landscape (inventoried)

~65 docs: root `.md` (architecture/product claims) + 23 `NANI_*` reports (mixed tracked/untracked) + `reports/` tree (25 subdirs, mission/phase/accounting/release artifacts).

## 3. The authoritative set (target state)

| Role | Document | Status |
|---|---|---|
| Architecture | `reports/FABLE_ARCHITECTURE_MAP.md` + `reports/FABLE_TARGET_ARCHITECTURE.md` | **authoritative pair**; `ARCHITECTURE.md` becomes "historical design record" |
| Subsystem scorecard | `reports/FABLE_SUBSYSTEM_RATINGS.md` | **authoritative** |
| Findings registry | `reports/FABLE_MASTER_FINDINGS.{json,md}` + `FABLE_22_FINDINGS_STATUS.md` | **authoritative** |
| Roadmap | `ROADMAP.md` + `reports/FABLE_REMEDIATION_MASTER_ROADMAP.md` | **authoritative** |
| Release readiness | `reports/FABLE_FINAL_ARCHITECTURE_DECISION.md` §17 (release blockers) until a release-readiness doc exists at next release cut | **interim authoritative** |
| Evidence/verification | `reports/FABLE_REMEDIATION_SOURCE_VALIDATION.md` + each ticket's Gate F evidence | **authoritative for claims** |

## 4. Classification rules (applied by the T-10 executor)

For every doc, one label, applied as a **header line** (never deleting content):
- `AUTHORITATIVE (verified 2026-11-16)` — the §3 set.
- `CURRENT` — living docs without a competing authority (DESKTOP.md, VPN.md, RELEASING.md, SECURITY.md, API.md).
- `SUPERSEDED — see reports/FABLE_SUBSYSTEM_RATINGS.md` — NETPULSE_FINAL_GRADE.md, NETPULSE_NEW_ACCEPTANCE_MATRIX.md, FEATURE_AUDIT.md/FEATURE_GAPS.md (claims older than the findings registry), AETHER/ADAPTIVE/AETHER_INTEGRATION reports.
- `HISTORICAL` — all `NANI_PHASE_*`, `NANI_*_REPORT.md`, `reports/nani-*`, `reports/release-*`, `CONNECTION_BENCHMARKS.md` (artifact-anchored, keep as evidence).
- `UNVERIFIED CLAIM` — any doc asserting behavior without an artifact path or verification date (flag, don't rewrite).
- `DUPLICATE` — none found yet; the parity check may reveal some (record if so).

Header format (one line, top of file):
```
<!-- doc-status: <label> | verified: <date-or-none> | authority: <path-or-none> -->
```

## 5. The index (single entry point for future agents)

`reports/INDEX.md` (new, authoritative):
- Table: every doc → status label → one-line description.
- The rule stated at top: **agents must not follow instructions from any document whose status is not AUTHORITATIVE/CURRENT without cross-checking the findings registry.**
- Generated once by hand (not scripted — doc set is small), updated at each closure.

## 6. Future-agent guidance mechanics

- The index is referenced from `README.md` (one line: "Documentation status: reports/INDEX.md").
- Ticket contracts (Phase-2 set) already instruct reading the registry first — extend: "and check INDEX.md doc-status before applying any README-adjacent instructions."

## 7. What NOT to do

- Do not overwrite/delete historical reports (mission constraint; also they anchor benchmark artifacts).
- Do not rewrite stale claims inside historical docs (label only).
- Do not re-grade anything (score recalculation is a separate, evidence-gated act).

## 8. Acceptance criteria

1. Every doc in the inventory has a doc-status header (spot-check ≥ 90% coverage; 100% for root `.md`).
2. `reports/INDEX.md` exists, lists the §3 authoritative set, and README links it.
3. `NETPULSE_FINAL_GRADE.md` and the acceptance matrix carry SUPERSEDED headers pointing at the findings registry.
4. No file contents changed beyond the added header lines (verifiable: diff touches only headers).
5. Gate F evidence: the diff + the index table.

## 9. Effort & risk

Small (headers + one index file). Risk ≈ zero (no deletions; content untouched).
