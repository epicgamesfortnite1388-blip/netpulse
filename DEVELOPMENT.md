# Development

## Prerequisites

- Node.js >= 22 (engines enforced)
- Windows, macOS, or Linux (platform-specific providers detect at runtime)

## Setup

```bash
npm install
npm run dev:api     # Fastify + file watch on http://127.0.0.1:8787
npm run dev:web     # Vite dev server on http://localhost:5173 (proxies /api)
```

State lives in `.data/` (SQLite DB, daemon token, VPN vault). Delete it for a clean slate.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run build` | Build API + web (web build typechecks first) |
| `npm test` | All workspace tests (Vitest) |
| `npx vitest run --root apps/api` | API tests only |
| `npx vitest run --root packages/shared` | Shared-model/scoring tests only |
| `npm run lint` | ESLint over all `src` trees |
| `npm run format` | Prettier |
| `npm run db:generate` | Generate a Drizzle migration into `apps/api/drizzle/` |

## Testing layout

- `packages/shared/test` — pure logic: statistics (`stats.test.ts`), scoring engine,
  schema validation.
- `apps/api/test` — API integration: auth + route contracts (`app.test.ts`), target-guard
  SSRF rules, platform output parsing (`pingParse.test.ts`).
- Tests never perform real network I/O; platform controllers are injected or stubbed.

## Conventions

- **TypeScript strict, ESM everywhere.** Type-only imports use `import type` (lint
  enforced).
- **Validation at the edge:** every route body/query is parsed with a Zod schema from
  `@netpulse/shared` (or a local schema for API-only shapes).
- **No business logic in routes; no Drizzle in services' hot paths** — repositories own
  persistence.
- **Long-running work** follows the `{ testId }` + WS progress contract; reuse
  `TestsRepository` and the realtime bus rather than inventing a new channel.
- **UI:** one feature folder per page; shared primitives in `components/ui`; long tests
  use the `useBackgroundTest` hook; charts use `components/charts`.
- **No fabricated data.** Unavailable capability → structured unavailable result; the UI
  renders an explicit state. Demo content only under `DEMO_DATA=true` with the DEMO badge.
- Comments are rare and explain *why*, not *what*.

## Adding a feature — checklist

1. Models/schemas in `packages/shared` (+ tests for scoring/stats logic).
2. Repository + migration if persistence is needed (`npm run db:generate`).
3. Service + provider code with abort support and event emission.
4. Route registration in `apps/api/src/app.ts` with Zod validation.
5. UI page under `apps/web/src/features/…` wired to the route contract.
6. Tests (unit for logic, integration for route), `npm run lint && npm test && npm run build`.
