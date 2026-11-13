# DNS leak measurement (tunnel-up)

measured: 2026-10-28T18:45:43.9071053Z

Tunnel: interface `happ-xray` (ifIndex 18), egress 83.229.87.141 DE (colo FRA)

| resolver | configured on | route interface | answers | resolver echo | verdict |
| --- | --- | --- | --- | --- | --- |
| 1.0.0.1 | Local Area Connection 3, Ethernet, Local Area Connection (+5 more) | happ-xray | True | 172.71.140.37 | answered-through-tunnel-path |
| 1.1.1.1 | Local Area Connection 3, Ethernet, Local Area Connection (+5 more) | happ-xray | True | 172.71.140.37 | answered-through-tunnel-path |
| 172.19.0.2 | happ-xray | happ-xray | True | 172.71.140.37 | answered-through-tunnel-path |
| 192.168.1.1 | Ethernet | Ethernet | False |  | off-tunnel-unreachable |

System resolution (example.com): 172.66.147.243

Fail-open surface (public resolvers on physical adapters): 1.0.0.1, 1.1.1.1, 192.168.1.1

**Verdict:** NO LEAK OBSERVED: every answering resolver routes through the tunnel