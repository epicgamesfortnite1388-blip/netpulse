# UI_REVIEW_00 — Repository Baseline (independent verification)

**Reviewer role:** independent Principal Code Reviewer / Frontend Architecture Auditor. **Read-only mission** — no application source was modified.
**Verified:** 2026-11-16 (evening).

---

## 1. Actual current state (verified, not assumed)

| Property | Verified value |
|---|---|
| Repository root | `E:/Code/Project/Vpn_app` |
| Branch | `main` |
| **HEAD** | **`005de03`** — `feat(ui): command-bar brand mark + dashboard command-center hero band` |
| Parent chain | `005de03` → `f5bdc8b` (brand identity layer) → `cc1ee99` (W0-1 docs) → `1fc8875` → `624daef` → `384f7f9` (recovery) → `b0311fb` |
| Tracked working-tree changes | `apps/web/src/features/vpn/AdaptiveRecoveryCard.tsx` only — **CRLF phantom** (`git diff` empty; documented as FABLE-BUILD-004) |
| Untracked entries | 55 (53 report PNGs + `.tmp-desktop-dev.log` + `.workbuddy-ai/`) — preserved, not touched |
| Submodules / LFS | none |

### ⚠️ Baseline discrepancy (important)
The mission brief states HEAD `cc1ee99`. **The repository has moved two commits ahead of that** — the UI Expert already landed `f5bdc8b` and `005de03` (brand identity tokens + `BrandMark`; command-bar mark + Dashboard hero band). The reviewer baseline is therefore `005de03`, not `cc1ee99`. Nothing was reverted; the W0-1 recovery point remains intact in history.

## 2. Verified build/test baseline at `005de03`

| Check | Result |
|---|---|
| Web typecheck (`tsc --noEmit -p apps/web`) | **clean (exit 0)** |
| Web tests (`vitest run`) | **54 files, 502 tests, 0 failed** (stable run) |
| Web production build (`vite build`) | **exit 0** (pre-existing chunk-size warning for the 1.26 MB map chunk) |
| Rust tests (from W0-1, unchanged since) | 530 passed, 0 failed, 2 ignored |
| Shared / API typecheck (W0-1) | clean |

### Test-infrastructure observation (MEDIUM, not a code defect)
Repeated `vitest run` invocations on an idle vs loaded machine returned **54/502, 53/500, 52/497** — all reported "passed", with **no `skip`/`skipIf` markers in the suite**. This is consistent with Vitest dropping jsdom workers under resource pressure (one worker per file, `isolate` default). **Implication for the redesign:** a shrinking "green" count is a silent-coverage hazard; CI must pin worker count (e.g. `--pool=threads --maxWorkers=2` or `isolate:false`) and assert an exact expected test count. Recorded as a baseline risk, not confirmed as a source bug.

## 3. Preservation state (verified intact)

- 53 report PNGs, `.tmp-desktop-dev.log`, `.workbuddy-ai/` present and untouched.
- `.data/`, `certs/`, `dist-desktop/` untouched.
- No `git reset`, `clean`, `amend`, or `push` performed.
- No NANI Rust or investigation logic modified.

## 4. Scope of this review

This review produces the eleven `UI_REVIEW_*` reports and answers the final readiness questions. It does **not** redesign, refactor, or change application source. Where a defect is found, it is reported with file + symbol evidence and a recommended remediation task, not fixed.

**Confidence:** high for code facts (read directly); moderate for runtime behaviour (no live VPN/tunnel exercised; UI states were verified from source, and the running app was previously rendered for the UI Expert's screenshots).

---

## 5. ⚠️ Concurrent workstream detected (baseline is live)

During this audit the working tree changed **outside this reviewer's session** (mtimes 22:26–22:30, mid-audit). Verified new/modified paths:

| Path | State | Likely owner |
|---|---|---|
| `apps/web/src/styles/identity.css` (19.8 KB) | new untracked | UI Expert ("Signal / Instrument" identity) |
| `apps/web/src/app/nav.ts` | new untracked | UI Expert |
| `apps/web/src/components/GlobalConnectionChip.tsx` | new untracked | UI Expert |
| `apps/web/src/components/PulseMark.tsx` | new untracked | UI Expert |
| `apps/web/src/features/connection/` | new untracked | UI Expert |
| `apps/web/src/main.tsx` | **modified** (imports `./styles/identity.css`) | UI Expert |
| `reports/FABLE_MASTER_FINDINGS.json` | **modified** (+`NANI-001`/`NANI-002` CRITICAL findings) | parallel NANI auditor |
| `reports/NANI_AUDIT_*.md` | new untracked | parallel NANI auditor |

**Implication.** HEAD is still `005de03`, but the working tree now contains uncommitted UI work in progress and new CRITICAL NANI findings (NANI-001: `InvestigationManager` built with its own empty `ApiRegistry` → investigations observe 0 APIs; NANI-002: manager holds a `EventBus::default()` not the real bus). This reviewer did **not** create or modify any of these files.

**Effect on this review.** The architecture, contract, connection-truth, performance, security, and test findings in UI_REVIEW_01–10 are about the *existing* system and remain valid; the concurrent additions are additive UI (a new stylesheet + nav/chip components) plus a parallel NANI audit that corroborates the connection/truth concerns. The reviewer must **re-verify against the final committed HEAD** before the next stage gate, because the UI Expert is now implementing the redesign in parallel with this review.

**Recommendation.** Freeze a baseline commit (or a `ui-wip` branch) before the UI Expert's next stage, so each review stage diffs against a known tree. The NANI-001/002 findings should be triaged as backend remediation — they are independent of the visual redesign.
