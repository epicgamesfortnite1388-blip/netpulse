# FABLE — Abystral-Ledger Audit Plan (FABLE-ECO-002)

Separate workstream. Read-only. **No changes to financial records, no payment execution, no deploys, no credential rotation.** Its findings stay out of the NetPulse score until complete (per Phase-2 §8).

## 0. Scope statement

Repo: `E:\Code\Project\Abystral-ledger` (~92k LOC). Role in ecosystem: ledger/accounting for the Abystral subscription side (per repo docs; to be verified — do not assume). Relationship to NetPulse: sibling; integration points must be discovered, not presumed (candidate: `netpulse-integration` patterns seen in the cloud worker; entitlement sync).

## 1. Audit phases (with kill-criteria)

| Phase | Objective | Key artifacts to produce | Kill criterion (stop & report) |
|---|---|---|---|
| A1 Inventory | languages, LOC, crates/packages, DB engines, migrations, entry points, schedulers/workers | inventory table + topology map | — |
| A2 Money-path map | every write path touching balances/credits/entitlements: entry → storage → effects | money-path diagram with file:symbol anchors | any write path that mutates money outside a transaction |
| A3 Invariant analysis | explicit ledger invariants: conservation (Σdebits=Σcredits), balance non-negativity, monotone ledger append, idempotency keys | invariant list with enforcement location (DB constraint vs code) | invariant enforced only in app code with no DB constraint |
| A4 Atomicity & idempotency | transaction boundaries per money path; idempotency-key presence and uniqueness enforcement (DB unique index?) | table: path → tx scope → idempotency mechanism | any money write without both |
| A5 Duplicate-prevention | payment webhooks/callbacks: replay protection, signature verification, provider-side idempotency, dedupe window | webhook flow audit | unsigned or unverified webhook ingestion |
| A6 Precision & rounding | currency representation (integers? cents? floats?), rounding rules, cross-currency conversion | precision finding list | float money anywhere |
| A7 Concurrency | race windows on balance updates (SELECT-then-UPDATE patterns), row locking, optimistic versioning | race register with reproducible interleavings | lost-update pattern on balances |
| A8 Authz | admin adjustments: who can credit/debit; audit trail of every adjustment; separation of duties | authz matrix | unlogged admin balance mutation |
| A9 Reconciliation | external↔internal reconciliation jobs; drift detection; alerting | reconciliation coverage table | no reconciliation for payment providers |
| A10 Entitlement consistency | entitlement state machine vs ledger state: expiry, renewal, refund/chargeback effects | state map | entitlements derivable only from unverifiable runtime state |
| A11 DB constraints & migrations | FK/constraints/checks on money tables; migration history integrity | constraint audit | nullable money columns, missing FKs |
| A12 Ops security | secrets handling, log redaction, backup/restore, deploy/rollback story | ops checklist | secrets in code/logs |
| A13 Tests & CI | do tests exercise money paths incl. failure branches? CI gates? | test-coverage verdict | money paths tested only on happy paths |

## 2. Highest-priority attack/failure questions (answer explicitly)

1. Can the same payment credited twice (replay or retry)?
2. Can a balance go negative or drift from Σ(ledger rows)?
3. Are adjustments attributable (who/when/why, immutably)?
4. Can entitlement outlive payment (or vice versa) on partial failure?
5. Are amounts integer-cents end-to-end?
6. Is any money path executable without auth or with forged identity?

## 3. Acceptance criteria for the audit

- Every phase A1–A13 has a verdict + file-anchored evidence.
- Every money write path classified: SAFE / RISK-<id> with reproducible reasoning.
- A severity-ranked findings registry (new IDs, `LEDGER-*`), no conflation with `FABLE-*`.
- Test/CI gaps listed with concrete proposed tests (not implemented by the auditor).
- Zero modifications to the repo (including formatting).

## 4. Execution & resourcing

- Runs fully in parallel with the NetPulse remediation (different repo, no shared files).
- Est. effort: comparable to the NetPulse Phase-1 audit (large repo; money-path focusing keeps it tractable).
- Reviewer: Gemini verdict on the audit report itself before any NetPulse score impact.

## 5. Score integration rule

On completion: a new subsystem row "Abystral ledger" enters the scoreboard with its own rate; NetPulse's 8.4 aggregate remains untouched until then.
