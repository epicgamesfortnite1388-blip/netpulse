# NANI_AUDIT_07 — Target Copilot AI Architecture (Mission E/F)

Reuse-first design over verified existing assets: the Rust explainer (grounding), the cloud worker proxy (auth boundary), and the Abystral gateway (real providers).

## 1. Architecture

```
CopilotPage (React)
  │  POST /api/v1/ai/stream  (SSE/WS via cloud worker; auth = session)
  ▼
Cloud Worker  ── proxy (key-authed) ──►  Abystral AI gateway
  │  - provider/model availability      (DeepSeek / OpenAI / Anthropic / XKiro)
  │  - usage accounting (NetPulse-side quota)
  │  - NANI tool-result injection (below)
  ▼  tool calls (structured, non-stream)
NANI structured tools (desktop: Tauri commands; worker-side: none —
desktop answers tool requests locally, worker only relays)
```

- Desktop keeps **zero provider keys** (current true claim — keep).
- The local deterministic explainer remains the offline mode: when the worker is unreachable/unconfigured, Copilot answers from `nani_explain` and says so ("local knowledge, no model").
- Streaming: worker already proxies `/admin/ai/stream` upstream — SSE passthrough; frontend consumes deltas; abort → worker cancels upstream request (verify upstream cancellation at implementation time).

## 2. NANI tool contract (the missing layer)

Tools exposed to the model as **structured function results** (never model-invented):

| Tool | Source (existing) | Mutating? |
|---|---|---|
| `network_context` | `nani_status` + system proxy/tunnel status DTOs | no |
| `vpn_state` | existing `vpnService` status + verified exit IP | no |
| `list_investigations` | `nani_investigations` | no |
| `get_report(id)` | **N2 report store** (must exist first) | no |
| `get_evidence(hypothesis)` | N2 report + registry probe history | no |
| `explain_confidence` | `nani_math_hypothesis_view` + calibration status | no |
| `plan_investigation(query)` | RecoveryPlanner-style plan (read-only plan) | no |
| `run_probe(scope)` | health-check subset, **requires explicit user authorization per call** | **yes — gated** |

Rules: tool results carry provenance (`source_record_id`); the model may not modify posteriors/learning/persistence (existing Rust `ai/` boundary extended); every mutating tool requires a user confirmation round-trip; no shell/system access; data minimization — profile secrets, vault keys and node credentials are never placed in prompts (redaction layer exists in `util/redact.ts`; apply to tool payloads).

## 3. Backend API surface (no duplicate endpoints)

| Endpoint | Status today | Change needed |
|---|---|---|
| `POST /api/v1/ai/ask` | ✅ implemented (worker) | none |
| `POST /api/v1/ai/stream` | partial (stream route exists in Abystral; worker route verify) | passthrough + tool injection |
| `GET /api/v1/ai/providers` | ❌ | new: availability/models/usage (worker-side config introspection only — no key exposure) |
| conversation CRUD | ❌ | new: worker D1 tables (messages keyed by session; retention policy) |
| usage | ❌ | new: Abystral gateway already reports usage — persist per-user |

## 4. Conversation management

IDs: `conversation_id` (UUID, D1), `message_id`, timestamps, role, content, model metadata, error state. Frontend keeps optimistic UI + server-authoritative history on reconnect. Retention: 90 days default, user-clearable (matches existing reset flows).

## 5. Security posture

- Provider credentials: only Abystral worker secrets (server-side, existing) — never in NetPulse.
- Rate limits: worker already rate-limits AI route; add per-user daily token quota.
- Prompt injection: NANI tool payloads are data, framed as such; system prompt forbids state-changing suggestions without the authorization flow; tool results carry provenance the UI renders.
- Logging: redact question text option; never log tool payloads containing endpoints with credentials (none exist in payloads by construction).

## 6. Honest availability states (fix the misleading indicator)

| State | UI |
|---|---|
| Worker configured + reachable | "Cloud AI: <model>" |
| Worker reachable, `ai_not_configured` | "AI backend not configured — local knowledge mode" (NOT a generic error) |
| Offline | "Local knowledge mode (deterministic)" |
| Local llama.cpp configured | "Local model: <model_name>" |
