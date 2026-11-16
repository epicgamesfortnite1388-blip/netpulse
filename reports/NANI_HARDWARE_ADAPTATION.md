# NANI Hardware Adaptation

## Implemented
- `hardware.rs`: `HardwareProfile` with tier classification (Minimal/Standard/HighPerformance), adaptive sampling interval, max concurrent tests, model inference gating.
- Detection uses `std::thread::available_parallelism` and optional memory input.

## Not implemented
- GPU/VRAM detection, thermal constraints, storage profiling.
- Dynamic adjustment of history retention and context size at runtime.

## Status
- Unit tests pass for tier classification and bounds.
- Real hardware profiling pending.
