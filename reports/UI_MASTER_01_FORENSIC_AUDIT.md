# UI_MASTER_01 — FORENSIC VISUAL AND UX AUDIT

## Audit scope

Every route, component, modal, state, and interaction in the NetPulse/NANI
frontend (`apps/web/src/`) was inspected against source code and the running
dev server. This report documents findings by severity.

## Severity definitions

- **CRITICAL** — Breaks usability, misleads the user, or creates a false impression of functionality.
- **HIGH** — Visible inconsistency that makes the product feel unfinished.
- **MEDIUM** — Minor visual defect or ergonomics issue.
- **LOW** — Polish opportunity.

---

## 1. Application shell (AppShell.tsx)

### 1.1 Rail and context column — structural

The rail (76px) and context column (226px) are well-structured with a clear
two-tier navigation model. However:

| # | Severity | Finding |
|---|----------|---------|
| S-1 | MEDIUM | Rail version label uses inline `style={{ fontSize: 9 }}` which bypasses the type scale system. At `type-scale: xl` this stays 9px while everything else grows. |
| S-2 | LOW | The context column blurb (`section.blurb`) uses `text-[11px]` inline, also bypassing the type scale. Should use `text-micro`. |
| S-3 | MEDIUM | `np-context` column has `overflow-y: auto` but no `scrollbar-gutter: stable`, causing a 10px layout shift when content overflows vs. when it doesn't. |
| S-4 | LOW | The breadcrumb in the topbar uses `text-faint` for the section label and `text-text` for the page title — the contrast jump is correct, but there is no visual separator between them other than a `ChevronRight` icon that is `text-faint` too, making it nearly invisible at a glance. |

### 1.2 Topbar

| # | Severity | Finding |
|---|----------|---------|
| T-1 | HIGH | The topbar uses `color-mix(in srgb, var(--color-bg) 92%, transparent)` for its background, which is nearly opaque but not quite. When the page scrolls underneath, content bleeds through faintly at 8% opacity — this reads as a rendering bug rather than intentional translucency. Should be fully opaque or use `surface-glass` deliberately. |
| T-2 | MEDIUM | The `Ctrl K` keyboard hint in the topbar uses a hardcoded `text-[10px]` that bypasses the type scale. |
| T-3 | LOW | The health status indicator (`StatusDot` + text) only appears at `xl` breakpoint (`hidden xl:inline-flex`). On a 1280px window — one of the stated target resolutions — the global health status is invisible, which violates the "where is the user" principle. |

### 1.3 Banner states (recovery, degraded, safe mode)

| # | Severity | Finding |
|---|----------|---------|
| B-1 | MEDIUM | The recovery banner `last_restart_reason` uses `text-micro` class which may not exist in the Tailwind config if `@theme` doesn't emit it — actually it does (line 118 of tokens.css), but `whitespace-pre-wrap` on a potentially multi-line backend string with no `max-height` or truncation means a verbose failure reason can push the banner to 4+ lines, shifting the entire page down. |
| B-2 | LOW | The degraded banner concatenates component labels with commas but has no `max-width` or truncation — on a narrow window with many degraded components, the banner overflows. |

---

## 2. Dashboard (DashboardPage.tsx)

### 2.1 Hero band

| # | Severity | Finding |
|---|----------|---------|
| D-1 | HIGH | The hero band uses `surface-glass` which the identity.css file overrides to `background: var(--color-surface) !important` with `backdrop-filter: none !important`. This means the "glass" effect the hero was designed for is gone — it renders as a plain opaque card, but the `rounded-2xl` radius (14px) conflicts with the design system's `--np-r-4: 14px`, which is correct but inconsistent with the `rounded-xl` (12px) used by every other card on the page. The hero reads as a different shape. |
| D-2 | MEDIUM | The hero band's `hairline-brand` top accent is overridden in identity.css to `background: var(--color-accent) !important; opacity: 0.55` — a solid 1px line at 55% opacity. This is fine but the original intent was a gradient fade. The override makes it a flat bar, which is less refined. |
| D-3 | MEDIUM | Hero metrics use `metric-num text-3xl` for health and `text-xl` for ping/DNS/download. The size jump from 30px to 20px is too large — the secondary metrics look diminutive next to the health number, creating a hierarchy cliff instead of a gradient. |
| D-4 | LOW | The `QUICK_ACTIONS` array uses `Zap` icon for 6 of 8 actions. This violates the "consistent icon family" principle — every quick action looks the same. |

### 2.2 Cards and metrics

| # | Severity | Finding |
|---|----------|---------|
| D-5 | HIGH | The `Card` component uses `rounded-xl` (12px from Tailwind), but identity.css defines `--np-r-3: 10px` for panels. The card radius (12px) and the panel radius (10px) are different values, so a card inside a panel has a larger radius than its container. |
| D-6 | MEDIUM | The `Metric` component renders a `text-2xl` (24px) value, but on the 6-column metric grid (`xl:grid-cols-6`), at 1280px each column is ~170px wide — a 24px number with a unit suffix can overflow on values like "999.9 Mbps". No `truncate` or `overflow-hidden` is applied. |
| D-7 | MEDIUM | The `Gauge` component at 190px sits centered in a `lg:col-span-1` column, but the column width at 1280px is ~380px. The gauge is visually lost in the space — it should either be wider or the column should contain supplementary information beside it. |
| D-8 | LOW | The latency chart `LatencyChart` has no empty state — when `latencyHistory` is empty (app just started), it renders an empty chart area with no "Awaiting data" message. |

### 2.3 Health data not available state

| # | Severity | Finding |
|---|----------|---------|
| D-9 | MEDIUM | When `health.score` is null, the dashboard shows a single centered card with "Health data not available yet." This is a poor empty state — no icon, no suggested action beyond "run a quick ping test", and the card is full-width with a `py-12` that makes it look like a loading state rather than an intentional empty state. |

---

## 3. NANI page (NaniPage.tsx)

### 3.1 Tab navigation

| # | Severity | Finding |
|---|----------|---------|
| N-1 | HIGH | The NANI tab bar uses raw inline `className` with `bg-accent text-accent-foreground` for the active state, but `text-accent-foreground` is not a defined color in the token system — it resolves to nothing, so the active tab text inherits the accent color, making it invisible on the accent background. Should use `text-on-accent`. |
| N-2 | MEDIUM | The NANI tab bar has 10 tabs. On a 1280px window with the sidebar (76px + 226px = 302px) consuming space, the content area is ~978px. Ten tabs at ~120px each (icon + label) = 1200px — they overflow and wrap to a second row, which looks broken. |
| N-3 | MEDIUM | The tab bar uses `border-b border-line pb-2` but the tabs themselves have no bottom border to indicate the active tab's connection to the content below. The active tab floats with a background fill but no visual anchor to the panel. |

### 3.2 Overview tab

| # | Severity | Finding |
|---|----------|---------|
| N-4 | MEDIUM | The `AiCore` component uses `animate-ping` on the outer ring when active — this is a Tailwind utility that creates a continuous scale/opacity loop. It conflicts with the design principle "functional animation over ornamental motion" and the identity.css motion policy which states "Nothing here loops." The identity.css does disable it under reduced motion but doesn't disable it in normal mode. |
| N-5 | HIGH | The "What would you like NANI to investigate?" card uses `rounded-lg` (8px) for its suggestion buttons, while the cards around them use `rounded-xl` (12px). The radius inconsistency is visible — the buttons look sharper than their containers. |
| N-6 | MEDIUM | The recent events list uses `font-mono text-xs` with `text-muted` — but the event type string (e.g. `DiagnosisUpdated`) has no color distinction from the sequence number. Everything is the same muted color, making it hard to scan. |
| N-7 | LOW | The `Badge` component for event stream status uses `tone="ok"` and `tone="neutral"`, but the `neutral` badge has `text-muted` which at the badge's `text-micro` size is borderline for contrast. |

### 3.3 Live investigation tab

| # | Severity | Finding |
|---|----------|---------|
| N-8 | HIGH | The investigation pipeline stages use `border-ok/40 bg-ok/5` for completed stages and `border-line bg-surface-2` for incomplete. The completed stage text is `text-muted` — same as incomplete — so the only distinction is a faint green tint on the border and a check icon. The stage doesn't read as "done" at a glance. |
| N-9 | MEDIUM | The `start investigation` card puts the `Input` and both `Button`s in the `CardHeader` `actions` prop. This is a layout abuse — the header was designed for a small action button, not a full-width input + two buttons. On narrow windows the header overflows. |
| N-10 | HIGH | The active investigation card uses `bg-surface-3` in the hover state for investigation list items (`hover:bg-surface-3`), but `--color-surface-3` is not defined in the token system. Only `surface`, `surface-2`, and `elevated` exist. This class resolves to nothing. |
| N-11 | MEDIUM | The investigation status `Badge` uses `tone="accent"` for running state, but `accent` badges have `bg-accent-soft text-accent-strong border-accent/30` — the accent-soft background is very faint (10% alpha), making the running state badge nearly invisible. |
| N-12 | MEDIUM | The confidence display uses `Math.round(active.confidence * 100)}%` — this rounds to an integer, losing precision that the hypothesis view tab shows with `.toFixed(1)`. The two tabs disagree on precision for the same value. |

### 3.4 Workspace tab (AI chat)

| # | Severity | Finding |
|---|----------|---------|
| N-13 | HIGH | The chat message bubbles use `rounded-2xl` (16px) which is the largest radius in the design system. Every other component uses `rounded-lg` (8px) or `rounded-xl` (12px). The chat bubbles look like they belong to a different app. |
| N-14 | MEDIUM | The chat area uses `h-[60vh]` which is a viewport-relative height. On a 720px window, this is 432px — barely enough for 3-4 messages. On a 1080px window it's 648px. The height should be relative to the available space, not the viewport. |
| N-15 | MEDIUM | The conversation list sidebar uses `lg:grid-cols-[220px_1fr]` but the conversation items have no active indicator beyond `bg-accent/15 text-text`. There's no left border or accent line to indicate which conversation is active. |
| N-16 | LOW | The "NANI is analyzing…" indicator uses `Loader2` with `animate-spin` — fine, but it sits at the bottom of the scroll area and can be scrolled out of view. |

### 3.5 Hypotheses tab

| # | Severity | Finding |
|---|----------|---------|
| N-17 | MEDIUM | The hypothesis bars use `bg-accent` for the posterior fill and `bg-text` for the prior marker. The prior marker is a 2px wide vertical line — at low prior values (e.g. 2%), it sits at the very left edge and is nearly invisible against the bar fill. |
| N-18 | MEDIUM | The entropy/calibration metadata row uses `text-faint` for labels and `text-text` for values, but the values are inline with the labels — `font-mono text-text` — with no visual separation. The metadata reads as a run-on sentence. |

### 3.6 Evidence tab

| # | Severity | Finding |
|---|----------|---------|
| N-19 | MEDIUM | Evidence cards use `font-mono text-xs text-accent` for the evidence ID (`ev-{seq}`), but the evidence detail uses `text-sm text-text`. The font family change from mono to sans within a 3-line card is jarring. |
| N-20 | LOW | The filter input has no clear button (x) — once a filter is typed, the only way to clear it is to select-all and delete. |

### 3.7 Network tab

| # | Severity | Finding |
|---|----------|---------|
| N-21 | MEDIUM | The Network tab has four distinct empty states depending on conditions (lastCheckFailed, lastCheck passed but no samples, gap detected, no check at all). The logic is correct but the visual presentation is inconsistent — each empty state has different messaging density and no shared visual template. |

### 3.8 Learning / History / Settings tabs

| # | Severity | Finding |
|---|----------|---------|
| N-22 | LOW | The Learning tab's drift events display is just a line of text inside a bordered box — "Drift events: 0". This is not a visualization, it's a counter. If drift events exist, they're not shown — only the count. |
| N-23 | MEDIUM | The History tab uses `line-clamp-2` for summaries, but `line-clamp-2` is a Tailwind utility that requires the `@tailwindcss/line-clamp` plugin in v3, or is built-in in v4. Needs verification that it actually works. |
| N-24 | LOW | The Settings tab's "Clear history" confirmation is inline — the confirmation UI appears in the same box as the button. This is easily missed. |

---

## 4. Copilot page (CopilotPage.tsx)

| # | Severity | Finding |
|---|----------|---------|
| C-1 | HIGH | The `AiStatusBadge` uses `bg-green-500/10 text-green-500` — these are raw Tailwind colors, not the semantic tokens (`--color-ok`, `--color-ok`). The badge renders a different green than every other "ok" status in the app. |
| C-2 | HIGH | The `MessageBubble` uses `rounded-2xl` (16px) for chat bubbles — same issue as NANI workspace (N-13). Inconsistent with the design system's radius scale. |
| C-3 | HIGH | The `MessageBubble` uses `text-accent-foreground` for user messages — same undefined token as NANI tab bar (N-1). User message text on accent background is invisible. |
| C-4 | MEDIUM | The `QuickAction` buttons use `hover:bg-accent hover:text-accent-foreground` — same undefined `accent-foreground` token. On hover, the text becomes invisible. |
| C-5 | MEDIUM | The Copilot page uses `bg-background` which is not a defined token — the token is `--color-bg`, which maps to `bg-bg` in Tailwind v4. `bg-background` resolves to nothing. |
| C-6 | MEDIUM | The page has `flex h-full flex-col` but the parent `np-content` doesn't set a height — `h-full` resolves to `auto`, so the flex layout doesn't fill the viewport. The chat area doesn't expand to fill available space. |
| C-7 | LOW | The initial message says "What would you like to investigate today?" but the empty state below it also says "Ask Copilot anything" — two different prompts for the same initial state. |
| C-8 | MEDIUM | There is no distinction between AI-generated content and measured data. The mission brief requires that AI text never look like a verified measurement, but the Copilot renders all assistant messages identically. |

---

## 5. Design system inconsistencies (cross-cutting)

### 5.1 Color tokens

| # | Severity | Finding |
|---|----------|---------|
| DS-1 | CRITICAL | `text-accent-foreground` is used in Button.tsx (`primary` variant), NaniPage.tsx (tab bar, chat bubbles), CopilotPage.tsx (message bubbles, quick actions). This token is NOT defined in `@theme` — only `--color-on-accent` is defined. In Tailwind v4, `text-accent-foreground` would only work if `--color-accent-foreground` existed in `@theme`. It doesn't. All text on accent backgrounds is potentially broken. |
| DS-2 | HIGH | `bg-surface-3` is used in NaniPage.tsx but `--color-surface-3` is not defined anywhere. Only `surface`, `surface-2`, and `elevated` exist. |
| DS-3 | HIGH | `bg-background` is used in CopilotPage.tsx but `--color-background` is not defined. The token is `--color-bg`. |
| DS-4 | MEDIUM | `bg-green-500` is used in CopilotPage.tsx instead of the semantic `--color-ok` token. |
| DS-5 | MEDIUM | The identity.css file overrides several utilities from tokens.css with `!important` (`surface-glass`, `hairline-brand`, `brand-gradient`, `shadow-glow`, `app-backdrop`). These overrides create a maintenance hazard — the original utilities in tokens.css appear to do one thing but actually do another. |

### 5.2 Radii

| # | Severity | Finding |
|---|----------|---------|
| DS-6 | HIGH | Four different border radii are in use across the app: `rounded-md` (6px), `rounded-lg` (8px), `rounded-xl` (12px), `rounded-2xl` (16px). The design system in identity.css defines `--np-r-1: 3px`, `--np-r-2: 6px`, `--np-r-3: 10px`, `--np-r-4: 14px`. None of the Tailwind utility values match the design system values. Cards use 12px (should be 10px), buttons use 8px (should be 6px), chat bubbles use 16px (should be 14px or less). |

### 5.3 Spacing

| # | Severity | Finding |
|---|----------|---------|
| DS-7 | MEDIUM | There is no spacing scale in the design system. Components use ad-hoc Tailwind spacing values (`px-5 py-4`, `px-4 py-3`, `gap-2.5`, `gap-3`, `space-y-6`, `space-y-4`). The values are mostly consistent but there's no token or convention to prevent drift. |
| DS-8 | MEDIUM | The content padding is `28px 28px 64px` on desktop and `20px 18px 48px` on mobile. The 64px bottom padding is excessive — it creates a large empty area at the bottom of every page that reads as wasted space. |

### 5.4 Typography

| # | Severity | Finding |
|---|----------|---------|
| DS-9 | MEDIUM | Several components use inline `text-[Npx]` values that bypass the type scale: `text-[11px]` (context blurb), `text-[10px]` (kbd hint, rail version), `text-[9px]` (rail item font-size in identity.css). These don't scale with `--type-scale`. |
| DS-10 | LOW | The `np-label` class uses `font-size: 10px` which is below the type scale floor of 12px. While this is for labels (not body text), it doesn't scale with `--type-scale`. |

### 5.5 Shadows

| # | Severity | Finding |
|---|----------|---------|
| DS-11 | MEDIUM | The `Card` component uses `shadow-raised` utility, but the hero band on the dashboard uses `surface-glass` which is overridden to use `shadow-raised` too. The hero and a regular card have the same elevation, so the hero doesn't read as more important. |

---

## 6. Component-level issues

### 6.1 Button

| # | Severity | Finding |
|---|----------|---------|
| BTN-1 | HIGH | The `primary` variant uses `bg-accent-soft text-accent-strong border border-accent/40` — this is a TINTED OUTLINE, not a solid fill. The design system in identity.css defines `.np-btn-primary` as a solid `background: var(--color-accent); color: var(--color-on-accent)` fill. The Tailwind `Button` component and the CSS `np-btn-primary` class define two different primary button styles. Pages that use `<Button variant="primary">` get a faint outline; pages that use `className="np-btn-primary"` get a solid fill. |

### 6.2 Badge

| # | Severity | Finding |
|---|----------|---------|
| BDG-1 | MEDIUM | The `Badge` component uses `rounded-md` (6px) but the `CapBadge` in SettingsPage uses `rounded-full`. Two different badge shapes in the same app. |
| BDG-2 | LOW | The `DemoBadge` and `PhaseBadge` use `uppercase tracking-wider` but regular `Badge` doesn't. The tracking is inconsistent. |

### 6.3 Tooltip

| # | Severity | Finding |
|---|----------|---------|
| TIP-1 | MEDIUM | The `Tooltip` arrow uses `fill-[#121b29]` — a hardcoded color that matches the old dark theme surface (`#0d131d` / `#121a27`). In the new identity.css, the surface is `#101a1e`. The tooltip arrow is a slightly different color than the tooltip background. |
| TIP-2 | LOW | No tooltip animation — Radix Tooltip supports `data-[state=delayed-open]:animate-in` but the component doesn't use it. Tooltips appear instantly. |

### 6.4 Switch

| # | Severity | Finding |
|---|----------|---------|
| SW-1 | MEDIUM | The `Switch` uses `h-5.5` which is not a valid Tailwind class (5.5 is not in the default scale). The inline `style={{ height: 22, width: 40 }}` compensates, but the `h-5.5` class is dead CSS. |
| SW-2 | LOW | The switch thumb uses `translate-x-5` (20px) for checked state, but the track is 40px wide and the thumb is 16px — 20px + 16px = 36px, leaving 4px of padding on the right. The thumb is not optically centered in its checked position. |

### 6.5 Tabs

| # | Severity | Finding |
|---|----------|---------|
| TAB-1 | MEDIUM | The `Tabs` component uses `rounded-xl` for the tab list container and `rounded-lg` for the tab triggers. The radii don't nest properly — the triggers (8px) sit inside a container (12px) and the corners don't align. |

### 6.6 Card

| # | Severity | Finding |
|---|----------|---------|
| CARD-1 | MEDIUM | The `Card` component's `CardHeader` uses `border-b border-line` but the border is `1px solid rgba(196, 220, 212, 0.105)` — at 10.5% alpha this is nearly invisible in the dark theme. The header/body separation relies on this border alone. |
| CARD-2 | LOW | The `CardBody` uses `px-5 py-4` — 20px horizontal and 16px vertical. The header uses `px-5 py-3.5` — 20px horizontal and 14px vertical. The 2px vertical padding difference means the header text and body text don't align to the same baseline grid. |

---

## 7. Motion issues

| # | Severity | Finding |
|---|----------|---------|
| M-1 | MEDIUM | The NANI `AiCore` uses `animate-ping` (infinite scale/opacity loop) which conflicts with the design principle "Nothing here loops" from identity.css. |
| M-2 | LOW | The `Progress` component's indeterminate state uses `animate-[pulse-dot_1.2s_ease-in-out_infinite]` — a custom animation reference. This works but the keyframe `pulse-dot` is defined in tokens.css, not identity.css, creating a split source of truth for motion. |
| M-3 | LOW | Tab transitions use `animate-fade-up` (TabPanel) which is a 250ms animation. The page-enter animation is 380ms. The two animations can overlap and create a double-motion effect when navigating to a page with tabs. |

---

## 8. Accessibility findings

| # | Severity | Finding |
|---|----------|---------|
| A-1 | HIGH | The NANI tab bar uses raw `<button>` elements instead of a proper `Tabs` component with `role="tablist"`, `role="tab"`, `aria-selected`, and `aria-controls`. Screen readers cannot identify these as tabs. |
| A-2 | MEDIUM | The `AiCore` animation (`animate-ping`) has no `prefers-reduced-motion` disable in the component itself — it relies on identity.css which disables it, but the Tailwind `animate-ping` class might override. |
| A-3 | MEDIUM | The Copilot chat area has no `role="log"` or `aria-live="polite"` — new messages are not announced to screen readers. |
| A-4 | MEDIUM | The NANI investigation list items use `<div>` with `onClick`-like behavior via nested buttons, but the container `div` has no `role="listitem"` and the list has no `role="list"`. |
| A-5 | LOW | The `Metric` component wraps its content in a `<Tooltip>` when `hint` is provided, but the tooltip trigger is a `<div>` with `cursor-help` — it has no `tabindex` and is not keyboard accessible unless the user happens to tab to the tooltip's Radix trigger. |

---

## 9. Responsive issues

| # | Severity | Finding |
|---|----------|---------|
| R-1 | HIGH | At 1280×720 (a stated target resolution), the rail (76px) + context column (226px) = 302px, leaving 978px for content. The NANI page's 10-tab bar overflows this width and wraps. The dashboard's 6-column metric grid (`xl:grid-cols-6`) at 978px gives each column ~150px — barely enough for a metric value. |
| R-2 | MEDIUM | The Copilot page's `h-[60vh]` at 720px height gives 432px for the chat area — this is too small for a usable chat experience. |
| R-3 | MEDIUM | The `np-content` max-width of 1360px means on a 1920px window, the content is centered with 280px of empty space on each side (after the 302px sidebar). This is fine for readability but the empty space is not used — no contextual sidebar, no quick actions panel. |

---

## 10. Error and empty state patterns

| # | Severity | Finding |
|---|----------|---------|
| E-1 | MEDIUM | The `EmptyState` component uses `border-dashed border-line-strong` — a dashed border that reads as "placeholder" rather than "intentional empty state". The dashed border is a web convention that doesn't fit the instrument aesthetic. |
| E-2 | MEDIUM | The `ErrorState` component has no `role="alert"` — screen readers don't announce errors proactively. |
| E-3 | LOW | The `LoadingState` uses `animate-spin` on a `Loader2` icon — this is fine, but the loading text always ends with `…` (ellipsis) even when the label already ends with one (e.g. "Loading settings…" becomes "Loading settings……"). |

---

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 1 |
| HIGH | 17 |
| MEDIUM | 46 |
| LOW | 21 |
| **Total** | **85** |

The most impactful issues to fix first:
1. **DS-1**: `text-accent-foreground` is undefined — broken text on all accent backgrounds
2. **DS-2/DS-3**: `surface-3` and `background` tokens don't exist — broken styles
3. **BTN-1**: Primary button is a faint outline, not a solid fill — contradicts design system
4. **DS-6**: Radii values don't match between Tailwind utilities and design system tokens
5. **N-1/C-3**: Invisible text on accent backgrounds in NANI tabs and Copilot bubbles
6. **C-1**: Raw `green-500` instead of semantic token in Copilot status badge
7. **A-1**: NANI tabs not accessible as tablist

Resolution status for every finding is recorded in
`UI_MASTER_13_FINAL_DESIGN_AUDIT.md`.
