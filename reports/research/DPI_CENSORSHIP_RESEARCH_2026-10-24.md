# NetPulse — DPI & Censorship Research Summary
**Scope:** Evidence-based threat model and protocol/architecture options for users in high-censorship environments, with documented conditions affecting Iran.  
**Mode:** Lab/repo review only. No live traffic was generated against third-party networks, and no on-Iran-network measurements were performed in this session.

---

## 1. Threat model

### 1.1 Observed/measured behaviors relevant to Iranian users
- **DNS tampering**: multiple OONI and IRBlock findings show bogon/private answers and DNS poisoning for blocked domains; this is one of the most consistent observed techniques.
- **HTTP blockpage injection / TLS interference**: IRBlock and OONI both document cases where blocked sites return block pages or TCP/TLS resets instead of real responses.
- **SNI/IP-based filtering**: some measurements show IP blocking and SNI-dependent blocking behavior, with variation across ISPs/networks and over time.
- **UDP disruption**: IRBlock documents UDP-based traffic disruption affecting some protocols/ports.
- **Overblocking/collateral damage**: blanket TLD or subnet policies have blocked innocuous sites; users need fallback paths.

### 1.2 What this means for a VPN product
- A “works on my VPS” test is not sufficient; the critical question is whether client-to-server traffic is recognizable and blockable on consumer ISP paths.
- Default WireGuard/OpenVPN signatures are widely documented as fingerprintable by DPI; that risk is real but not uniform across all networks.
- Protocols that blend into common TLS traffic, or that use domain-fronting/camouflage, reduce passive fingerprinting risk.
- DNS must be validated end-to-end; VPN uptime alone does not prove uncensored access.

---

## 2. Candidate protocols and trade-offs

| Protocol | Strengths | Weaknesses / cautions |
|---|---|---|
| **VLESS + REALITY (Xray-core)** | TCP/443 camouflage against a real target site; strong local evidence of use in Iran/China; good performance vs OpenVPN-over-cloak. | Requires careful target-site selection; protocol must be served by Xray-core. |
| **AmneziaWG 3.1** | UDP-based, high throughput, obfuscated packet signatures relative to stock WireGuard. | Amnezia docs explicitly say AWG 2.0 is now vulnerable to blocking; migration path to 3.1 is required. |
| **Shadowsocks / Shadowsocks 2022** | TCP, resembles normal HTTPS to many passive sensors. | Some DPI systems can still recognize it; higher mobile power draw than simpler tunnels. |
| **OpenVPN over Cloak** | Active-probing resistance via disguise; mature. | TCP-only; higher power use; version-sensitivity noted in Amnezia docs. |
| **WireGuard / IKEv2** | Simple, fast, stable. | Easily fingerprintable per Amnezia docs; not recommended as the sole option in high-censorship contexts. |
| **Hysteria2** | UDP-based, often useful as fallback. | QUIC fingerprintability and blocking risk varies; IRBlock-style UDP disruption applies. |

---

## 3. Recommended architecture (evidence-backed, minimal)

**Primary:** VLESS + REALITY over TCP/443 with Xray-core.  
**Secondary:** AmneziaWG 3.1 as a UDP fallback where REALITY/TCP is impaired.  
**Tertiary:** Shadowsocks 2022 for environments where UDP is disrupted but TCP remains usable.

Supporting requirements:
- Target domain for REALITY must be a large, public, TLSv1.3/H2-capable site that is accessible without a VPN from the user’s network.
- Client TLS fingerprint should be configurable (e.g., Chrome-like via uTLS) to avoid JA3/ fingerprint staticity.
- VPN server DNS must be authoritative and non-recursive to external resolvers from the tunnel’s perspective; leak tests should verify resolver identity.
- Subscription/entitlement enforcement should be independent from transport: expiry must disable/rotate credentials at the server, not only in the client config.

---

## 4. Reproducible test matrix (what to validate without abusing public infrastructure)

| Test | What it validates | Evidence required |
|---|---|---|
| TCP/443 REALITY handshake | Transport reachability + certificate behavior | Server hello / TLS fingerprint from control host; NOT against censored targets. |
| UDP/51820 AmneziaWG handshake | UDP path viability | Successful key exchange + ping through tunnel from authorized client. |
| DNS delegation + TCP/53 | DNS data-plane health | Authoritative SOA/NS answers + TCP/53 open from independent external nodes. |
| Tunneled IP check | Egress correctness | External IP-check from inside tunnel matches expected egress. |
| DNS leak check | Resolver identity | Resolver seen from inside tunnel matches intended resolver; no fallback to recursive public resolver. |
| Revoked/expired credential | Enforcement | Connection refused or entitlement returns inactive after expiry/revocation. |
| Reconnect after interruption | Resilience | Client re-establishes after brief network loss without manual reset. |

---

## 5. Implementation priority

1. **Harden Xray REALITY listener** on the live VPS with an explicit target-domain policy and client-fingerprint option.  
2. **Add AmneziaWG 3.1** as a secondary protocol with documented migration from AWG 2.0.  
3. **Tie VPN credential lifetime to subscription state** so expired entitlements are enforced server-side.  
4. **Add automated leak/connectivity checks** in the desktop sidecar using only authorized self-owned endpoints.  
5. **Add measurement logging** (success/fail/stage) without logging private keys or subscriber identities.

---

## 6. Open honest limits

- This summary is derived from published research/repos and prior local verification artifacts; it does not constitute live censorship measurement on Iranian consumer networks.
- Actual blocking probability depends on ISP, time, and protocol implementation details; tests should be run from representative vantage points before claiming universal effectiveness.
