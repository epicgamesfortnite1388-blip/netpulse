# NANI Chat Integration Report

## What changed
- Workspace now calls `explain(question)` from `naniApi.ts`:
  - Desktop: `nani_explain` (Rust) → deterministic facts, optional local-model rewrite; returns `source` and `warning`.
  - Web: `POST /nani/diagnose` with no observations → honest `Insufficient evidence` explanation + recommended test.
- Messages are persisted per conversation (`naniStore`), survive restart.
- Each send also records a durable investigation entry (status, summary, error).
- Failures are shown in-message and recorded as `Failed`.

## Guarantees
- The assistant text comes from a real backend call; no fabricated measurements.
- `source` (deterministic vs local_model) and `warning` are displayed, so LLM vs deterministic output is distinguishable.
- Disabled external AI: desktop `nani_explain` still returns deterministic text; web diagnose still responds.

## Not implemented
- Streaming token response for the NANI workspace (Copilot's `streamAi` is separate).
- Cancel-in-flight for an explanation request.
- Server-side chat storage (local only).
- Multi-investigation context switching beyond separate conversations.
