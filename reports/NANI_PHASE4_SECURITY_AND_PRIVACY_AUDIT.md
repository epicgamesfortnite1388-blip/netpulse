# Phase 4 - Security and Privacy Audit

## Reviewed
- No new crate or npm dependencies.
- Local random ids only; no SSID/MAC/IP/URL/hardware identifiers in profiles.
- Fixed profile path under the app data directory; no user-supplied path in IPC.
- File-size cap, schema validation, Beta parameter validation.
- Atomic temp-file + rename writes; corrupt files ignored and reported.
- IPC reset/delete for personalization.
- LLM cannot write evidence or posteriors; this change does not touch the LLM path.

## Risks
- Profile JSON is not encrypted at rest.
- A local attacker with file permissions can read or modify it; corruption is detected, tampering is not authenticated.
- Automatic context collection is absent, so less personal data is collected.

## Not audited
Full desktop threat model, Windows ACL behavior, and side-channel analysis.

## Executed evidence
- Rust: 443 passed, 0 failed, 2 ignored.
- Shared: typecheck pass, 212 tests / 14 files.
- API: typecheck pass, 1234 tests / 111 files.
- Web: typecheck pass, 472 tests / 52 files.
- Simulation: NANI 178/220 = 0.809 (95% CI 0.752-0.856) vs fixed 0.636; Brier 0.159; ECE 0.191; H 1.119.
- Debug benchmark (best of 3): update 139.2us, rank 4487.7us, route 0.1us.
