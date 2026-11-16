# NANI UI Audit

## Scope
Audit of `Vpn_app` (Tauri desktop + React web + Fastify API) for NANI exposure before Phase 6 UI work.

## Existing NANI backend (apps/api)
- `routes/nani.ts` — REST endpoints: status, apis, health/shadow, register api, check, diagnose, recovery plan/step/next/reset.
- `services/naniService.ts` — orchestrates registry, health checks, diagnosis, recovery, shadow assessments, publishes `nani:*` events via RealtimeBus + EventService.
- `services/naniDiagnosticAdapter.ts`, `naniProbeAdapter.ts`, `naniShadowHealthLoop.ts`.
- Pure core in `packages/shared/src/nani/*` (diagnosis, drift, metrics, apiHealth, decision, recovery, events, registry).

## Existing frontend
- `apps/web/src/features/nani/NaniPage.tsx` (new) — multi-tab command center.
- `EngineManagerPage.tsx` had a NANI status bar reading `/nani/status`.
- Copilot page referenced NANI via Rust `nani_explain` (desktop only).
- No dedicated NANI nav item existed before.

## Gaps identified
- No first-class NANI navigation entry.
- No live investigation pipeline view.
- No AI workspace/chat tied to diagnose endpoint.
- No hypothesis/evidence/network/learning/history/settings screens.
- No real-time event subscription in web (backend publishes but web has no SSE/WS consumer for nani events).
- CopilotPage had broken import (`./aiAi` vs `./aiApi`) and other pre-existing TS errors.

## Design tokens / components
- Tailwind 4, Radix, lucide-react, Recharts, TanStack Query, react-router 7.
- Shared UI: Card, Badge, Button, Field/Input, PageHeader, States, Progress, Metric.

## Baseline
- Web typecheck: pre-existing CopilotPage errors (duplicate impl, isRetryable, outline variant).
- NaniPage typechecks clean.
