# UI_REVIEW_07 — UI Redesign Engineering Contract

Binding for the UI Expert. It defines what may change freely, what needs compatibility review, and what must not change. Where an interface is authoritative, the defining file is named. Do not invent signatures.

---

## 1. Change freely (visual/structural, no backend impact)

- Styling, colour, typography, spacing, elevation, motion (within the token system).
- Layout, page structure, component composition, reusable *presentational* components.
- Navigation **presentation** (sidebar/header layout, grouping, icons, command bar) — **not** route identifiers (see §2).
- Animation, hover/focus styling, empty/loading/error *presentation*.
- Adding new presentational components (e.g. the `BrandMark` already added).

## 2. Careful compatibility review (contract-sensitive)

| Area | Why | Authority |
|---|---|---|
| **Route identifiers** (`/vpn`, `/nodes/:id`, …) | deep links, `?tab=`/`?card=` params, `NotFoundPage` | `app/router.tsx` |
| **Persistent UI state** (`np.ui.*`, `np.disclosure:*`, `np.nani.*`) | changing the format orphans every stored filter/selection | `lib/usePersistentState.ts`, `components/ui/Disclosure.tsx`, `features/nani/naniStore.ts` |
| **`usePersistentState`** | 20 files, ~55 keys; Set-aware | `lib/usePersistentState.ts` |
| **`Card`/`CardHeader`/`CardBody`** | `fold` prop + `HeadingLevel` context; DOM shape feeds `vpnDecisionCards.test.tsx`/`nodeHealthDisplay.test.tsx` | `components/ui/Card.tsx`, `HeadingLevel.tsx` |
| **`DisclosureScope`/`Toolbar`** | 24 pages; storage keys depend on `name`; Expand/Collapse-all broadcast | `components/ui/Disclosure.tsx` |
| **`ErrorState`** | coupled to `isRetryableError`; only retry affordance on 24 screens | `components/ui/States.tsx`, `lib/api.ts` |
| **`lib/api.ts`** | error envelope + retry semantics for every request | `lib/api.ts` |
| **`lib/transport.ts`** | desktop/web branch + memory-only bearer | `lib/transport.ts` |
| **`lib/ws.ts`** | `/ws/ticket` contract + `test:progress|done|error` frames consumed by 9 screens | `lib/ws.ts` |
| **`useVpnData`/`useVpnStatus`** | single status source for VPN + dashboard | `features/vpn/useVpnData.ts` |
| **`useStartupHealth`** | drives 3 global banners; instantiated in shell + health page | `lib/useStartupHealth.ts` |
| **`useNodeActions`** | test/favorite/geo/promote + toast wording pinned by `nodeActionPolicy.test.ts` | `features/nodes/useNodeActions.ts` |
| **`useCloudSession`/`useSessionStore`** | two zustand stores that must stay consistent | `lib/cloud/*` |
| **`LatencyChart`/`Gauge`** | formatter hardcodes "ms/Latency"; test DOM-shape coupling | `components/charts/*` |
| **`HeadingLevel`** | document outline (h1→h2→h3) | `components/ui/HeadingLevel.tsx` |

**Rule:** changing a shared symbol's signature or DOM shape requires a codemod + running the coupled tests in §2 before merging.

## 3. Must NOT change during the redesign

- NANI mathematical algorithms and Rust investigation logic (`src-tauri/src/network_intelligence/**`).
- VPN engine implementation (`apps/api/src/vpn/**`, `proxyCores`, `proxyTunnel`, `aetherProvider`).
- Cloudflare infrastructure / `cloud/worker/**`.
- Database migrations (`apps/api/drizzle/**`, `cloud/worker/migrations/**`).
- Production deployment / any remote change.
- Security boundaries: CSP, capabilities, token storage model, entitlement enforcement.
- The backend contract shapes in `UI_REVIEW_03` (request/response fields).

## 4. Authoritative interfaces (do not invent)

- **VPN status truth:** `GET /vpn/status` → `VpnStatus` (`packages/shared/src/models/vpn.ts`). `verification` + `verifiedPublicIp` must be surfaced, not collapsed.
- **Tunnel status:** `GET /vpn/tunnel/status` → `ProxyTunnelStatus` (`models/vpnTunnel.ts`).
- **NANI:** Tauri `nani_*` (desktop) / `/nani/*` (web) — `features/nani/naniApi.ts`; event envelope `{seq, event:{kind,payload}}` via `naniEvents.fromTauriEvent`.
- **Nodes:** `GET /nodes` with its 16 params (`routes/nodes.ts`).
- **Settings:** `GET/PUT /settings` (`schemas/settings.ts`).
- **Events/WS:** `/events`, `/ws/ticket`, `/ws?ticket=` (`realtime/wsRoute.ts`).

## 5. Definition of "done" for any redesign stage

1. Every visible action calls the same backend operation it did before (no dead buttons, no new fake success).
2. `verification`/`unknown`/insufficient-evidence states remain representable and honest.
3. All existing tests pass (54 files / 502 tests, stable run) + the new tests from `UI_REVIEW_08`.
4. Typecheck + production build clean.
5. No new token outside `tokens.css`; no sub-12px text; no `text-[var(--…)]` bracket forms (guards).
6. Visually verified in the running app (screenshots), not source-only.
