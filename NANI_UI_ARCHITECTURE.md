# NANI UI Architecture

## Navigation
Primary nav entry "NANI" (Brain icon) -> `/nani` route, lazy-loaded `NaniPage`.

## Page structure (tabs)
Overview | Live Investigation | AI Workspace | Hypotheses | Evidence | Network Intel | Learning | History | Settings

## Data layer
TanStack Query against `/api/v1/nani/*` (status, apis, health/shadow, diagnose, check, recovery). All requests go through `api` transport.

## State
Local component state for tabs, chat messages, investigation stage index. No global store added; reuse existing patterns (usePersistentId where needed).

## Real-time
Backend publishes `nani:*` events via RealtimeBus + EventService. Web currently polls (staleTime 15s) + manual refresh; a future SSE/WS consumer can subscribe to `/events` stream. No fake progress percentages are shown.

## Security
No secrets in frontend. All inputs validated server-side (zod). Session/account boundaries enforced by API.
