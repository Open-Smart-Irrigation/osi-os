# Expert review of the Surveyor screens and firmware core

Date: 2026-09-03. Four independent reviewers with complementary domains judged
the rendered screens, the firmware core, the survey methodology and the
published presentation page. This document records their verdicts and the
disposition of every finding: fixed the same day, queued to the backlog, or
amended with reasons. The fixed items are in `osi-surveyor-fw` (tests first,
387 host checks green, ASan clean) and in the re-rendered screens.

| Reviewer | Domain | Verdict |
|---|---|---|
| Embedded C++ | Core codecs, LVGL layer, tests, build | needs work |
| LoRaWAN expert | ETSI/duty, MAC semantics, methodology honesty | sound with corrections |
| Field UX | Wearable HMI, sunlight, gloves, colour vision | not field-ready |
| Visual design | Screen system, presentation page | inconsistent |

The shared judgment underneath the verdicts: the data layer's honesty
(attempt-before-TX, delivery withheld until correlation, uplink/downlink
separation) held up under all four reviews; the defects clustered in the
display seam and in code the host renderer structurally could not catch.

## Fixed the same day

| Finding (reviewer) | Fix |
|---|---|
| `lv_screen_load` never deletes the outgoing screen: every rebuild leaked ~25 objects, DRAM exhausted within an hour of walking (embedded, blocker) | `load()` helper deletes the previous screen after every load |
| `trace_bars` read past the 20-slot array when `trace_len` overran, and a third negative sentinel produced negative heights (embedded, blocker) | `kTraceCap` clamp in the model and renderer; negative sentinels normalised |
| Touch-target arithmetic wrong 3× ("56 px ≈ 12 mm"; it is ~4.5 mm at ~315 ppi) and no button path could start a survey (field UX, both blockers) | Spec corrected; button navigation added as the guaranteed path (BOOT cycles focus, side button opens) with a visible focus ring; touch demoted to fast path |
| `decode_ack` accepted a 20-byte SAMPLE as a valid 8-byte ACK, turning any spoofed downlink into a survey verdict (embedded) | Exact-length requirement; test proves a SAMPLE is rejected |
| `TX_RESULT.duty_wait_ms` was u16 and wrapped on exactly the DR0 refusals it exists to record (embedded) | Widened to u32 on struct and wire; DR0-scale round-trip test |
| DutyBudget wedged for 49.7 days after a clock wrap and its sentinels overflowed the UI's percent math (embedded) | Clock contract documented; future-dated events ignored and pruned; `used_permille` clamped; oversized airtime refused; `band_known`/`is_never` helpers |
| Duty display could show "ready" while RadioLib's flat post-TX interval refused (embedded + LoRaWAN) | The rolling-hour model now floors on RadioLib's global interval; test pins both models to one answer |
| 863–865 MHz band missing from the ETSI table — legal NewChannelReq channels would brick silently (LoRaWAN) | Band K added at 0.1% |
| Raw `const char*` snapshots would dangle across the FreeRTOS queue (embedded) | All view-model strings are fixed in-struct buffers; snapshots are POD copied by value |
| Golden vectors were decorative — nothing executed them — and the sim encoded the wrong RadioLib error (-1105 for -1108) plus SF7 airtime labelled DR3 (embedded + LoRaWAN) | `osv_tool vectors` + `check_vectors.py` wired into `make test`, full framed record pinned with independent zlib CRC verification; sim uses `RADIOLIB_ERR_UPLINK_UNAVAILABLE`, ~206 ms DR3 airtime, and a late-ACK path the echoed-seq machinery exists for |
| Toolchain "pins" tracked upstream HEAD on six libraries; the install script clobbered developer config (embedded) | Every library pinned to a verified SHA/tag, `toolchain.lock` written, RadioLib fallback removed, config no longer overwritten |
| Duplicate, disagreeing battery readouts on live screens (field UX + visual) | Header is the single battery source; the footer line is GNSS-only |
| The hero margin number rendered full green minutes after its LinkCheck (field UX + LoRaWAN + visual) | Age tag ("2 samples ago", warn colour) and grey-out once stale |
| Refused TX pixel-identical to a delivered 0 dB sample; colour-only encodings failed deuteranopia (field UX + visual) | Refused = full-height hollow red mark (form, not colour); 10 dB hairline behind the trace; neutral ticks raised to visible contrast |
| Quick probe's "not heard" claimed a failure direction the radio cannot prove (LoRaWAN) | "reply / no reply", with the caveat line reworded; spec table updated |
| Refused transmissions folded into the success line, count dropped on the summary (field UX) | Separate warn-coloured "refused N" line on walk and summary |
| Design contradicted itself on payload length (19 vs 20 bytes); the worst-case profile was unencodable (LoRaWAN) | Docs and profile example corrected to 20 |
| JoinEvt dropped the DevAddr §7.3 promised as the correlation tiebreaker (LoRaWAN) | DevAddr + epoch starting fcnt added to the record |
| Missing-uplink classifier would misfile hub-side ingestion losses as radio losses (LoRaWAN) | "Delivered, radio-proven" outcome added to §7.3 (watch-side LinkCheckAns/ACK as secondary proof) |
| Status screen unreachable from the home menu; GW 1 rendered as a permanent warning on single-gateway farms; sync silently truncated at 4 rows; invisible progress-bar tracks; six different left rails (visual + field UX) | "Status & settings" row added; GW 1 neutral; "+N more" overflow line; tracks raised to visible contrast; edge/content rails unified |
| Presentation page: red legend dot hardcoded outside the token system (broken in light mode), centered shots against left captions, dead CSS, headline rule contradicted by the screens under it (visual) | `--bad` token in all three theme blocks; shots left-aligned; scaffolding removed; rule restated as it actually holds |
| DR0 walk surveys are legal but statistically empty at walking pace, undisclosed (LoRaWAN) | §7.4 now requires per-profile achievable-cadence disclosure at mode start and sparse-by-construction labelling |

## Backlog (accepted, scheduled into R1 tasks, not this render cycle)

Incremental `update_*()` screen API so live screens stop rebuilding per sample
(the leak fix makes rebuilds safe; the churn remains); error/recovery,
join-test and walk-no-fix screens; the 2 s hold progress ring; a haptic
pattern for GNSS loss during screen-off walks; flex-based layout with string
headroom before the seven-locale translation pass; per-band duty plumbing
behind the "worst band" label; promotion of must-act 14 px text after the
sunlight test on real hardware (E11 has the field check); `txack`
consumption; projected mode duration on profile selection.

## Amended rather than adopted

The field-UX remedy for touch targets (≥137 px rows, three per page) traded a
real defect for a worse information architecture; the adopted fix corrects
the false constant and makes buttons the guaranteed path instead. The
"one glanceable number" rule was restated, not enforced by demotion: it
governs the two measurement screens (walk, point), while list screens rank by
colour and form — the visual reviewer's reading of the original claim was
correct, and the claim was the part at fault.

## Round 2: the fixes handed back to the same panel

All four reviewers re-examined the fixed code and re-rendered screens against
their own findings, instructed to verify empirically and to hunt for
fix-induced defects. All four returned "mostly resolved", and all four found
real problems in the fixes themselves; those were repaired the same day
(tests first, 398 host checks + ASan green, file format bumped to v2 while
nothing has shipped).

| Re-review finding | Repair |
|---|---|
| The RadioLib-floor port under-estimated the real stack interval: RadioLib divides with truncating integer arithmetic, inflating its own wait, and the test pinned the optimistic number under a name claiming parity (embedded) | Formula mirrors the truncation exactly; test expectations re-derived from RadioLib's source arithmetic (6146 / 20485 / 132015 ms) |
| An oversized-but-real transmission was forgotten instead of counted — permissive on a regulatory limit (embedded) | Clamped to the full band budget (saturates), and `record_tx` returns false so the caller files a fault record |
| The clock-regression guard amnestied real airtime (embedded) | Detection also arms a bounded 260 s hold: long enough to cover any outstanding stack interval, no 49-day wedge, no free budget |
| The wire format changed under an unchanged version byte (embedded) | `kFileFormatVersion` bumped to 2 with a dated pre-release note |
| The executable contract omitted exactly the two changed layouts, and its strongest check was skippable (embedded) | TX_RESULT and JOIN_EVT vectors added; every contract key is mandatory and verified fail-closed |
| The unguarded previous-screen delete becomes a use-after-free once event callbacks exist (embedded, latent) | `lv_screen_load_anim(..., auto_del=true)`: LVGL's own guarded delete |
| Sim DR3 airtime still ~17% low, and the late-ACK record stamped the answered sample as its arrival window, so the echoed-seq mismatch was never exercised (LoRaWAN) | 247 ms; frame seq = arrival window, embedded seq = answered sample; the test asserts the mismatch |
| The age tag warned on any age, but ages within the LinkCheck cadence are normal: permanent amber, warn devalued (field UX) | Staleness thresholds scale with the mode's `lc_every`; normal ages render muted |
| The refused trace mark, made full-height for visibility, became the tallest element in a chart where height means quality (field UX + visual) | Low hollow mark: form still carries the distinction, height no longer lies |
| The denser walk card visually merged uplink and downlink; the hairline vanished at page scale; the trace floated off both rails; home dropped to an 8 px gap; probe lost its footer hint and baked an English line break into two labels; summary left its side-button path unhinted (visual + field UX) | Group gap restored; 2 px hairline at higher contrast; trace on the content rail; 12 px home rhythm; single wrapped caveat plus hint; "BOOT: home / side: sync" |

Accepted with reasons, not fixed: RadioLib's `msPerHour` is runtime-mutable
via a server DutyCycleReq while the port's constant is the EU868 default
(backlog, documented at the constant); the visual reviewer's negative-margin
finding misread the contract (`margin_db < 0` is the no-data sentinel, and
LinkCheck margins are unsigned); green-as-healthy on the Status checklist
stays (checklist convention, numerals always adjacent); array-reference
signatures stay deferred on the re-reviewer's own advice; a `-Werror` UI
compile target waits until the pinned LVGL stops emitting deprecation
warnings. Escalated out of the backlog into R1-blocking on the field-UX
re-review's argument: join-test, walk-no-fix and recovery surfaces, plus a
GNSS-loss auto-wake during screen-off walks.
