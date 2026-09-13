# Deployment

NetPulse is designed to run **on the machine whose network you are diagnosing** — a
desktop/laptop agent or a small VPS you own. It is not a multi-tenant SaaS.

## Single-process production mode

```bash
npm run build       # builds apps/api and apps/web
npm start -w @netpulse/api
```

The API serves the built web bundle from `apps/web/dist`, so one process on one port
serves both UI and API.

## Environment

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port |
| `HOST` | `127.0.0.1` | **Keep loopback unless you understand the exposure** |
| `DATA_DIR` | `./.data` | SQLite DB, daemon token, VPN vault, VPN configs |
| `DEMO_DATA` | `false` | Seed demo content (badged in UI; not real measurements) |
| `LOG_LEVEL` | `info` | pino level |
| `CORS_ORIGINS` | Vite dev origins | Only relevant for separate-frontend setups |
| `SESSION_TTL_HOURS` | `168` | Session lifetime |

## Running as a service

- **Windows**: `schtasks` / NSSM / a scheduled task running `npm start -w @netpulse/api`
  in the repo directory, as the **logged-in user** (not SYSTEM) so per-user networking
  context matches.
- **Linux/macOS**: a user-level systemd unit (`WantedBy=default.target`) or launchd agent.
  Run as an unprivileged user; NetPulse does not need root.

## Exposure guidance

- Default loopback binding is the intended mode: reach it via `localhost:8787`.
- If you bind a non-loopback `HOST`, put TLS in front (reverse proxy) and restrict
  access (firewall/VPN). All data routes require auth, but active-probe endpoints are
  powerful by design — treat the API like a diagnostic console, not a public website.
- Back up `DATA_DIR` to preserve history and VPN profiles; the vault key file must be
  backed up together with vault data or secrets become unrecoverable.

## Upgrading

1. `git pull && npm install`
2. `npm run build`
3. Restart the service — Drizzle migrations apply at startup.
