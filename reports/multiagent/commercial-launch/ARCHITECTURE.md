# Architecture

## Components

- NetPulse desktop (Tauri/React/Rust) — `apps/`
- Cloudflare Worker + D1 — `cloud/worker/`
- Abystral Telegram bot — `E:\Code\Project\Abystral`
- VPS (206.1.96.89) — Xray/WireGuard/microsocks (claimed, unverified)
- WhiteDNS — identity unconfirmed

## Data flow

Customer → App/Bot → Worker API → D1 (authoritative) → provisioning adapter → VPS Xray → client config → tunnel → HTTPS.

Payment: app/bot → provider → webhook → Worker → D1 state machine → provisioning (only after verified payment/admin approval).
