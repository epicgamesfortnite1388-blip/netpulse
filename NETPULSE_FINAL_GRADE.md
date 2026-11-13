# NetPulse — Final Grade

**Mission:** `NETPULSE_AETHER_AUTONOMOUS_V2`
**Evaluation date:** 2026-11-04
**Grade:** **89 / 100 (B+)** — *verified engineering with a working public-node path; the central censored-network claim is still unproven.*

> **A note on the number.** The 2026-11-03 report also said 88/100; this one is 89 after a live training run and three defects it exposed in the adaptive path. That is a coincidence, not an endorsement. The earlier figure was produced by scoring modules that did not work (one has since been deleted) and by marking planned work as done. This figure is produced by artifacts, and it is held below 90 by four named gaps in §3.

---

## 1. Category scores

| Category | Weight | Score | Basis |
| --- | ---: | ---: | --- |
| Aether integration and provenance | 20% | **84** | Real 2.4.0 binary, checksum-verified install, relay + exit-IP + tunnel-DNS proofs, reconnect, 4/4 negative controls, pinned submodule commit documented. Deductions: Windows only, no byte counters, `--team` pinning unused |
| Free-configuration discovery | 15% | **82** | 9/9 feeds live, 34,150 parseable configs, 437-duplicate collapse in one import, dead feeds retired on 404 evidence, duplicate feed rejected by sha256. Deductions: single vantage, Telegram excluded, 5.9% yield |
| Validation, probing and ranking | 15% | **78** | 270 bounded probes, traffic-required verification, failure taxonomy, evidence-age staleness, untested cap 55, port-only cap 70. Deductions: no throughput measurement, most of the catalog is dead by nature |
| Smart Connect | 10% | **84** | **Live end-to-end verified**: 300 candidates ranked in 43 ms, real probe verified Shadowsocks/xray at 580 ms HTTP 200, `node_tests` and adaptive state written, UI card shipped. Deductions: one live run, no automated UI test |
| Adaptive AI | 10% | **82** | Deterministic bounded bandit, 4 µs ranking, 79 KB state, censored corpus 0/15 → 5/15 with 0 losses; ranking on a lower confidence bound; **training run live** — 56 dials, 4 verified, calibration **skill +0.104** (Brier 0.146 vs 0.25) on 12 scored samples. The run also found and fixed three defects in this machinery: no nudge ever reached a real engine (`xray+doh` split on `:`), predictions were dropped on state reload, and the training queue only saw the top of the ranking. Deductions: replay evidence, 12 samples is direction not proof, node-level nudge effect still untested |
| Security and privacy | 10% | **76** | DPAPI-held vault key, addresses withheld from responses, a real SSRF hole found and closed, explicit per-node warnings. Deductions: plaintext Aether identity, UDP/QUIC leak matrix open |
| UI / UX | 10% | **66** | Existing premium surfaces; `SmartConnectCard` and `AgentAutonomyCard` **rendered in the running app** against the trained database (screenshots in `reports/screenshots/`) and covered by an automated render test (11 tests) on the real markup. Deductions: no interaction test for Verify/Train, no keyboard/a11y audit, explorer not extended for the decision model, one metric label wraps in the autonomy strip |
| Testing | 10% | **86** | Measured: API **1,198 tests / 107 files**, web **472 / 52**, shared **136 / 10** (1,806 total, all exit 0); three typechecks exit 0; eslint exit 0; `vite build` exit 0; 40 Smart Connect + 28 agent-permission tests; live training run with measured calibration (skill +0.104). The full suite caught one fixture that asserted a keyless REALITY config was dialable — corrected to a real one. Deductions: Iran untested, no automated UI test, node-record classification defect open |
| Documentation and honesty | 10% | **92** | Ten reports, each claim tied to a path/test/URL; unmeasured metrics marked; prior inflated grade corrected |

**Weighted total: 89.4 / 100 → 89.**

---

## 2. What this evaluation actually produced

1. **A working Smart Connect path, proven live.** Not a design: a plan, a bounded probe, a verified endpoint, persisted test rows, adaptive feedback, and a UI card.
2. **Three defects that only the live run could find**, all fixed and tested:
   - an empty-list message that blamed the configurations when the real cause was a missing core;
   - a staleness filter that would have excluded the entire freshly imported catalog (and later a node that had just passed a probe, because the `freshness` flag is not cleared by tests);
   - a TCP-only success scoring 93 and displacing a node that had actually carried HTTP traffic at 580 ms.
3. **One security regression removed**: a duplicate discovery module that fetched user-supplied URLs with no SSRF guard, kept state only in memory, and advertised validation it did not perform.
4. **Honest replacement of a false grade** with an artifact-backed one.

---

## 3. Why it is not higher — four named gaps

| Gap | Why it caps the grade |
| --- | --- |
| **Iran is `NOT TESTED`** | The mission's premise is circumvention on a censored network. Every network measurement was taken from a host behind an existing VPN on a non-Iranian network. Until `npm run field:iran` runs on an Iranian ISP, the headline claim is unproven. |
| **Throughput is `NOT MEASURED`** | No download/upload figure exists for any tunnel in this project. The UI therefore shows none, and the product cannot honestly claim speed. |
| **sing-box is unavailable** | Its pinned tags no longer resolve upstream, so Hysteria2 and TUIC are structurally `engine_unavailable`. That is a fixable dependency, and it is not fixed. |
| **Non-Windows targets are `NOT TESTED`** | Aether has native Linux/macOS/Android builds, but NetPulse has only ever run the Windows client. PattNG's Android binding was not inspected. |

---

## 4. Highest-value next work, in order

1. **Run the Iran field harness** and publish the result, whatever it says. This is the mission.
2. **Fix the sing-box pin** so the protocol matrix is complete.
3. **Measure throughput** on a verified tunnel, then display it — or keep showing nothing.
4. **Encrypt the Aether identity** through the existing vault.
5. **Add an interaction test** for the Verify and Train buttons (both cards now render and are covered by a render test; the click path is untested).

---

## 5. Final statement

This is no longer a design document wearing a grade. The public-node path discovers, dedupes, ranks, dials, verifies and learns, and it does so with a test row and an HTTP status behind every claim. What it still cannot do is prove itself on the network the mission was written for.

**89 / 100 — B+.**

A claim without an artifact is not a result. That rule produced this grade, and it should produce the next one.
