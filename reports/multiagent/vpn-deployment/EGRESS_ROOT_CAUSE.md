# Egress Path Root Cause

**Status:** NOT ESTABLISHED — requires reproducible experiment.

## Background

Previous reports indicated Xray children and Node/curl use different egress addresses on the same development machine. No repeatable experiment was run in this session.

## Potential Mechanisms (from codebase inspection)

1. **Proxy env vars:** Node/curl may inherit HTTP_PROXY/HTTPS_PROXY; Xray children may not
2. **Interface binding:** egressProxy.ts and proxyEngineRunner.ts bind per-process
3. **TUN/route table:** Xray may use TUN interface; Node/curl use physical interface
4. **Windows routing policy:** WFP rules may route differently per process
5. **DNS/address family:** IPv4 vs IPv6 selection may differ
6. **Parent/child env diff:** spawned Xray children inherit different env

## Required Experiment (not performed)

- Simultaneous timestamped requests from Xray child and Node/curl to same controlled endpoint
- Record observed source IP per process
- Repeat ≥3 times
- Inspect route tables, interface metrics, env diff, TUN state

## Conclusion

**Dual-egress root cause: NOT ESTABLISHED.** Do not attribute to DPI. Treat as unresolved pending reproducible experiment.
