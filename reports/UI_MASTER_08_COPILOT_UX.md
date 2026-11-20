# UI_MASTER_08 — COPILOT UX

## 1. What Copilot is, and what it is not

Copilot explains and diagnoses in natural language. It runs **locally** against a
model the user configures — it is not a cloud chat product, and the interface says
so on every load.

The header subtitle is the most important string on the page:

| Backend state | Subtitle |
|---|---|
| Model ready | `Local explanations — {runtime} ready` |
| Model unavailable | `Local explanations — model unavailable ({message})` |
| Status not yet fetched | `Local explanations — initializing…` |

"Local explanations" appears in all three. A user should never be uncertain about
whether their network diagnostics left the machine. When the model is missing the
UI says which configuration is missing rather than degrading to a generic
"something went wrong".

---

## 2. Layout

```
┌──────────────────────────────────────────────────────────────┐
│ Copilot                          [● AI Copilot Online]       │  PageHeader
│ Local explanations — llama3 ready                            │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│   ◆  Ask Copilot anything                    (empty state)   │
│      I can diagnose connections, analyze profiles…           │
│      [Why is my connection slow?] [Diagnose my connection]…  │
│                                                              │
│                                    ┌──────────────────┐      │
│                                    │ user message     │      │
│                                    └──────────────────┘      │
│   ┌──────────────────────────────┐                           │
│   │ assistant message            │  [Copy]                   │
│   └──────────────────────────────┘                           │
├──────────────────────────────────────────────────────────────┤
│ Message                                                      │
│ ┌──────────────────────────────────┐ [Send] [Clear] [Retry] │
│ │ Ask about your connection…       │                        │
│ └──────────────────────────────────┘                        │
└──────────────────────────────────────────────────────────────┘
```

Three vertical regions: header (identity + status), thread (scrollable), composer
(fixed). The thread is the only scrolling region, so the composer is always
reachable and the status badge never scrolls away.

---

## 3. Message bubbles

| Property | User | Assistant |
|---|---|---|
| Alignment | Right | Left |
| Background | `bg-accent` | `bg-surface` + `border-line` |
| Text | `text-on-accent` | `text-text` |
| Radius | `rounded-xl` + `rounded-tr-sm` | `rounded-xl` + `rounded-tl-sm` |
| Max width | `max-w-[80%]` | `max-w-[80%]` |
| Timestamp | `text-micro text-faint` | same |

### 3.1 The `rounded-tr-sm` tail

A 12px bubble with one 6px corner on the speaker's side. This is the standard
chat affordance and it does the work that an avatar would do, at zero width cost.
A fully uniform `rounded-xl` bubble loses the speaker cue at a glance; a
`rounded-2xl` bubble (16px) becomes a capsule on single-line messages, which
reads as a notification toast rather than a message.

### 3.2 Timestamp

`text-micro` (12px, the floor) in `text-faint`. Present on every bubble but
visually subordinate — you find it when you need it, it does not compete with
content.

### 3.3 Long content

`whitespace-pre-wrap break-words`. Pre-wrap preserves the model's paragraph
structure (a model output with line breaks is meaning-bearing). `break-words`
prevents a long URL or hash from forcing horizontal scroll.

---

## 4. Empty state

The empty state is a designed onboarding surface, not a placeholder:

- 48px circular `Sparkles` glyph in `bg-accent/10 text-accent`
- Title: **"Ask Copilot anything"**
- One sentence naming the five capabilities
- **Eight quick questions** as clickable chips

```
Why is my connection slow?     Diagnose my connection
Explain my VPN configuration   Compare server performance
Troubleshoot connection error  Recommend the best server
Explain protocol differences   Analyze connection stability
```

### 4.1 Why eight, and why these eight

The eight questions span the five advertised capabilities, so the set
demonstrates the product rather than describing it. They are also the eight
questions a network tool is actually asked. A single "How can I help?" would
leave the user to invent a prompt; eight examples teach the prompt style by
example.

### 4.2 Chip design

```
[✦ Why is my connection slow?]
```

`rounded-lg`, `border-line`, `text-muted`, `hover:bg-surface-2 hover:text-text`.

The hover state was previously `hover:bg-accent hover:text-accent-foreground`,
which turned every chip solid cyan on hover — eight chips flashing brand colour
as the pointer crossed them. Hover is a *surface* change, not a brand statement;
`surface-2` is the correct weight. The `Sparkles` glyph is `text-faint` at 12px:
it marks the chip as a suggestion without competing with the question text.

---

## 5. Composer

| Element | Behaviour |
|---|---|
| Input | `autoFocus`, `disabled` while streaming, placeholder names three domains |
| Send | `disabled={!input.trim()}` — whitespace is not a question |
| Stop | Replaces Send while streaming; aborts the `AbortController` |
| Clear | Appears once there is content; resets to the initial message |
| Retry | Appears once there is content **and** a retryable error |

### 5.1 Stop, not Send-with-spinner

While streaming, the primary button becomes **Stop**. A disabled Send with a
spinner leaves the user unable to interrupt a slow generation. `Stop` aborts the
request and returns the composer to rest.

### 5.2 Retry is conditional

`canRetry = hasContent && error != null && isRetryableError(new Error(error))`

Retry appears only for errors the client classifies as retryable. A retry button
on a permanent failure (model not configured) teaches the user to press a button
that cannot work.

---

## 6. Streaming and thinking states

| State | Render |
|---|---|
| Request in flight, no tokens yet | Centred `LoadingState label="Copilot is thinking"` |
| Tokens arriving | Message bubble grows in place |
| Error | `ErrorState` with `role="alert"` and optional retry |
| Status unknown | Header subtitle "initializing…", badge reads Offline |

The thinking state renders **only** when the last message is empty. Once the
first token lands, the spinner is replaced by the growing bubble — no spinner and
partial text on screen simultaneously.

---

## 7. The status badge

```
[● AI Copilot Online]      healthy
[● Offline]                unavailable
```

| State | Classes |
|---|---|
| Online | `bg-ok/10 text-ok border-ok/30`, dot `bg-ok` |
| Offline | `bg-surface text-faint border-line`, dot `bg-muted` |

Previously this used `bg-green-500/10 text-green-500` and `bg-green-500` — a raw
Tailwind palette colour outside the design system. Green is not a token in this
product; `--color-ok` is. The badge now uses the semantic token, so it tracks the
theme (the light-theme `ok` is `#036249`, not `#34d399`) and it matches every
other success indicator in the app.

The dot is `rounded-full` at 8px — the only circular element in the badge, which
is what makes it read as a status light rather than a bullet.

---

## 8. Accessibility

| Concern | Implementation |
|---|---|
| Thread announcements | `role="log" aria-live="polite"` on the message region |
| Errors | `ErrorState` carries `role="alert"` |
| Icon-only actions | Copy / Clear / Retry all have visible text labels; none are icon-only |
| Input labelling | Wrapped in `Field label="Message"` |
| Focus | `autoFocus` on the composer — the page has one job |
| Reduced motion | Streaming has no animation of its own; the spinner honours the global reduced-motion block |

`aria-live="polite"` on the log means a screen reader announces each new message
once, without interrupting whatever it is currently reading. `assertive` would
interrupt on every token of a streaming response.

---

## 9. Fixed defects

| # | Defect | Fix |
|---|---|---|
| P-1 | Status badge used `green-500` outside the token system | `--color-ok` via `bg-ok/text-ok/border-ok` |
| P-2 | Bubbles used `rounded-2xl` (capsule on short messages) | `rounded-xl` + speaker-side `sm` corner |
| P-3 | User bubble text used `text-accent-foreground` — undeclared token, invisible label | `text-on-accent` |
| P-4 | Quick chips turned solid accent on hover | `hover:bg-surface-2 hover:text-text` |
| P-5 | Page background used `bg-background` | `bg-bg` (canonical token) |
| P-6 | Thread had no live-region semantics | `role="log" aria-live="polite"` |
| P-7 | Unused `Bot` import after the empty-state redesign | Removed |
| P-8 | `model unavailable (undefined)` when the backend omitted `message` | `\|\| 'not configured'` fallback |

---

## 10. Acceptance criteria

| Criterion | State |
|---|---|
| User always knows whether inference is local | Pass — subtitle on every state |
| Missing model is explained, not hidden | Pass — names the missing config |
| Composer always reachable | Pass — fixed footer |
| Generation can be interrupted | Pass — Stop button |
| Retry only offered for retryable errors | Pass |
| No off-system colours | Pass — `--color-ok` |
| New messages announced to screen readers | Pass — `role="log"` |
| Empty state teaches the prompt style | Pass — 8 example questions |
| Whitespace cannot be submitted | Pass — `!input.trim()` |
