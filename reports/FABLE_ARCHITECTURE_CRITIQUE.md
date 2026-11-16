# FABLE — Architecture Critique (challenge everything)

Format per finding: current design → evidence → failure mode → root cause → proposed design → migration → compatibility → tests → benefits → risks.

## A-1 [CRITICAL] The dual NANI engine

1. **Current**: NANI exists as Rust (`src-tauri/src/network_intelligence`, 19.3k LOC, Tauri-IPC-facing) and as TS (`packages/shared/src/nani`, 2.4k LOC + `apps/api/src/services/naniService.ts` 668 L + `naniShadowHealthLoop.ts`). The sidecar starts its NANI loops unconditionally, even in desktop mode.
2. **Evidence**: `app.ts:608,651,897`; `main.rs` `MonitorLoop` wiring; `naniApi.ts` claims "the same capabilities" — false (Rust is ~8× larger with learning/bandit/drift/changepoint/hierarchical that TS lacks).
3. **Failure mode**: double probing of the same APIs (rate-limit burn, cost), two contradictory "what does NANI know" answers, silent feature divergence, every new NANI feature must be built twice or the UI lies on one platform.
4. **Root cause**: the web (browser) variant was needed for non-desktop mode, then the desktop never turned the web variant off.
5. **Proposed**: **one authoritative engine per surface, explicitly**. Desktop: Rust engine authoritative; Node NANI disabled under `NETPULSE_DESKTOP=1`. Web/server mode: TS core authoritative. Anything shared (hypothesis taxonomy, test catalog, event kinds) moves to `packages/shared` as data, not code.
6. **Migration**: (a) add the gate (1 line), (b) run both for one release with a shadow-comparison script to detect behavioral divergence worth porting, (c) port any TS-only capability users actually hit into Rust or mark unsupported.
7. **Compatibility**: web mode unchanged; desktop loses nothing it actually uses (verify via event-log diff).
8. **Tests**: `naniShadowHealthLoop` tests keep passing (service still exists, just not started in desktop); new integration test asserting the gate.
9. **Benefits**: halves desktop background probing, single source of diagnostic truth, halves NANI maintenance.
10. **Risks**: if some desktop UI secretly reads `/nani/*` routes, it would go stale — verified: `naniApi.ts` routes to Tauri in desktop mode; `AppShell` references `/nani` only for navigation.

## A-2 [HIGH] Dead mathematical machinery (VOI / early stopping)

1. **Current**: `sequential.rs` (VOI, `should_stop`, `cost_adjusted_gain`) + parts of `information_theory.rs` are implemented and tested but never called by the investigation lifecycle.
2. **Evidence**: `cargo check` dead-code warnings (2× each); `investigation.rs` `run_observe_stage` probes all registered APIs without a stopping rule.
3. **Failure mode**: investigations are more expensive and slower than designed; "expected information gain selects the next probe" is true only in the `nani_math_select_probe` display path, not the actual observe loop.
4. **Root cause**: Phase 7 built the theory layer; lifecycle integration was left as future work.
5. **Proposed**: wire `select_best_probe` + `should_stop` into `run_observe_stage` (probe loop: while !should_stop and budget remains, run best probe, update posterior) — or consciously delete the layer.
6. **Migration**: behind a config flag `NANI_ADAPTIVE_STOPPING=1` for one release.
7. **Compatibility**: none broken; events already describe stages.
8. **Tests**: simulator-driven test: adaptive stopping must reduce mean probes-to-diagnosis vs fixed plan on `NetworkSimulator` scenarios.
9. **Benefits**: fewer probes, honest "expected IG drives selection" claim.
10. **Risks**: stopping too early on adversarial evidence — mitigate with minimum-probe floor and the existing Wilson/credible-width machinery.

## A-3 [HIGH] Three "NANI math" homes (Rust, TS core, adapter glue)

- Evidence: `foundation.rs`/`diagnosis.rs` vs `packages/shared/src/nani/*` vs `naniDiagnosticAdapter.ts`/`failureIntelligence.ts`.
- Proposed: Rust = all math. TS = UI types + event contracts only. Delete the TS posterior/diagnosis math after A-1 migration. Keep the TS simulator tests only if they guard shared taxonomy data.

## A-4 [MEDIUM] Feature sprawl vs. one product thesis

- Evidence: 27 pages, ~70 services, 34 route files. Several surfaces exist because prior phases produced them (mission control, overdrive, gaming, optimizer, adaptive…). The honesty discipline (missionControl's verified/observed/not_tested classes) is good — but the breadth dilutes QA and review bandwidth.
- Proposed: freeze the core loop (VPN connect/verify, engines, NANI, diagnostics, DNS, history, settings) as Tier-1; Tier-2 everything else with explicit "not tested" labels (already the case in mission control) and no new Tier-2 features until the roadmap's Tier-1 items close.

## A-5 [MEDIUM] The 157k-line sidecar bundle

- Current: `netpulse-backend.js` is esbuild output with node_modules inlined; shipping design is sound (single file + bundled node.exe).
- Failure mode: none at runtime; risk is **stale-bundle drift** — a dev editing `apps/api` and running the packaged app sees old behavior.
- Mitigation exists (`desktop:verify`, `prepare-desktop`); critique: enforce a mtime/fingerprint check in `desktop:package` that FAILS if any `apps/api/src` file is newer than the bundle (currently a manual discipline).
- Benefit: eliminates the most likely "it works in dev, not in the package" class of bug.

## A-6 [MEDIUM] Two databases, two migration systems

- Local SQLite via drizzle (13 migrations) + D1 via wrangler (5 files, with the duplicate `0005` numbering suspicion C-16).
- Proposed: keep both (different trust domains) but add a CI check that fails on duplicate migration numbers and on `schema.sql`/drizzle snapshot divergence. No R2 needed — D1 suffices for entitlement rows and reset tokens (already the case).

## A-7 [LOW] `os_open`, `elevation`, `dpapi`, `sidecar` are exemplary

Deliberate narrow-IPC design, allow-listed OS handoffs, typed bootstrap — keep as-is. This critique deliberately does not propose refactoring them; the risk of touching them exceeds any benefit.

## A-8 [LOW] Test-suite ergonomics

- 360 s API suite, jsdom churn. Proposed: `pool: 'vmThreads'` or `isolate:false` for unit-only tests, keep isolation for integration tests. Measured: Vitest itself suggests ~31 s savings on API suite; web suite ~90 s jsdom creation. Low effort, high contributor-QoL.

## A-9 Keep / Repair / Replace / Delete summary

| Verdict | Modules |
|---|---|
| **KEEP as-is** | `sidecar.rs`, `elevation.rs`, `dpapi.rs`, `updater_feed.rs`, `engineManager.ts`, `proxyTunnel.ts` core verify loop, `killSwitch.ts`, `missionControl.ts` honesty classes, NANI Rust math primitives (math/bayesian/robust_stats/probability/causal), cloud worker structure |
| **REPAIR** | `investigation.rs` (adaptive stopping), `app.ts` (desktop gate), `naniApi.ts` claim text, Bot/Abystral broken test collection (separate repo), D1 migration numbering |
| **REPLACE** | dual NANI (consolidate), dual failure classifiers (consolidate into Rust + shared data) |
| **DELETE** | `features/nani-reports/`, `aether-*.zip` stubs, stale `dist-desktop/`, `.staging-dist/`, stale `apps/api/dist/` chunks, `.tmp-desktop-dev.log`, dead Rust exports (C-02 list), unused TS NANI math after consolidation |
