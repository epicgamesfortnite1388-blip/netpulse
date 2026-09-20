# v1.0.1

*Everything since v1.0.0 — one defect fix, shipped through the first real
cross-version update drive of the fixed updater chain.*

## Fixes

- **Force-kill cleanup guard** — a force-killed app could leave the system
  proxy pointing at a dead local port with no process left to undo it,
  breaking every proxy-honoring app on the machine. Boot recovery now
  restores any stale loopback handoff the persisted hold record covers,
  never touches a proxy owned by another tool, and skips the write when a
  clean shutdown already restored the value. Verified live against the
  real registry: a dead `127.0.0.1:<port>` handoff plus the real persisted
  record produced a restored registry and a consumed record on the next
  boot. (6 new regression tests; full API suite at 782.)

## Honest limitations (unchanged from v1.0.0)

- The installers are **self-signed**: Windows SmartScreen shows the publisher
  as unverified until a trusted code-signing certificate is provisioned.
- The guard runs at next boot — a force-kill leaves the broken proxy until
  the app starts again; the normal quit path restores the handoff
  immediately.
