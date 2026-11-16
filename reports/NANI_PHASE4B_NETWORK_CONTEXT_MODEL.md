# Phase 4B - Network Context Model

## Objective
Represent a network without tracking identifiers.

## Implementation
ContextSignals uses interface class flags, gateway class, resolver class and MTU. It excludes SSID, BSSID, MAC, public IP and URLs. NetworkContextId is a local random u64.

Matching uses class + gateway class + resolver class. Contexts are capped at 64 and evicted least-recently-used.

## Tests
Returning signals reuse the id; a class/gateway change creates a separate id; remove/clear and capacity tests pass.

## Limitation
Signals must be supplied by a platform collector. No collector was implemented, so the model is not automatically populated at desktop boot.

## Executed evidence
- Rust: 443 passed, 0 failed, 2 ignored.
- Shared: typecheck pass, 212 tests / 14 files.
- API: typecheck pass, 1234 tests / 111 files.
- Web: typecheck pass, 472 tests / 52 files.
- Simulation: NANI 178/220 = 0.809 (95% CI 0.752-0.856) vs fixed 0.636; Brier 0.159; ECE 0.191; H 1.119.
- Debug benchmark (best of 3, 200 iters): update 139.2us, rank 4487.7us, route 0.1us.
