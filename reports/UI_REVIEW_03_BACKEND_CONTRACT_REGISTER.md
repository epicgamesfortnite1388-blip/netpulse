# UI_REVIEW_03 — Backend Contract Register (frontend-facing)

**Read-only.** Contracts read from `apps/api/src/routes/*` + `packages/shared/src/**`. Responses are **plain TS interfaces; none is runtime-validated (no zod) on the frontend** unless noted. Request bodies are zod-validated in most routes (exceptions flagged). The UI Expert must treat these as authoritative and must not change their shapes.

---

## VPN (`routes/vpn.ts`, `routes/tunnel.ts`; types `packages/shared/src/models/vpn.ts`)
| Method · Path | Request | Response | Defined | zod req |
|---|---|---|---|---|
| GET `/vpn/status` | — | `VpnStatus{connected, providerId, verification, verificationNote, verifiedPublicIp, ...}` | `models/vpn.ts` | n/a |
| GET `/vpn/health` | — | `{connected, providerId?, rxBytes, txBytes, handshakeAgeSec, endpointLatencyMs, note?}` | inline route | n/a |
| POST `/vpn/connect` | `{profileId, elevation?:{opId}}` | `{status, outcome?}` | `ConnectSchema` | **yes** |
| POST `/vpn/reconnect` | `{profileId}` | `{status}` | `ConnectSchema` | **yes** |
| POST `/vpn/disconnect` | — | `{status}` | inline | n/a |
| POST `/vpn/verify` | — | `{connected, providerId, currentPublicIp, ipAtConnect, trafficStillViaTunnel, note}` | inline | n/a |
| GET `/vpn/profiles` · POST · DELETE `/:id` | import schema | `{profiles[]}` / `{profile}` | `ImportSchema` | **yes** |
| POST `/vpn/profiles/from-node` | `{nodeId, providerId:'singbox', name?}` | `{profile, node}` | `FromNodeSchema` | **yes** |
| GET `/vpn/tunnel/status` | — | `{tunnel: ProxyTunnelStatus}` | `models/vpnTunnel.ts` | n/a |
| POST `/vpn/tunnel/start|stop|reconnect|quick` | `TunnelStartSchema` | `{tunnel, quick?}` | `routes/tunnel.ts` | **yes** |
| POST `/vpn/discover` | profile payload | `{report: DiscoveryReport}` | `tunnel.ts` | yes |
| POST `/vpn/smart-connect` · `/train` | body schema | `SmartPlan` / `TrainResult` | `SmartConnectBodySchema` | **yes** |
| GET `/vpn/selftest` · POST `/run` | — | `{last, running, schedule, safeMode}` | `routes/health.ts` | n/a |
| GET `/vpn/killswitch` · `/vpn/history` · `/vpn/connections?limit` | — | state / rows | `models/vpn.ts` | n/a |

**Critical invariant:** `VpnStatus.verification ∈ {not_verified, verified, failed, unavailable, skipped}` and `verifiedPublicIp` must be honoured by any redesign. Today `status()` hardcodes `not_verified` after connect (see UI_REVIEW_04 F1).

## Nodes / servers / sources (`routes/nodes.ts`, `servers.ts`, `sources.ts`, `scanner.ts`)
| Method · Path | Request | Response | zod req |
|---|---|---|---|
| GET `/nodes` | 16 query params (limit/offset/protocol/country/asn/status/transport/security/freshness/favorite/search/minScore/maxLatency/minReliability/engine/sortField/sortDir) | `{nodes, total, limit, offset}` | **no** (manual `Number()` coercion) |
| GET `/nodes/:id` · `/nodes/:id/history|health` · `/nodes/stats` | param | node / rows / summary | param schema |
| POST `/nodes/:id/test` · `/nodes/test-batch` | body schemas | result / results | **yes** |
| POST `/nodes/:id/favorite|tags|geo-recheck` | body | ok | **yes** |
| POST `/nodes/import` · GET `/nodes/export` | payload | `{imported, duplicates, invalid}` | yes |
| GET `/nodes/engines` · `/nodes/engines/releases` · POST `/nodes/engines/install` | `EngineInstallRequestSchema` | status / releases / `EngineInstallResult` | **yes** |
| GET/POST/PATCH/DELETE `/sources*` · POST `/scanner/*` · GET/POST/DELETE `/test-endpoints` | schemas | source/job/endpoint | **yes** |
| GET `/servers`, `/servers/:id`, `/servers/:id/health`; POST/PATCH/DELETE `/servers`; POST `/servers/:id/check`, `/servers/recommend`; GET `/servers/recommendations`; `/health-monitor/*` | schemas | `ServerRecord` | yes (most) |

## NANI (`routes/nani.ts`; desktop Tauri `nani_*`)
| Method · Path | Request | Response | zod req |
|---|---|---|---|
| GET `/nani/status` · `/nani/apis` · `/nani/health/shadow` | — | status / apis / shadow | n/a |
| POST `/nani/check` · `/nani/diagnose` | body schema | check / `{insufficientEvidence, explanation, top, confidence, recommendedTest}` | **yes** |
| POST `/nani/recovery/plan|step|rollback|reset`; GET `/nani/recovery/next` | body schema | plan/step/rollback/reset/next | **yes** |
| Tauri `nani_status`, `nani_poll_events{since}`, `nani_explain{question}`, `nani_learning_status`, `nani_learning_drift`, `nani_health_check_all`, `nani_start_investigation{query}`, `nani_cancel_investigation{investigation_id}`, `nani_investigation_status{id}`, `nani_investigations`, `nani_math_hypothesis_view`, `nani_personalization_status`, `nani_learning_reset` | — | DTOs cast client-side | **no** (cast only) |

## Diagnostics / tests
| Method · Path | Request | Response | zod req |
|---|---|---|---|
| POST `/diagnostics/complete|mtu|cgnat|bufferbloat` | schemas (mtu **not** validated) | `{testId}` / result | mixed |
| POST `/ping-test` · `/speed/run` · `/dns/test|leak-test` · `/gaming/*` · `/optimizer/run` · `/iran/*` · `/webrtc-report` · `/whitedns/tunnel-test` · `/cloudflare/scan` · `/route-test|route-compare` | body schemas | `{testId}` / results | mostly **yes** (`ping-test` **no**) |

## Account / subscription (cloud via sidecar `POST /cloud/egress`)
Worker endpoints: `POST /account/telegram/link`, `/link/confirm`, `GET /account/telegram`, `POST /account/telegram/unlink`, `POST /integrations/telegram/status|sync`, `GET /subscriptions`, provisioning. `NetpulseSubscription = {id, plan, status, started_at, expiration_time, auto_renew, total_gb, used_gb, ip_limit, config_updated_at}` (`lib/cloud/client.ts`). **Frontend types only; no zod.** Entitlement enforced server-side (see UI_REVIEW_06 F8).

## Settings / events / system
| Interface | Contract | zod |
|---|---|---|
| GET `/settings` · PUT `/settings` | `SettingsPatchSchema` | **yes** |
| GET `/settings/schedule` · POST `/schedule/run` | schema | yes |
| GET `/events?level&category&limit(1..500)&before` | `{events: EventRow[]}` | query yes, response no |
| POST `/ws/ticket` → `{ticket, expiresInMs}`; GET `/ws?ticket=` (single-use) | client frames `{type:'subscribe'|'unsubscribe', testId}`; server frames `{type, testId?, pct?, result?, error?, ...}` | hand-checked, **not zod** |
| GET `/meta` · `/meta/capabilities` · `/meta/health` · POST `/meta/reset-state` | `{status:'ok'|'degraded', checks: HealthCheck[], ...}` | response no; client ad-hoc shape guard |
| NANI desktop event `{seq, event:{kind, payload}}`; web bus `{seq, at, type, payload, version}` | `fromTauriEvent`/`fromBusEvent` manual `typeof` | **not zod** |

## Contract rules for the UI Expert
1. Do not rename or reshape any request/response field above.
2. Do not move logic that currently lives server-side (verification, entitlement, engine lifecycle) into the frontend.
3. `POST /vpn/status` verification fields must be surfaced honestly, not collapsed.
4. If adding runtime validation, use the shared zod schemas already exported (`schemas/engines.ts`, `schemas/settings.ts`, `schemas/vpnTunnel.ts`); do not invent new signatures.
