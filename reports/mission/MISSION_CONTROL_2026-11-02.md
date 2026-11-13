# Mission Control — verified cycle report

**Mission:** `NETPULSE_MISSION_CONTROL`
**Date:** 2026-11-02 · **Workspace:** `E:\Code\Project\Vpn_app`
**Scope of this cycle:** establish current truth from the existing reports, fix the two
outstanding test failures that were carried forward as "pre-existing", and ship a
Mission Control surface whose every row is classified by the strength of its evidence.

Nothing in this report is inferred from a 200, a build, or a prior claim. Each PASS
names the command and the number it produced.

---

## 1. Baseline, re-established rather than assumed

The prior four cycles left reports (`reports/mission/`, `reports/adaptive/`,
`reports/infra/`, `reports/engines/`) and a journal. They were read first, and treated
as claims to re-test, not facts to repeat.

| Claim from the existing corpus | Re-tested this cycle | Result |
| --- | --- | --- |
| "1098 passed / 2 failed — `adaptive.ts` hand-written error bodies, `AdaptiveRecoveryCard` fetch path" | full API suite before changes | **Reproduced exactly**: `routeWiring` (1 failed) + `httpSemantics` (1 failed) |
| Worker / host / payment state | not re-queried | **NOT TESTED this cycle** — depends on SSH to the VPN host (`206.1.96.89`) that the journal records as lost, and on D1/owner action |
| Adaptive learning is local and bounded | read `adaptiveEngine.status()` path + tests | Consistent with the journal; 24 engine tests pass |

---

## 2. The two carried-forward failures were real defects, and are fixed

**2.1 Frontend route path that no route could match** — `apps/web/src/features/vpn/AdaptiveRecoveryCard.tsx`

```ts
api.get(`/adaptive/status${nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : ''}`)
```

`routeWiring.test.ts` strips the query and then normalizes `${…}` → `:param`. A ternary
inside the template closes at the first `}`, so the gate saw the pseudo-path
`/adaptive/status${nodeId ? ` and could not distinguish "this request is wrong" from
"this route is missing". Fixed by making each branch a literal path
(`/adaptive/status?nodeId=…` and `/adaptive/status`). The gate now passes **and** the
gate can see this file again.

**2.2 Two error bodies outside the single envelope** — `apps/api/src/routes/adaptive.ts`

```ts
reply.status(400).send({ error: 'invalid_request', message: 'nodeId is required' })
reply.status(404).send({ error: 'not_found',      message: 'no such node' })
```

The client reads only `{ error: { code, message } }` (`lib/api.ts: parseErrorBody`), so
both messages were silently dropped and the UI rendered the HTTP status text instead.
Routed through `replyApiError()` — the owner of the envelope
(`apps/api/src/util/apiError.ts`). `httpSemantics.test.ts` is the guard that caught
this, and it is green.

---

## 3. Mission Control — what was built

### 3.1 Backend: one read-only snapshot

`apps/api/src/services/missionControl.ts` + `apps/api/src/routes/mission.ts`
→ `GET /api/v1/mission/status`

The design rule is the mission's own: **a status is a claim, and every claim needs a
class.** There is deliberately no `ok` / `healthy` field.

| Class | Meaning |
| --- | --- |
| `verified` | a measurement this process performed |
| `observed` | real state read from config/rows — not a test |
| `not_tested` | no test evidence exists in this process |
| `unavailable` | the capability is absent here |
| `blocked` | an external dependency or permission is missing |

Rows: adaptive selection · VPN tunnel · engine availability · WhiteDNS ·
subscription entitlements · host provisioning/revocation · payments. Each row carries
`headline` (the raw fact), `detail` (what it does *not* prove) and `source` (the service
it came from).

The overall state is the **weakest** class present, not an average — a `blocked`
payments row cannot hide behind four verified ones. Composition is per-section
`try/catch`: one unreadable service degrades that row and nothing else. No section
writes, dials, scans or provisions.

### 3.2 Frontend: `/mission`

`apps/web/src/features/mission/MissionControlPage.tsx`, lazy route in
`app/router.tsx`, nav entry under **Overview**.

- Ledger of subsystems, each with a class badge, the raw fact, the source and an age.
- Adaptive panel: context, approved vs refused strategies, learned rows with sample
  counts and confidence, policy version and trust anchor — plus the standing statement
  that no failure is labelled censorship.
- Live activity: the app's own event log, filterable by severity and category.
- "What this page does not prove": the limits rendered next to the numbers, not in a
  footnote.
- One button — "Re-read now" — wired to the real refetch. No inert controls, and no
  second control path around the VPN/provisioning guards.

Untested renders **faint/neutral**, never green: absence of evidence is not a pass.

---

## 4. Checks actually run (this cycle)

| Command | Result |
| --- | --- |
| `npm test -w @netpulse/api` | **1113 passed / 103 files, 0 failed** |
| `npm test -w @netpulse/web` | **461 passed / 51 files, 0 failed** |
| `npx vitest run test/missionControl.test.ts test/routeWiring.test.ts test/httpSemantics.test.ts test/apiErrorEnvelope.test.ts test/adaptiveConnect.test.ts test/adaptiveEngine.test.ts` | **55 passed / 6 files** |
| `npm run typecheck -w @netpulse/api` | clean |
| `npm run typecheck -w @netpulse/web` | clean |
| `npx eslint` on all seven touched/new files | clean (0 findings) |
| `npm run build -w @netpulse/web` | pass, 7.36 s, `MissionControlPage` emitted as its own chunk |

New regression tests (`apps/api/test/missionControl.test.ts`, 6):

1. the ledger is classified and every row names a non-empty source;
2. a fresh process reports `not_tested` for engines and VPN — the one wrong answer
   here would be "no engine installed" or "disconnected" presented as knowledge;
3. payments is `blocked` (not part of this application's surface);
4. the overall state equals the weakest class present, and counts sum to the rows;
5. the snapshot carries no daemon token;
6. adaptive state is reported with zero invented observations, and activity rows are
   real event records.

---

## 5. What this cycle did **not** establish

Stated plainly, because the mission's acceptance rule is evidence, not intent:

| Item | Status | Why |
| --- | --- | --- |
| A new live tunnel (connect → traffic → egress) | **NOT TESTED this cycle** | not attempted; no core/proof run was executed. The prior cycles' live results are cited in `reports/engines/03_…` and `reports/mission/…` and were **not** re-verified here |
| Iranian-ISP field measurement | **BLOCKED** | requires a vantage point on an Iranian access network; the last one was recorded in `reports/adaptive/ADAPTIVE_EVIDENCE_2026-10-26.md` |
| Host reconciliation / revocation on `206.1.96.89` | **BLOCKED** | the journal records lost SSH credentials from this workstation; repository-side verifiers exist but were not run against the host |
| WHITEDNS data-plane test | **NOT TESTED** | config presence is reported (`observed`); no authoritative-DNS or tunnel-data test was run |
| Payment / Stars checkout | **BLOCKED** | owner-gated (merchant eligibility, Stars availability, payout) and `XTR_ENABLED` unset by decision |
| 30-source research sweep | **NOT DONE this cycle** | the existing corpus (`reports/research/DPI_CENSORSHIP_RESEARCH_2026-10-24.md`, `docs/research/dpi/`) was not extended |
| Desktop packaged build / webview check | **NOT RUN** | `tauri build` and the CDP audits were not executed; only the web bundle was built |

---

## 6. Acceptance matrix

| # | Objective | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | Inventory the accessible project and infrastructure | **PASS** | repo tree, `reports/**`, `docs/**` read; host/D1 state explicitly not re-queried |
| 2 | Inspect existing research and evidence | **PASS** | `reports/mission/MISSION_JOURNAL.md`, `FULL_STACK_ACCEPTANCE_2026-10-27.md`, `reports/adaptive/ADAPTIVE_EVIDENCE_2026-10-26.md` |
| 3 | Fix defects that block the verification gates | **PASS** | §2 — both, with the guards green |
| 4 | Mission Control with real telemetry | **PASS (local)** | §3 + §4; every value derives from a live service call |
| 5 | Accessibility / no fake progress | **PASS by construction** | no timers or synthetic values; classes are neutral/faint when untested; `page-enter` animation is honouring the app's existing reduced-motion CSS |
| 6 | Adaptive AI present and explainable | **PASS (existing, re-tested)** | `adaptiveEngine` 24 tests; snapshot surfaces learned rows, confidence, refusals |
| 7 | New live connection proof | **NOT TESTED** | §5 |
| 8 | WHITEDNS end-to-end | **BLOCKED / NOT TESTED** | `no_per_user_identity` from prior cycles; no test run here |
| 9 | Payments | **BLOCKED** | owner-gated; no surface in this app |
| 10 | Production deployment of this change | **NOT PERFORMED** | no deploy was requested or attempted; desktop/shared bundle only compiled |

---

## 7. Next actions, ranked

1. **Run the live proof on this machine** (`npm run proof:vpn` with an `xray.exe` core) and
   let Mission Control report `verified` for the tunnel row from a real egress check.
2. **Restore host access**, then re-run `scripts/verify-vps-reconciler-failure.py --apply`
   and `verify-vps-reconciler-removal.py` on `206.1.96.89`; the host rows should stop
   saying `not_tested`.
3. **WHITEDNS**: give the service a per-user identity or keep issuance withheld; only a
   `soar-check` run can move that row off `observed`.
4. **Field vantage**: a voluntary Iranian-ISP measurement is the only way to move the
   adaptive claim from "local parity" to "works on the target network".
5. **Packaged build**: `npm run desktop:package` and the CDP/webview audit, since the
   bundle changed (`/mission` is a new lazy chunk).

---

## 8. Rollback

The change is additive plus two small route fixes. Revert with:

```bash
git checkout -- apps/api/src/routes/adaptive.ts apps/web/src/features/vpn/AdaptiveRecoveryCard.tsx \
  apps/api/src/app.ts apps/web/src/app/router.tsx apps/web/src/app/AppShell.tsx
rm -rf apps/api/src/services/missionControl.ts apps/api/src/routes/mission.ts \
  apps/api/test/missionControl.test.ts apps/web/src/features/mission
```

No database migration, no schema change, no configuration change, no deployment.
