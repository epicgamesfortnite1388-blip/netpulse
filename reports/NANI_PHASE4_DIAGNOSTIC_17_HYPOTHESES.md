# Phase 4 - Diagnostic Hypothesis Space

## Objective
Verify the expanded hypothesis space and remove stale identifiers.

## Implementation
packages/shared/src/nani/types.ts exports 18 hypotheses including unknown: gateway, dns, dns-inconsistency, routing, ipv4, ipv6, tcp, tls, udp, mtu, congestion, filtering, remote-endpoint, api-auth, api-rate-limit, application, server, unknown. Rust has 18 causes plus unknown, with an extra UpstreamProxy cause retained by the simulator.

defaultTests.ts referenced non-existent local-interface and upstream-proxy keys and broke shared typecheck. They were removed; every test now emits a normalized row for all 17 hypotheses.

## Tests
New nani.hypotheses.test.ts: 17 unique hypotheses, required causes present, every likelihood row sums to 1 and stays in [0,1], empty evidence yields top=null and insufficient evidence.

## Gap
Application and server causes are now separate. The total is 18 (17 causes + unknown).

## Executed evidence
- Rust: 443 passed, 0 failed, 2 ignored.
- Shared: typecheck pass, 212 tests / 14 files.
- API: typecheck pass, 1234 tests / 111 files.
- Web: typecheck pass, 472 tests / 52 files.
- Simulation: NANI 178/220 = 0.809 (95% CI 0.752-0.856) vs fixed 0.636; Brier 0.159; ECE 0.191; H 1.119.
- Debug benchmark (best of 3): update 139.2us, rank 4487.7us, route 0.1us.
