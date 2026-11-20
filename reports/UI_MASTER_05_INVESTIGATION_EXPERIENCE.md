# UI_MASTER_05 — INVESTIGATION EXPERIENCE

## 1. The design problem

NANI runs a diagnostic pipeline — observe, classify, hypothesise, analyse, plan,
test, verify, learn — and streams events while it does. The interface must let a
user answer three questions at increasing depth:

1. **Is something happening?** (ambient)
2. **What stage is it at?** (progress)
3. **What does it believe, and why?** (reasoning)

Most AI products collapse these into a single chat transcript. NANI does not,
because the pipeline is not a conversation — it is a state machine with a real
event log behind it. The interface is therefore organised as **ten tabs over one
shared event stream**, not as a chat.

---

## 2. Tab architecture

| Tab | Question it answers | Data source |
|---|---|---|
| Overview | What is NANI's overall state? | `fetchNaniStatus`, `fetchLearningStatus` |
| Live Investigation | What is running right now? | `useNaniEvents` + `listInvestigations` |
| Recovery | What will it try, and did it work? | `RecoveryControls` |
| AI Workspace | Let me ask about it directly. | `naniApi.explain` + local conversations |
| Hypotheses | What does it believe, with what confidence? | `fetchHypothesisView` |
| Evidence | What observations support that? | event stream |
| Network Intel | What does it know about the path? | events + `lastCheck` |
| Learning | What has it learned across runs? | `fetchLearningStatus`, `fetchDriftEvents` |
| History | What happened before? | `listInvestigations` |
| Settings | How is it configured? | status DTO |

Ten tabs is a lot. They are acceptable because:

- Each is a **different question**, not a different view of the same data.
- The tab bar is a single row of icon + label at 13px, not a vertical list.
- The default tab (Overview) answers the ambient question without any clicking.
- Tabs are grouped implicitly: Overview/Live/Recovery = *operate*;
  Workspace/Hypotheses/Evidence/Network = *understand*;
  Learning/History/Settings = *review and configure*.

---

## 3. The pipeline strip

The signature element of Live Investigation. Eight fixed stages:

```
OBSERVE → CLASSIFY → HYPOTHESES → ANALYZE → PLAN RECOVERY → TEST → VERIFY → LEARN
```

Each stage maps to one or more real event types:

| Stage | Matched events |
|---|---|
| OBSERVE | `TelemetryTick`, `HealthCheckCompleted`, `nani:health:updated` |
| CLASSIFY | `FailureDetected`, `ApiHealthChanged` |
| HYPOTHESES | `DiagnosisUpdated`, `nani:diagnosis:completed` |
| ANALYZE | `DriftDetected` |
| PLAN RECOVERY | `RecoveryStarted`, `nani:recovery:planned` |
| TEST | `RecoveryStepCompleted`, `nani:recovery:step:*` |
| VERIFY | `RouteSelected`, `nani:route:activated` |
| LEARN | `LearningUpdate` |

### 3.1 Why a fixed strip and not a progress bar

A progress bar needs a denominator. The pipeline has no fixed length — an
investigation may loop back to CLASSIFY after a failed recovery. A strip of
eight named stages with three states each (untouched / reached / completed)
communicates *where the reasoning got to* without pretending to know *how much
is left*.

### 3.2 Stage state encoding

| State | Visual |
|---|---|
| Not reached | `text-faint`, no fill |
| Reached | `text-muted`, `bg-surface-3` |
| Completed | `text-ok`, `bg-ok/10` |

Completed stages use `bg-ok/10` + `text-ok` together, never colour alone. The
label text also changes weight, so the state survives greyscale and colour
vision deficiency.

### 3.3 Sequence gaps

`events.gapCount > 0` renders an explicit warning: *"N sequence gap(s) detected —
the replay fetch recovers retained events."* The UI admits that it may have
missed events rather than silently rendering an incomplete story. This is the
single most important honesty affordance in the feature.

---

## 4. Investigation list and detail

The live tab is a two-pane layout: a list of investigations on the left, the
active investigation's detail on the right.

### 4.1 List rows

Each row shows: query text, stage, outcome, sequence number, and start time.

- Active row: `border-l-2 border-accent` plus `bg-accent/10`. The left rule is
  the primary signal — a background tint alone is too weak at this row height.
- Row background was reduced from `bg-accent/15` to `bg-accent/10`; at 15% the
  tint competed with the text rather than sitting under it.
- Sequence number (`seq`) is `text-faint`, event type is `text-muted`. Two
  different greys in one row is what makes the row parseable at a glance —
  previously both were `text-muted` and the row read as one undifferentiated
  string.

### 4.2 Detail panel

The detail panel exposes the four numbers that matter:

| Field | Format | Rationale |
|---|---|---|
| Observations | integer | Count of evidence items |
| Hypotheses | integer | Count of candidate explanations |
| Confidence | `(confidence * 100).toFixed(1)%` | One decimal — 72.4% and 72.9% are meaningfully different when you are deciding whether to trust a diagnosis |
| Top hypothesis | truncated single line | The headline belief |

Confidence was previously `Math.round(x * 100)` — an integer. Rounding a
posterior to whole percent hides the difference between a hypothesis at 0.724
and one at 0.729, which is exactly the resolution the engine computes at.

---

## 5. AI Workspace

The Workspace tab is the only place in NANI that behaves like a chat, and it is
scoped accordingly: it is one tab among ten, not the product's front door.

### 5.1 Layout

- Left: conversation list. Each entry is deletable via an icon button with
  `aria-label="Delete conversation"`.
- Right: message thread + composer.
- Thread height: `h-[calc(100vh-280px)] min-h-[300px]`.

The `calc` replaces a fixed `h-[60vh]`. At 60vh the thread was too short on
1080p (648px) and too tall on a laptop (420px) where it pushed the composer off
screen. Anchoring to viewport height minus the measured chrome height (280px =
topbar + page header + tab bar + composer + gutters) makes the composer stay
visible at every window size, and `min-h-[300px]` prevents collapse on very
short windows.

### 5.2 Message bubbles

- `rounded-xl` (12px), not `rounded-2xl`. At 16px a single-line bubble is almost
  a capsule, which reads as a notification rather than a message.
- User bubble: `bg-accent text-on-accent`.
- Assistant bubble: `bg-surface-2 text-text`.

### 5.3 Empty state

When there is no conversation, the tab renders a designed empty state with a
`MessageSquare` icon, a title, and a message that tells the user what the
workspace is for — not a blank panel with a cursor.

---

## 6. Overview tab

The ambient answer. It renders:

- A status summary (web vs desktop mode, availability)
- Last diagnosis with cause and confidence, when one exists:
  `Last diagnosis: {cause} ({confidence ?? '?'})`
- Pipeline activity summary
- Health check entry point

The `?` fallback is deliberate: if the backend reports a diagnosis without a
confidence, the UI shows `?` rather than `0` or omitting the field.

---

## 7. Recovery tab

`RecoveryControls` (681 lines) is the largest single component in the feature.
It presents:

- The recovery plan as ordered steps
- Per-step state (pending / running / succeeded / failed)
- Manual overrides where the backend allows them
- A hard stop

The governing principle: **every step shows the backend's own state string.**
The UI does not synthesise "Step 2 of 4 (50%)" from a plan length, because a
plan can be amended mid-flight and the denominator would then be a lie.

---

## 8. Cross-tab consistency

| Element | Rule |
|---|---|
| Confidence | `toFixed(1)%` in detail cards and calibration headers. The compact per-hypothesis list in web mode uses whole percent because the bar already carries the precision. |
| Timestamps | `timeAgo()` for recency, `toLocaleTimeString` for absolute time. Never both in one field. |
| Event type names | Rendered verbatim in mono. They are identifiers, not prose. |
| Empty states | Always icon + title + explanation + (where possible) an action. |
| Errors | `ErrorState` with `role="alert"`, never a bare red string. |

---

## 9. Fixed defects in this area

| # | Defect | Fix |
|---|---|---|
| N-1 | Tab bar active label used `text-accent-foreground`, an undeclared token → invisible text | Changed to `text-on-accent`; token alias also added globally |
| N-2 | Chat bubbles used `rounded-2xl` (16px) — capsule look | `rounded-xl` (12px) |
| N-3 | `AiCore` used `animate-ping` — an infinite loop contradicting the no-loop rule | Replaced with `animate-pulse-dot` (2s opacity pulse) |
| N-4 | Suggestion buttons used `hover:bg-accent/10`, tinting every suggestion cyan on hover | `hover:bg-surface-3` — hover is a surface change, not a brand statement |
| N-5 | Completed pipeline stages used `text-muted` on `bg-ok/5` — the success colour was invisible | `text-ok` on `bg-ok/10` |
| N-6 | Event rows rendered seq and type in the same grey | seq → `text-faint`, type → `text-muted` |
| N-7 | Investigation list had no active indicator beyond a background tint | Added `border-l-2 border-accent` |
| N-8 | Confidence rounded to whole percent | `toFixed(1)` |
| N-9 | Workspace thread used fixed `h-[60vh]` — composer pushed off screen on laptops | `h-[calc(100vh-280px)] min-h-[300px]` |
| N-10 | Observation/hypothesis values inherited parent colour | Explicit `text-text` |

---

## 10. Acceptance criteria

| Criterion | State |
|---|---|
| Ambient state answerable without interaction | Pass — Overview is the default tab |
| Pipeline position always visible during a run | Pass — fixed 8-stage strip |
| Stage state survives greyscale | Pass — weight + colour + background |
| Missed events are disclosed, not hidden | Pass — gap counter |
| Confidence precision matches engine precision | Pass — one decimal |
| Composer reachable at 768px and 1440px height | Pass — viewport-anchored thread |
| No infinite animation | Pass — ping replaced |
| Empty and error states are designed | Pass — icon + title + copy |
| Every icon-only control labelled | Pass — `aria-label` on delete and close |
