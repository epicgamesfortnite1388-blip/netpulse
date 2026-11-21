# 17 — Remaining Risks and Limitations

This report is deliberately the honest tail of the operation. Every item below is either blocked by authorization, genuinely unverified in this environment, or a low-impact issue that was consciously left alone. Nothing here is claimed to be fixed.

## P0 — blocked by mission scope

- **DD-060 — committed SSH private key.** A tracked 14 MB JSON attachment in `.cloud-attachments/` contains a complete OpenSSH private key, its passphrase and a routable VPS address. Verified without reproducing any value: `git ls-files .cloud-attachments/` lists the file; a PEM-header grep returns one hit. **Owner action required:** rotate/revoke the key, purge the blob from Git history, untrack and ignore the directory, run a history-wide secret scan. This operation is not authorized to rewrite history or force-push, so the finding stays BLOCKED. No key material, passphrase or address appears in any report.

## P1 — none outstanding

The two P1s found during the operation (DD-049 elevation nonce contract, DD-061 Reset App State no-op) were fixed and tested. No P1 remains open.

## P2 — open

- **DD-042 — NANI accuracy suite aggregates only.** Per-condition blind spots (`server_failure` 0/10, `remote_endpoint` 0/10) remain green. No mathematical change was justified; add per-condition floors or document the blind spot explicitly.
- **DD-012 — concurrent provision read-then-upsert** (`cloud/worker/src/vpn-users.ts:53-71`) can transiently hand out the losing credential; self-healing on next provision. Production was not mutated.

## P3 — open

DD-021 speed cancellation (non-cancellable run; tunnel-state annotation now carried), DD-023 batch-import itemization, DD-024 diagnostic path discarded in toast, DD-026 NANI monitor 5 s tick, DD-027 health sync I/O, DD-028 tasklist.exe burst, DD-029 connection poll without backoff, DD-030 GlobeCanvas rAF, DD-037 speed history refresh, DD-039 Cloudflare unhandled rejections, DD-040 swallowed DNS delete failure, DD-041 IpPage WebRTC cleanup, DD-043 duplicate investigation terminal event, DD-044 source-text proxy test, DD-063 EventsPage inert detail control, DD-064 clipboard false success, FE-DD-04 dark-theme danger contrast, FE-DD-05 command-palette dialog semantics. All are real but non-blocking; each is in the findings register with file/line evidence.

## P4 — open / accepted

DD-004 (ts-prune advisory, honestly labelled), DD-005/DD-006/DD-052 version sync, DD-007/DD-051 doc/test overstatement, DD-008 insecure loopback transport (required for local feed; release stamps HTTPS), DD-013 rate-limit non-atomicity, DD-014/015/016 accepted contract risks, DD-017 AI header naming, DD-023/024, DD-045 NaN prior defensiveness, DD-050 weak e2e assertions, DD-053 orphaned feature files, DD-054 aria-label.

## Environment limitations (not defects)

- **No live VPN traffic proof.** No installer was built and no tunnel was brought up; exit-IP/relay proofs were audited in code, not re-executed. Reports never claim a running process equals a working VPN.
- **No real WebView2 run.** Keyboard/focus/screen-reader behavior and rendered contrast were checked from source and tests, not a live engine. The real-webview navigation test is `#[ignore]` by default and needs tauri-driver.
- **No production integrations.** No real account, payment, subscription, Cloudflare or VPS operation was attempted; all fixtures were synthetic.
- **Sandbox blocks.** `reg.exe` was blocked during one API run (suite still green); repeated cargo commands emitted a post-success sandbox notice. Neither was treated as a product failure.
- **Concurrent session.** Another session edited the same working tree during this operation (release gates, secureStore, system-health reset, elevation nonce, additional findings). Edits were made with exact-string replacement to avoid clobbering; a final full-suite run was performed against the combined tree. Reviewers should treat the tree as a merge of both cycles.

## Process risks

- The findings register used duplicate IDs DD-032..036 across two agent sets; they were reconciled to DD-060..064 for the first set with an explicit note. Nothing was deleted.
- Worker tests are load-sensitive (one run produced 2 failures that passed in isolation and on rerun). Treat a single red worker run as a signal to re-run before concluding a regression.
- No commits were made; all work lives in the working tree. A future maintainer must stage explicitly.
