# Unexpected Commit Provenance — A4

**Scope:** Investigate the unexpected commits, especially `0b05f8d`, without rewriting repository history. Record branches, parent commits, reflog info, timestamps, author/committer metadata, worktree state, and content differences.

**Verification performed this session:** 2026-10-23

**Rule followed:** No history rewrite, no reset, no amend, no cherry-pick, no force-push. All commits, branches, reflog entries, and uncommitted work preserved.

---

## 1. Repository starting state (Vpn_app)

- `main` HEAD: `48c1794` (docs: close out Mission 3 integration audit)
- `feat/iran-resilience` HEAD: `a68505f` (docs: record worker deployment, desktop reinstall, and VPS verification)
- Working tree: clean except untracked `VPS-KEYS.txt` and `reports/multiagent/` (this report set)
- `main` IS an ancestor of `feat/iran-resilience` (verified via `merge-base --is-ancestor`)

---

## 2. Commit 0b05f8d — verified metadata

| Field | Value |
|---|---|
| SHA | `0b05f8d66c7126a56df75f94e59b7201cba936fb` |
| Subject | `fix(web): keep skip link off-canvas and raise chart text to 12px` |
| Author | Abyss <radinshurideh@gmail.com> |
| Committer | Abyss <radinshurideh@gmail.com> |
| Date | 2026-10-23 09:39:12 +0330 |
| Parent | `b76b81271b985cc2ed95e09932d7ac791afbaf35` |
| Files changed | 3 (AppShell.tsx, LatencyChart.tsx, globeMath.ts) |
| Diff | +9 / -9 (accessibility + font-size 10→12px) |
| Diff stat | skip-link off-canvas; chart tick/font/tooltip sizes 10→12px |

### 2.1 Ancestry (verified by direct merge-base tests)

- `0b05f8d` IS an ancestor of `feat/iran-resilience` tip `a68505f` — confirmed via `git merge-base --is-ancestor` (exit 0) and via `git log --ancestry-path 0b05f8d..a68505f` which lists `0b05f8d` between `b76b812` and `7324a93`.
- `0b05f8d` is NOT an ancestor of `main` tip `48c1794` — confirmed via `merge-base --is-ancestor` (exit 1).
- The feat-branch path to `0b05f8d`: `a68505f` ← `7324a93` ← `0b05f8d` ← `b76b812` ← `048e927` ← ... ← `48c1794` (main).

So `0b05f8d` lives on `feat/iran-resilience` only, sitting between `b76b812` and `7324a93`, and has **not** been merged into `main`.

### 2.2 Reflog entries

- `HEAD@{3}` on `feat/iran-resilience`: commit `0b05f8d` at 2026-10-23 09:39:12 +0330, author Abyss
- Also present: `7324a93` HEAD@{2} (same timestamp), `a68505f` HEAD@{1} (09:45:29), then `checkout: moving from feat/iran-resilience to main` HEAD@{0} (2026-10-13)

No force-push or rewrite detected in reflog for this SHA.

### 2.3 Content difference vs known agent changes

The change is a small, coherent accessibility/font-size adjustment:
- `AppShell.tsx`: skip link restructured (off-canvas `sr-only focus` pattern → `fixed` with `transition-transform`)
- `LatencyChart.tsx`: chart tick/font size 10→12px (2 sites)
- `globeMath.ts`: tooltip font sizes 10→12px (4 sites)

No secrets, no API-contract changes, no logic changes. Plausible legitimate front-end work.

---

## 3. What CAN be established

1. Commit `0b05f8d` exists in the object store and in `feat/iran-resilience`'s history.
2. Its parent chain is intact; no rewrite/amend detected.
3. Author/committer metadata both show Abyss <radinshurideh@gmail.com>, matching the repo's configured user.
4. It is on `feat/iran-resilience` only — not on `main`.
5. The diff is small, coherent, accessibility-related, and contains no secrets.

## 4. What CANNOT be established

1. **Whether the reporting agent actually authored it.** Attribution ≠ authorship: the same Git identity could have been used by automation, an editor, or another agent. Commit metadata alone cannot prove who typed the change or triggered the commit.
2. **Whether it was auto-generated** by an editor/agent tooling.
3. **The exact tooling** that produced it.
4. **Whether it was intentional** (part of the feature work) or incidental.

## 5. The two feat-branch commits ahead of main

`feat/iran-resilience` has four commits ahead of `main`:
1. `b76b812` feat: add MasterDNS/StormDNS tunnels, harden WireGuard, refresh UI and audits
2. `0b05f8d` fix(web): keep skip link off-canvas and raise chart text to 12px
3. `7324a93` feat(cloud): serve entitlement snapshot compare; record automation audit
4. `a68505f` docs: record worker deployment, desktop reinstall, and VPS verification

None are merged into `main`. `0b05f8d` is the one the reporting agent did not recognize.

## 6. Status

- **Known:** SHA, metadata, diff, parent chain, branch membership, ancestry on feat vs main, reflog entries, content (no secrets).
- **Unknown:** true authoring agent/process; whether intentional; exact tooling.

## 7. Action taken

- No history rewrite, no reset, no amend, no cherry-pick, no force-push. Commit preserved.
- All branches, commits, reflog entries, and uncommitted work preserved.
