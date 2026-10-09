# LoRain rain replay fixtures

Each file pins one or more rows of the truth table in `docs/contracts/rainfall/lorain.md`. `scripts/test-lorain-rain-contract.js` replays every frame through the shipped codec (`aquascope_lorain_decoder.js`, canonical bcm2712 profile) and checks the decoded amounts and the expectations below. Fixtures describe the contract; they are not field captures.

## Fields

| Field | Meaning |
|---|---|
| `id` | Short name, unique across the directory. |
| `truthRows` | Truth-table rows the fixture pins (`T1` to `T16`). |
| `description` | The situation in one or two sentences. |
| `config` | What the backend has recorded before the first frame: `conf_interval` and `conf_heartbeat` from earlier `0x04` blocks (null when none), and `firmwareRevision` (`unknown` for every fixture today). |
| `promotedConfig` | What promotion assumes for the right-hand column: `conf_interval` 900 and `conf_heartbeat` 16 from the device's `0x04` reply, and `fPort` 2, the only port a pinned source covers. Frames on another port are never promoted (`t15`). |
| `frames[]` | Uplinks in arrival order, as ChirpStack delivers them. |
| `frames[].deduplicationId` | ChirpStack's event identity. A repeated value is a duplicate delivery. |
| `frames[].devAddr`, `frames[].fCnt` | Session address and frame counter. A new `devAddr` or a falling fCnt is a new session. |
| `frames[].time` | Reception time (UTC, ISO 8601). |
| `frames[].fPort` | 2, the port of the pinned vendor revision; 10 in `t15`, which pins the unpinned-build outcome. |
| `frames[].bytesHex` | The payload. Loop frames use the pinned revision's layout: uptime `06 03`, temperature `06 01`, rain tips `06 81`, battery `12`. Configuration (`04 <index> HH LL`), firmware (`0a`), hardware (`03`) and alarm (`0b <status> 03 HH LL`) blocks appear where that revision sends them. Null when `object` is given. |
| `frames[].object` | A decoded object that replaces the codec output. Used only for values the codec cannot emit (`t12`). |
| `expect.observations[]` | One entry per frame, by `frameIndex`. |
| `.counted` | Whether the frame's amount is additive. |
| `.tips`, `.amount_mm` | Raw tips (also for frames that are not counted) and the additive amount (tips × 0.5 mm, null when not counted). Tips are the sum of every `06 81` block in the payload. |
| `.codec_tips` | Only on a frame with more than one rain block (`t16`): what the current codec reports, which is the last block alone. When the codec learns to sum the blocks, this field and the test change together. |
| `.frame_kind` | `ordinary`, `heartbeat_zero`, `button`, `alarm`, `config` or `status`. |
| `.interval_basis` | Basis while the installed revision is unknown (the received-only state). Always `unknown` in these fixtures. |
| `.interval_basis_promoted` | Basis after automatic promotion under `promotedConfig`, assuming the fixture's first frame directly follows a received frame of the same session. |
| `.reason` | The coverage reason code the observation carries after promotion; null when it would count in a certified total. |
| `.fw_version`, `.alarm_value`, `.conf_interval`, `.conf_heartbeat` | Optional decoded values the test also checks. |
| `expect.spans[]` | Silent spans between two frames (`fromFrameIndex` to `toFrameIndex`, in fCnt order): `dry` (row `T13`) or `unknown` with a reason (`frame_gap`, `session_reset`, `config_change`, `build_unpinned`, `multi_block`). |

## Identifiers

All identifiers are synthetic: `deduplicationId` values `00000000-0000-4000-8000-0000000000NN`, `devAddr` values `0N0000NN`. Never add a real device EUI, address, key, session identifier or a raw operational capture. Real frames used to check the contract stay in private records.
