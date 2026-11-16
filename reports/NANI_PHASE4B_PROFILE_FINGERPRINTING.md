# Phase 4B - Profile Fingerprinting and Privacy

## Objective
Recognize a returning network locally without a cross-service fingerprint.

## Implementation
The fingerprint is coarse classes (interface, gateway, resolver) plus MTU, not hardware addresses or network names. The persistent key is a random local id.

## Privacy properties
- No SSIDs, MACs, IPs, URLs or payloads in profile records.
- Contexts capped at 64; profiles at 256.
- User can delete one profile or all local data through IPC.
- Stored baselines are numeric summaries only.

## Tests
Matching, separation, eviction, deletion and snapshot tests pass.

## Limitation
Coarse matching can merge networks with identical class/gateway/resolver labels; that privacy trade-off can reduce personalization accuracy.

## Executed evidence
- Rust: 443 passed, 0 failed, 2 ignored.
- Shared: typecheck pass, 212 tests / 14 files.
- API: typecheck pass, 1234 tests / 111 files.
- Web: typecheck pass, 472 tests / 52 files.
- Simulation: NANI 178/220 = 0.809 (95% CI 0.752-0.856) vs fixed 0.636; Brier 0.159; ECE 0.191; H 1.119.
- Debug benchmark (best of 3, 200 iters): update 139.2us, rank 4487.7us, route 0.1us.
