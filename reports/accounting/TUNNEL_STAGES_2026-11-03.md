# Tunnel Stage Timings — 2026-11-03

**Workstream:** Iran-ready requirement 2 (separate DNS / TCP / TLS / HTTP stage results)
**Verdict:** **MEASURED (lab)** — 20/20 rounds completed through the Aether tunnel, with one finding that matters more than the timings: **DNS is resolved outside the tunnel.**
**Scope limit:** non-Iranian network, single target, single path. Iran-network stage behaviour remains unmeasured (W5).

---

## The finding first

`domain-form SOCKS5 (ATYP 0x03) accepted: false`

Aether's SOCKS5 listener refuses a hostname in the CONNECT request, so every name has to be resolved before the tunnel is asked for a socket. That is why `fetchExitIpThroughSocks()` resolves locally first — its own comment says so — and it means:

- **DNS queries leave by the local resolver, not through the tunnel.** A censor watching the resolver sees the destination name even though the payload is tunnelled.
- The exit-IP proof is still valid for what it claims (payload egress), but it does **not** demonstrate name confidentiality.
- Any product claim of "DNS goes through the tunnel" is false on this path today. The only honest statement is "payload goes through the tunnel; names are resolved locally."

This is a code-level fact, not a network artifact: it is reproducible with no tunnel traffic at all.

## Stage timings

20 rounds, `api.ipify.org:443`, HTTP/1.1 GET with `Connection: close`, millisecond resolutions.

| Stage | min | median | p90 | max |
|---|---|---|---|---|
| DNS (local resolver) | 0 | **1** | 1 | 89 |
| SOCKS5 TCP + greeting + CONNECT | 76 | **80** | 87 | 95 |
| TLS handshake (through tunnel) | 82 | **92** | 100 | 100 |
| HTTP first byte | 186 | **197** | 278 | 361 |
| End to end | 352 | **372** | 467 | 535 |

Completed 20/20, no failures.

Read across: roughly 80 ms to get a socket out, 92 ms for TLS on top of it, 197 ms to first byte, ~372 ms total. The DNS column is the odd one — 1 ms, because it never left the host's resolver. A tunnel that carried names would put tens of milliseconds there and the total would rise; the cheap DNS stage is a symptom, not an optimisation.

## Cross-check against earlier numbers

The exit-IP proof over plain HTTP measured 265–283 ms for a full request. Plain HTTP skips the ~92 ms TLS stage, so 372 − 92 ≈ 280 ms — consistent. The two measurements agree, which is why both are kept.

## What this enables

Requirement 2 wants stage-level numbers per path because a single end-to-end figure cannot say *where* a network interferes. On this path the stages separate cleanly, so the same table on an Iranian vantage would answer the useful questions directly: is TLS being reset (TLS stage fails, SOCKS succeeds), is the tunnel being throttled (all stages inflate evenly), or is name resolution being poisoned (DNS stage changes or fails while the rest is normal)?

## Not measured

- Iranian-network stage behaviour — **NOT TESTED** (W5).
- UDP/QUIC path (MASQUE's datagrams) — **NOT TESTED**; only TCP through SOCKS5.
- Same stages on the free-config/xray path — **NOT TESTED**.
- ≥20 repeats *per path*: 20 repeats on one path only, so requirement 2 is **PARTIAL**, not satisfied.

## Reproduce

```bash
# with a tunnel already listening on 1819
npx tsx scripts/tunnel-stages.ts [port]
```

Raw samples: `reports/accounting/TUNNEL_STAGES_2026-11-03.json`.
