# 02 — Feature Completeness Matrix

Status values: Complete / Partial / Broken / Stubbed / Dead / Unverified. "A rendered button is not proof of a working feature" — each row records the traced implementation, not the label.

| Feature | UI entry | Frontend logic | Backend / boundary | Integration | Tests | Real behavior | Status |
|---|---|---|---|---|---|---|---|
| Elevated WireGuard connect | `features/vpn/ProviderSurface.tsx:88` | `lib/elevationBroker.ts` opId+nonce | `routes/vpn.ts:695`, `elevationBroker.ts`, `elevation.rs` | UAC → wireguard.exe allow-list | Rust 12/0, API 12/0 (cycle 2) | Was **Broken** (nonce discarded); repaired end-to-end this cycle | Complete (repaired) |
| Direct vs VPN route compare | `NodeDetailPage.tsx:447` | `RoutesPage.tsx:162-190` | `routes/routes.ts:71-98` `?nodeId=` | stored node resolved server-side | API `nodeEndpointLeak.test.ts` | Was sending default target; now honors nodeId | Complete (repaired) |
| Reset App State (health check action) | `SystemHealthPage.tsx:353` | navigate to settings | `routes/health.ts:70,75` emits `repair-reset-state`; real implementation `SettingsPage.tsx:676-697` | Rust `reset_app_state` | code-path verified, typecheck PASS | Was green toast with no effect; now routes to confirmed control | Complete (repaired) |
| Telegram subscription display | `TelegramIntegrationCard.tsx` | 3-branch render | cloud worker | cloud API | web typecheck PASS | Failure now distinguishable from empty | Complete |
| Connection truth (exit-IP/relay/public-IP proofs) | VPN surfaces | state + watchdog | `vpn/vpnService.ts verifyConnect`, `aetherProvider.ts` | real probes | API VPN suites | Honest before/after diff; no simulated success | Complete |
| Entitlement enforcement | account UI | client never writes entitlement | `cloud/worker/src/index.ts:717-746`, `vpn-users.ts:186-219` | server gate fail-closed | accounting suite | Genuinely server-enforced; no client grant | Complete |
| NANI investigation | `features/nani/*` | `useNaniEvents.ts:56-113` (cleanup verified) | `network_intelligence/investigation.rs` + ~30 modules | IPC + HTTP /nani/* | Rust 558 pass; math audits | Deterministic Bayesian engine authoritative; see 06 | Complete with documented gaps |
| Update check / install | `UpdateBanner.tsx` | `updater.ts:205,266` | `updater_feed.rs:145-150` minisign | local loopback feed | test:feed, test:signing | Signature verified before install; feed gate now mandatory in release | Complete |
| Diagnostics export | `SystemHealthPage.tsx` | `tauriInvoke('save_diagnostic_report')` | `diagnostics.rs:90-136` redaction | OS file dialog | Rust tests | Report path returned but success toast discards it (DD-024) | Partial |
| Speed test | `SpeedTestPage.tsx` | `useBackgroundTest` | `routes/speed.ts`, `speedService.ts` | network probes | API speed suites | Result carries tunnel-state annotation, but runs non-cancellable + history stale (DD-021/037) | Partial |
| Progressive disclosure | `ui/DetailLevel.tsx` shared control | 26/26 routed pages render control | n/a | n/a | route-level invariant test 29/29 | EventsPage control inert (DD-035); warnings gated too deep on AccountPage | Partial |
| Settings advanced switches | `SettingsPage.tsx:424-445` | explicitly disabled + labelled | none | n/a | typecheck | Honest "not wired" state, not a fake success | Stubbed (honest) |
| nani-reports / nani-memory | none (no route) | orphan files | n/a | n/a | none | Unreachable; one file missing `.ts` extension | Dead (preserved) |
| Noise-floor polling (health/map/connection) | background hooks | 3s / 10s / 1.5s loops | loopback API | n/a | perf audit | Real requests; no backoff when wedged (DD-026..030) | Complete but inefficient |

## Route completeness (frontend specialist, verified against `app/router.tsx`)

- **Complete (21):** `/`, `/map`, `/diagnostics`, `/dns`, `/gaming`, `/iran`, `/routes`, `/cloudflare`, `/nodes`, `/nodes-sources`, `/servers`, `/vpn`, `/optimizer`, `/history`, `/engines`, `/copilot`, `/nani`, `/settings`, `/mission`, `/overdrive`, `/speed-test`
- **Partial (3):** `/account` (expired warning gated at required=3; clipboard false-success), `/ip` (WebRTC cleanup leak), `/settings` (honest dead switches)
- **Broken (3):** `/nodes/:id` (repaired this cycle → Complete), `/health` (repaired → Complete), `/events` (inert detail control)
- **Stubbed/Dead (2):** nani-reports, nani-memory

## Verification gap

No real installer/e2e desktop run was possible in this environment; live tunnel traffic was not re-proved this cycle. Rows marked Complete rely on suite-level evidence plus code-path tracing, not a fresh live VPN connection.
