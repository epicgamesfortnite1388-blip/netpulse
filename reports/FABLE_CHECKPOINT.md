# FABLE Investigation Checkpoint — COMPLETE

Mission finished 2026-11-16. All 20 deliverables written (21 files incl. this checkpoint).

## Final verified baseline (this session, all executed live)
- API: 1,264 tests green (360 s) · Web: 502 green · Shared: 212 green · Rust: 529 green/0 failed
- Web build OK (10.55 s); entry 574 KB; LiveMapPage 1.27 MB; LatencyChart 350 KB
- `cargo check`: ~55 dead-code warnings; sequential-analysis layer (VOI/should_stop/cost_adjusted_gain) disconnected from the production investigation loop
- `pytest` in Bot/Abystral: collection error in tests/test_resilience.py (deeper inspection not authorized)

## Key decisions delivered
- FABLE-ARCH-001 (CRITICAL): dual NANI engines in desktop — gate `naniShadowHealth.start()` behind NETPULSE_DESKTOP
- FABLE-RUST-001: wire adaptive stopping into investigation.rs or delete the layer
- No fake production functionality found; forensics report adjudicates every suspicious hit
- Execution: tickets T-01..T-12, waves W0..W4, agent allocation with file-ownership rules
- Hard prerequisite: W0-1 — commit the 36-file in-flight working tree before any ticket runs
