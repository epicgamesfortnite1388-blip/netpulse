# Phase 4B - Network Transitions

## Objective
Switch profiles without treating a network change as a failure.

## Implementation
ContextTransitionTracker returns None, NewContext(id) or ContextSwitch(id). NetworkProfileEngine records a bounded history with from/to random ids and timestamp. Old profiles are retained; returning to a known signal pattern restores its profile.

## Tests
First signal -> new; repeated -> none; class change -> switch; return to Wi-Fi restores the original id and keeps both profiles; delete removes only one context.

## Integration
LearningEngine::observe_network persists after a transition; nani_context_observe exposes it to the desktop runtime.

## Automatic observation
A desktop watchdog samples the active adapter every 120 s and calls observe_network. Failure returns no context; transitions are still not treated as failures.

## Limitation
A transition can be detected up to two minutes late, and adapter-name classification may miss unusual drivers.

## Executed evidence
- Rust: 443 passed, 0 failed, 2 ignored.
- Shared: typecheck pass, 212 tests / 14 files.
- API: typecheck pass, 1234 tests / 111 files.
- Web: typecheck pass, 472 tests / 52 files.
- Simulation: NANI 178/220 = 0.809 (95% CI 0.752-0.856) vs fixed 0.636; Brier 0.159; ECE 0.191; H 1.119.
- Debug benchmark (best of 3): update 139.2us, rank 4487.7us, route 0.1us.
