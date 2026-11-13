# Webview-navigation CI — run attempt, defect found, fix verified

**Date:** 2026-10-27
**Scope:** the `webview-navigation` job in [.github/workflows/ci.yml](../../.github/workflows/ci.yml) — the real-WebView2 run of `src-tauri/tests/navigation_webview.rs` ("the extended test").
**Request:** run that job on GitHub Actions and fix anything that makes the extended test fail there.

## 1. Status

| Item | Status | Note |
|---|---|---|
| Trigger the job on GitHub Actions | **BLOCKED** | This checkout has no git remote at all; no `gh`, no `act`. §2 |
| Reproduce the job's steps locally, in its conditions | **PASS** | §3 |
| Defect that stops the job on a clean checkout | **FOUND → FIXED** | Two gitignored bundle resources; `cargo build` exited 101. §4 |
| Extended test after the fix, clean-checkout emulation | **PASS** | build 22.38 s, test 1 passed in 7.51 s. §5 |
| Extended test after the fix, normal tree | **PASS** | forced rebuild, 1 passed. §5 |
| The job as a whole on a real runner | **NOT TESTED** | No runner was reachable. §7 |

## 2. Why the job could not be run on GitHub Actions

Measured in this checkout, not assumed:

```
$ git remote -v                 # (no lines)
$ cat .git/config               # [core] only — no [remote "origin"]
$ command -v gh act            # (nothing)
$ ls "/c/Program Files/GitHub CLI/gh.exe"   # No such file or directory
$ ls .github/workflows/         # ci.yml
$ env | grep -i '^GITHUB'       # FREEBUFF_GIT_DIR, HERMES_GIT_BASH_PATH only
```

There is no remote to push to and no CLI to dispatch a workflow with, so the job cannot be
triggered from here — and creating a public repository for this project is not a step to take on
someone else's behalf. What *is* fully doable locally is the part the request actually cares
about: make the job pass **on a clean checkout**, which is what an Actions runner gives it.

## 3. The job, reproduced step by step

The runner is `windows-latest`, so the local reproduction is Windows-native; the two differences
that matter (a clean checkout, and how the drivers are installed) are reproduced exactly.

| # | CI step | What was run here | Result | Evidence |
|---|---|---|---|---|
| 1 | `actions/checkout@v4` | this tree | — | — |
| 2 | `npm ci` | `npm ci --dry-run` (non-destructive: a real `npm ci` would delete `node_modules` under a dev server that is currently running) | **exit 0** — lockfile in sync with `package.json` | — |
| 3 | Build the web bundle | `npm run build -w @netpulse/web` | **exit 0** (`tsc --noEmit` + vite, 9.53 s) | — |
| 4 | *(step added by this fix)* Satisfy the build's resource paths | the step's own PowerShell, verbatim | dir + 0-byte file created | `nav-ci-04-build-passes-after-fix.log` |
| 5 | Build the desktop binary | `cargo build --manifest-path src-tauri/Cargo.toml` | before fix **exit 101**; after fix **exit 0** | `nav-ci-03-…`, `nav-ci-04-…` |
| 6 | Serve the app document | a dev server for `@netpulse/web` already listening on `localhost:5173` in exactly the job's shape (vite started with no arguments → default host, the command the job starts) | `http://localhost:5173/` → **200** | §6 |
| 7 | Install msedgedriver matching WebView2 | `cargo install --git https://github.com/chippers/msedgedriver-tool` + the tool, run from the repo root as the job does | installed `msedgedriver-tool.exe`; it read the installed runtime (**155.0.4283.62**), downloaded that exact driver, extracted `msedgedriver.exe` into the cwd | `nav-ci-06-msedgedriver-tool-install.log` |
| 8 | Install tauri-driver | already on PATH (`D:\cargo\bin\tauri-driver.exe`, the crate's 2.1.0 source in the local registry) | present | — |
| 9 | Navigation backstop (real WebView2) | `env -u MSEDGEDRIVER PATH="<repo root>:$PATH" NAV_WEBVIEW_APP=… cargo test --test navigation_webview -- --ignored --nocapture` | **1 passed** (6.84 s) | `nav-ci-02-test-pass-driver-from-PATH.log` |
| 10 | Stop the dev server | not applicable — the server in step 6 was already running and was not started by this work, so it was left alone | — | — |

Step 9 is deliberately run the way the job runs it: **`MSEDGEDRIVER` unset** and the driver found
through `PATH`, which is how the workflow installs it (`$PWD.Path >> $env:GITHUB_PATH`).
`tauri-driver` resolves it with `which::which("msedgedriver.exe")`
(`tauri-driver-2.1.0/src/webdriver.rs:16`), and the run passed with the repo root first on `PATH`.

## 4. The defect: the job could not compile on a clean checkout

`tauri.conf.json` declares two **bundle resources**:

```json
"resources": { "backend/": "backend/", "WebView2Loader.dll": "WebView2Loader.dll" }
```

and `.gitignore` keeps both out of the repository — `.gitignore:6` (`src-tauri/backend/`, "rebuilt
by `scripts/prepare-desktop.mjs` at package time; never commit generated artifacts (node.exe alone
is ~92 MB)") and `.gitignore:9` (`src-tauri/WebView2Loader.dll`). On this machine both exist; a
clean checkout has neither. `tauri-build` refuses a declared resource whose path is missing and
names them **one at a time**, so the failure is a two-step discovery:

```
resource path `backend` doesn't exist                     BUILD_EXIT=101
```

…and after creating only that directory:

```
resource path `WebView2Loader.dll` doesn't exist          BUILD_EXIT=101
```

Both measured by moving exactly those two paths aside (they are untracked, so the tree's git state
was unaffected) and forcing the build script to re-run. The job's `Build the desktop binary` step
would therefore have failed on the runner **before the test ever started** — and so would the
`gates` job's `cargo test`, which compiles the same crate.

Nothing else in the job depends on the missing payloads: the test drives the webview, and a **debug**
binary loads its document from the dev server rather than from the embedded bundle.

### Fix

One step per job, immediately before the first cargo command — [.github/workflows/ci.yml](../../.github/workflows/ci.yml):

```yaml
      - name: Satisfy the build's resource paths
        shell: pwsh
        run: |
          New-Item -ItemType Directory -Force -Path src-tauri/backend | Out-Null
          New-Item -ItemType File -Force -Path src-tauri/WebView2Loader.dll | Out-Null
```

with a comment in each job recording why (the resource list, the two measured error strings, and
that the placeholders are inert). `gates` gets the same step because it fails for the same reason;
the `webview-navigation` copy points back at that explanation.

Why placeholders are the honest fix rather than a workaround: the build script checks **existence
only**, a debug binary never bundles them, and WebView2 itself comes from the installed runtime
(the app logs `WebView2Loader.dll next to exe: false` and runs). The real payload still comes from
`scripts/prepare-desktop.mjs`, and a release bundle must still be built from a tree where that
script has run — the comment says so, in those words.

## 5. Verification

Under the clean-checkout emulation — empty `src-tauri/backend/`, 0-byte `WebView2Loader.dll`, and
the new step's commands run first:

```
--- cargo build:
   Compiling netpulse-desktop v1.1.1
    Finished `dev` profile … in 22.38s          BUILD_EXIT=0
running 1 test
test the_navigation_backstop_holds_in_a_real_webview ... ok
test result: ok. 1 passed; 0 failed              finished in 7.51s
```

(`nav-ci-04-build-passes-after-fix.log`, `nav-ci-05-test-pass-clean-checkout.log`.)

Then, with the real artifacts restored and a forced rebuild (so the binary left on disk is not one
built under emulation):

```
   Compiling netpulse-desktop v1.1.1
    Finished `dev` profile … in 5.13s           BUILD_EXIT=0
test result: ok. 1 passed; 0 failed              finished in 7.64s
```

(`nav-ci-09-rebuild-real-payload.log`, `nav-ci-10-test-pass-real-payload.log`.)

`js-yaml` over the edited workflow confirms both jobs still parse and that the new step lands
*before* the cargo steps (job order: … web bundle → resource paths → build binary → serve → drivers
→ test → stop server).

## 6. Checks that came back clean (no change needed)

- **Lockfile**: `npm ci --dry-run` exit 0 — step 2 of the job cannot fail on a desync.
- **The dev server's bind address.** `scripts/verify-navigation-webview.mjs` passes
  `--host 127.0.0.1` and its header warns that vite's default `localhost` can bind the IPv6 loopback
  only, leaving the webview on `chrome-error://chromewebdata/`. The job does **not** pass `--host`,
  so this looked like the next failure. Measured: the running server holds `[::1]:5173` only
  (`127.0.0.1:5173` refused, `localhost:5173` → 200), and the WebView2 window loaded the app
  document anyway — the extended test passed against precisely that server (`nav-ci-02-…`). So the
  `--host 127.0.0.1` in the local script is belt-and-braces, not something the job needs.
- **`msedgedriver-tool`'s install location.** The workflow runs `& "$HOME\.cargo\bin\msedgedriver-tool.exe"`.
  Verified the crate installs a binary with exactly that name (`msedgedriver-tool v0.2.2`,
  "executable `msedgedriver-tool.exe`"). Here it landed in `D:\cargo\bin` because this machine sets
  `CARGO_HOME`; a runner's default `%USERPROFILE%\.cargo` is what `$HOME\.cargo\bin` names. ✅
- **The driver/runtime match.** The tool read the runtime version and fetched the matching driver —
  the mismatch that produces "only supports Microsoft Edge version N" does not occur here, and the
  job's use of the tool (rather than a fixed version) is the right shape.

## 7. Limitations — what this does not establish

- **No run on a real runner.** Everything above is a faithful local reproduction on Windows, not an
  observation of `windows-latest`. The emulation removes the two gitignored payloads; it does not
  reproduce a fresh `target/` directory (affects build *time*, not outcome), the runner's WebView2
  build number, or any GitHub-hosted-image difference.
- **The `gates` job** got the same defect fixed; its other steps (lint, four typechecks, all
  workspaces' tests, `cargo test`, `npm run test:feed`) were **not** re-run here — the request was
  the webview job, and this machine's `npm ci` was not run destructively.
- **Placeholder resources are inert for this job only.** Any artifact produced by a job that ran
  this step has no sidecar payload; it must never be used as a release bundle.
- **Nothing was published**: no remote added, no repository created, no push, no workflow dispatch.

## 8. To actually run it

```bash
git remote add origin <url>      # or: install gh, then gh auth login
git push -u origin main          # starts CI on main; `workflow_dispatch` also works
gh workflow run CI --ref main    # once gh is available
gh run watch                     # the job is named `webview-navigation`
```

The failing step to expect, if anything is still wrong on the runner, is `Build the desktop binary`
or `Navigation backstop (real WebView2)`; the job already prints the driver log and the handoff
record on failure, which is where the next diagnosis starts.

## 9. Evidence index

All under `reports/mission/evidence/`:

| File | Content |
|---|---|
| `nav-ci-01-test-pass-driver-from-cache.log` | extended test green with a driver from the script's cache |
| `nav-ci-02-test-pass-driver-from-PATH.log` | extended test green the way the job runs it — `MSEDGEDRIVER` unset, driver on `PATH` |
| `nav-ci-03-build-fails-clean-checkout.log` | `resource path 'backend' doesn't exist`, `BUILD_EXIT=101` |
| `nav-ci-04-build-passes-after-fix.log` | empty `backend/` + 0-byte DLL: `BUILD_EXIT=0` |
| `nav-ci-05-test-pass-clean-checkout.log` | extended test green under clean-checkout emulation |
| `nav-ci-06-msedgedriver-tool-install.log` | `cargo install --git … msedgedriver-tool` → `msedgedriver-tool v0.2.2` |
| `nav-ci-07-rebuild-normal-state.log` | resources restored; build exit 0 |
| `nav-ci-08-test-pass-normal-state.log` | extended test green in the normal tree |
| `nav-ci-09-rebuild-real-payload.log` | forced rebuild with the real payload, exit 0 |
| `nav-ci-10-test-pass-real-payload.log` | extended test green on the rebuilt binary |
