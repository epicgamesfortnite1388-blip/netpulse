# v1.0.2

*Everything since v1.0.1 — the same force-kill discipline extended to TUN mode,
where a killed app could strand the machine's default route.*

## Fixes

- **TUN route-claim recovery** — the TUN gateway is an elevated process that
  owns the default route through its wintun device. A force-killed app left it
  running unmanaged, holding that route with nothing to release it. The gateway
  now writes a crash record into its own config dir **before** the spawn (the
  device exists the moment the process starts, so a kill during the readiness
  wait must already be recorded), and boot recovery stops the orphan — which is
  what returns the route. Identification is by the config path in the process
  command line, never by a recorded pid: pids recycle and a kill during the
  readiness wait happens before the pid is known.
- **Nothing is killed without proof.** A live owner (this or another session)
  is left untouched; a running gateway whose command line cannot be read (an
  elevated process seen from a non-elevated relaunch) and a refused kill are
  reported as real degraded states — with the recovery event saying a stale
  default route may still be held and that an administrator relaunch releases
  it — instead of a silent log line. If the process listing itself fails,
  nothing is removed or killed.
- **Legacy leftovers** — dirs leaked before crash records existed are now
  matched to their still-running gateway by config path, so those orphans are
  reaped too, instead of being deleted as harmless litter while the route
  stayed claimed.
- The boot sweep reports what it did: a log line with the recovery counts and a
  user-visible event (`… N orphaned TUN gateway(s) stopped and their default
  route released.`).

Verified live on this machine: real leaked config dirs with real `sing-box`
processes — a pre-spawn claim with a dead owner and a claim-less legacy dir were
both reaped (process stopped, dir removed), a dir owned by a live process was
left untouched, an empty dir was cleaned; then the real app boot against a
scratch data dir logged `{"reaped":1,…}` and recorded the recovery event.
(9 new regression tests; full API suite at 791.)

## Honest limitations

- The `refused` path — a genuinely elevated orphan seen from a non-elevated
  relaunch — is covered by unit tests, not observed end to end: producing it
  needs an elevated TUN gateway plus a non-elevated restart, i.e. the user at
  the machine. The elevated relaunch is expected to reap it (its command-line
  read succeeds), but that has not been demonstrated.
- The recovery runs at **next app start**; a force-kill leaves the route held
  until then. The normal stop path releases it immediately.
- The installers are still **self-signed**: Windows SmartScreen shows the
  publisher as unverified until a trusted code-signing certificate is
  provisioned (`docs/AZURE_SIGNING_SETUP.md`).
