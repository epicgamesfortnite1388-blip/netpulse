# NANI Local LLM

## Implemented

A new Rust module `network_intelligence/ai/` provides:

- `local_runtime.rs` — optional llama.cpp-compatible process.
  - Disabled by default; requires `NANI_LLM_ENABLED=1`, `NANI_LLM_BINARY`, `NANI_LLM_MODEL`.
  - Direct `Command` spawn with an argument vector; no shell, no arbitrary command surface.
  - Hard timeout (1–120 s, default 20 s), max 64–512 output tokens, 256 KiB output cap.
  - Child is killed on timeout; stdout/stderr drained on threads to avoid pipe deadlock.
  - Output validation rejects empty text, prompt echo and control characters.
  - Process-per-request; no resident model when unused.
- `explanation.rs` — deterministic explanation with four sections (Observed / Inferred / Confidence / Next step), plus an optional model rewrite. The deterministic text is always returned and is authoritative.
- Tauri commands `nani_ai_status` and `nani_explain`.
- The frontend Copilot calls only `nani_explain`; it no longer calls any cloud AI endpoint.

## Tested

- Disabled default returns a deterministic, grounded explanation with no narrative.
- Enabled but missing binary/model is reported as unavailable, not as a crash.
- Output validation rejects empty/echoed output.
- Boolean environment parsing is conservative.
- Prompt contains structured facts and explicit anti-fabrication rules.
- Build and Rust suite: 419 passed.

## Benchmarked

**BLOCKED.** No llama.cpp-compatible binary and no `.gguf` model exist on this machine or in the workspace. Therefore:

- No first-token latency, total latency, RAM usage or tokens/second was measured.
- No 0.5B–3B model was selected through an actual benchmark.
- The runtime adapter's timeout and output validation were unit-tested, but real inference was not executed.

This report does not claim a model was evaluated or installed.

## Deferred

- Downloading/licensing a compact GGUF model and measuring candidates on this hardware.
- Model manager UI (select/unload) beyond status display.
- Structured-output validation against a JSON schema.
- Optional personalization adapter training (intentionally not implemented).
