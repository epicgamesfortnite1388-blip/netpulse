# 13 — Documentation Audit

## Corrected in the prior part of this operation (DD-019, verified again)

Ten inaccuracies were corrected in `RELEASING.md`, `DEPLOYMENT.md`, `README.md`, `API.md`, `ARCHITECTURE.md`: daemon-token persistence claim, in-app updater `check()` callers, SESSION_TTL_HOURS default (12 not 168), stale test counts, Rust module table omissions, hysteria engine listing, "full surface" overstatement, WS ticket prerequisite, stale paths/version, and vault key file vs Credential Manager.

## Documentation defects found this cycle

| ID | Defect | Status |
|---|---|---|
| DD-051 (P4) | `scripts/verify-desktop-pipeline.mjs:6` docstring claims the bundle is checked fresh; implementation at `:53` checks existence only (`verify-desktop-pipeline.mjs:91-98` does check web dist version, but not the backend bundle) | OPEN — code comment, no behavior change made |
| DD-052 (P4) | `scripts/release.mjs:5-7` claims ALL workspace packages are version-synced, but `cloud/worker/package.json:3` is 1.0.2 and is not a sync target | OPEN — either add the worker to the sync list or document independent versioning; not changed because it could alter release behavior without a real release to validate |
| DD-007 (P4) | `scripts/e2e-desktop.mjs:8-9` docstring honestly says its assertions prove well-formedness, not behavior; the assertions themselves (`:160`, `:196`, `:210`) remain permissive | OPEN |

## New documentation produced by this operation

`reports/DEEP_DISCOVERY/00`-`17`, including explicit record of:
- The P0 committed credential (DD-060) and the exact owner-only remediation steps.
- The elevation nonce contract and its repair (DD-049).
- Fresh test counts and commands (11).
- Load-sensitive benchmark false-reds (11/12).
- Kim's adversarial findings and their corrections (15, register reconciliation note).
- The full set of accepted risks and blocked items (17).

## Honesty checks

No report claims a live VPN connection, real installer run, real account operation or production integration was verified. Reports distinguish code-path evidence, unit/integration suite evidence and live evidence explicitly.
