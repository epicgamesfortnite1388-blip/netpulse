# DPI and Iran Censorship Source Registry

Registry date: **2026-10-25**. GitHub metadata was read from the public
`api.github.com/repos/<owner>/<repo>` endpoint on that date; `pushed` is the
repository's last push, not necessarily the last reviewed commit. Papers were
read at the level stated in each entry. "Iran relevance" distinguishes a
direct Iran measurement from a general-purpose implementation.

Confidence is about **the specific finding recorded here**, not the general
quality of the source. Unless an entry explicitly says code/spec sections were
inspected, repository entries reflect the public README/metadata and are not a
line-by-line code audit. This distinction matters: protocol names are not
deployment evidence.

## A. Iran-specific measurement and policy

### S01 — IRBlock (USENIX Security 2025)

- **Title:** IRBlock: A Large-Scale Measurement Study of the Great Firewall of Iran
- **URL:** https://www.usenix.org/conference/usenixsecurity25/presentation/tai
- **Type / Iran relevance:** peer-reviewed measurement paper / direct
- **Date:** August 2025 (USENIX Security '25)
- **Findings:** 2.5-month multi-protocol measurement of Iran's address space;
  reports DNS poisoning and HTTP block-page injection on 6.8M IPs, UDP-based
  disruption on 5.4M IPs, and more than 6M censored FQDNs / 3.3M apex domains.
  Documents TLD-wide overblocking (e.g. `.il`) and similarities to the GFW.
  The method uses the censor's own bidirectional blocking/injection behavior
  as a side channel.
- **Evidence:** abstract and paper landing page; full PDF not parsed for this
  registry.
- **Limitations:** measurements are from outside/at the edge and over a
  specific period; they do not establish every ISP's behavior today or the
  behavior of a particular user's path.
- **NetPulse implication:** DNS and UDP failure are first-class transport
  risks, not edge cases; a single working TCP/443 test cannot represent the
  product.
- **License / confidence:** USENIX open-access paper / **High** for the
  reported measurements, **Medium** for applying them to a specific path.

### S02 — I(ra)nconsistencies (FOCI 2025)

- **Title:** I(ra)nconsistencies: Novel Insights into Iran's Censorship
- **URL:** https://www.petsymposium.org/foci/2025/foci-2025-0002.php
- **Type / Iran relevance:** workshop paper / direct
- **Date:** 2025
- **Findings:** reports injections of *correct static IPs* for some domains
  (e.g. google.com) at the DNS level, unclear HTTP-version parsing, and
  correlations between DNS and HTTP censorship. Emphasizes inconsistent,
  sometimes counter-intuitive behavior.
- **Evidence:** abstract and paper page (CC BY 4.0).
- **Limitations:** small paper; observations are not a complete taxonomy and
  may depend on resolver, browser, and network.
- **NetPulse implication:** do not assume a DNS answer is either "poisoned"
  or "clean"; validate the answer against the delegated authoritative server
  and the actual destination.
- **License / confidence:** CC BY 4.0 / **Medium-High** for the observations,
  **Low** for generalization.

### S03 — Iran's protocol whitelister (FOCI 2020)

- **Title:** Detecting and Evading Censorship-in-Depth: A Case Study of Iran's
  Protocol Whitelister
- **URL:** https://www.usenix.org/conference/foci20/presentation/bock
- **Type / Iran relevance:** peer-reviewed workshop paper / direct
- **Date:** 2020
- **Findings:** Iran deployed a protocol filter permitting only a small set
  (DNS, HTTP, HTTPS) and censoring other protocols. The authors reverse
  engineer fingerprints and show packet-manipulation strategies that defeat
  the filter; the code is Geneva.
- **Evidence:** abstract and paper page; code at geneva.cs.umd.edu.
- **Limitations:** 2020 deployment; fingerprints and policy can change.
- **NetPulse implication:** "encrypted" is not enough if the transport itself
  is not permitted; test protocol shape, not just payload secrecy.
- **License / confidence:** USENIX open-access / **High** for the historical
  mechanism, **Medium** for current applicability.

### S04 — Automated DNS censorship circumvention (FOCI 2026)

- **Title:** Towards Automated DNS Censorship Circumvention
- **URL:** https://ris.uni-paderborn.de/download/64566/64568/foci-2026-0001.pdf
- **Type / Iran relevance:** workshop paper / direct (title/abstract context)
- **Date:** 2026
- **Findings:** **Not used for a technical conclusion in this iteration.** The
  PDF was fetched but the local toolchain could not extract text; only the
  title and metadata were verified.
- **Evidence:** PDF retrieval; no text-level claim recorded.
- **Limitations:** no reproducible reading yet.
- **NetPulse implication:** schedule a proper reading before citing its
  automation claims.
- **License / confidence:** publisher PDF, license not verified / **Low**.

### S05 — OONI Iran measurement report

- **Title:** Internet Censorship in Iran: Network Measurement Findings from
  2014-2017
- **URL:** https://ooni.org/post/iran-internet-censorship/
- **Type / Iran relevance:** measurement report + open data / direct
- **Date:** 2017-09-28 (data 2014-2017)
- **Findings:** 60 Iranian networks; 886 domains confirmed blocked; DNS
  injection of block pages and HTTP transparent proxies; non-deterministic
  blocking over time; Tor and circumvention sites targeted. Provides
  methodology and limitations.
- **Evidence:** report body, methodology, findings, and linked measurements.
- **Limitations:** older than the current network; not a live measurement of
  the user's ISP.
- **NetPulse implication:** build for inconsistency and fallback; log the
  failure stage rather than a binary "blocked".
- **License / confidence:** OONI/open data, report terms / **High** for
  historical findings, **Low** for current per-path behavior.

### S06 — Freedom House, Freedom on the Net 2025: Iran

- **Title:** Iran: Freedom on the Net 2025 Country Report
- **URL:** https://freedomhouse.org/country/iran/freedom-net/2025
- **Type / Iran relevance:** policy assessment / direct context
- **Date:** 2025
- **Findings:** score 13/100, Not Free; documents the June 2025 near-total
  shutdown shortly after the coverage period, platform blocking, surveillance,
  and pressure toward a domestic network.
- **Evidence:** country report and key developments.
- **Limitations:** policy context, not packet-level evidence; some claims are
  from secondary reporting.
- **NetPulse implication:** shutdown and domestic-only modes are product
  requirements, not rare exceptions; a tunnel cannot be assumed available.
- **License / confidence:** Freedom House terms / **High** for context,
  **not** a substitute for technical measurement.

## B. WhiteDNS / Soar / DNS-tunnel implementations

### S07 — Lantern Soar

- **Title:** Soar: a fast, reliable DNS tunnel for networks that censor
  everything but DNS
- **URL:** https://github.com/getlantern/soar
- **Type / Iran relevance:** reference implementation and specification /
  general-purpose, with Iran-oriented design
- **Date / version:** pushed 2026-10-22; v0.2.2 is what the VPS diagnostic
  reports; v0.2.3 is used by CottenDNS Max.
- **Findings:** DNS tunnel over recursive resolvers to an authoritative
  delegated zone; multiple resolver paths with per-path RTT/loss; TCP/53;
  forged answers cannot authenticate; X25519 + Ed25519 transcript signature;
  ChaCha20-Poly1305 with 8-byte tag; `LOST` reports; held polls; resolver
  discovery. README reports emulator benchmarks, not field Iran results.
- **Evidence:** README design/spec sections, `client.go`, `discover.go`,
  `roundtripper.go`, `SPEC.md`; live VPS test below.
- **Limitations:** pre-release, no compatibility promises; README itself says
  field measurements from Iran/Russia/China come next; benchmark figures are
  emulator results.
- **NetPulse implication:** suitable as a last-resort DNS path, but it needs
  a real client and a delegated zone; it is not a general-purpose VPN and not
  a substitute for the Xray data plane.
- **License / confidence:** Apache-2.0 / **High** for protocol design,
  **High** for live VPS tunnel, **Low** for Iran-wide performance.

### S08 — WhiteDNS Soar-Server panel

- **Title:** WhiteDNS Server Management / Soar-Server
- **URL:** https://github.com/WhiteDNS/Soar-Server
- **Type / Iran relevance:** installer + panel + engine integration / direct
  WhiteDNS ecosystem
- **Date / version:** pushed 2026-10-25; repository advertises panel 0.8.0;
  the VPS installed bundle is **0.6.0**.
- **Findings:** guided Ubuntu/Debian installer; panel with Soar, Cotten and
  MasterDNS engines; per-account quotas/expiry/speed; subscription links;
  random admin path; `soar-panel` binds UDP/TCP 53 and the panel on loopback.
  Soar engine is Lantern Soar v0.2.2; Cotten is a compatible fork.
- **Evidence:** README (Persian/English), `panel-install.sh`, `panel-security.sh`,
  and live VPS units/listeners.
- **Limitations:** panel version on the VPS is older than the repository's
  advertised release; panel HTTPS is pending; the random path was exposed
  during troubleshooting and still needs rotation.
- **NetPulse implication:** do not reinstall or upgrade blindly; use the
  panel's supported account/subscription API and rotate the path.
- **License / confidence:** Apache-2.0 / **High** for deployment shape,
  **Medium** for version-specific behavior.

### S09 — WhiteDNS Wizard

- **Title:** WhiteDNS 3X-UI Wizard
- **URL:** https://github.com/WhiteDNS/WhiteDNS-Wizard
- **Type / Iran relevance:** provisioning CLI/TUI / WhiteDNS ecosystem
- **Date / version:** pushed 2026-07-24
- **Findings:** Cloudflare-first provisioning of a managed 3x-ui/Xray stack
  over SSH; creates DNS records, certificates, inbounds/outbounds, client
  links; supports Tor-routed profiles. It is **not** the DNS-tunnel engine.
- **Evidence:** README, DNS/protocol tables, output paths.
- **Limitations:** GitHub API reports no resolved license; reuse terms must be
  checked before code reuse; it provisions a different stack from the current
  Soar panel.
- **NetPulse implication:** useful reference for profile generation and
  operational flows, not a drop-in WhiteDNS tunnel.
- **License / confidence:** no SPDX in API / **Medium**.

### S10 — WhiteDNS Android

- **Title:** WhiteDNS Android client
- **URL:** https://github.com/WhiteDNS/WhiteDNS-Android
- **Type / Iran relevance:** Android client / direct WhiteDNS ecosystem
- **Date / version:** pushed 2026-10-25; README references 1.6.8+ and beta
  1.6.10-1.6.14 releases.
- **Findings:** source-available **proprietary** Android app; supports
  MasterDNS, StormDNS, CottenDNS and Soar engines; proxy and VpnService modes;
  `stormdns://` and `soar://` profiles; subscriptions; resolver management.
- **Evidence:** README, license notice, project structure.
- **Limitations:** not open source; cannot copy/repackage/redistribute; no
  Windows build; Android only.
- **NetPulse implication:** use only as an external client or protocol
  reference; do not vendor its code or APK.
- **License / confidence:** source-available proprietary / **High**.

### S11 — WhiteVPN

- **Title:** WhiteVPN for Android
- **URL:** https://github.com/WhiteDNS/WhiteVPN
- **Type / Iran relevance:** Android VPN client / WhiteDNS ecosystem but not
  the DNS tunnel
- **Date / version:** pushed 2026-10-15
- **Findings:** Mihomo-based client; VLESS/VMess/Trojan/SS/Hysteria2/WireGuard;
  subscriptions; split tunneling; DoH/DoT; built-in public subscription.
- **Evidence:** README, supported methods, build notes.
- **Limitations:** GPL-3.0; it is a Mihomo proxy client, **not** a WhiteDNS
  Soar/Cotten DNS-tunnel client. Do not label a Mihomo connection as
  "WhiteDNS connected".
- **NetPulse implication:** useful as a client reference for Mihomo
  subscription UX, not as the WhiteDNS engine.
- **License / confidence:** GPL-3.0 / **High**.

### S12 — CottenDNS

- **Title:** CottenDNS
- **URL:** https://github.com/WhiteDNS/CottenDNS
- **Type / Iran relevance:** DNS tunnel implementation / direct WhiteDNS
  ecosystem
- **Date / version:** pushed 2026-10-25; README describes Normal and
  CottenMax beta; CottenMax uses Soar v0.2.3.
- **Findings:** normal mode: UDP/TCP/DoT/DoH paths, ARQ/FEC/duplication,
  per-path controller, resolver scanning, SOCKS5 local proxy; CottenMax:
  Soar-derived adaptive sizes/windows, held polls, multipath, authenticated
  transfer marker. Windows/Linux/macOS clients are published.
- **Evidence:** README (long setup/design), configuration presets, client and
  server source tree; no live CottenDNS test in this iteration.
- **Limitations:** beta; DNS tunneling is slower than a normal VPN; shared
  key in normal mode; no real Iran test; CottenMax is opt-in.
- **NetPulse implication:** a viable Windows-capable DNS-tunnel client to
  evaluate, but keep it separate from the Soar profile and from Android code.
- **License / confidence:** MIT lineage; GitHub API reports NOASSERTION for
  the aggregate / **Medium-High** for documented behavior, **Low** for
  untested performance.

## C. Proxy, TLS, and transport implementations

### S13 — Xray-core

- **URL:** https://github.com/XTLS/Xray-core
- **Type / Iran relevance:** proxy core / general-purpose, widely used in Iran
- **Date / version:** pushed 2026-10-25; MPL-2.0
- **Findings:** VLESS, VMess, Trojan, Shadowsocks, REALITY, XTLS, XHTTP,
  uTLS; platform for many panels/clients. REALITY is a TLS camouflage
  mechanism, not ECH.
- **Evidence:** README, docs, protocol topics; local NetPulse integration
  uses Xray for REALITY/VLESS.
- **Limitations:** implementation/version differences matter; a protocol
  name does not prove a deployment is correctly configured.
- **NetPulse implication:** keep REALITY as a primary candidate, but validate
  the actual server/client pair and fingerprint.
- **License / confidence:** MPL-2.0 / **High**.

### S14 — REALITY

- **URL:** https://github.com/XTLS/REALITY
- **Type / Iran relevance:** TLS camouflage design / general-purpose
- **Date / version:** pushed 2026-10-14; MPL-2.0
- **Findings:** steals a real TLS handshake from a target site; client
  authenticates the server without a separate certificate; designed to look
  like the target. It does not encrypt SNI the way ECH does.
- **Evidence:** README and protocol description.
- **Limitations:** target selection and active probing are operational risks;
  a public target can change behavior or block the server IP.
- **NetPulse implication:** the live VPS uses REALITY; do not describe it as
  ECH or as unblockable.
- **License / confidence:** MPL-2.0 / **High**.

### S15 — v2ray-core (V2Fly)

- **URL:** https://github.com/v2fly/v2ray-core
- **Type / Iran relevance:** proxy core / general-purpose
- **Date / version:** pushed 2026-10-20; MIT
- **Findings:** original V2Ray core; broad VMess/VLESS compatibility; fewer
  REALITY/XTLS extensions than Xray.
- **Evidence:** README and local NetPulse engine support.
- **Limitations:** legacy configs and different behavior from Xray.
- **NetPulse implication:** keep as compatibility engine, not the default for
  REALITY.
- **License / confidence:** MIT / **High**.

### S16 — sing-box

- **URL:** https://github.com/SagerNet/sing-box
- **Type / Iran relevance:** universal proxy platform / general-purpose
- **Date / version:** pushed 2026-10-24; GitHub API reports NOASSERTION
- **Findings:** wide protocol coverage, DNS routing, rule-based outbounds,
  Hysteria2/TUIC support. NetPulse uses it for proxy probes and managed
  tunnels.
- **Evidence:** README/docs and local code.
- **Limitations:** license must be verified from the repository before
  redistribution; capability table changes across versions.
- **NetPulse implication:** primary fallback/probe core; pin versions.
- **License / confidence:** license not resolved by API / **Medium**.

### S17 — v2rayNG

- **URL:** https://github.com/2dust/v2rayNG
- **Type / Iran relevance:** Android client / general-purpose, popular in Iran
- **Date / version:** pushed 2026-10-25; GPL-3.0
- **Findings:** Android V2Ray client with Xray/v2fly cores; import/export,
  routing, subscriptions.
- **Evidence:** README and repository structure.
- **Limitations:** Android only; client behavior is not server proof.
- **NetPulse implication:** compatibility reference.
- **License / confidence:** GPL-3.0 / **High**.

### S18 — PattNG

- **URL:** https://github.com/patterniha/PattNG
- **Type / Iran relevance:** Iran-focused v2rayNG fork / direct
- **Date / version:** pushed 2026-10-25; GPL-3.0
- **Findings:** fork adds `cipherSuites` and an "unsafe" fingerprint option,
  Aether core, and a modified Xray that permits unencrypted VLESS/Trojan to
  public addresses. README is in Persian and explicitly targets Iranians.
- **Evidence:** README and repository tree; no independent measurement of the
  fork's DPI resistance.
- **Limitations:** no evidence that fingerprint changes improve connectivity;
  the "unsafe" option weakens security; no benchmark.
- **NetPulse implication:** study the configuration surface, do not copy the
  unsafe option, and do not assume novelty equals resistance.
- **License / confidence:** GPL-3.0 / **Medium** for feature claims, **Low**
  for efficacy.

### S19 — Hysteria

- **URL:** https://github.com/HyNetworks/hysteria
- **Type / Iran relevance:** QUIC/UDP proxy / general-purpose
- **Date / version:** pushed 2026-10-21; MIT
- **Findings:** Hysteria2 uses QUIC, loss-tolerant congestion control,
  obfuscation; often used as a fallback.
- **Evidence:** README and local VPS service.
- **Limitations:** UDP can be disrupted; QUIC is identifiable; performance
  claims are environment-specific.
- **NetPulse implication:** keep as a fallback where UDP survives; test
  separately from TCP paths.
- **License / confidence:** MIT / **High**.

### S20 — TUIC

- **URL:** https://github.com/tuic-protocol/tuic
- **Type / Iran relevance:** QUIC proxy / general-purpose
- **Date / version:** pushed 2025-05-15; GPL-3.0
- **Findings:** 0-RTT QUIC proxy; lower handshake latency in principle.
- **Evidence:** README/spec.
- **Limitations:** maintenance appears less active than Hysteria; UDP path
  risks; 0-RTT replay considerations.
- **NetPulse implication:** evaluate only if UDP path works; not a default.
- **License / confidence:** GPL-3.0 / **Medium**.

### S21 — NaiveProxy

- **URL:** https://github.com/klzgrad/naiveproxy
- **Type / Iran relevance:** HTTP/2/3 TLS proxy / general-purpose
- **Date / version:** pushed 2026-10-22; BSD-3-Clause
- **Findings:** uses Chromium's network stack to make proxy traffic resemble
  HTTPS; relies on a real HTTPS server and domain.
- **Evidence:** README.
- **Limitations:** needs a domain/certificate and a compatible server; not a
  generic SNI trick; traffic shape still analyzable.
- **NetPulse implication:** candidate for a TLS/HTTP front, not a quick fix.
- **License / confidence:** BSD-3-Clause / **Medium-High**.

### S22 — shadowsocks-rust

- **URL:** https://github.com/shadowsocks/shadowsocks-rust
- **Type / Iran relevance:** Shadowsocks implementation / general-purpose
- **Date / version:** pushed 2026-10-25; MIT
- **Findings:** Rust Shadowsocks; AEAD and 2022 methods; used as a TCP
  fallback.
- **Evidence:** README and local VPS SS2022.
- **Limitations:** shared password in current NetPulse deployment means no
  per-user revocation; protocol can be fingerprinted.
- **NetPulse implication:** do not hand out a non-revocable shared profile;
  per-user identity is required.
- **License / confidence:** MIT / **High**.

### S23 — Outline SDK

- **URL:** https://github.com/OutlineFoundation/outline-sdk
- **Type / Iran relevance:** transport SDK / general-purpose
- **Date / version:** pushed 2026-10-23; Apache-2.0
- **Findings:** modular transports and network tools; useful for building
  fallback clients.
- **Evidence:** README.
- **Limitations:** not a turnkey server; integration work required.
- **NetPulse implication:** reference for transport abstraction, not a
  deployed path.
- **License / confidence:** Apache-2.0 / **Medium**.

### S24 — AmneziaVPN client

- **URL:** https://github.com/amnezia-vpn/amnezia-client
- **Type / Iran relevance:** multi-protocol VPN client / general-purpose
- **Date / version:** pushed 2026-10-25; GPL-3.0
- **Findings:** desktop/mobile client for WireGuard/AmneziaWG/OpenVPN and
  other protocols; traffic masking options.
- **Evidence:** README.
- **Limitations:** not tested here; protocol variants and versions matter.
- **NetPulse implication:** client UX reference; not a server proof.
- **License / confidence:** GPL-3.0 / **Medium**.

### S25 — AmneziaWG Go

- **URL:** https://github.com/amnezia-vpn/amneziawg-go
- **Type / Iran relevance:** obfuscated WireGuard protocol / general-purpose
- **Date / version:** pushed 2026-09-20; MIT
- **Findings:** WireGuard-compatible implementation with obfuscation
  parameters; aims to reduce static WireGuard fingerprints.
- **Evidence:** README/source.
- **Limitations:** obfuscation parameters can become signatures; no Iran
  measurement here; UDP path risk.
- **NetPulse implication:** candidate fallback, not a default; test with a
  real client and server pair.
- **License / confidence:** MIT / **Medium**.

### S26 — 3x-ui

- **URL:** https://github.com/MHSanaei/3x-ui
- **Type / Iran relevance:** Xray panel / general-purpose, widely used
- **Date / version:** pushed 2026-10-25; GPL-3.0
- **Findings:** multi-protocol panel; manages Xray inbounds/clients; the VPS
  runs x-ui alongside the NetPulse Xray service.
- **Evidence:** README and live x-ui listeners.
- **Limitations:** panel exposure is a security risk; API/automation is not a
  stable public contract across versions.
- **NetPulse implication:** do not expose the panel; do not depend on
  undocumented UI endpoints for provisioning.
- **License / confidence:** GPL-3.0 / **High**.

### S27 — MasterDnsVPN

- **URL:** https://github.com/masterking32/MasterDnsVPN
- **Type / Iran relevance:** DNS tunnel / general-purpose
- **Date / version:** pushed 2026-08-29; MIT
- **Findings:** low-overhead DNS tunnel with ARQ, resolver balancing, packet
  loss handling; lineage behind StormDNS/CottenDNS.
- **Evidence:** README.
- **Limitations:** shared-key normal mode; no per-user identity; performance
  claims not independently reproduced.
- **NetPulse implication:** prior art for CottenDNS/Soar comparisons.
- **License / confidence:** MIT / **Medium**.

### S28 — StormDNS

- **URL:** https://github.com/nullroute1970/StormDNS
- **Type / Iran relevance:** DNS tunnel / general-purpose
- **Date / version:** pushed 2026-10-23; GitHub API reports NOASSERTION
- **Findings:** MasterDNS-derived tunnel; WhiteDNS Android includes it.
- **Evidence:** README/API metadata.
- **Limitations:** license unresolved; no live test here.
- **NetPulse implication:** do not reuse until license is verified; use only
  as compatibility context.
- **License / confidence:** license not resolved / **Low-Medium**.

### S29 — ByeDPI

- **URL:** https://github.com/hufrea/byedpi
- **Type / Iran relevance:** local DPI-bypass tool / general-purpose
- **Date / version:** pushed 2026-03-29; MIT
- **Findings:** client-side packet fragmentation/desync for TLS/HTTP; no
  server. WhiteVPN lists it as optional compatibility.
- **Evidence:** README.
- **Limitations:** not a VPN; may not work against modern stateful filters;
  can break applications.
- **NetPulse implication:** a research probe, not a replacement for an
  encrypted tunnel.
- **License / confidence:** MIT / **Medium**.

### S30 — Geneva

- **URL:** https://github.com/Kkevsterrr/geneva
- **Type / Iran relevance:** automated censorship evasion research / general
- **Date / version:** pushed 2026-10-23; BSD-3-Clause
- **Findings:** genetic algorithm searches packet-manipulation strategies;
  research platform, not a production client.
- **Evidence:** README and paper context.
- **Limitations:** results are target- and time-specific; active manipulation
  can be detected; do not run against third-party infrastructure.
- **NetPulse implication:** use only in an authorized lab to generate
  hypotheses; do not ship a strategy without field validation.
- **License / confidence:** BSD-3-Clause / **Medium**.

## D. Standards and TLS/DNS primitives

### S31 — RFC 8446, TLS 1.3

- **URL:** https://www.rfc-editor.org/rfc/rfc8446.html
- **Type / relevance:** standards track / general
- **Findings:** TLS 1.3 encrypts handshake messages after ServerHello; SNI is
  still in ClientHello unless ECH is used; 0-RTT has weaker replay/forward
  secrecy properties; record lengths are not hidden.
- **Evidence:** Sections 1.2, 2, 4.1.2, 8.
- **Limitations:** specification, not deployment.
- **NetPulse implication:** TLS 1.3 alone does not hide SNI; do not claim it
  does.
- **License / confidence:** IETF / **High**.

### S32 — RFC 8484, DoH

- **URL:** https://www.rfc-editor.org/rfc/rfc8484.html
- **Type / relevance:** standards track / general
- **Findings:** DoH maps DNS to HTTPS; protects on-path DNS from tampering;
  does not provide DNSSEC integrity by itself; bootstrap and HTTP correlation
  remain; HTTP/2 recommended.
- **Evidence:** Sections 1, 5, 8, 9.
- **Limitations:** a DoH endpoint can still be blocked or be malicious; DoH is
  not a tunnel.
- **NetPulse implication:** use DoH for resolver integrity, but verify the
  resolver and bootstrap separately; do not label it a DNS tunnel.
- **License / confidence:** IETF / **High**.

### S33 — RFC 9250, DoQ

- **URL:** https://www.rfc-editor.org/rfc/rfc9250.html
- **Type / relevance:** standards track / general
- **Findings:** DNS over QUIC on UDP/853; privacy similar to DoT; lower
  head-of-line blocking; spec explicitly does not attempt to evade middlebox
  classification.
- **Evidence:** Sections 1, 3.3, 4.1.1.
- **Limitations:** UDP/QUIC may be blocked; no anti-classification guarantee.
- **NetPulse implication:** optional encrypted DNS transport, not a
  censorship-resistant data plane by itself.
- **License / confidence:** IETF / **High**.

### S34 — RFC 9849, ECH

- **URL:** https://datatracker.ietf.org/doc/rfc9849/
- **Type / relevance:** standards track / general
- **Findings:** ECH encrypts ClientHelloInner under a server public key
  advertised via HTTPS/SVCB (RFC 9460); protects SNI and ALPN; requires
  ECH-capable client-facing server; does **not** hide the destination IP or
  plaintext DNS; rejection/retry behavior is part of the protocol.
- **Evidence:** Abstract, Sections 1, 3, 4, 6.1.3, 8, 10.
- **Limitations:** deployment and middlebox support vary; ECH is not a
  replacement for a VPN and does not by itself provide a tunnel.
- **NetPulse implication:** ECH is a future TLS-metadata improvement, not a
  current REALITY feature; do not advertise it without an ECH-capable
  deployment.
- **License / confidence:** IETF / **High**.

### S35 — Cloudflare ECH explainer

- **URL:** https://blog.cloudflare.com/encrypted-client-hello/
- **Type / relevance:** engineering explainer / general
- **Findings:** clear explanation of ClientHelloOuter/Inner, ECHConfig via
  DNS HTTPS records, DoH dependency, and traffic-analysis/padding caveats.
- **Evidence:** article sections "The ins and outs of ECH", "Road ahead".
- **Limitations:** vendor explainer; not a deployment measurement for Iran.
- **NetPulse implication:** reinforces that ECH alone does not hide IP or
  make a connection unblockable.
- **License / confidence:** Cloudflare blog terms / **High** for protocol
  explanation.

## E. What is still missing

The registry is intentionally not padded with unrelated projects. A complete
Iran-focused corpus still needs: current (2024-2026) OONI/IRBlock data
analysis, a parsed FOCI 2026 paper, first-hand measurements from at least one
voluntary Iranian fixed/mobile vantage, and a license review of the WhiteDNS
Desktop/CottenDNS aggregate. Until then, the engineering conclusions are
conditional.
