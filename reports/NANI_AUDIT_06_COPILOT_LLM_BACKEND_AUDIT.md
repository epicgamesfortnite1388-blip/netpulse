# NANI_AUDIT_06 — Copilot LLM Backend Audit (Mission D)

## Verdict

**NetPulse Copilot has NO working LLM backend in any of its three possible configurations today.** The claim is CONFIRMED — with precision about what does and does not exist:

## What the Copilot actually is (traced)

`CopilotPage.tsx:141` → `streamAi` (aiApi.ts:89) → `askAi` (aiApi.ts:52) → `tauriInvoke('nani_explain')` → **the Rust deterministic explainer** (commands/nani.rs:336) + optional local llama.cpp rewrite (disabled unless `NANI_LLM_ENABLED=1` + binary + model configured; not configured on this machine — the status command reports configuration only, honestly).

- "Streaming" is a single-delta delivery of the complete answer (aiApi.ts:89–95, documented in-code as deliberate non-fake).
- **No conversation history is sent** — each question is answered from a fresh state snapshot.
- **No NANI tools, no tool-calling, no VPN/engine context** beyond registry health lines and learning counters.
- Conversation is `useState`-only → lost on reload. (The Nov-15 screenshot claiming "persisted across reload" does not match the current code — no persistence exists in `CopilotPage.tsx`.)

## The false claim in the code

`CopilotPage.tsx:5–13` states: *"Connects through the authenticated NetPulse cloud API (/api/v1/ai/ask, /api/v1/ai/stream). The desktop application never holds a provider API key."* — **The first sentence is false.** The code never calls those endpoints (verified: no `fetch`/`api.post` to `/ai/` in the copilot feature). The second sentence is true. This misleads both users and future developers.

## The three LLM paths, fully traced

| Path | Implementation status | Configured? | Working end-to-end? |
|---|---|---|---|
| **Local deterministic explainer** (Rust) | ✅ real, honest (facts → Observed/Inferred/next step; `confidence: None` — honest) | always on | ✅ (unit tests + earlier visual verification of the explanation content) |
| **Local llama.cpp** (`ai/local_runtime.rs`) | ✅ real code, strict boundary (prose-only) | ❌ not configured (opt-in env) | BLOCKED-by-configuration (by design) |
| **Cloud LLM via NetPulse worker → Abystral gateway** | Backend chain **fully implemented**: worker `/api/v1/ai/ask` (auth + role check + proxy, index.ts:1236–1290) → Abystral `/admin/ai` + `/admin/ai/stream` (REAL multi-provider gateway: DeepSeek/OpenAI/Anthropic clients, XKiro router, per-persona models, usage accounting — `Abystral/workers/src/telegram/src/ai/gateway.ts`) | ❌ `ABYSTRAL_AI_BASE_URL = ""` in `wrangler.toml` → worker returns honest **503 `ai_not_configured`** | ❌ BLOCKED-by-configuration |

- The DeepSeek integration found in the Abystral **telegram bot** is real but is the bot's own gateway — correctly NOT conflated with NetPulse Copilot (the mission's warning was warranted; they share the gateway *file family*, not credentials).
- **No credentials exist anywhere in the NetPulse desktop or worker for LLM providers** (desktop never holds keys — true claim).

## Missing capabilities vs Mission E's definition

Streaming, conversation persistence, history context, provider/model selection UI, usage accounting (NetPulse side), cancellation (AbortSignal exists frontend-side; the backend path has no long request to cancel), provider status detection (worker 503 is surfaced as a generic error, not an "AI unavailable" state — the UI shows the error text as a message).

## What works and is worth keeping

The deterministic explainer is genuinely grounded (real registry/learning facts, honest unknowns, `confidence: None`). It is the correct **fallback and grounding layer** for the target architecture — not a bug. The Abystral gateway is production-grade and is the correct provider backend once configured.
