# FABLE — T-06 Execution Contract: Failure-Classification Consolidation

## 1. Current behavior

Two failure-classification implementations:
- Rust: `src-tauri/src/network_intelligence/api_intelligence/failure_classifier.rs` (`classify(ProbeInputs)` → `FailureCategory`), authoritative for desktop NANI.
- TS: `apps/web/src/lib/failureIntelligence.ts` (UI) and `apps/api/src/services/naniDiagnosticAdapter.ts` + `packages/shared/src/nani/apiHealth.ts` (`classifyApiFailure`, `assessApiHealth`) — used by web-mode NANI and UI rendering.

## 2. Problem & root cause

FABLE-ARCH-002: the taxonomy lives in two languages with independent copy evolution. No cross-check exists; divergence would be silent.

## 3. Target behavior

- A single **taxonomy data module** in `packages/shared/src/failures/` (kinds, labels, severity, icons, display order) consumed by BOTH sides.
- Rust keeps the classification **logic** (it owns outcomes and evidence); TS keeps only display mapping + web-mode classification via the shared data.
- Probe-outcome superset documented: Rust outcomes (6 incl. AuthRejected/RateLimited/ServerError) ⊃ TS outcomes (5) — the shared data module encodes the full set; TS mapping handles the subset explicitly (unknown → displayed verbatim, never fabricated).

## 4. Exact source files & symbols

| File | Action |
|---|---|
| `packages/shared/src/failures/taxonomy.ts` (NEW) | const taxonomy: kind → {id, label, severity, order, appliesToOutcomes[]} |
| `packages/shared/src/failures/index.ts` (NEW) | exports + version const |
| `apps/web/src/lib/failureIntelligence.ts` | replace inline kind tables with taxonomy import (display mapping only) |
| `packages/shared/src/nani/apiHealth.ts` | classification result types reference taxonomy ids (no logic change) |
| Rust `failure_classifier.rs` | no logic change; a doc-comment points to the shared taxonomy as the label source; optional: a test reads the shared JSON export for label parity (Rust reading `packages/shared` at build time is NOT allowed — instead a CI script diffs the two tables) |
| `scripts/check-taxonomy-parity.mjs` (NEW) | CI-time check: parses Rust `FailureCategory` variants + TS taxonomy, fails on mismatch |

## 5. Call paths affected

UI failure rendering (`failureIntelligence.ts` consumers), `naniDiagnosticAdapter` mapping, and (read-only) Rust classification — Rust path untouched.

## 6. Required API/event changes

None (ids are strings already; this is data unification). Event payloads unchanged.

## 7. Persistence changes

None.

## 8. Migration strategy

Additive: introduce taxonomy → switch TS tables to import it → add the CI parity check → done. Rust logic never changes during this ticket.

## 9. Mathematical parity requirements

Classification is rule-based, not Bayesian — but the **outcome superset** rule must hold: TS mapping must not invent outcomes; unknown kinds display verbatim (existing reducer principle).

## 10–12. Tests

- **Unit (TS)**: taxonomy completeness (every kind has label/severity/order); mapping for all 5 TS outcomes + unknown handling.
- **Parity (CI script)**: Rust variants vs TS taxonomy — fail on missing/extra/mislabeled.
- **Golden fixtures**: a fixture list of (probe result → expected label) executed in TS tests; Rust's existing classifier tests remain the logic floor.
- **Regression**: shared + api + web suites.

## 13. Performance expectations

Zero (data + imports).

## 14. Rollback

Revert TS import switches; taxonomy module is inert without consumers.

## 15. Objective acceptance criteria

1. Exactly one taxonomy table in TS land; `failureIntelligence.ts` contains no inline kind definitions.
2. CI parity check green (and demonstrably red if a kind is removed — negative test).
3. Rust classifier tests untouched and green.
4. No TS code path can emit an outcome label that doesn't exist in the taxonomy.

## Gate notes

- **Gate A**: verify the in-flight work hasn't already added/renamed categories (`naniDiagnosticAdapter.ts` is in the modified set — re-read at Gate A).
- **Gate D (Gemini)**: attempt to find a Rust category absent from the taxonomy (counterexample hunt); verify the parity script actually parses Rust (not hardcoded).
- **Sequencing**: AFTER T-05 (single-writer rule on `packages/shared`) or confined strictly to `src/failures/*` if T-05 is delayed — decision at Gate B.
