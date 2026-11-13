# Deployment Plan

**Status:** Baseline only — no deployment performed.

## Stages (per mission §15)

1. Baseline & protect existing service — PARTIAL
2. WhiteDNS/Xray design — NOT STARTED
3. Provision real VPN service — BLOCKED (VPS access)
4. Backend/D1 — NOT STARTED
5. Desktop app — NOT STARTED
6. Telegram bot — NOT STARTED
7. Integrated tests — NOT STARTED
8. Release decision — NO-GO

## Rollback principle

Every production change must have a documented rollback before application. No destructive DNS/zone-wide SSL changes without impact review.
