# UI_MASTER_09 — MOTION AND MICRO-INTERACTIONS

## 1. The motion philosophy

Three rules govern every animation in NetPulse:

1. **Enter-only.** Nothing animates out. An exit animation delays the next thing
   the user asked for, which is the opposite of feeling fast.
2. **Nothing loops** in the primary UI. A perpetual animation reads as "still
   loading" even when the system is idle.
3. **Motion is never the only signal.** Every animated state has a static
   colour, text or layout equivalent, so `prefers-reduced-motion` removes
   decoration without removing information.

---

## 2. Motion tokens

| Token | Value | Use |
|---|---|---|
| `--ease-fluid` | `cubic-bezier(0.22, 1, 0.36, 1)` | Default for anything travelling a distance |
| `--ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | Overlay entry only |
| `--ease-out-soft` | `cubic-bezier(0.4, 0, 0.2, 1)` | Backdrop fades |
| `--dur-quick` | 140ms | Hover, focus, colour |
| `--dur-base` | 200ms | Most transitions, tooltip |
| `--dur-move` | 280ms | Drawers, cards |
| `--dur-slow` | 380ms | Route change |

The spring curve is used in exactly one place — the command palette panel — and
never on hover. A spring on a hover state produces a bounce on every pointer
movement, which is exhausting within ten seconds.

---

## 3. The fill-mode decision (`backwards`, never `both`)

This is the subtlest and most consequential rule in the motion system, and it is
documented at length in `tokens.css`:

> Fill mode is `backwards`, never `both`. `both` retains the animation's last
> keyframe forever, and a retained transform — even `transform: none`, which the
> browser reports as an identity matrix — makes the element a containing block
> for `position: fixed` descendants.

Concretely: the Live Map page mounts a `fixed inset-0` panel inside a routed
page. If `page-enter` used `animation-fill-mode: both`, that panel would size
itself to the *page box* instead of the *window* — the map would render
mispositioned after the entry animation completed.

For the same reason, `page-in` deliberately omits `filter` and `will-change`:
both create a containing block for fixed descendants. And the keyframe ends at
`transform: none` rather than a lingering `translate3d(0,0,0)`, so no transform
survives the animation.

---

## 4. Page transition

```css
@keyframes page-in {
  from { opacity: 0; transform: translate3d(0, 10px, 0) scale(0.998); }
  55%  { opacity: 1; }
  to   { opacity: 1; transform: none; }
}
.page-enter {
  animation: page-in var(--dur-slow) var(--ease-fluid) backwards;
}
```

| Property | Value | Reasoning |
|---|---|---|
| Distance | 10px | Small enough to read as a settle, large enough to register |
| Scale | 0.998 | Sub-perceptual alone; adds weight in combination with the translate |
| Opacity ramp | Reaches 1 at 55% | The content is readable before the movement finishes — perceived speed comes from early legibility, not short duration |
| Duration | 380ms | Longer than a hover because it covers a full content swap |
| Fill | `backwards` | See §3 |

`key={pathname}` on the wrapper re-runs the animation on every route change.

---

## 5. Card stagger

`page-enter` moves the routed page as one surface. On a page made of cards, that
makes every card indistinguishable from the page — the content reads as arriving
as a slab.

`.stagger` hands the movement one level down: each direct child settles 8px after
the one before it.

```css
.stagger { --stagger-base: 40ms; --stagger-step: 35ms; }
.stagger > * {
  --stagger-i: 7;
  animation: card-in var(--dur-move) var(--ease-fluid) backwards;
  animation-delay: calc(var(--stagger-base) + var(--stagger-i) * var(--stagger-step));
}
.stagger > :nth-child(1) { --stagger-i: 0; }
/* … through :nth-child(8) */
```

### 5.1 Design decisions

| Decision | Reasoning |
|---|---|
| Index via `:nth-child`, not inline style or JS | A card that mounts later joins the same rhythm with no hook |
| Default `--stagger-i: 7` | Anything past the 8th child waits in the last slot |
| Cap at 8 | Past that, the last card arrives after the user has begun reading the first — that reads as lag, not choreography |
| Base 40ms | Gives the page a head start before the cards begin |
| Step 35ms | Fast enough that card 8 lands at 285ms, inside the page animation |
| Runs on creation only | A re-render never replays it, so a 5-second poll does not re-animate the page |

---

## 6. Route progress bar

Rendered only while a lazy route chunk is in flight:

```css
@keyframes route-progress {
  from { transform: scaleX(0.02); opacity: 0.9; }
  40%  { transform: scaleX(0.55); }
  70%  { transform: scaleX(0.72); }
  to   { transform: scaleX(0.86); opacity: 0.65; }
}
```

It grows fast to 55%, then creeps to 86% and fades. This is the **honest shape of
"still loading"**: it never reaches 100% because 100% would claim to know when
the load finishes. It is `position: fixed; top: 0` and measures against the
window — which is why `PageSkeleton` renders outside the `page-enter` wrapper.

Under reduced motion the bar is frozen at `scaleX(0.5)` rather than removed: the
bar is the *only* indicator that a route is loading, so removing it would remove
information. Freezing keeps the signal and drops the movement.

---

## 7. Overlays

### 7.1 Command palette

```css
.palette-backdrop-in { animation: palette-backdrop-in var(--dur-quick) linear backwards; }
.palette-panel-in    { animation: palette-panel-in var(--dur-base) var(--ease-spring) backwards; }
```

Panel: `translate3d(0, -10px, 0) scale(0.985)` → `none`. It drops in from above,
which is the direction of the shortcut that opened it. Backdrop: plain opacity
fade at 140ms — faster than the panel, so the panel is the only thing that
appears to move.

All of this is CSS, not JS: opening the palette costs no layout read.

### 7.2 Mobile drawer

```css
@keyframes drawer-panel-in { from { transform: translate3d(-100%, 0, 0); } to { transform: none; } }
```

It slides from the edge it lives on — the same gesture as the thumb that opened
it. The backdrop only fades. There is **no exit animation**: closing the drawer
must reveal the page immediately, not after a curtain call.

### 7.3 Toast

```css
@keyframes toast-in {
  from { opacity: 0; transform: translate3d(18px, 0, 0) scale(0.97); }
  to   { opacity: 1; transform: none; }
}
```

Toasts arrive from the right edge they are anchored to, which is the direction
they will leave in. A toast that fades up from below reads as *content*; one that
slides in from the edge reads as an *interruption*. The distinction matters
because a toast is competing with the page for attention.

---

## 8. Status pulse

```css
@keyframes pulse-dot { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
.animate-pulse-dot { animation: pulse-dot 2s ease-in-out infinite; }
```

The **only** infinite animation in the primary UI. It appears exclusively on a
`StatusDot` whose state is not terminal — `connecting`, `reconnecting`,
`checking`, `recovering`. A dot in a terminal state (`connected`, `failed`,
`idle`) does not pulse.

### 8.1 Fixed: `animate-ping` removal

NANI's `AiCore` used `animate-ping` — an expanding ring that repeats forever. A
perpetual ping means "still loading" permanently, even when NANI is idle. It was
replaced with `animate-pulse-dot`: a 2s opacity breath, which reads as *alive*
rather than *busy*.

The distinction is the whole point of the no-loop rule. A system that is alive
may breathe; a system that is working may spin; nothing may do either when it is
idle.

---

## 9. Interaction states

| Element | Rest → Hover | Transition |
|---|---|---|
| `Button` primary | `bg-accent` → `bg-accent-strong` | `--dur-quick` |
| `Button` secondary | `bg-surface-2` → `bg-surface-3` + `border-line-strong` | `--dur-quick` |
| `Button` ghost | `transparent` → `bg-surface-2`, `text-muted` → `text-text` | `--dur-quick` |
| Rail item | icon + label colour, `::before` indicator | `--dur-quick` |
| Context link | `bg-transparent` → `bg-surface-2` | `--dur-quick` |
| Quick action chip | `bg-transparent` → `bg-surface-2` | `--dur-quick` |
| Input / Select | `border-line` → `border-accent/60` + 1px ring | `--dur-quick` |
| Switch thumb | `translate-x-[3px]` → `translate-x-[21px]` | `--dur-base` |

### 9.1 Hover is a surface change

The single most repeated correction in this pass: hover states that used accent
colour were changed to surface colour. `hover:bg-accent/10` on suggestion chips,
`hover:bg-accent hover:text-accent-foreground` on quick actions — both made the
brand colour the hover feedback. Hover should say *"this is clickable"*, not
*"this is the primary action"*. Accent is reserved for the one primary action per
view.

### 9.2 Pressed states

`active:` states use a smaller transform or a darker surface, at `--dur-quick`.
There is no `scale(0.95)` bounce — on a 36px button a 5% scale is 1.8px, which
reads as a glitch rather than a press.

---

## 10. Reduced motion

Seven `@media (prefers-reduced-motion: reduce)` blocks across both stylesheets
neutralise:

| Removed | Preserved |
|---|---|
| `page-enter` | Route still changes |
| `card-in` stagger | Cards still render |
| Palette / drawer / toast entry | Overlays still open |
| Nav pill travel | Active state still shown by colour |
| Aether decorative layers (aurora, halo, scanline, sheen, orbit, ping) | Static decoration remains |
| Skeleton sheen | Skeleton still visible |
| Route progress animation | Bar frozen at 50% — the loading signal survives |

The last row is the principle in miniature: when motion must go, replace it with
a static equivalent of the same information, never with nothing.

---

## 11. What is deliberately not animated

| Not animated | Why |
|---|---|
| Page exit | Delays the next page |
| Data refetch / value updates | A number changing every 5s must not flash |
| Table row hover | Row-level motion in a dense table is noise |
| Tooltip exit | Exit animations on tooltips leave ghosts when the pointer moves fast |
| Fold open/close height | `height: auto` animation requires measurement and janks on long content |
| Gauge needle | The gauge renders its value directly; an animated sweep would suggest a live measurement it does not have |

---

## 12. Acceptance criteria

| Criterion | State |
|---|---|
| No animation loops in idle state | Pass — only `pulse-dot`, and only on non-terminal states |
| No exit animations | Pass |
| No retained transform creating a containing block | Pass — `backwards` fill everywhere |
| Card stagger capped | Pass — 8 |
| Stagger does not replay on refetch | Pass — creation-only |
| Hover never uses accent as feedback | Pass |
| Reduced motion preserves every signal | Pass — 7 blocks |
| All durations from tokens | Pass |
| Spring only on overlay entry | Pass |

---

## APPENDIX — Evidence correction (recovery mission, 2026-11-20)

Original text preserved above. Corrections:

- "Seven `@media (prefers-reduced-motion: reduce)` blocks" → **five** in the current tree: `identity.css:672` and `tokens.css:685,745,937,1018`. The count of distinct selectors/components is a different quantity and was not measured.
- "Reduced motion preserves every signal — Pass — 7 blocks" → **Pass — 5 blocks**; the pass verdict is unchanged, the count was wrong.
- "`animate-ping` removal" — accurate **only for NANI `AiCore`**. One `animate-ping` still ships at `features/vpn/AgentPathTrace.tsx:78`, but it is `motion-safe:animate-ping motion-reduce:animate-none` — reduced-motion-safe and intentional state feedback. The blanket "removed" phrasing should be read as "removed from AiCore".

No source was changed to satisfy these claims; the reports were corrected to match the source.
