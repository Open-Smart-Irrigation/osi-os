# Rainfall instrument contracts

One entry per rain instrument the edge ingests. Each entry says where the instrument's measurement rules live.

| Instrument | Device type | Contract |
|---|---|---|
| Aqua-Scope LoRain tipping bucket | `AQUASCOPE_LORAIN` | [`lorain.md`](lorain.md): truth table `T1` to `T14`, replay fixtures in `scripts/fixtures/lorain-rain/`, test `scripts/test-lorain-rain-contract.js`. |
| SenseCAP S2120 weather station | `SENSECAP_S2120` | The "Rain semantics" section of `.claude/skills/osi-agronomy-sensors-reference/SKILL.md`: measurement 4213 is the cumulative counter that the edge differences; 4113 is rain intensity and is never summed. |
| Dragino LSN50 in MOD9 with a tipping bucket | `DRAGINO_LSN50` | One assumption: 0.2 mm per tip, the Davis 6466M bucket. Other buckets need their own factor, recorded at commissioning. |
