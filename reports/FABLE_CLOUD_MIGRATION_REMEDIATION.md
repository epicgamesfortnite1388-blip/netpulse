# FABLE — Cloud Migration Remediation (FABLE-INFRA-001 / FABLE-INFRA-002)

## 1. Facts established (read-only, 2026-11-16)

- Files: `cloud/worker/migrations/0005_reset_atomic.sql` (password-reset atomicity + delivery state) and `0005_vpn_credentials.sql` (per-user VPN identities for the reconciler).
- Semantics: **filename collision, not a schema conflict.** D1 tracks applied migrations by filename; the two files are distinct entries and apply in listed order.
- Local dev DB (`wrangler d1 migrations list`, local): 0001–0004 applied; **both 0005s pending**.
- Remote production DB: **status UNKNOWN** — the read-only `--remote` check failed with D1 error 7500: *free-tier daily row read limit exceeded*.
- Docs ambiguity: `cloud/worker/README.md:128` says "Migration `0005` adds `vpn_credentials`" — true for one of the two 0005 files; the doc doesn't disambiguate.

## 2. The quota problem (INFRA-002) interacts with INFRA-001

The remote journal read is blocked by quota until UTC midnight. The quota exhaustion itself is a finding: something consumed the free-tier daily read budget. Candidates (to verify with logs/observability once quota resets):
- wrangler/ops polling, session validation frequency, entitlement sync cadence, telegram link checks, or an external consumer hammering the Worker.
- Impact: late-in-day failures of ALL cloud-authenticated features (sessions/entitlements/telegram) for the account.

Remediation direction: **read reduction first** (per the minimize-paid-services constraint):
1. Quantify reads per route (D1 metrics in the CF dashboard — read-only, by the user).
2. Apply session-caching (the Worker already holds session state in D1 — add a KV/cookie-cached session check or short-TTL in-memory cache per isolate) — only after measuring.
3. Only if measurement shows legitimate sustained volume: discuss upgrade with the user (decision is theirs).

## 3. Migration renumber decision tree (execute only when quota permits the remote read)

```
Read remote journal: wrangler d1 migrations list netpulse-cloud --remote
├─ Case R1: NEITHER 0005 applied remotely
│   → Safe to renumber 0005_vpn_credentials.sql → 0006_vpn_credentials.sql
│     (git mv; update README reference; local list re-verified)
├─ Case R2: 0005_vpn_credentials.sql APPLIED remotely (and reset_atomic not)
│   → Do NOT renumber an applied migration. Instead: leave filenames as-is,
│     document the ordering convention in README + a migrations/README,
│     and adopt zero-padded unique numbering going forward (0006, 0007...).
├─ Case R3: BOTH applied remotely
│   → Same as R2 (rename would cause a re-apply attempt of the renamed file —
│     harmless for reset_atomic's IF NOT EXISTS DDL? NO — do not rely on that;
│     renaming applied migrations is forbidden per §14 constraints).
└─ Case R4: reset_atomic applied, vpn_credentials not
    → Renumber vpn_credentials → 0006 is SAFE (it was never applied under
      its old name; re-apply under the new name is the intended fresh apply).
```

## 4. Corrective-migration rules (if any DDL gap is found)

- Never edit an applied migration file. New file `000N_*.sql` with forward-only DDL.
- Local repro first: `wrangler d1 execute netpulse-cloud --local --file=...` against a copy.
- Remote apply only by the user, after review, and NOT during this phase (constraint).

## 5. Acceptance criteria

1. Remote journal status recorded (whichever case applies).
2. The decision tree's chosen branch executed (or deliberately deferred with reason).
3. Local `migrations list` clean afterwards; `check-health.sh`-style smoke passes in local dev.
4. README migration section corrected (one authoritative sentence: which file does what, and the numbering convention).
5. INFRA-002: read-quantification note added to the findings registry (evidence-based), with a read-reduction proposal for a future approved ticket.

## 6. Explicit non-goals

No production DB changes, no deploy, no quota workaround via paid upgrade without user decision, no remote queries beyond the read-only journal listing.
