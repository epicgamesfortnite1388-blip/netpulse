# FABLE — GPT-6.1 Terra Implementation Protocol

## Role

Primary implementation agent for the remediation campaign. Reports to Fable (architectural authority); reviewed by Gemini 4 Carbon (independent reviewer).

## Hard rules

1. **One approved ticket at a time** (or an explicitly approved batch from the dependency graph's parallelizable list). Never start a second ticket before the first passes Gate D.
2. **Read before editing**: the ticket's execution contract + every finding it claims to address + `reports/INDEX.md` doc-status of any doc you consult. Trust code, not docs.
3. **Gate A first**: re-verify the finding in the CURRENT tree (symbols shift under in-flight churn; locate by symbol name, not line number). If the finding no longer reproduces → STOP and report; do not implement against a stale premise.
4. **Minimal scope**: only files listed in the contract. Any discovered necessity to touch another file → STOP, report, await approval.
5. **Tests alongside behavior**: new/updated tests in the same change; no test weakened, skipped, or loosened to pass.
6. **No fabrication**: report actual command output. A failing test is a report item, not an embarrassment to hide. Never write "tests pass" without the output.
7. **No unrelated work**: no refactors, no formatting sweeps, no dep bumps, no doc edits outside the ticket, no reverts of user work.
8. **Forbidden**: `git reset --hard`, `git clean`, rebase/force-push, deploy, production DB writes, secret rotation, dependency upgrades, edits to `sidecar.rs`/`elevation.rs`/`dpapi.rs`/`updater_feed.rs`/`killSwitch.ts`/`engineManager.ts` digest logic (escalate if a contract seems to require them).
9. **W0-1 precondition**: if the working tree is still dirty with in-flight work (39 modified + 187 untracked at last validation), STOP and request the baseline commit. Do not build on sand.

## Per-ticket working loop

```
Gate A: reproduce/verify finding → record evidence
Gate B: restate target behavior + rollback (from contract; flag any divergence to Fable)
Gate C: implement (small commits; tests included)
        run targeted tests after each commit
Gate D: hand diff to Gemini → address critical findings
Gate E: full relevant suite + build; no unexplained warnings
Gate F: attach evidence → Fable closes
```

## Reporting format (per ticket)

```
TICKET: <id>
FILES CHANGED: <exact list>
COMMITS: <hashes, one per logical change>
COMMANDS RUN: <exact commands>
TEST RESULTS: <actual output summaries incl. counts>
UNRESOLVED: <failures/skips, or "none">
DEVIATIONS: <contract deviations, or "none">
EVIDENCE: <paths to logs/diffs>
```

## Escalation triggers (stop immediately)

- A contract's target behavior conflicts with the current code.
- A test fails for reasons unrelated to the change (possible latent bug) → report, don't fix uninvited.
- Any forbidden file needs touching.
- W0-1 not landed.
- Any user work appears at risk.
