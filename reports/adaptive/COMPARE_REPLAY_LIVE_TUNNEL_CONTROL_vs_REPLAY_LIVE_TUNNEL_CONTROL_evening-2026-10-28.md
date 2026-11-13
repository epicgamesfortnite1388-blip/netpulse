# Field vantage comparison: AS16322 tunnel control, 13:17Z vs AS16322 tunnel control, 18:52Z

generated: 2026-10-28T18:53:20.873Z

**Kind:** same corpus and same arm — repeatability / time-of-day comparison

| | A | B |
| --- | --- | --- |
| label | AS16322 tunnel control, 13:17Z | AS16322 tunnel control, 18:52Z |
| file | `reports/adaptive/REPLAY_LIVE_TUNNEL_CONTROL.json` | `reports/adaptive/REPLAY_LIVE_TUNNEL_CONTROL_evening-2026-10-28.json` |
| measured | 2026-10-27T13:17:58.954Z | 2026-10-28T18:52:22.193Z |
| arm | control (through tunnel) | control (through tunnel) |
| attempts | 29/36 ok (80.6%) | 29/36 ok (80.6%) |

## Adaptive arm, side by side

| metric | A | B | delta |
| --- | --- | --- | --- |
| episodes | 15 | 15 | 0 |
| successRate | 80% | 66.7% | -13.3% |
| firstChoiceRate | 66.7% | 60% | -6.7% |
| meanAttempts | 1.13 | 1.07 | -0.06 |
| p50MsToWorking | 903ms | 739ms | -164ms |
| p95MsToWorking | 9246ms | 8824ms | -422ms |
| wastedAttempts | 5 | 4 | -1 |
| adaptiveWins | 0 | 0 | 0 |
| adaptiveLosses | 0 | 0 | 0 |

## Outcome agreement

- compared pairs (node + engine present in both): **33**
- agree: **27** (81.8%) — 24 worked on both, 3 failed on both
- flips: **6** — 2 worked only on A, 4 worked only on B

### Flips

| node | corpus id | engine | worked on | A ms | B ms | error on the failing side |
| --- | --- | --- | --- | --- | --- | --- |
| vps-vless-443 | `file:0` | xray | A | 898 | 8243 | probe timed out |
| vps-vless-2053 | `file:2` | xray | B | 8096 | 1946 | probe timed out |
| vps-trojan-2087 | `file:3` | xray | A | 914 | 8064 | probe timed out |
| vps-vless-2053 | `file:7` | xray | B | 8088 | 739 | probe timed out |
| vps-trojan-2087 | `file:8` | sing-box | B | 8106 | 757 | probe timed out |
| vps-trojan-2087 | `file:8` | v2ray | B | 8088 | 1089 | probe timed out |

## Reading

Same corpus, same arm: this is a **repeatability** comparison. Agreement here bounds how much of any difference between two networks can be blamed on the network rather than on the corpus or the moment.

No cause is claimed: a flip is a pair that behaved differently, not proof that filtering caused it. The shared limitations of both runs are listed below.

- counterfactual replay over recorded outcomes; the network at the time is not reproduced
- an episode is excluded when a policy wants an (node, core) outcome the corpus does not hold
- accuracy of a probability from fewer than MIN_SAMPLES observations is not claimed by the engine itself

