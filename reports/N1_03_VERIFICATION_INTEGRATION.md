# N1_03 — Verification Integration

**Phase:** N1.1 · **Commit:** `200de54`

## What changed in `run_verify_stage`

**Before:** re-probed `registry.ids()[0]` (the first registered API,
regardless of what failed), judged `verified` from the probe's OVERALL health,
recorded an observation with layer `"verify"` and an ok-flag derived from
health. The verification was not targeted at the diagnostic claim.

**After:**

1. **Targeting:** `verify_layer_for(top)` maps the leading hypothesis to the
   layer whose re-measurement can confirm or refute it:
   - dns / dns_inconsistency → `dns`
   - tls → `tls`
   - tcp, ipv4, ipv6, routing, mtu, congestion_or_packet_loss, quic_udp_failure → `tcp`
   - gateway, upstream_proxy, remote_endpoint, auth_failure, rate_limit,
     application_failure, server_failure, network_interference_or_filtering,
     unknown → `http` (only the full HTTP exchange can exercise these)
2. **Correct API identity:** the API probed is the first one whose
   observations actually FAILED the implicated layer (falling back to the
   first observed API) — verification measures where the fault was seen.
3. **Real outcome, honest semantics:** `verified` = the implicated layer's
   re-measured result is `Ok`. **Missing (never exercised) is NOT success.**
   A failed verification stays failed. The recorded observation now carries
   the implicated layer's REAL result kind ("ok"/"failed"/"unknown") and
   detail, so a Missing verification is never recorded as a pass.
4. **Engine contract:** the verification measurement enters the authoritative
   engine via `diagnostic_probes` filtered to the mapped test, timestamped in
   seconds — the same `observe` contract as observe-stage evidence. The
   repeat is correlation-discounted by the engine itself, so **a verification
   rerun cannot amplify evidence** or double-count.
5. **Final verdict:** recomputed from the updated posterior after
   verification. If the refutation drops the leader below the 0.25 floor, the
   investigation honestly concludes "Insufficient evidence to reach a
   conclusion." — the pre-verification snapshot never overrides the truth.

## Established rules preserved (mission §4)

- Verified-only learning untouched (`LearningEngine` feed unchanged; no
  online self-training introduced).
- Six-outcome model untouched; verification uses the same honest mapping.
- Event schemas unchanged (`VerificationCompleted { route_id, verified }`,
  `EvidenceAdded` with kind "verify" — same shapes as before N1.1).
- Missing verification never becomes success (test-asserted).
- No LLM in any path; no automatic prior adjustment.

## Test evidence

- `n1_bayesian_engine_drives_the_real_analysis`: the oracle reconstructs the
  verification measurement from the recorded verify observation and asserts
  the final reported verdict equals the reference engine's post-verify
  posterior exactly.
- `n0_end_to_end_…` failing leg still passes: failure evidence → verify runs,
  `VerificationCompleted` + `EvidenceAdded{kind:"verify"}` present; healthy
  leg still honestly skips verify.
