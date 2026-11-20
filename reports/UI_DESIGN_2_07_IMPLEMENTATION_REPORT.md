# UI DESIGN 2.0 — 07 — Implementation Report

**Footprint:** 25 modified files (+672 / −398) plus 5 new files and 3 new tooling
scripts. Nothing was committed — see §7.

---

## 1. Order of work

Implemented in small, independently verifiable groups, each closed with
`tsc` → `vitest` → `eslint` → `vite build` → `assert-ui-contract.mjs` and a fresh
screenshot. Foundations first, so later screens consume decisions rather than
re-deciding them.

| Group | Subject | Why this order |
|---|---|---|
| G1 | Design-system primitives | Everything downstream consumes these |
| G2 | Palette unification | Mechanical and wide; best done before per-screen polish so screens are tuned against final colours |
| G3 | Dashboard + connection panel | The two highest-traffic surfaces |
| G4 | NANI | Largest single screen |
| G5 | Copilot | Honesty fixes, independent of the rest |
| G6 | VPN / config | Consumes the palette work from G2 |
| G7 | Missing page headings | Small, caught by the new assertion |
| G8 | Tooling | Needed to *verify* the above |
| G9 | Tests | Pins the decisions |

---

## 2. G1 — Design-system primitives

| File | Change |
|---|---|
| `components/ui/tabStyles.ts` **(new)** | Single source of tab chrome: `TAB_LIST_CLASS`, `tabTriggerClass(size, active)` |
| `components/ui/Tabs.tsx` | Rewritten on `tabStyles`; added `size`, `ariaLabel`, per-item `icon` |
| `components/ui/Segmented.tsx` | Same chrome, keeps `radiogroup` roles |
| `components/ui/States.tsx` | `EmptyState` / `LoadingState`: removed the inner border → `bg-surface-2/40` well |
| `components/ui/Field.tsx` | Anatomy corrected to label → control → help |
| `components/ui/Metric.tsx` | Added `size: 'md' \| 'lg'`; default 20 px |
| `components/ui/Surface.tsx` | `EngineHero` gained `pageTitle` (h1); `MetricStrip` stops truncating; hero glow tokenised |
| `styles/identity.css` | Reduced motion now covers the `animate-*` family |

**Verification:** the shared-chrome decision is asserted structurally — `Tabs` and
`Segmented` must emit the same track class while keeping different roles.

---

## 3. G2 — Palette unification

110 raw palette utilities across 11 files, replaced through an explicit, idempotent
script (`scripts/unify-palette.mjs`) so each change is a reviewable
`(file, from, to)` triple rather than a regex sweep.

| File | Raw → token |
|---|---|
| `components/EngineBadge.tsx` | 4 per-engine hues → one `text-accent bg-accent-soft` |
| `features/nodes/NodeExplorerPage.tsx` | protocol chip surrounds → `bg-proto-*/10 border-proto-*/25` |
| `features/vpn/engineMeta.ts` | 8 glyph gradients → accent; Aether → `--color-aether*` |
| `features/vpn/VpnPage.tsx` | rail glyphs → accent / ok / aether / muted |
| `features/vpn/OverviewSurface.tsx` | glyphs + the invisible `text-violet-200` label → `text-aether` |
| `features/vpn/TunnelSurface.tsx` | glyph → accent |
| `features/vpn/AgentPathTrace.tsx` | state chips + rail → accent / ok / danger / line |
| `features/vpn/QuickConnectActivity.tsx` | 18 stage tones → state tokens; `bg-[#07121b]` → `bg-surface-2` |
| `features/vpn/AetherCore.tsx` | 4 state gradients → aether / warn / danger |
| `features/vpn/AetherSurface.tsx` | state accents → aether / warn / danger borders, fixed white ink |
| `features/account/AccountPage.tsx` | `text-red-400` → `text-danger` |

**Two judgement calls, both recorded:**

1. **Engine glyphs collapsed from six hues to one.** They carried no information the
   label did not, and two of the six (`rose` for WireGuard, `amber` for OpenVPN) were
   the danger and warning hues — the native tunnels were painted as faults.
2. **The Aether stage keeps white ink.** `.aether-stage` is a hard-coded dark gradient
   in *both* themes, so state tokens (which flip to dark values in light theme) must
   not be used for text there. The hue moved to the border; the ink stayed light.

**Verification:** `grep` for palette utilities in `apps/web/src` returns nothing;
`assertNoRawPalette` returns nothing in the compiled stylesheet; all token utilities
confirmed present in the output (`bg-proto-sky/10` compiles to
`color-mix(in oklab, var(--color-proto-sky) 10%, transparent)`).

---

## 4. G3 — Dashboard and connection panel

`features/dashboard/DashboardPage.tsx` (+194 / −89):

- New `HeroMetric`; the unit renders only when a value exists (killed `DNS —as`).
- One health-verdict scale, matching the backend; the hint became evidence.
- Page re-laid into two explicit rows: verdict + hero, then connection card +
  **Measurements** card. Six 24 px metrics inside a bare strip became six 20 px
  metrics in a labelled card.

`features/connection/ConnectionHero.tsx`:

- `np-panel @container`; `lg:grid-cols-[236px_…_258px]` → `@[480px]:grid-cols-[auto_minmax(0,1fr)]`.
- New `DetailCell` (label above value) replaces `DetailRow` (side-by-side), which
  could not truncate in a narrow column.
- Session block is its own `@container` with `@[300px]:grid-cols-2`.

---

## 5. G4 — NANI

`features/nani/NaniPage.tsx` (+277 / −140):

- Hand-rolled tab bar, `onTabKeyDown`, and the `ReactKeyboardEvent` import deleted;
  all ten sections now use shared `<Tabs size="sm">` + `<TabPanel>`.
- "AI activity" and "Engine status" merged into one **Engine** card
  (`@container lg:grid-cols-[200px_minmax(0,1fr)]`).
- Event-stream capability is a `Notice tone="info"`, not a competing badge.

Net effect: ~137 lines removed while gaining a card merge — the deleted keyboard
handler and duplicate tab markup paid for the restructure.

---

## 6. G5–G7 — Copilot, VPN, headings

**Copilot** (`+89 / −?`): deleted `INITIAL_MESSAGE`; `messages` starts `[]`;
`clearConversation` → `[]`; hero centred when empty; root reserves
`min-h-[calc(100dvh-var(--np-topbar-h)-76px)]` so the composer sits at the bottom;
badge and subtitle share one vocabulary.

**VPN:** `AdaptiveRecoveryCard` — corrected the `censorshipHint` DTO to the real
`censorshipHintOf` shape (`{ likely, reason, considered, distinctStrategies }`), which
fixed a `tsc` error and made the `tone` branch reachable for the first time.

**Headings:** `LiveMapPage` gained a `PageHeader`; `NodeDetailPage` passes `pageTitle`.
Both were found by the new assertion, not by looking.

---

## 7. G8–G9 — Tooling and tests

| New file | Purpose |
|---|---|
| `scripts/ui-capture.mjs` | CDP screenshot harness; 20 routes; records `h1`, `scrollH`, overflow, and the **resolved** theme/`--type-scale`; supports ad-hoc `--path` for detail routes |
| `scripts/ui-probe.mjs` | Per-selector geometry **and computed colour** |
| `scripts/unify-palette.mjs` | The G2 transformation, idempotent and reviewable |
| `apps/web/test/designPrimitives.test.tsx` | 9 tests pinning the G1 decisions |

`scripts/assert-ui-contract.mjs` grew from 47 to **54** assertions (see report 03 §4
and report 06 §2). No existing assertion was relaxed.

### 7.1 Nothing was committed

The working tree already contained uncommitted work from earlier agents (Rust
`src-tauri/**`, `FABLE_*` reports, `apps/web/vite.recovery.config.mjs`,
`test/recoveryRegressions.test.ts`, `components/PulseMark.tsx`, and more — several of
which are untracked entirely, including `identity.css` and `assert-ui-contract.mjs`).

Per the brief's preservation rules, nothing was staged, nothing was reset, and no
commit was created. `git diff --cached --name-only` is empty. The changes are on disk
for the maintainers to review and stage deliberately.

---

## 8. Errors encountered and how they were resolved

Recorded because two of them were my own mistakes and both were caught by tooling
rather than by review.

| Error | Cause | Resolution |
|---|---|---|
| `Could not resolve entry module "index.html"` | Ran `vite build` from the repo root | Run from `apps/web` |
| `ERR_MODULE_NOT_FOUND: @/lib/transport` | Ran `vitest` from the repo root; the `@`/`@shared` aliases live in `apps/web/vite.config.ts` | Always run tests from `apps/web` |
| `Property 'likely' does not exist …` | The DTO declared fields the API never sends | Corrected the type — this was the bug, not an obstacle |
| `TS1005: ')' expected` in `LiveMapPage` | I put a `{/* … */}` comment before the root element inside `return (` | Moved it above the `return` as a normal comment |
| `ENGINE_BADGE_CLASS is not defined` | The multi-line block replacement missed while its single-line usage applied | Fixed directly with an edit; then verified `tsc` |
| 3 multi-line replacements silently missed | Indentation differed from the pattern (not line endings) | Listed by the script's `NOT FOUND` report and fixed individually |
| `--dom-scale 1.25` captured at 100 % | The ramp keys off named steps (`large`, `xl`), not a multiplier | Mapped numbers → names **and** made the harness read back the resolved value and abort if it did not apply |
| One test failure, not reproducible | Timing-sensitive test under jsdom | Two subsequent full runs: 56/56 files. Recorded as an observed flake, not dismissed |

The `--dom-scale` bug is the one worth remembering: the harness reported success while
producing invalid evidence. It is now self-verifying.

---

## 9. What was not implemented

- NANI investigation creation / progress / verification driven with live data.
- VPN configuration rows below the first two sections.
- Motion curve tuning.
- A pixel-diff suite (recommendation in report 08 §6).
- Any change to Rust, backend, NANI mathematics, VPN networking or API contracts.
  Every change in this pass is confined to `apps/web` plus `scripts/` and `reports/`.
