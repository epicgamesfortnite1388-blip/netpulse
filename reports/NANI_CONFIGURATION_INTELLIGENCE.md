# NANI Configuration Intelligence

## Implemented

`config_intelligence.rs` defines the pipeline:

`DISCOVER → PARSE → NORMALIZE → VALIDATE → DEDUPLICATE → TEST → SCORE → CLASSIFY → STORE`

- Canonical and structural fingerprints.
- Distinct states: Discovered, Parsed, ValidSyntax, StructurallyValid, Reachable, AppVerified, TemporarilyUnavailable, Expired, Unsupported, InsufficientEvidence, PermissionNotEstablished, ApprovedForDistribution.
- Separate redistribution permission state (Permitted/Prohibited/Unknown).
- Source reputation, discovery time and last validation time.
- Scoring uses success probability, latency, jitter, loss, stability, freshness and uncertainty.

The TypeScript gatherer in `apps/api` owns retrieval, protocol parsing and endpoint probes; the Rust module owns the mathematical classification/scoring model.

## Tested

- Configuration intelligence tests run inside the API/Rust suites.
- Route-wiring tests verify the UI paths for configuration intake exist.
- Full Rust suite: 419 passed. API suite result is recorded in `NANI_TEST_RESULTS.md`.

## Verified

- Public availability is not treated as redistribution permission.
- A reachable endpoint is not labelled AppVerified; that requires an application-level check.
- Missing evidence maps to InsufficientEvidence, not failure.
- No credentials are stored in scoring fields.

## Not tested

No live third-party source was fetched and no public endpoint was probed in this pass. Live discovery, source terms and rate limits were not exercised. This report does **not** claim a verified live gatherer.

## Deferred

- Wiring the Rust scoring model to the live TypeScript discovery result as one typed pipeline.
- Adaptive test scheduling using expected information gain and source rate limits.
- Persisted per-source reliability and expiry models.
