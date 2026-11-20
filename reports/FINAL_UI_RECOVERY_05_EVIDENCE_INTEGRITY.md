# FINAL_UI_RECOVERY_05_EVIDENCE_INTEGRITY

## F-35 scope

The prior review found false or overstated claims in the UI_MASTER report set. Rather than silently rewriting history, correction appendices were added while preserving the original text.

## Corrected reports

| Report | Original issue | Correction |
|---|---|---|
| `UI_MASTER_02_DESIGN_SYSTEM.md` | Contrast values quoted from base `tokens.css` as if shipped; “seven reduced-motion blocks”; broad `animate-ping` removal claim | `identity.css` is imported last and overrides tokens; actual pairs recomputed; block count is five; `animate-ping` removed from NANI AiCore only, one guarded instance remains in `AgentPathTrace.tsx` |
| `UI_MASTER_09_MOTION_AND_MICROINTERACTIONS.md` | Claimed seven reduced-motion blocks and unconditional removal of `animate-ping` | Five blocks; NANI AiCore scope qualifier |
| `UI_MASTER_10_ACCESSIBILITY.md` | Incorrect contrast ratios | Recomputed from shipped cascade |
| `UI_MASTER_11_FRONTEND_PERFORMANCE.md` | Stale line/test/build claims | Corrected to final recovery evidence |

## Recomputed contrast values

Calculated from the actual shipped CSS cascade (`identity.css` imported after `tokens.css`):

| Pair | Ratio | WCAG AA |
|---|---:|---|
| faint / surface (dark) | 4.62:1 | Pass |
| on-accent / accent (dark) | 9.74:1 | Pass |
| warn / surface (dark) | 9.27:1 | Pass |

All three pairs still pass AA. The original failure was in the evidence claim, not necessarily in the visual result.

## Reduced-motion inventory

- Actual `prefers-reduced-motion` blocks: **5**.
- `animate-ping` was removed from NANI AiCore.
- One `animate-ping` remains at `AgentPathTrace.tsx:78` and is paired with `motion-reduce:animate-none`.

## Evidence rules applied in this recovery

- No test was counted unless its command output was captured.
- No “green” assertion was accepted when it tested the wrong state (the original F-30 test was replaced with a true mid-flight abort test).
- No build was claimed from a blocked default `dist` cleanup; builds used fresh output directories.
- No visual pass was claimed from Vite error-overlay screenshots; those captures were discarded and recaptured after aliases were fixed.
- No production/source fix was attributed to a test-only correction.
