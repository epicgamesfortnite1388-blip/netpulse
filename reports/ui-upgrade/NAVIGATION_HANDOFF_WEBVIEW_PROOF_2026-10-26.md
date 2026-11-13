# Navigation backstop — real-webview proof, including the OS handoff

**Date:** 2026-10-26, extended 2026-10-27 (in-page anchor-click step; handoff evidence
as data rather than log text)
**Component:** `src-tauri` (`window.rs`, `os_open.rs`, `tests/navigation_webview.rs`),
`apps/web/src/lib/externalNavigation.ts`
**Verdict:** **PASS** — both exits that can hand a link to the OS are proven through
a real WebView2 window driven by `tauri-driver`: the Rust backstop (an
engine-initiated navigation, and `window.open`) and the in-page guard (a click on a
raw anchor). Every step asserts the refusal *and* the OS handoff, and each handoff is
read from a JSON-lines record — URL, layer that opened it, spawn outcome — not from
message wording.
**Status change:** the in-window half of the backstop no longer rests on unit tests
alone. `reports/mission/MISSION_JOURNAL.md` item 7 previously recorded this test as
`#[ignore]`d and never run.

## 1. What was added

The test used to prove only *where the window ended up* (URL unchanged, no second
webview). That is not the whole rule: a `classify` that refused everything would
leave the window in exactly the same place as a correct one, so a silent drop would
have passed.

It now asserts the other half — that each URL reached the OS — as **data**:

| Step | Assertion |
|---|---|
| `location.href = 'https://example.com/'` | request refused (requested URL and document both unchanged), **and** the record gained exactly one row: `url = https://example.com/`, `source = navigation`, `ok = true` |
| `window.open('https://example.com/','_blank')` | no second window, **and** exactly one new row with `source = new-window`, `ok = true` |
| click on an anchor injected into the page (`#np-external-probe`) through WebDriver's element-click endpoint (a real input event) | URL and document unchanged, **and** exactly one new row with `source = command`, `ok = true` — i.e. the handoff came from the in-page guard's `open_external` invoke, not from the engine |
| `location.href = 'http://example.com/'` | refused (document still the app), **and** the record gained **no** row: a refused URL launches nothing |
| `location.hash = '#/vpn'` | in-app routing still works, so this is a policy and not a blanket block |

### The record — why the proof does not read the log

The OS browser is a separate process this test cannot drive, so the handoff itself
has to be observed from inside the app. That used to mean matching log phrases
(`opening external link for host …`), which made every message wording a contract:
renaming one broke the test. Telling the layers apart was worse — all of them
converge on the same launch path, so the anchor-click step had to assert the
*absence* of the Rust backstop's line to claim the guard had handled the click.

Now `os_open::record_handoff` appends one JSON object per handoff to the file named
by `NETPULSE_HANDOFF_RECORD`, **after** the spawn attempt, so a row means the OS was
really asked:

```json
{"at":1793101058095,"host":"example.com","ok":true,"source":"navigation","url":"https://example.com/"}
```

`source` is the layer that opened the URL — `command` (the page's guard → the
`open_external` command), `navigation` (`on_navigation`), `new-window`
(`on_new_window`). The variable is **unset in every normal run**: a durable journal
of the URLs the app opened is a browsing record this product does not keep, so the
channel exists only for this test, which points the driver process at a temp file
(the app inherits the variable through `tauri-driver` → `msedgedriver`) and deletes
it when the run passes. A missing or unwritable file is logged and never fails a
handoff.

The anchor step also waits for the guard to report *itself* installed — its
disposer is registered on the document under
`Symbol.for('netpulse.external-navigation-guard')` — before clicking. The reason is
measured, see §3: the app document reloads after a refused navigation, and a click
during that reload reaches the engine instead of the guard.

## 2. A readiness gate that could pass against an error page (fixed)

Running the extended test for the first time failed in the *pre-existing* check,
with `the document is no longer the app after the blocked navigation:
"chrome-error://chromewebdata/"`. The cause was not the backstop:

- the debug binary resolves its window to `build.devUrl`
  (`http://localhost:5173`) — Tauri sets its `dev` cfg for a debug build — and
  nothing was listening there, so the window was the engine's error page;
- WebDriver's `GET /url` answers with the URL that was *requested*, which stays
  `http://localhost:5173/` on an error page, so the test's "the app document
  loaded" wait had passed vacuously.

So the wait now requires `document.location.href` to be the app document as well as
the requested URL, and the test's run instructions say the dev origin must be served
(or the app built `--release`, where the bundle is compiled in).

## 3. Evidence

One command does the whole chain (`scripts/verify-navigation-webview.mjs`, wired as
`npm run e2e:navigation`): it resolves a native driver matching the installed
WebView2 runtime — downloading that exact msedgedriver when none is on `PATH` —
serves the dev origin, builds the app, runs the test, and stops only the server it
started. A passing run:

```
PASS  cargo on PATH
PASS  tauri-driver on PATH — D:\cargo\bin\tauri-driver.exe
PASS  native webdriver resolved — node_modules\.cache\netpulse\msedgedriver\155.0.4283.62\msedgedriver.exe
PASS  cargo build
PASS  app binary — src-tauri\target\debug\netpulse-desktop.exe
PASS  dev origin served at http://127.0.0.1:5173
test the_navigation_backstop_holds_in_a_real_webview ... ok
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 7.27s
PASS  navigation backstop (real webview)
PASS  the backstop held in a real webview
```

The record that run produced (kept for this report by temporarily skipping the
test's cleanup, then deleted):

```
{"at":1793101058095,"host":"example.com","ok":true,"source":"navigation","url":"https://example.com/"}
{"at":1793101060330,"host":"example.com","ok":true,"source":"new-window","url":"https://example.com/"}
{"at":1793101061960,"host":"example.com","ok":true,"source":"command","url":"https://example.com/"}
```

Three rows, three layers, in the order the test drives them — including the
`command` row that could previously only be inferred from a *missing* log line.

### The mutation check for the anchor step

The click could be rescued by the backstop, so a passing row proves nothing unless a
broken guard is caught. `onActivate` in `apps/web/src/lib/externalNavigation.ts` was
therefore made to `return` immediately — the guard still installs and still reports
itself at the registry symbol, so the precondition passes, but no click is
intercepted:

| Run | Result |
|---|---|
| guard intact | **PASS** — 1 test, 7.3–8.3 s (repeated) |
| `onActivate` returns immediately (dev server restarted, same binary) | **FAIL** in ~26 s: `timed out waiting for a \`command\` handoff of https://example.com/ to be recorded`, and the printed record shows the third row as `source: navigation` |
| guard restored (file byte-identical) | **PASS** again |

That is the assertion doing its job: the click fell through to the engine, the
backstop handled it, and the record says so — a handoff count alone would have
counted it as success.

### The one failing run, and the precondition it produced

One earlier run (the first after the app binary was rebuilt) failed the same way,
before the guard precondition existed: the record's third row came back
`source: navigation` for the anchor click. It did not reproduce in the nine passing
runs since (four of them instrumented to report, from the page, the guard's
presence and the click event's `defaultPrevented`/`isTrusted` state — all four saw
the guard installed and the click prevented). The check those instrumented runs
performed is now the step's precondition, so a repeat would fail with `the in-page
external-navigation guard to report itself installed` instead of misattributing the
handoff.

Unit tests for the modified Rust: `cargo test --manifest-path src-tauri/Cargo.toml`
— **161 passed, 2 ignored** (the two are the webview test and a UAC-dialog test).

The script's own behaviour was re-checked when it was added: it leaves a dev server
it did not start running (`PASS  dev origin already served … (left running)`); a
missing `--app` binary fails with `FAIL  app binary` and exit 1; after every run the
port is free and no app/driver process is left behind.

Environment used: Windows, WebView2 runtime `155.0.4283.62`, `msedgedriver`
155.0.4283.62 (matching the runtime), `tauri-driver` on `PATH`, Vite dev server
bound to `127.0.0.1:5173`.

## 4. CI change this required

`.github/workflows/ci.yml` (`webview-navigation`) built the app with plain
`cargo build` and never served the dev origin, so with the corrected readiness gate
the job would fail for a reason unrelated to the backstop. It now starts
`npm run dev -w @netpulse/web`, waits for `http://localhost:5173/` to answer 200
(failing with the server's log if it never does), and stops it afterwards. The job's
comment was updated to describe what the test now covers (both exits, handoff read
from the record).

## 5. What this proves, and what it does not

Proves: in a real engine, the builder callbacks are consulted; an engine-initiated
external https navigation is refused while the URL and document stay the app's, and
is recorded as a `navigation` handoff; a `window.open` is denied and recorded as a
`new-window` handoff; a click on a raw anchor is intercepted *in the page* and
recorded as a `command` handoff, so the guard — not the backstop — handed it over; a
plaintext `http://` navigation is refused without recording anything; and in-app
routing still works.

Does not prove: that a browser window actually appeared (the record says the spawn
succeeded, not that a browser rendered the URL — nothing can assert on the user's
default browser); that every anchor-activation variant behaves the same in a real
engine (middle-click/`auxclick`, keyboard Enter and drag-and-drop are covered by the
jsdom suite only — the real-engine proof is one left click); Linux/WebKitGTK
behaviour (this run is Windows only); and the CI job itself has not been run on
GitHub Actions from this workstation.
