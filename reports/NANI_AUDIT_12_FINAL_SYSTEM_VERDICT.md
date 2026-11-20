# NANI_AUDIT_12 — Final System Verdict (Missions A–J + scoring)

## The five most severe root causes

1. **NANI-001 — The investigation engine's registry is empty by construction** (main.rs:243–249 constructs a second `ApiRegistry`; only `state.registry` receives the one API). Investigations observe nothing, always.
2. **NANI-002 — The investigation engine's event bus is a placeholder** (no AppHandle, not the replay bus). Every lifecycle event is emitted into the void; the UI's live pipeline, evidence, and event-derived panels are structurally blind to investigations.
3. **NANI-003 — Analysis bypasses the Bayesian engine.** `run_analyze_stage` is a per-layer failure-ratio counter; the 12-hypothesis likelihood machinery — the actual intelligence — never runs in the decision path.
4. **NANI-004/005 — Nothing persists.** `PersistenceStore` is constructed and never written; investigation history is an in-memory 50-item vector; no report builder/store/UI exists. Completed investigations evaporate.
5. **NANI-006/007 — Copilot has no LLM.** The cloud path is fully built but unconfigured (`ABYSTRAL_AI_BASE_URL=""` → honest 503), the desktop path is a local deterministic explainer (real, but not an LLM, no tools, no history), and the frontend header falsely claims cloud connectivity.

## Answers to the final questions (no evasion)

1. **Does NANI currently perform real investigations?** No. It runs a lifecycle that observes an empty registry, analyzes nothing, cannot verify, and reports emptiness into a void.
2. **Can it execute diagnostic probes?** The probe code is real and works — but only through the health-check and monitor paths, never through investigations.
3. **Does it collect real evidence?** The monitor collects real evidence for the one hardcoded API; investigations collect none; nothing is persisted.
4. **Does the mathematical core influence actual diagnostic results?** Only peripherally (health-check posterior maintenance, monitor learning, display commands). The investigation "diagnosis" never touches it.
5. **Can it verify hypotheses correctly?** The verify stage re-probes correctly *in principle*, but with an empty registry it returns false immediately.
6. **Does it persist investigations?** No — in-memory, 50 items, lost on restart.
7. **Can it produce real diagnostic reports?** No report capability exists.
8. **Can users access reports?** No; the reports page is dead UI.
9. **Does Copilot have a real backend?** A real deterministic local explainer (yes, real but not an LLM); the cloud LLM backend is fully implemented on both sides and unconfigured.
10. **Does Copilot call a real LLM?** No. Never has, in any shipped path.
11. **Which provider/model is configured?** None for NetPulse. (The Abystral telegram gateway supports DeepSeek/OpenAI/Anthropic via an XKiro-style router — real, and the correct backend once the user configures the two worker values.)
12. **Does Copilot receive real NetPulse network context?** Registry health + learning counters only — no VPN state, no investigations, no evidence.
13. **Can it call real NANI functionality?** No tool layer exists.
14. **Is Copilot merely a frontend mock?** It is a real local explainer wearing a chat UI with a false cloud-claim header — not a mock, but not an AI assistant either.
15. **Five most severe root causes:** listed above.
16. **Minimum work for genuine functionality:** N0.0–N0.3 (wire registry+bus, integration test, manual verification) + N1.1 (engine in the loop) + N2.1–N2.2 (persistence + reports). That is a working investigation product.
17. **Before adding more advanced AI:** N3 (real provider, streaming, persistence, honest states) and N4 (structured NANI tools with provenance) — never more math first.
18. **Before claiming production-ready:** N0–N2 complete, N3 honest-or-configured, E2E matrix rows 1–14 PASS in a live desktop run, calibration labeled, D1 quota resolved or mitigated.

## Scores (weighted per the mission table)

| Category | Weight | Score | Basis |
|---|---:|---:|---|
| Actual investigation execution | 20 | **4** | lifecycle runs; probes/verify/analysis dead |
| Probe execution & evidence collection | 15 | **7** | real probes exist & work on health path; never in investigations; nothing persisted |
| Mathematical correctness in real execution | 15 | **6** | math correct+tested; participates only in peripheral paths |
| Hypothesis verification & uncertainty | 10 | **3** | honest insufficiency machinery; verify stage inert; concept conflation in UI |
| Reporting & persistence | 10 | **1** | store unwritten; no reports; in-memory history only |
| Copilot backend & real LLM integration | 15 | **4** | no configured LLM; deterministic explainer real; upstream gateway real-but-unconfigured |
| Copilot/NANI interoperability | 10 | **3** | registry/learning facts only; no tools, no VPN/investigation context |
| Reliability, observability, testing | 5 | **2** | strong unit tests; zero E2E; the wiring defects were invisible to all suites |
| **TOTAL** | **100** | **30/100** | |

Separate sub-scores:

| Subsystem | Score /100 | One line |
|---|---:|---|
| Mathematical core | **85** | correct, adversarially tested, 60% disconnected from decisions |
| Actual runtime functionality | **30** | monitor+health work; the headline feature does not |
| Copilot | **25** | honest local explainer; no LLM, no tools, false header |
| Reporting | **10** | nothing durable exists |

## Final statement

The gap between NANI-as-written and NANI-as-running is almost entirely **wiring**: three construction lines (registry, bus, persistence writers) plus one integration decision (engine in the loop) separate a 30/100 from a genuinely functional diagnostic product whose mathematics are already built and tested. The recovery blueprint (`NANI_AUDIT_11`) sequences exactly that, before any new intelligence is added.
