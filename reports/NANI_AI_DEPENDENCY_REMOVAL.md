# NANI AI Dependency Removal

## Removed from the production execution path

1. **Desktop Copilot cloud call.** `apps/web/src/features/copilot/aiApi.ts` posted to `/ai/ask` (and previously `/ai/usage`) through `cloudApi.aiAsk`. That method was removed. Copilot now calls the local Rust command `nani_explain`.
2. **Default external AI health probes.** `main.rs` registered `xkiro` and a placeholder `abystral.example` endpoint for background monitoring. `xkiro` and `deepseek` were also in the API's default registry. All were removed; only the actual NetPulse Cloud backend remains registered by default.
3. **Simulated streaming.** The old SSE path could not work through the desktop egress transport. The local path returns one complete answer and does not pretend to stream.

## Retained, optional, not required

- The cloud worker endpoints `/api/v1/ai/ask` and `/api/v1/ai/stream` still exist. They are not called by the desktop and no core feature depends on them. They can be removed in a later cleanup without affecting NANI.
- The local LLM is optional and disabled by default. With it off, planning, diagnosis, recovery, learning, scoring and the UI continue to work.

## Verified

- No desktop code path calls an external AI provider.
- `rg` across `apps/web/src` and `src-tauri/src` finds no OpenAI/DeepSeek/Anthropic client.
- The default desktop registry has no AI provider entry.
- With no local model configured, `nani_explain` returns deterministic text (unit-tested).
- Full test suites run without any model or AI credential.

## Deferred

- Removing the cloud worker proxy and its configuration variables.
- Removing the legacy `xkiro`/`deepseek` fixtures from Rust tests (they are test data, not runtime dependencies).
