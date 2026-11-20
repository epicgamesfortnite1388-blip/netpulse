# UI DESIGN 2.0 — 06 — Interaction and Motion

**Principle:** motion reports change. A measurement that has not changed does not move.

---

## 1. What motion is allowed

| Kind | Allowed | Why |
|---|---|---|
| State transition (colour, opacity) | Yes, 140 ms `--ease-out-soft` | Confirms an action landed |
| Panel enter / route change | Yes, ≤ 320 ms `--ease-fluid` | Orients the user after navigation |
| Press feedback | Yes, `--ease-spring` | Physical confirmation |
| Progress (spinner) | Yes, while genuinely in flight | It is reporting work |
| Infinite decoration | **No** | Nothing is being reported |
| Fake progress | **No** | See §4 |

Durations are capped at 320 ms deliberately: above that a navigation reads as
*waiting* rather than *travelling*, and every one of these runs on the main thread
of a WebView.

---

## 2. Reduced motion — the gap that was found

`identity.css` had a `prefers-reduced-motion` block, and it was correct as far as it
went:

```css
@media (prefers-reduced-motion: reduce) {
  .np-rail-item, .np-context-link, .np-btn-primary, .np-btn-quiet,
  .np-icon-btn, .np-dial-arc, .page-enter { transition: none !important; animation: none !important; transform: none !important; }
  .aether-halo, .aether-ping, .aether-orbit, .aether-orbit-slow, .animate-pulse-dot { animation: none !important; }
}
```

**It was a blocklist.** Components use Tailwind's animation utilities directly, and
nothing in that list matched them:

| Utility | Count | Guarded before? |
|---|---|---|
| `animate-spin` | 29 | n/a (progress) |
| `animate-pulse` | 10 | **No** — infinite, unguarded |
| `animate-pulse-dot` | 4 | Yes, by name |
| `animate-ping` | 1 | Yes, via `motion-safe:` / `motion-reduce:` |

So `animate-pulse` — an infinite 2 s pulse — ran on six elements regardless of the
user's motion preference. A list of names cannot keep up with a utility family; every
new component re-opens the hole.

### The fix

Cover the family, not the names:

```css
[class*='animate-']:not([class*='animate-spin']) {
  animation: none !important;
}
```

`animate-spin` is exempt on purpose. A spinner that stops is indistinguishable from a
hang, and it is the only one of these that reports progress rather than decorating.

Verified in the compiled stylesheet:

```
@media (prefers-reduced-motion:reduce){…
  [class*=animate-]:not([class*=animate-spin]){animation:none!important}}
```

And pinned by assertion 54:

```js
const family = css.includes('[class*=animate-]');
const spinExempt = css.includes(':not([class*=animate-spin])');
checks.push([family && spinExempt, 'reduced motion neutralises the animation-utility family (spinners exempt)']);
```

---

## 3. Decorative loops already removed

Before this pass, Aether's stage ran three infinite animations. `identity.css`
neutralised them and slowed the composition to a single quiet drift:

```css
.aether-aurora, .aether-scanline, .aether-sheen { animation: none !important; opacity: 0.22 !important; }
```

That decision is retained. The stage keeps its structure — it is a real engine
surface, not decoration — but it no longer moves to prove it is alive.

---

## 4. Progress without fake percentages

The brief forbids fake progress. What the connection flow actually does:

- `QuickConnectActivity` appends **real** milestones received from the backend event
  stream (`accepted`, `memory-check`, `adaptive-plan`, `candidate-probe`, `core-start`,
  `relay-check`, `connected`, …), keeping the last 48.
- While waiting it renders *"awaiting next measured milestone"* with a spinner — it
  does **not** interpolate a percentage.
- The stage list is a fixed vocabulary; an unknown stage falls back to a neutral dot
  rather than inventing a label.
- The timeline header shows the latest probe latency when one exists, and omits it
  otherwise — no placeholder number.

`AgentPathTrace` derives hop state from the same events (`pending` / `active` / `ok` /
`failed`). A hop is `active` only when an event says so; it is never animated into
looking active on a timer.

---

## 5. State signalling that must not become motion

Two places where the temptation is to pulse, and what was chosen instead:

**Unknown / stale data.** No pulse. A stale value is rendered with its age
(*"checked 35 s ago (cached)"*). Motion would imply something is being fetched.

**Disconnected.** The dial is static. The earlier design language would have pulsed a
red ring; a static ring plus the word *Disconnected* states the fact without anxiety
theatre.

---

## 6. Focus and keyboard

- `focus-visible` outlines are `outline-2` with `outline-offset-2` on
  `outline-accent` — a 2 px ring at 2 px offset, not a colour change alone.
- Tabs and segmented controls: Radix owns roving tabindex and arrow keys. NANI's
  hand-written `onTabKeyDown` was deleted, so there is one implementation to keep
  correct instead of two.
- No transition is attached to `transform` on any focusable element, so focus does not
  animate the layout.

---

## 7. What was deliberately not done

| Considered | Decision |
|---|---|
| Tuning the easing curves | Not done. The three curves are documented and adequate; re-tuning without a user-visible problem would be churn. |
| Adding page-transition choreography | Rejected. Navigation should be instant; a 260 ms choreography on every route adds latency to a tool used repeatedly. |
| Scroll-linked animation | Rejected. No information is carried by it. |
| A motion inventory on every component | Not done. Motion was reviewed at the stylesheet level, where it is defined, rather than per component. |

---

## 8. Verification

| Check | Result |
|---|---|
| `prefers-reduced-motion` blocks present | 7 across the two stylesheets |
| Animation-utility family neutralised | Assertion 54 — pass |
| Spinner exempt | Assertion 54 — pass |
| Compiled rule confirmed | `[class*=animate-]:not([class*=animate-spin]){animation:none!important}` |
| Infinite decorative animations in identity | 0 (three removed earlier, retained) |
| Fake percentages in progress UI | 0 — verified by reading every stage renderer |
