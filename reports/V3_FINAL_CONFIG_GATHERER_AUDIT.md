# NetPulse V3 — Configuration Gatherer Audit

**Status: IMPLEMENTED, UNIT-TESTED; live-source verification NOT TESTED in this release run.**

## What was verified

The configuration subsystem is present in the API and covered by the 1227-test API suite. The following behaviours are implemented in source and exercised by existing tests:

| Requirement | Implementation | Verification |
| --- | --- | --- |
| Approved source retrieval | Source registry with allow-listed providers | Unit/integration tests in API suite |
| Source failure handling | Per-source attempt reports; failures recorded, not converted to success | API tests |
| Parsing | Protocol-specific share-link parsers (VLESS/VMess/Trojan/SS) | API tests |
| Normalization | Canonical config model before scoring | API tests |
| Exact deduplication | Key-based exact match | API tests |
| Similarity detection | Normalized structural similarity | API tests |
| Structural validation | Required fields, ports, UUIDs, transport constraints | API tests |
| Endpoint testing | TCP/TLS/HTTP probes with explicit unknown outcomes | API tests; live network NOT TESTED |
| Protocol validation | Protocol/transport compatibility checks | API tests |
| Application-level usability | Reachability alone is not treated as usable; an end-to-end check is required | API tests |
| Reliability scoring | Mathematical score with confidence, not a boolean | API + shared tests |
| Adaptive testing | Budgeted re-testing by uncertainty | API tests |
| Expiration | Staleness/expiry fields and filtering | API tests |
| Persistence | Drizzle/SQLite storage | API tests |
| UI updates | Node explorer/config intake routes wired to API | Route-wiring test |
| Optional lightweight LLM | Assistive only; cannot promote a candidate | Source review |

## Safety properties reviewed

- **Public accessibility is not redistribution permission.** The source registry is separate from reachability probes; a reachable endpoint is not automatically eligible for listing.
- **Unknown remains unknown.** Failed or timed-out probes are not scored as zero reliability; they remain untested with lower confidence.
- **LLM cannot promote.** Acceptance requires deterministic validation and endpoint usability; model output has no write path to the accepted-config store.
- **LLM failure does not disable the gatherer.** The deterministic pipeline runs independently.
- **No credentials in output.** Config intake reports redact secrets; the packaged bundle was scanned for keys and tokens and none were found.

## Not tested in this run

No public sources were fetched and no live endpoints were probed. That requires network access to third-party providers and could change external state; it was not performed as part of installation verification. The installed UI was not clicked through. Therefore this report does **not** claim the gatherer was verified end-to-end against live sources for V3.
