# SDI-12 external review decisions

The external review found defects in the offline foundation and gaps in the
proposed live transition design. Correct the foundation first. Treat PAYVER tags
as a transport proposal whose application and freshness guarantees still need
evidence; do not activate candidates by observing a tag alone.

This record updates the [preparation design](2026-10-02-sdi12-sensor-expansion-preparation.md).
The [follow-up plan](../plans/2026-10-03-sdi12-external-review-followup.md) scopes
the code correction. Existing live normalization remains unchanged.

The later [Tensiomark investigation](../../devices/tensiomark-output-units-investigation.md)
found a pressure-output manual and a conflicting field order. The approved
[pF preparation](../plans/2026-10-05-tensiomark-pf-preparation.md) supersedes this
record's legacy-preservation decision for Tensiomark: unqualified live inputs are
quarantined, and offline interpretation requires version 3 with explicit ordering.
Other profiles retain the decisions below.

## Findings and dispositions

| External finding | Decision and evidence |
|---|---|
| Tensiomark hPa has no documented basis | Accepted. Version 2 rejects hPa. The ecoTech manual documents pF output; only variant 1 is represented by the current 0..7 profile. |
| Whole-vector range rejection loses useful channels | Accepted with a bounded policy. PR2 per-position and TEROS VWC range failures can return `partial`. All TEROS error codes, non-finite values, framing/count failures and other range failures remain vector-fatal. |
| Configuration hash does not bind rules | Accepted. A separate pinned interpretation digest covers the evaluated rules. The full configuration hash also covers address and depths. Both are content identities, without a claim of device verification. |
| Firmware is a declared string treated as configuration | Accepted. Remove the setting. Identity observations and compatibility checks belong to commissioning; no arbitrary firmware claim can make this preview eligible for acquisition. |
| Generic legacy counts and depths diverge | Reproduced. Limit channel descriptions to valid learned counts; preserve finite 0..500 cm including fractions and zero. Keep Sentek's independent validated depth domain. |
| Tensiomark temperature range is too narrow | Accepted after rendering the manual's technical table. Candidate version 2 uses −40..80 °C. Legacy behavior stays intact. |
| PR2 percent mode cannot be inferred from numbers | Accepted as an evidence limit. A fraction or permittivity can pass the percent range check. The preview remains provisional and cannot enable acquisition. |

Version 2 replaces the unpublished candidate version 1; the resolver refuses
version 1 explicitly. Nothing in this branch has persisted these descriptors or
used them for live ingestion. Existing live profiles are represented as legacy
version 0, preserving their current interpretation.

The [ecoTech manual, May 2014](https://www.stevenswater.com/resources/documentation/Stevens_Tensiomark_Manual.pdf),
§§5.1.5 and 7, supports the pF restriction and temperature correction. Its power
timing and minimum interval prevent reusing the existing Sentek recipe unchanged.
The later [audit reconciliation](../../devices/sdi12-protocol-audit/RECONCILIATION.md)
could not verify this review's original reference to a second circulated manual.
Other published variant-3 bounds conflict; that variant remains outside the
implemented candidate. A proposed 25–30 s power window still requires validation.

The [TEROS manual](https://publications.metergroup.com/Manuals/20587_TEROS11-12_Manual_Web.pdf),
installation system check, expects slightly negative VWC in air. Omitting that
VWC channel while retaining temperature and EC is a software acceptance policy,
not evidence of a broken sensor. The
[integrator guide, page 5](https://publications.metergroup.com/Integrator%20Guide/18224%20TEROS%2011-12%20Integrator%20Guide.pdf)
does not establish independent recovery after any of its error codes, so all
three remain fatal. The equation's RAW-to-calibratedCountsVWC correspondence
still needs release evidence as described in the preparation design.

The [PR2 SDI-12 manual](https://delta-t.co.uk/wp-content/uploads/2016/09/PR2_SDI-12-_User_Manual_version_4_1.pdf),
pp. 31–33 and 49–50, distinguishes measurement modes and describes stale-reading
behavior. The review's approximately −7% air calculation is a derivation, not a
captured response. Do not treat that number as an error sentinel or proof of how
a particular probe behaves. The regression uses it to exercise a range failure.

## Transport decisions before persistence

| Question | Decision for the next design |
|---|---|
| Can PAYVER carry an acquisition discriminator? | Possibly. Preserve legacy 1/2 behavior and design an explicit tag/layout/revision mapping. Unknown tags are quarantined. Do not allocate or send tags in this correction. |
| Does a transition tag followed by a final tag prove all command writes? | No. The first/last frames in this proposal are configuration downlinks. A final tag can arrive after a missing middle command. Treat the bracket as evidence, not a transaction. |
| How is layout selected? | Dragino documents DATAUP as the layout selector and PAYVER separately. An OSI bit partition would be a new convention, not vendor behavior; it needs an explicit supported-firmware and mapping contract. |
| Can counters prove one segmented cycle? | They can reject some mixed cycles. A proposed strict assembler must start at segment 0, check indices/count/tag/layout, and establish counter continuity within a session. The device's actual emission behavior still needs bench evidence. |
| What does a confirmed-downlink ACK prove? | Radio acknowledgement only. Capture it as `frames_acknowledged`, correlated to queue item and apply attempt. Keep tag observations separate. Neither establishes probe settings or sample freshness. |
| Can tag values be reused? | Not merely because an apply completed. A finite byte space requires durable mapping lifetime, session/epoch handling and exhaustion behavior. Old/delayed observations must never resolve to a new meaning under a reused tag. |
| Should acquisition and presentation identities split? | Yes, conceptually: a depth-only edit need not send commands. Both records must be immutable, and each accepted observation must retain its chosen metadata revision. Wall-clock effective time alone cannot disambiguate delayed observations. |
| What is the first persistence boundary? | An edge-local sidecar keyed by `device_data.id`, committed with the measurement. No early canonical history hash or cloud contract change. |

[Dragino's converter manual](https://wiki.dragino.com/docs/LoRaWAN-End-Node/io-controllers-sensor-nodes/sdi-12-lb/)
documents separate DATAUP and PAYVER settings and shows a configurable PAYVER
value. It does not establish atomic application of a command sequence, a sample
cycle identifier or buffer flushing on a PAYVER write. A manually changed command
slot retaining the same tag is also undetectable through that tag.

[ChirpStack event documentation](https://www.chirpstack.io/docs/chirpstack/integrations/events.html)
defines the confirmed-downlink `ack` event. It is distinct from `up`, and cannot
replace application readback. Current commissioning polls queue disappearance;
it must not promote that observation to command execution. Queue removal on
failure/expiry also needs confirmation against the deployed ChirpStack version.

ACK ingestion would require an explicit revision of the repository's MQTT IN
topic rule, its verifier and documentation. The existing rule permits only
`application/+/device/+/event/up`. Any exception must be limited to the required
local ChirpStack event and preserve dynamic application IDs and device filtering;
it is unrelated to the edge-only direction of cloud MQTT.

## Concrete failure scenarios to simulate next

1. Apply transition tag, miss a command-slot write, then apply the final tag.
   The desired revision must remain ineligible despite that final tag.
2. Complete an apply while an old measurement or its remaining fragments are
   buffered. The newly observed tag must not reinterpret the old values.
3. Lose complementary fragments in two cycles with the same segment count.
   Current reassembly keys on device/count and can combine them within its
   timeout. A stricter assembler must reject the resulting mixed vector.
4. Rejoin/reset while a partial vector exists, reuse a counter after restart,
   or receive out-of-order and duplicate deliveries. Session identity and
   persistent anti-replay state must prevent the old buffer being reused.
5. Exhaust the available tag space, then receive delayed history carrying an
   earlier tag. Reuse must fail closed unless an evidenced epoch disambiguates it.
6. Receive an old sample after a depth edit. Assigning presentation metadata by
   receipt time must not silently label that sample with the new physical depth.
7. Crash after saving an apply attempt or accepting only some queue entries.
   Recovery returns the existing result/evidence without blindly repeating apply.
8. Receive ACKs after timeout, from an earlier apply, or without a known queue
   item. None can advance the current desired revision's state.

The SDI-12 flow currently receives `fCnt` but does not pass it into the
reassembler; the reassembled object also hard-codes PAYVER 2. Preserve original
frame bytes, received tag and counter/session context before that information
is discarded. DevAddr alone is not a durable LoRaWAN session identity. If a
trustworthy session boundary is unavailable, clear/quarantine rather than infer.

Even strict counter continuity is conditional evidence: device status uplinks,
retransmissions and firmware-specific segmentation may interrupt it. Simulations
prove the software's rejection rules, not the converter's generation behavior.

## Persistence and rollout limits

Key the sidecar by the actual measurement row ID. `device_data` does not have
a unique `(deveui, recorded_at)` constraint. Retain raw ASCII and original frame
evidence, revision references, received tag, counters/session context,
disposition and diagnostics in the same transaction as the measurement. A failed
write must leave neither half committed. Retention must preserve the descriptors
referenced by retained observations and clean up sidecars consistently.

Legacy observations keep a null revision and an explicit unverified status.
Do not assign today's descriptor to old history or recalculate clipped Tensiomark
values. Old PR2 recipes may have acquired a different quantity; neither the
current profile selection nor a plausible numeric range repairs that uncertainty.

The edge-local phase leaves existing telemetry hashes and payloads unchanged.
Cloud can continue displaying canonical values but cannot claim revision-specific
depth provenance until the paired schema, history and reader changes arrive.
Ship server support first, capability-gate new commands/events, and test reordered
descriptor/history delivery and older peers before enabling the new contract.

## Work sequence

1. Complete and independently verify the bounded offline correction.
2. Write the transport evidence contract and simulator cases above. Resolve
   ACK integration scope and tag/session lifetime before schema design.
3. Implement edge-local immutable revisions, sidecar and recovery state machine
   against that contract, with candidate live activation still gated.
4. Prepare source-backed dry-run compilers and bench capture/replay checklists.
   Leave undocumented commands or power settings unavailable.
5. Build the local workflow, then the paired cloud contract and presentation.

Bench evidence remains necessary for accepted PAYVER values, downlink ordering
and application, segmentation counters, startup behavior and fresh-cycle
boundaries. Tensiomark response order/errors and HydraScout's command/quantity
map still require vendor evidence. No manufacturer messages were sent.
