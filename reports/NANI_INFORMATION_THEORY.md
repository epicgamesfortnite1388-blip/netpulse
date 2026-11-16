# NANI Information Theory

## Implemented

- Shannon entropy of the posterior (`uncertainty`).
- KL divergence and Jensen-Shannon divergence in `math.rs`/`bayesian.rs`.
- Expected information gain per diagnostic test, enumerating all probe outcomes and weighting by predictive probability (`diagnosis.rs`).
- Cost-aware ranking (`rank_tests`), with a fixed cost per test type.
- Sequential stopping (`sprt_stop`, `should_stop_testing`).

## Tested

- Information gain matches the ranker (`information_gain_matches_ranker`).
- Entropy of a uniform distribution over the declared hypothesis space.
- SPRT accept/continue/reject boundaries.
- Stopping thresholds for low entropy and high MAP probability.
- `cargo test`: 419 passed, 0 failed, 2 ignored.

## Benchmarked

Ranking all tests (8 tests, 6 outcomes, cloned engines) measured **4300.4 µs** in the debug benchmark, under the 5000 µs debug cap. No release-mode measurement was taken, so no production latency claim is made.

## Limits

- Information gain assumes the current likelihood table is correct; it does not account for model uncertainty.
- Test cost is a static table, not measured per network.
- No value-of-information calculation that includes user impact or action cost.
- No adaptive test scheduler is wired to the live UI; ranking exists as an engine capability.

## Deferred

- Bayesian experimental design over continuous test budgets.
- Information-theoretic source selection for the configuration gatherer.
- Calibrated expected-cost-of-error ranking.
