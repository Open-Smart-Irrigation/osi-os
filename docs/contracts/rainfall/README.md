# Rainfall instrument contracts

One entry per rain instrument the edge ingests. Each entry says where the instrument's measurement rules live.

Which rain amount an advice rule uses for a zone day, and what the rule may conclude from it, is the [rain-resolution policy](rain-resolution-policy.md). Edge and cloud advice apply it in the same order.

| Instrument | Device type | Contract |
|---|---|---|
| Aqua-Scope LoRain tipping bucket | `AQUASCOPE_LORAIN` | [`lorain.md`](lorain.md): truth table `T1` to `T16`, replay fixtures in `scripts/fixtures/lorain-rain/`, test `scripts/test-lorain-rain-contract.js`. |
| SenseCAP S2120 weather station | `SENSECAP_S2120` | The "Rain semantics" section of `.claude/skills/osi-agronomy-sensors-reference/SKILL.md`. |
| Dragino LSN50 in MOD9 with a tipping bucket | `DRAGINO_LSN50` | One assumption: 0.2 mm per tip, the Davis 6466M bucket. Other buckets need their own factor, recorded at commissioning. |

The zone-day projection that consumes these instruments, and the rain quality fields the cloud receives with each `zone_daily_environment` row, are in [`zone-day-projection.md`](zone-day-projection.md).
