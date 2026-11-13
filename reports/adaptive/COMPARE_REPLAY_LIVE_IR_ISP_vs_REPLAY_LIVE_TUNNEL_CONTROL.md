# Field vantage comparison: AS16322 Tehran, raw path vs AS16322 Tehran, via tunnel

generated: 2026-10-28T18:50:32.014Z

**Kind:** same corpus, different arm — raw-ISP path vs tunnel path on this network (NOT a different ISP)

| | A | B |
| --- | --- | --- |
| label | AS16322 Tehran, raw path | AS16322 Tehran, via tunnel |
| file | `reports/adaptive/REPLAY_LIVE_IR_ISP.json` | `reports/adaptive/REPLAY_LIVE_TUNNEL_CONTROL.json` |
| measured | 2026-10-27T13:10:54.380Z | 2026-10-27T13:17:58.954Z |
| arm | isp (raw path) | control (through tunnel) |
| attempts | 22/36 ok (61.1%) | 29/36 ok (80.6%) |

## Adaptive arm, side by side

| metric | A | B | delta |
| --- | --- | --- | --- |
| episodes | 15 | 15 | 0 |
| successRate | 53.3% | 80% | +26.7% |
| firstChoiceRate | 46.7% | 66.7% | +20% |
| meanAttempts | 1.13 | 1.13 | 0 |
| p50MsToWorking | 1381ms | 903ms | -478ms |
| p95MsToWorking | 12926ms | 9246ms | -3680ms |
| wastedAttempts | 7 | 5 | -2 |
| adaptiveWins | 1 | 0 | -1 |
| adaptiveLosses | 0 | 0 | 0 |

## Outcome agreement

- compared pairs (node + engine present in both): **33**
- agree: **25** (75.8%) — 20 worked on both, 5 failed on both
- flips: **8** — 2 worked only on A, 6 worked only on B

### Flips

| node | corpus id | engine | worked on | A ms | B ms | error on the failing side |
| --- | --- | --- | --- | --- | --- | --- |
| line 12 (vmess) | `file:11` | xray | B | 8086 | 823 | probe timed out |
| vps-vless-2053 | `file:12` | xray | B | 8093 | 3476 | probe timed out |
| vps-trojan-2087 | `file:13` | v2ray | B | 8087 | 1360 | probe timed out |
| vps-vless-2053 | `file:2` | xray | A | 1381 | 8096 | probe timed out |
| vps-trojan-2087 | `file:3` | v2ray | B | 8093 | 1341 | probe timed out |
| vps-vless-443 | `file:5` | xray | B | 8172 | 1911 | probe timed out |
| vps-vless-2053 | `file:7` | xray | A | 1101 | 8088 | probe timed out |
| vps-trojan-2087 | `file:8` | xray | B | 8091 | 846 | probe timed out |

## Reading

Same corpus, different arm: this measures what the **path** changes on one network (raw ISP route vs the tunnel), not what a different ISP does. A different ISP needs its own field run (`npm run field:iran -- -Tag <vantage>` on that network) and its own comparison.

No cause is claimed: a flip is a pair that behaved differently, not proof that filtering caused it. The shared limitations of both runs are listed below.

- counterfactual replay over recorded outcomes; the network at the time is not reproduced
- an episode is excluded when a policy wants an (node, core) outcome the corpus does not hold
- accuracy of a probability from fewer than MIN_SAMPLES observations is not claimed by the engine itself

