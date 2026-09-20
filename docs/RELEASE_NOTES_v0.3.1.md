# v0.3.1

The first release shipped through the app's own local update feed.

## Update system
- In-app update surface: launch banner, release notes, install-and-restart
- Settings → Platform "Check for updates" button
- Signed artifacts (minisign) verified against the key baked into the app before any update runs
- Local feed: the sidecar serves `latest.json` and the signed artifact on loopback, so updates work with no GitHub release published

## What this update proves
Installing this version from 0.3.0 exercises the complete chain: poll → manifest fetch → signature verify → download → extract → installer → restart on the new version.
