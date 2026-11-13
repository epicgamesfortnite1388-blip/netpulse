# NetPulse — Accounting & Subscription Lifecycle
**Date:** 2026-10-24  
**Scope:** internal mirrors vs externally owned billing/payment surfaces.

## Internal
- Subscription entitlements are MIRRORED from the Abystral bot via signed event inbox (`cloud/worker/src/netpulse-integration.ts`).
- Lifecycle coverage in code/tests: `subscription.activated`, `.renewed`, `.extended`, `.paused`, `.resumed`, `.expired`, `.revoked`, `.refunded`, `.updated`, `.config_regenerated`, `link.revoked`.
- Plan defaults live in `plans` and are used by `/api/v1/provision` to generate client configs.

## External (not in this repo)
- Real-money payments, invoices, receipts, tax/VAT, and payment-method storage are owned by the Abystral/Telegram commerce stack.
- This repo intentionally has no card/payment processing code.

## Open verification item
- Live payment/signature proof requires the external bot/test environment; no local reproduction is possible without credentials.
