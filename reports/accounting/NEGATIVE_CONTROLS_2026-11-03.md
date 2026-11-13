# Negative Controls — 2026-11-03

**Workstream:** Iran-ready requirement 4 (negative controls **and** a fallback path)
**Verdict:** **4/4 controls behaved** — every designed failure was refused, and the machine's egress was unchanged afterwards.
**Harness:** `scripts/negative-controls.ts` (raw output `NEGATIVE_CONTROLS_2026-11-03.json`)
**Scope limit:** exercises the Aether path on a non-Iranian network. The app-level provider fallback is covered by unit tests (`adaptiveConnect.test.ts`), not by this harness.

---

## Why this exists

An exit-IP proof is only worth something if it says **no** when there is no tunnel. During the W1 work three configurations had the SOCKS5 port *listening* while nothing relayed, which is exactly the state a naive checker would call "connected". These controls pin that behaviour down as a test rather than an anecdote.

Each case is built to look like a working client — an open port, a live process, a plausible log — and passes only when `socks5RelayCheck` and the exit-IP proof refuse to certify it.

## Results

| # | Control | What it simulates | `portOpen` | `relay` | `exitIp` | Verdict |
|---|---|---|---|---|---|---|
| C1 | Blocked peer — `192.0.2.1:443` (TEST-NET-1, never routeable) | A gateway that cannot be reached | true | **false** | null | **PASS** |
| C2 | Occupied bind port — harness binds `127.0.0.1:2920` first | A port that is open but is not a tunnel | true | **false** | null | **PASS** |
| C3 | Corrupt identity — invalid TOML in `aether-masque.toml` | A wrong/damaged key | false | **false** | null | **PASS** |
| C4 | Fallback — direct egress after C1–C3 | A failed tunnel leaving the host half-proxied | — | — | `83.229.87.141` | **PASS** |

### What each case actually showed

**C1 — blocked peer.** Aether accepted the forced peer, bound the port, and then had nothing to relay. Port answered, relay false. This is the honest-failure path the provider relies on: `started` is not `connected`.

**C2 — occupied port.** Aether refused to start rather than squatting or half-binding:

```
Error: Other("the socks5 listener cannot use 127.0.0.1:2920: Only one usage of each socket
address ... (os error 10048); another program already list[ens]")
```

A checker that only tested "is the port open?" would have reported a tunnel here, because *our* listener was answering. The relay check correctly said no.

**C3 — corrupt identity.** The binary rejected the identity and quarantined it instead of silently using the wrong key:

```
Error: Other("config parse: TOML parse error at line 1, column 6
1 | this is not valid toml [[[
key with no value, expected `=`
; the damaged file was moved to ... aether-masque.toml.corrupt so a fresh identity can be provisioned")
```

Note the recovery behaviour: a corrupt identity is moved aside and a fresh one provisioned. That is a fallback inside the engine, and it is worth knowing — it means C3 cannot be distinguished from "fresh install" by outcome alone unless the log is read. With `--startup-secs 15` and no route out, the process exited before exposing a port.

**C4 — fallback.** After all three failures, direct egress was still `83.229.87.141`, exactly the pre-run baseline. Nothing was left pointed at a dead local proxy.

## What this closes and what it does not

Requirement 4 asks for "negative controls (wrong key, expired profile, blocked port) **and** a fallback path". Today:

- Wrong key → covered (C3).
- Blocked port → covered twice, from both sides (C1 unreachable peer, C2 occupied port).
- Fallback path → covered at the network level (C4: egress intact after failure). The provider-selection fallback (Aether unavailable → adaptive core path) is asserted in the existing test suite, not re-derived here.
- **Expired profile** → **NOT COVERED.** No expiry mechanism exists to expire: free share links carry no validity field, and Aether's identity has no expiry the client can read. The closest analogue is C3.

## Not measured

- Iranian-network behaviour of any control — **NOT TESTED** (no vantage, W5).
- Behaviour when the tunnel drops *after* certification (kill-switch verification) — **NOT TESTED** here; it lives in `killSwitch.ts` and its tests.
- Controls against xray/sing-box paths — only the Aether engine was exercised.

## Reproduce

```bash
npx tsx scripts/negative-controls.ts     # exits 0 when all controls refuse to certify
```

The harness spawns Aether on ports 2919–2921, never touches 1819, and kills each process tree it starts.
