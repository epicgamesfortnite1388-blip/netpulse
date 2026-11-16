# NANI Real-World Validation

## Status
Not implemented.

## What exists
- Deterministic simulator scenarios in `simulation.rs` (DNS, TCP, TLS, HTTP, latency, jitter, loss, IPv4/IPv6, outages, recovery).
- Evidence and measurement validation in `evidence/`.

## Missing
- Reproducible field-test harness across ISPs/networks.
- Dataset with timestamps, network context, measurement method, outcome, classification, action, verification, confidence, data quality, privacy classification.
- Real-world metrics (DNS reliability, TCP success, TLS success, HTTP success, recovery success, false recovery rate).

## Next steps
- Build an opt-in, privacy-minimized telemetry export from the desktop app.
- Run staged validation on multiple networks and hardware profiles.
- Report simulator vs real-world separately.
