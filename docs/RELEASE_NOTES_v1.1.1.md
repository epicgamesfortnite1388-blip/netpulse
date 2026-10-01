# NetPulse 1.1.1

## Update history

The updater now keeps a diary. Settings → Platform → **Update history** records every
feed check and every install attempt — including the real failure reason — newest
first, so "why is this app out of date?" finally has an answer on the machine itself.

- **Update history card** — checks, downloads and installs with the actual error text
  the updater produced; a failed check never reads as success.
- **Clear history** — wipe the diary from the card header (asks to confirm first).
  Only update-feed history is removed; other event logs are untouched.
- **Dashboard warning** — if the last update check failed, the dashboard says so in
  one line with the real reason and links straight to the history card. A newer
  successful check clears it.

## Cloud

- Encrypted profile backup and restore hardening (smoke-tested account system
  changes ship in this line).
