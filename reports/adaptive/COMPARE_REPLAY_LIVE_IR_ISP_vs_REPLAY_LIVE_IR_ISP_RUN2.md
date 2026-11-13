# Field vantage comparison: REPLAY_LIVE_IR_ISP vs REPLAY_LIVE_IR_ISP_RUN2

generated: 2026-10-28T18:55:24.193Z

**Kind:** same corpus and same arm — repeatability / time-of-day comparison

| | A | B |
| --- | --- | --- |
| label | REPLAY_LIVE_IR_ISP | REPLAY_LIVE_IR_ISP_RUN2 |
| file | `reports/adaptive/REPLAY_LIVE_IR_ISP.json` | `reports/adaptive/REPLAY_LIVE_IR_ISP_RUN2.json` |
| measured | 2026-10-27T13:10:54.380Z | 2026-10-27T13:12:52.226Z |
| arm | isp (raw path) | isp (raw path) |
| attempts | 22/36 ok (61.1%) | 30/36 ok (83.3%) |

## Adaptive arm, side by side

| metric | A | B | delta |
| --- | --- | --- | --- |
| episodes | 15 | 15 | 0 |
| successRate | 53.3% | 66.7% | +13.4% |
| firstChoiceRate | 46.7% | 66.7% | +20% |
| meanAttempts | 1.13 | 1 | -0.13 |
| p50MsToWorking | 1381ms | 874ms | -507ms |
| p95MsToWorking | 12926ms | 5924ms | -7002ms |
| wastedAttempts | 7 | 3 | -4 |
| adaptiveWins | 1 | 0 | -1 |
| adaptiveLosses | 0 | 0 | 0 |

## Outcome agreement

- compared pairs (node + engine present in both): **33**
- agree: **26** (78.8%) — 22 worked on both, 4 failed on both
- flips: **7** — 0 worked only on A, 7 worked only on B

### Flips

| node | corpus id | engine | worked on | A ms | B ms | error on the failing side |
| --- | --- | --- | --- | --- | --- | --- |
| line 12 (vmess) | `file:11` | xray | B | 8086 | 1058 | probe timed out |
| vps-vless-2053 | `file:12` | xray | B | 8093 | 1111 | probe timed out |
| vps-trojan-2087 | `file:13` | v2ray | B | 8087 | 5905 | probe timed out |
| vps-trojan-2087 | `file:3` | v2ray | B | 8093 | 1113 | probe timed out |
| vps-vless-443 | `file:5` | xray | B | 8172 | 955 | probe timed out |
| vps-trojan-2087 | `file:8` | sing-box | B | 8113 | 928 | probe timed out |
| vps-trojan-2087 | `file:8` | xray | B | 8091 | 874 | probe timed out |

## Reading

Same corpus, same arm: this is a **repeatability** comparison. Agreement here bounds how much of any difference between two networks can be blamed on the network rather than on the corpus or the moment.

No cause is claimed: a flip is a pair that behaved differently, not proof that filtering caused it. The shared limitations of both runs are listed below.

- counterfactual replay over recorded outcomes; the network at the time is not reproduced
- an episode is excluded when a policy wants an (node, core) outcome the corpus does not hold
- accuracy of a probability from fewer than MIN_SAMPLES observations is not claimed by the engine itself

