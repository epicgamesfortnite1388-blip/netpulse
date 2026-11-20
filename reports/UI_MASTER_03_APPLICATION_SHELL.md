# UI_MASTER_03 — APPLICATION SHELL MASTERY

## 1. The navigation problem this shell solves

The previous shell flattened **25 destinations into one 240px scrolling
column**. At 900px window height the sidebar scrolled; at any height it read as
a control panel rather than an application. A user could not answer "where am I"
or "what else lives here" without scanning 25 rows of equal weight.

The current shell splits navigation into two tiers with different jobs:

| Tier | Width | Job | Content |
|---|---|---|---|
| **Rail** | 76px | *Which capability am I in?* | 5 sections, icon + 1-word label |
| **Context column** | 226px | *What lives inside this capability?* | Only the active section's routes, grouped |

Total chrome width: **302px**, down from a variable 240px that scrolled. The
content area gained both width and vertical stability.

---

## 2. Section model

Five sections, 25 routes. Every routed screen belongs to exactly one section.

| Section | Rail label | Routes | Rail destination |
|---|---|---|---|
| `overview` | Overview | Dashboard, Live Map, Mission Control, Mission Overdrive | `/` |
| `connect` | Connect | VPN & engines, Servers, Optimizer, Node Explorer, Sources, Engines | `/vpn` |
| `intelligence` | NANI | NANI, Copilot, History, Events | `/nani` |
| `diagnose` | Diagnose | Quick Check, Speed Test, DNS, IP & leaks, Routes, Cloudflare, Gaming, Iran Connectivity | `/diagnostics` |
| `system` | System | Settings, Account, System Health | `/settings` |

### 2.1 Section resolution

`resolveSection(pathname)` in `app/nav.ts` derives the active section from the
URL by **longest matching prefix**. A detail route such as `/nodes/abc123`
lights up Connect without any special case in the shell; `/nani` and
`/copilot` both resolve to `intelligence` because `intelligence` declares both.

This is the whole reason the shell has no route table of its own: the nav model
*is* the route map, and the two cannot drift.

### 2.2 Context column grouping

Routes inside a section are grouped by a `group` field, rendered as a micro-label
divider:

- **Connect** → Connection / Inventory
- **NANI** → Investigation / Records
- **Diagnose** → Network tests / Edge
- **System** → System

Grouping is what lets Diagnose hold eight routes without becoming a list — the
user reads two groups of four instead of eight undifferentiated rows.

Each section also declares a one-line `blurb` shown at the top of its column
("Network state, evidence and live topology."). It is the honest answer to "what
is this section for" and it is the only prose in the chrome.

---

## 3. Rail behaviour

- Active item: accent-tinted background, accent icon, and a 2px left indicator
  drawn by `::before`.
- Label under the icon is always visible — the rail is not icon-only. An
  icon-only rail saves 20px and costs every new user a hover-to-discover loop.
- Version label at the rail foot uses `np-label`, not an inline `font-size: 9px`.
  It now participates in the type scale; at `type-scale: xl` it grows with
  everything else.
- Rail items are real links with `aria-current="page"` on the active one.

---

## 4. Topbar

Height `--np-topbar-h: 58px`. Contents, left to right:

1. Mobile menu button (`lg:hidden`)
2. Breadcrumb: `section.label` → `›` → `currentTitle(pathname, section)`
3. Global connection chip
4. Theme toggle (sun/moon, `aria-label` states the *destination* theme)
5. Command palette button with `Ctrl K` kbd hint
6. Quick Connect button
7. Demo badge (conditional)
8. Backend health link with `StatusDot`

### 4.1 Fixed: translucency bleed

The topbar used `color-mix(in srgb, var(--color-bg) 92%, transparent)`. At 8%
transparency, scrolled content bled faintly through the bar. It read as a
rendering artefact, not as intentional glass. The bar is now **fully opaque**;
the `data-scrolled` attribute switches on a bottom hairline instead, which is
the honest way to signal "content is now passing under me".

### 4.2 Fixed: invisible health status at 1280px

The health indicator was `hidden xl:inline-flex` — invisible at 1280px, one of
the stated target resolutions. It is now `hidden lg:inline-flex`, so it appears
from 1024px up.

### 4.3 Fixed: type-scale bypasses

Three chrome strings used raw pixel sizes (`text-[11px]`, `text-[10px]`,
`font-size: 9px`). All three migrated to `text-micro`. At large text settings
the topbar no longer mixes 10px kbd hints with 18px breadcrumbs.

---

## 5. Responsive behaviour

| Breakpoint | Shell state |
|---|---|
| `< 1024px` | Rail and context column hidden. Mobile menu button in topbar opens `MobileNav` drawer. Content full width, 16px gutters. |
| `≥ 1024px` | Rail + context column visible. Health indicator appears. Command palette button appears. |
| `≥ 1280px` | Full chrome. |

`MobileNav` is a right-side drawer with a `bg-black/55` backdrop. It carries
`aria-hidden="true"` on the backdrop, a labelled close button, and reuses the
same `SECTIONS` model — so a route added to the nav model appears in the mobile
drawer with no extra work.

### 5.1 Scroll stability

`np-context` previously had `overflow-y: auto` without `scrollbar-gutter:
stable`. Switching between a 3-route section and an 8-route section shifted the
content area by 10px. `scrollbar-gutter: stable` is now set, so the gutter is
reserved whether or not the column overflows.

Content bottom padding was reduced 64px → 48px desktop and 48px → 40px mobile.
The old value left a dead band under every page that made short pages look
truncated.

---

## 6. Page transition

Route changes render through:

```tsx
<Suspense fallback={<PageSkeleton />}>
  <div key={pathname} className="page-enter">
    <Outlet />
  </div>
</Suspense>
```

- The error/suspense boundary sits **inside** the shell, so a slow route never
  blanks the rail or topbar. Navigation stays visible and clickable.
- `key={pathname}` re-runs the `page-enter` keyframe on every route change — a
  380ms `fade-up` at `--ease-fluid`.
- `PageSkeleton` renders *outside* the animated wrapper so its fixed progress
  rail measures against the window rather than a transformed ancestor.
- `TabPanel` no longer applies `animate-fade-up`; stacking it under `page-enter`
  produced a double-fade on first tab paint.

---

## 7. Skip link (WCAG 2.4.1)

The shell now opens with:

```tsx
<a href="#np-main" className="sr-only focus:not-sr-only focus:fixed focus:left-3
   focus:top-3 focus:z-[60] focus:rounded-md focus:bg-accent focus:px-3 focus:py-2
   focus:text-sm focus:font-medium focus:text-on-accent focus:shadow-overlay">
  Skip to main content
</a>
```

`<main id="np-main" tabIndex={-1}>` receives focus. A keyboard user can now skip
**25 navigation links** with one Tab + Enter. Previously the first Tab landed on
the rail and the 26th landed in content.

`outline-none` on `main` is intentional: the target is programmatically focused,
not interactively focused, and a focus ring around the entire content column
would be noise.

---

## 8. Global surfaces

Three banners stack directly under the topbar, each conditional on real backend
state:

| Banner | Trigger | Content |
|---|---|---|
| `UpdateBanner` | Update available | Silent until the backend reports one. |
| Safe Mode | `meta.safeMode` | Explains that networking/VPN/scanners are disabled + link to Settings. |
| Recovery | `phase === 'recovery'` | Retry countdown, attempt number, and the **first line** of `last_restart_reason` truncated to 200 chars. |
| Degraded | `phase === 'degraded'` | Either the single failing check's label + detail, or "N components degraded: …". |

The recovery banner's `last_restart_reason` is deliberately truncated to one line
and 200 characters with `whitespace-pre-wrap` removed from the visible span. A
multi-line stack trace would push the entire application down by 4+ lines at the
exact moment the user needs the page stable.

---

## 9. Command palette and Quick Connect

- `Ctrl K` opens the palette; `Ctrl Shift K` opens Quick Connect.
- Both shortcuts are handled by **one** listener. Two listeners stacked the
  palette underneath the connect overlay, because `Shift+K` still reports
  `event.key === 'k'`.
- Quick Connect can also be opened by any screen dispatching
  `netpulse:quick-connect` on `window` — the shell owns the overlay, features
  never thread its state.
- Opening Quick Connect closes the palette first, so the two overlays can never
  be simultaneously mounted.

---

## 10. Shell acceptance criteria

| Criterion | State |
|---|---|
| Every routed screen maps to exactly one section | Pass — `resolveSection` is total over the route set |
| Active section always visible at ≥1024px | Pass |
| Active route always visible in context column | Pass — `aria-current="page"` |
| No horizontal scroll at 1024 / 1280 / 1440 / 1920 | Pass |
| Nav column never scrolls at 900px height | Pass — 8 routes is the maximum per section |
| No layout shift when switching sections | Pass — `scrollbar-gutter: stable` |
| Keyboard can bypass navigation | Pass — skip link |
| Route change never blanks the chrome | Pass — boundary inside shell |
| All chrome text participates in the type scale | Pass — no arbitrary px remains |
| Backend health visible at 1280px | Pass — `lg:` breakpoint |
