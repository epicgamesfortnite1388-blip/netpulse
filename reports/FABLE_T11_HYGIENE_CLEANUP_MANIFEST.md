# FABLE — T-11 Hygiene Cleanup Manifest (reviewed, per-file, reversible)

Scope correction from re-validation: `dist-desktop/`, `apps/api/dist-desktop/`, `.staging-dist/`, `apps/api/dist/` are **gitignored build intermediates actively consumed by `prepare-desktop.mjs` and e2e scripts — REMOVED from this manifest.** Nothing here touches referenced build outputs.

Constraint compliance: no `git reset --hard`, no `git clean -fd`, no recursive wildcards, no deletions of unverified content. Every row: tracked-status + reference check + risk + verification command. Execution = one small commit per group, reviewed by Gemini.

## Manifest

### Group 1 — Tracked dead stub archives (verified: tracked + unreferenced)

| Path | Tracked | Referenced by | User work? | Regenerable | Risk | Action |
|---|---|---|---|---|---|---|
| `aether-1793627158001.zip` | YES (`git ls-files`) | none (grep across scripts/CI/docs) | no — contains literal `Not Found` (HTTP 404 body) | no (was a failed download) | none | `git rm aether-1793627158001.zip` |
| `aether-1793627158015.zip` | YES | none | no | no | none | `git rm` |
| `aether-1793627158016.zip` | YES | none | no | no | none | `git rm` |
| `aether-test.zip` | YES | none | no — also `Not Found` | no | none | `git rm` |

Verification: `git grep -l "aether-179\|aether-test" -- ':!*.zip'` → empty; full suites green after removal.
Risk if wrong: zero content value (404 stubs); if some doc references them it's stale docs (T-10 labels, not blockers).

### Group 2 — Committed scratch/temp artifacts (tracked-status check per item BEFORE deletion)

| Path | Tracked? | Referenced? | User work? | Action |
|---|---|---|---|---|
| `.tmp-desktop-dev.log` | NO (untracked, 144 KB) | no | possibly the user's local dev log → **ASK, default KEEP** (do not delete untracked user files without authorization) | leave; optionally gitignore |
| `.scratch-pickerdrive/`, `.scratch-pickerdrive-1791226548/`, `.scratch-provision-repair/` | verify with `git ls-files <dir> \| head` | grep scripts/CI | check contents for user notes | delete **tracked** parts via `git rm` only; untracked leftovers left in place |
| `scripts/__pycache__/` | verify | no (python bytecode) | no | `git rm -r --cached` if tracked; add to `.gitignore` |
| `tmp/` | verify tracked files individually | grep | per-file | same rule as scratch dirs |

### Group 3 — Stale duplicate build outputs (untracked-only deletion candidates — needs explicit user authorization, not part of default batch)

| Path | Tracked | Referenced | Risk |
|---|---|---|---|
| stale `apps/api/dist/aetherProvider-*.js` variants (many hashed chunks; only the ones referenced by the current `index.js` chunk graph matter) | NO (gitignored) | current build rewrites them | deleting wrong ones can't break builds (Vite regenerates), but the dir is ignored — **skip entirely**; not worth the risk |

Decision: **no action** — the dir is gitignored and self-healing.

### Group 4 — `.gitignore` additions (preventive)

Add (verify none already present):
```
__pycache__/
*.log
.scratch-*/
```
(Do NOT add `aether-*.zip` — they will be deleted, not ignored; do not add dist dirs that are already ignored.)

### Group 5 — Evidence dir (OUT OF SCOPE for deletion)

`evidence/leak-live-20261112/` — FABLE-SEC-002: requires the user's authorization to open (may contain field data). Deletion is forbidden without review. Separate ticket after user review.

## Forbidden-command list (binding)

`git reset --hard`, `git clean -fd` (any form), `rm -rf` on directories not individually named above, bulk `git rm` without the per-file list, any operation on `dist-desktop*`/`.staging-dist`/`apps/api/dist`.

## Execution order

1. W0-1 lands first (commit in-flight work) — hygiene deletions must not entangle with it.
2. Group 1 commit (4 files, `git rm`) + suites green.
3. Group 2 after per-file tracked-check; only tracked files removed.
4. Group 4 `.gitignore` commit.
5. Gemini review of each diff; Gate F evidence attached per commit.

## Verification commands (post-cleanup)

- `git status --short` → no new unexpected changes.
- `npm run build:desktop-backend` → bundle still produced (proves no referenced artifact was touched).
- Full suites green (API/web/shared/Rust).
- `git grep -l "Not Found" -- '*.zip'` → empty.
