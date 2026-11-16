# FABLE — Master Findings Registry

Machine-readable source: `reports/FABLE_MASTER_FINDINGS.json`. Confidence levels reflect evidence strength (all findings below carry proven or compiler-checked evidence unless noted).

| ID | Sev | Category | Finding (one line) | Status |
|---|---|---|---|---|
| FABLE-ARCH-001 | CRITICAL | duplication | Two NANI engines run simultaneously in desktop (Node shadow loop + Rust MonitorLoop); TS core is an 8× smaller subset of the Rust engine | OPEN |
| FABLE-RUST-001 | HIGH | dead-code | Sequential analysis (VOI, `should_stop`, `cost_adjusted_gain`) implemented+tested but never called by the investigation loop | OPEN |
| FABLE-RUST-002 | MEDIUM | dead-code | ~55 compiler dead-code warnings across `network_intelligence` (shelf constructors/observers/predictors) | OPEN |
| FABLE-MATH-001 | MEDIUM | math | Evidence confidence weighting is a pseudo-likelihood (`ll*c`), not a derived likelihood model | OPEN |
| FABLE-MATH-002 | MEDIUM | math | Brier/ECE calibration machinery exists but is not run continuously on real investigations | OPEN |
| FABLE-UI-001 | MEDIUM | ui | `features/nani-reports/` dead page (unrouted, unimported) | OPEN |
| FABLE-UI-002 | LOW | ui | `naniApi.ts` claims web mode serves "the same capabilities" as the Rust engine — false (subset) | OPEN |
| FABLE-BUILD-001 | **CRITICAL** (was MEDIUM) | build | 36 files of in-flight uncommitted work (+2,656/−493) at review baseline; 21 NANI Rust files/dirs untracked incl. `commands/`, `foundation.rs`, `investigation.rs`, `sequential.rs` | **RESOLVED** (W0-1: commit `384f7f9`, 262 files, +30,523/−516; backup+restore verified 317/317 ×2; engine restorable from Git) |
| FABLE-BUILD-002 | LOW | hygiene | Committed junk: `aether-*.zip` stubs, stale dist chunks, scratch dirs, 144 KB dev log | OPEN |
| FABLE-BUILD-003 | LOW | build | No enforced bundle-freshness fingerprint in `desktop:package` | OPEN |
| FABLE-VPN-001 | MEDIUM | vpn | sing-box pin refusals are invisible to the user (correct security, poor explainability) | OPEN |
| FABLE-VPN-002 | LOW | vpn | Post-install engine version may show stale-absent for ≤30 s (cache not forced) | OPEN |
| FABLE-SEC-001 | MEDIUM | security | Bundled Node runtime has no documented version pin/CVE policy | OPEN |
| FABLE-SEC-002 | LOW | security | `evidence/leak-live-20261112/` committed — contents need sensitivity review | OPEN |
| FABLE-INFRA-001 | MEDIUM | infra | D1 has two migrations numbered `0005` (ordering hazard, unproven) | OPEN |
| FABLE-TEST-001 | MEDIUM | test | API suite 360 s; web jsdom churn 90 s — slow red-green loops | OPEN |
| FABLE-ECO-001 | MEDIUM | ecosystem | Bot/Abystral pytest fails at collection (`tests/test_resilience.py`) | OPEN |
| FABLE-ARCH-002 | MEDIUM | duplication | Failure classification implemented in Rust and TS (drift risk) | OPEN |
| FABLE-PERSIST-001 | MEDIUM | persistence | Two persistence systems hold NANI knowledge (consequence of ARCH-001) | OPEN |
| FABLE-DOC-001 | LOW | docs | Stale grade/acceptance documents lack a supersession index | OPEN |
| FABLE-ECO-002 | MEDIUM | ecosystem | Abystral-ledger (92k LOC) never deep-audited — unknown quality | OPEN |
| FABLE-DOC-002 | INFORMATIONAL | verification | Subsystem ratings published (FABLE_SUBSYSTEM_RATINGS.md): overall 8.4/10 (A−); weakest: hygiene 5.0, Bot 3.5 | CLOSED (rated) |

## Explicitly NOT findings (adjudicated in Fake-Function Forensics)

- No fake measurements, simulated connectivity, hardcoded confidence, or fake-success paths reachable in production.
- 63 `ok:true` patterns, 8 `Math.random()` uses, simulation module, webrtc/iran/speed "mock" comments — all benign or honest-degradation (F-01..F-16 in the forensics report).

## Not-a-defect register (to prevent future false alarms)

- `engineManager` 30 s version cache / 10 min release cache — correct given GitHub rate limits.
- Kill switch proxy-layer-only enforcement — honestly stated in-code.
- Hysteria `--version` fallback — correct handling of urfave/cli.
- `simulation.rs` — test fixture, gated from production by construction.
