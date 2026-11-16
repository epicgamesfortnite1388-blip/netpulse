# FABLE — Remediation Dependency Graph

Tickets: Phase-1 IDs (T-01..T-12) + the Phase-2 campaign items. Dependencies are derived from **actual file/contract overlap**, verified in re-validation — not from name similarity.

## Ticket → finding → files → contract effects

| Ticket | Findings | Files | DB mig? | API/event/IPC contract? | Persisted schema? | Windows packaging? | VPN behavior? | NANI math? |
|---|---|---|---|---|---|---|---|---|
| W0-1 (baseline commit) | BUILD-001 | 39 tracked + 187 untracked | no | no | no | no | no | commits current math as-is |
| T-01 (desktop gate) | ARCH-001 | `apps/api/src/app.ts`, 1 test | no | no (routes stay) | no | no | no | stops Node NANI loops in desktop |
| T-08 (freshness gate) | BUILD-003 | `scripts/desktop-package.mjs` | no | no | no | **yes** | no | no |
| T-10 (docs rehab) | DOC-001 | `reports/*`, root `.md`, new `reports/INDEX.md` | no | no | no | no | no | no |
| T-11 (hygiene manifest) | BUILD-002 | tracked junk only (4 zips, scratch, logs, `__pycache__`) | no | no | no | no (verified non-references) | no | no |
| T-02 (adaptive stopping) | RUST-001 | `investigation.rs`, `foundation.rs`, `sequential.rs` | no | new optional status field | no | no | no | **yes** (loop behavior) |
| T-03 (shelf deletion) | RUST-002 | per compiler list | no | no | no | no | no | removes unused math only |
| T-04 (noise model) | MATH-001 | `bayesian.rs` | no | no | no | no | no | **yes** (posterior numerics) |
| T-05 (calibration) | MATH-002 | `evaluation.rs`, `persistence.rs`, `commands/nani.rs`, web nani feature, shared DTO | no | new command + event field | **yes** (new rolling record) | no | no | **yes** (measurement layer) |
| T-06 (classifier consolidation) | ARCH-002 | `packages/shared/src/failures/*` (new), `failureIntelligence.ts`, `naniDiagnosticAdapter.ts` | no | no (display mapping only) | no | no | no | no (taxonomy data only) |
| T-07 (pin UX + cache force) | VPN-001/002 | `EngineManagerPage.tsx`, engines route, `engineManager.ts` glue | no | response field addition | no | no | UI-only | no |
| T-09 (DB quarantine) | (new, hygiene-adjacent) | `apps/api/src/db/*` | no | no | no | no | no | no |
| T-12 (Bot pytest) | ECO-001 | Bot repo test file | no | no | no | no | no | no |
| M-1 (D1 migration renumber) | INFRA-001 | `cloud/worker/migrations/0005_vpn_credentials.sql` → `0006_*` | **yes (cloud)** | no | yes (cloud) | no | no (entitlements unaffected if applied cleanly) | no |
| P-1 (Node pin/CVE policy) | SEC-001 | `RELEASING.md`, package.json engines, CI | no | no | no | **yes** | no | no |
| L-1 (ledger audit) | ECO-002 | separate repo (read-only) | no | no | no | no | no | no |

## Dependency edges (implementation-justified)

```
W0-1 ───────────────────────────────────────► EVERYTHING
W0-1 ─► T-01 ─► T-05 (calibration runs where Node NANI loops are already gated,
        │       and naniService is in-flight-modified → sequence, don't collide)
        │
        ├─► T-02 ─► T-03 (deletion after consumption decision)
        │      └─► T-04 (posterior semantics must be stable before calibration feeds)
        │             └─► T-05
        ├─► T-06 (needs W0-1; must NOT run while T-05 edits packages/shared)
        ├─► T-10 (classification is mechanical; safe early, AFTER W0-1)
        ├─► T-11 (tracked-junk only; safe after W0-1)
        ├─► T-08, T-09, T-07, P-1 (independent of each other)
M-1 ─ needs remote journal read (quota reset) ─► then decide renumber
L-1 ─ independent workstream, read-only
T-12 ─ independent (other repo)
```

## Execution classes

**Parallelizable batch P1 (after W0-1, disjoint files):** T-01, T-08, T-10, T-11, T-09, P-1, T-12.

**Sequential chain S1 (one agent, ordered):** T-02 → T-03 → T-04 → T-05.

**Must not run simultaneously:**
- T-05 and T-06 (both touch `packages/shared`; T-05 also touches the in-flight `naniService.ts` surface).
- T-02/T-03/T-04 with any other Rust-touching ticket (`mod.rs` conflicts).
- Any ticket with the user's active in-flight work (all NANI Rust/TS files currently churn) → everything waits on W0-1 and a freeze confirmation from the user.

**Postponed until prerequisite verification:**
- M-1 renumber until remote journal is read (INFRA-001 evidence incomplete).
- T-03 until T-02 decides consumption.
- Any `wrangler deploy`/production action: permanently out of scope for agents.

## Database-migration register (only migration in campaign: M-1, gated)

No NetPulse-local (drizzle) migration is required by any ticket. The only migration touch is cloud D1 renumbering, gated on the remote journal read.
