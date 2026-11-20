# NANI_AUDIT_11 — Recovery Roadmap (Mission J)

Dependency-aware. Stages N0–N5. Nothing advanced (N5) begins before N0–N2 close. Ordering rationale: the product fails at *wiring*, not *math* — fix transport of data first, then decision quality, then durability, then AI.

## N0 — Runtime truth and integration recovery (days, not weeks)

| # | Item | Gap IDs | Notes |
|---|---|---|---|
| N0.0 | T-01: stop dual NANI engines in desktop | NANI-017 / FABLE-ARCH-001 | one-line gate + test (contract exists) |
| N0.1 | Wire InvestigationManager to the real registry AND the real bus | NANI-001, NANI-002 | single construction-site fix; keep old behavior behind a debug flag during verification |
| N0.2 | Integration test: investigation emits events on `nani:event` + replay; ≥1 probe runs | NANI-001/002 acceptance | the missing "assembly test" (Phase-1 lesson institutionalized) |
| N0.3 | Manual desktop verification run (launch, start investigation, watch live pipeline) | — | closes the loop with eyes on screen |

## N1 — Functional investigation engine

| # | Item | Gap IDs |
|---|---|---|
| N1.1 | Route investigation analysis through `NaniMathEngine`/`DiagnosticEngine` (posteriors, competing hypotheses, evidence weighting) | NANI-003, NANI-012 |
| N1.2 | Configurable, persisted API/target registry (user-editable: DNS resolvers, gateway, VPN endpoints, arbitrary hosts) | NANI-010, NANI-018 |
| N1.3 | Bounded DNS probe; add interface/route/proxy-context inputs from existing Node services via the sidecar (read-only) | NANI-011 |
| N1.4 | IG-driven probe selection + stopping behind `NANI_ADAPTIVE_STOPPING=1` (T-02 contract) | NANI-013 |
| N1.5 | CVaR port to Rust + cross-engine oracle fixture (mandatory before any TS math retirement) | NANI-014 |

## N2 — Durable reports

| # | Item | Gap IDs |
|---|---|---|
| N2.1 | Persistence writers: observation journal, model state, completed investigations | NANI-004 |
| N2.2 | Report builder + store + retrieval command + routed UI page (19-field contract, missionControl states, calibration labeling) | NANI-005, NANI-015 |
| N2.3 | Delete or wire `nani-reports/` + `nani-memory` (post-N2.2 decision) | NANI-015 |

## N3 — Copilot AI infrastructure

| # | Item | Gap IDs |
|---|---|---|
| N3.1 | Configure + verify the existing worker→Abystral chain (user decision on the Abystral endpoint/key); SSE streaming end-to-end | NANI-006 |
| N3.2 | Fix CopilotPage claims + honest availability states | NANI-007 |
| N3.3 | Conversation persistence (D1) + history context + usage display | NANI-008, NANI-016 |

## N4 — NANI-aware Copilot

| # | Item | Gap IDs |
|---|---|---|
| N4.1 | Structured NANI tools with provenance + authorization gate for `run_probe` | NANI-009 |
| N4.2 | Evidence-grounded answers (report/evidence retrieval wired into prompts) | depends N2.2 |

## N5 — Advanced intelligence (only after N0–N4)

Calibration-on-real-outcomes (T-05), drift field-validation, longitudinal comparison of reports, verified learning expansion, better probe scheduling. **Explicitly blocked until the product can run, report, and be read.**

## Sequencing rule

N0 (≤2 days of work) is the highest-leverage change in the entire NetPulse codebase: three lines of construction wiring convert NANI from a display surface into a working investigation system.
