# NANI Local AI Runtime

## Status
Not implemented.

## Design (planned)
- Optional trait-based runtime abstraction with graceful fallback.
- Hardware detection, model download with checksums, signed manifests, versioning.
- Structured JSON input/output validation in Rust.
- Model disabled by default; NANI core operates without it.

## Current state
- No ML crates in `Cargo.toml`.
- No model manager or inference code in repository.
- NANI core is fully operational with AI disabled (all unit tests pass without any model).

## Requirement
The ultimate test (disable local AI; NANI still observes, diagnoses, decides, recovers, verifies, learns) is satisfied by current architecture because no module depends on AI inference.
