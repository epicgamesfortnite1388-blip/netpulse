# Capabilities

NetPulse desktop deliberately grants the webview a **minimal** capability set:

| Permission | Why |
|---|---|
| `core:default` | events/invocation plumbing |
| `core:window:*` (show/hide/focus) | tray minimize-restore behavior |
| `dialog:open/save/message/ask` | native import/export file dialogs |

Not granted, on purpose:

- **No `shell:*`** — the frontend can never execute processes.
- **No `fs:*`** — no arbitrary disk access from the webview; native dialogs only.
- **No `http:*`** — network access goes through the loopback sidecar with the
  ephemeral token, not from the webview directly to the internet.

Custom commands exposed to the webview (see `src/main.rs`):

| Command | Returns |
|---|---|
| `bootstrap` | sidecar `api_base`, `ws_base`, ephemeral `token`, app version/OS/arch |
| `data_paths` | native data + log directories |
| `reveal_path` | open a folder in the OS file manager (absolute paths only) |
