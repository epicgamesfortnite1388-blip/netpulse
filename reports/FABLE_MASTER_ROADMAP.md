# FABLE — Master Roadmap

Same content as root `ROADMAP.md` (Waves 0–4 with IDs, dependencies, acceptance criteria, verification commands, priority, complexity, status). That file is the operative roadmap; this report records the classification basis.

## Feature verification classification (from prior phase claims → code)

| Claimed feature | Classification | Basis |
|---|---|---|
| VPN connect (cores/Aether/WG) with verified exit IP | VERIFIED COMPLETE (traced) | `proxyTunnel.ts`, `aetherProvider.ts`, `VpnPage.tsx` |
| Engine install with digest pinning | VERIFIED COMPLETE | `engineManager.ts` + unit tests |
| Kill switch (proxy-layer, fail-closed) | VERIFIED COMPLETE (honest scope) | `killSwitch.ts` |
| Updater with minisign + loopback fix | VERIFIED COMPLETE | `updater_feed.rs` |
| Sidecar supervision | VERIFIED COMPLETE | `sidecar.rs` + unit tests |
| NANI math primitives (stats/Bayes/IG/causal/changepoint) | VERIFIED COMPLETE | 364 tests, green |
| NANI investigation lifecycle (events, cancel, replay) | VERIFIED COMPLETE | `investigation.rs` + UI |
| Adaptive stopping / VOI-driven probing | IMPLEMENTED BUT UNVERIFIED (disconnected) | compiler dead-code evidence |
| Continuous calibration (ECE/Brier on real runs) | PARTIALLY IMPLEMENTED | machinery yes, continuous no |
| Web NANI parity with desktop | NOT IMPLEMENTED (subset only) | LOC + module comparison |
| Dual-engine consolidation | NOT IMPLEMENTED (the defect) | ARCH-001 |
| Hierarchical pooling in production | IMPLEMENTED BUT UNVERIFIED (shelf) | dead-code warnings |
| Learning (verified-only updates) | IMPLEMENTED BUT UNVERIFIED (needs field data) | code + tests, no field validation |
| nani-reports UI | NOT IMPLEMENTED / OBSOLETE | dead page |
| Mission Control honesty classes | VERIFIED COMPLETE | `missionControl.ts` |
| Cloud D1 entitlements + telegram | VERIFIED COMPLETE (deployed per git) | worker + migrations |
| AI copilot proxy | VERIFIED COMPLETE (503 when unconfigured) | worker config |
| Bot/Abystral tests | BROKEN | pytest collection error |
| D1 migration chain | PARTIALLY IMPLEMENTED (0005 duplicate suspicion) | two files numbered 0005 |
| Packaging freshness enforcement | NOT IMPLEMENTED | manual discipline only |

## Execution order rationale

1. Baseline integrity first (W0): nothing else can be verified against a moving tree.
2. Single-engine consolidation (W0-3) before touching NANI math (W1): halving the probing surface changes the environment every W1 test runs in.
3. Wire/dispose the dead intelligence layer (W1) before any new intelligence features: never add math while existing math is disconnected.
4. Transparency + persistence hardening (W2): cheap, independent.
5. Performance (W3): measured-only items, after functional waves.
6. Field validation (W4): the project's next real risk is unvalidated intelligence in the field, not missing features.
