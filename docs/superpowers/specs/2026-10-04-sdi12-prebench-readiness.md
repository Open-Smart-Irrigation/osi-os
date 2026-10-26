# SDI-12 preparation before bench testing

Prepare the acquisition and product paths offline, then use the bench to check
device-specific behavior against written expectations. One targeted consultation
on transport evidence is useful before persistence design; another general review
of the corrected normalizer is not the next priority.

This is a work programme and acceptance checklist, not a completed implementation
or a command sheet for live hardware. The implemented foundation is `3f806b9ea`.
Its [review decisions](2026-10-03-sdi12-review-decisions.md) remain authoritative.
Exact installed converter firmware, Tensiomark variant and HydraScout model are
unknown unless supplied from existing records.

## Evidence coverage

For each integration claim, record the source URL and edition/firmware, page or
section, the resulting rule, its executable test and remaining uncertainty.
Classify evidence as vendor specification, vendor example, derived expectation,
synthetic case or installed-device capture. These categories are not interchangeable.
Hash downloaded references where retained locally so mutable web pages can be
distinguished; do not assume a newer manual applies to older installed firmware.

| Area | Public evidence to use | Preparation possible now | Evidence still needed |
|---|---|---|---|
| PR2/4 and PR2/6 | [Delta-T SDI-12 manual v4.1](https://delta-t.co.uk/wp-content/uploads/2016/09/PR2_SDI-12-_User_Manual_version_4_1.pdf), command and calibration tables | Command-mode/readback model, four/six-position contracts, multi-response transcripts, compiler budgets and negative tests | Installed command coefficients, actual response lengths, power timing and stale-reading behavior |
| TEROS 11/12 | [Integrator guide revision 12](https://publications.metergroup.com/Integrator%20Guide/18224%20TEROS%2011-12%20Integrator%20Guide.pdf) and [user manual](https://publications.metergroup.com/Manuals/20587_TEROS11-12_Manual_Web.pdf) | Separate model compilers, source-count conversion, sentinels, startup/address handling and independent expected values | Applicable firmware, RAW-field equivalence confirmation and installed response/error captures |
| Tensiomark | [ecoTech May 2014 manual](https://www.stevenswater.com/resources/documentation/Stevens_Tensiomark_Manual.pdf), §§5.1.5 and 7 | Variant-1 pF contract, warm-up/measurement budget, minimum interval, electrical budget and timeout tests | Installed calibrated variant, unambiguous D-response ordering, error values and cold-start capture |
| HydraScout | [Banner application note Rev. A, 2015](https://info.bannerengineering.com/cs/groups/public/documents/literature/b_4182045.pdf), plus model-specific HSTI material when available | Grouped-response test scenarios, depth/channel capacity checks and rejection of unsupported mappings | Authoritative command table, installed model, depth count/order, units, salinity meaning, errors and timing |
| Converter | [Dragino SDI-12-LB/LS manual](https://wiki.dragino.com/docs/LoRaWAN-End-Node/io-controllers-sensor-nodes/sdi-12-lb/), §§2.3, 2.6.4 and 3 | Firmware capability matrix, command/cut emulator, raw-frame parsing, payload budgets and failure simulator | Installed firmware's ordering, retry/buffer behavior, tag semantics and power behavior |
| Shared protocol | [SDI-12 specification 1.4, 2023 correction](https://www.sdi-12.org/current_specification/SDI-12%20Specification%201.4%20February%2020%202023.pdf) | Address/number/framing rules, announced waits, M/C response limits, D-block assembly and CRC cases | Whether each probe implements the selected command family as documented |
| LoRaWAN integration | [ChirpStack events](https://www.chirpstack.io/docs/chirpstack/integrations/events.html) and installed-version source | ACK correlation, session/counter preservation, queue failure/recovery and duplicate delivery cases | End-device behavior after radio acknowledgement; the event itself does not prove application |

The public Dragino TEROS example includes serial and uplink screenshots. The
identity shows firmware `112` (1.12), and its sample payload includes identification
text and addressed measurement data. Label transcribed fixtures as vendor examples
for that version, not our captures or validation of the current candidate.
The current manual also documents 15 command slots and firmware-1.3.2 NEWLINE
support, while our compiler intentionally uses eight slots. Audit these differences
before considering a firmware-specific extension; neither is proof of cycle identity.

Banner's tables suggest separate moisture and temperature groups. They do not
justify the deployed HydraScout interleave or define its conductivity semantics.
Keep its candidate unavailable until the missing model contract is supplied.

## Work packages and acceptance

### 1. Close documentation gaps and draft vendor questions

Create the claim-to-source/test ledger and record conflicting editions. Retire
copyable recipes that contradict the manuals; the PR2, Tensiomark and HydraScout
sections of `docs/devices/dragino-sdi12.md` are corrected in this preparation.
Do not replace them with invented settings merely to make the guide look complete.

Prepare exact questions for Dragino about command application/readback, retries,
buffers and tag behavior; for METER about the named raw field and error scope;
for ecoTech about variant, response order and errors; and for HSTI about the
complete installed-model protocol. Sending requests requires separate instruction.

Acceptance: every compiler parameter is either supported by a named source or
explicitly unresolved. Missing HydraScout documentation does not block PR2/TEROS.

### 2. Specify and simulate acquisition evidence

The first executable slice is the [transport replay lab](../../devices/sdi12-transport-lab.md).
It compares the shipped codec/assembler with an offline candidate, including cases that still
defeat counter/session inference. It does not implement configuration transaction
correlation, tag allocation, or durable session evidence. The
[parallel research prompt](../../devices/sdi12-external-research-prompt.md) assigns
sensor-specific protocol evidence without overlapping the shared transport work.

Reproduce the existing mixed-cycle defect in a regression harness. Evaluate
counter/session checks, tag mappings and conservative rejection policies using
the failure scenarios in the review decisions. Do not make persistent revisions
depend on an unproven tag protocol.

Include an explicit PAYVER-by-DATAUP matrix: the existing decoder's 1/2 layout
convention must not silently become an arbitrary-tag decoder. Test unsupported
values and every proposed mapping. Use concrete ChirpStack `up`, `ack` and `txack`
fixtures for missing/negative acknowledgement, duplicate/late events, counter
discontinuity and session changes. Gateway transmission, device acknowledgement
and converter application are separate facts. Any ACK subscription needs a
deliberate change to the repository's current MQTT IN `event/up`-only rule.

Acceptance: incomplete apply, missing middle commands, late frames, complementary
segment loss, duplicates, session resets, restart and exhausted tags cannot make
an observation eligible for a different interpretation. The design states which
properties are proven by software, assumed from vendor behavior or still unknown.

Request one focused external consultation at this point. Give the consultant the
evidence ledger, alternative designs, minimal failure transcripts and explicit
questions below. Ask for counterexamples and a recommendation, not a fresh survey.
Independent internal reviews continue for implementation changes.

Source transcription, independent calculations and dry-run recipe fixtures can
proceed while that consultation runs. Only work whose schema or activation rules
depend on the unresolved transport guarantees must wait for the decision.

### 3. Build source-backed recipe previews and a converter emulator

The [protocol preview](../../devices/sdi12-protocol-preview.md) is the first
framing/capacity slice. Its [audit reconciliation](../../devices/sdi12-protocol-audit/RECONCILIATION.md)
records the evidence limits that recipe generation must preserve. Converter
wrappers and command timing are not emulated by this parser.
The [converter preview](../../devices/sdi12-converter-preview.md) adds single-frame
wrapper inspection, a bounded serialization model and an explicit response-binding
bridge. DATAUP=1 remains diagnostic; command execution, timing and cuts are not
emulated yet.
The [sensor recipe preview](../../devices/sdi12-recipe-preview.md) now generates
source-cited logical commands and validates supplied transcripts against model
counts and caller budgets. It leaves fixed converter slots, timing and candidate
normalization unavailable; the remaining acceptance work below still applies.

Compile addressed commands, retrieval blocks, delays, power settings, cuts and
payload options from a validated descriptor. Emit a readable dry-run report and
exact bytes. Preserve verified Sentek output. Refuse unsupported capabilities.

Run synthetic probe replies through command sequencing, cuts and payload creation,
then through the actual codec/reassembler/normalizer. Vary sign, digit width,
decimal precision, error values, empty replies and D-block boundaries. Fixed cuts
must not pass only because one attractive sample happened to have the right length.
Model documented behavior and separately label hypothetical behavior branches.

Acceptance: independent calculations and vendor transcripts agree with supported
paths; malformed or ambiguous responses are rejected. Budget command slots,
maximum reply lengths, regional/data-rate payload limits, retries, startup power
and reporting interval. Emulator success is not firmware conformance evidence.

### 4. Complete storage and user workflows offline

Implement immutable revisions and atomic provenance storage using the approved
transport contract. Exercise save/apply separation, restart recovery, rollback,
idempotency, legacy upgrade and historical depth labeling against temporary DBs.
Use the real ingestion path in tests, rather than ending at the normalizer.

Build local setup, cards, histories and exports with synthetic API data. Test
never-observed channels, real zero, partial readings, stale readings and diagnostic
states. Then complete the paired cloud contract with server-first compatibility,
reordered events and offline catch-up tests. Candidate hardware activation remains
disabled until evidence permits it.

Acceptance: configuration and a replayed supported sample traverse the actual
storage/API/UI/export path. Existing devices and history survive upgrades. Cloud
displays only provenance its negotiated contract actually carries.

### 5. Deliver a repeatable bench package

The [capture package](../../devices/sdi12-bench-capture.md) supplies local templates,
serial timing checks, single-uplink byte comparisons and per-model procedures.
It preserves incomplete/failed observations and leaves qualification false.
Stored-row/API/UI evidence and transport freshness remain outside its checker.

Prepare a per-model script/checklist with exact identity and configuration reads,
expected replies, capture locations, comparison calculations and stop conditions.
Separate read-only discovery from explicit configuration writes. Include converter
console output, raw SDI-12 replies, complete LoRaWAN frames, counters/session data,
and the resulting stored row and UI output in one evidence record.

Arrange cold start, normal cycles, no response and interrupted configuration tests
in advance. Respect sensor minimum intervals; shorter radio intervals must not
silently trigger measurements faster than permitted. Use console/serial capture
where available to avoid debugging solely through slow Class A downlink cycles.

Acceptance: adding a bench capture to the replay corpus requires no parser or
test-harness rewrite. Hardware discoveries change a bounded profile/recipe or
invalidate an explicit assumption, rather than forcing a database/UI redesign.

## Questions for the targeted consultation

1. Under documented Dragino behavior, what is the strongest defensible acquisition
   guarantee? Compare bracketed tags plus acknowledgements, an operator-confirmed
   readback procedure, and keeping automatic transitions unavailable.
2. Which counter/session conditions prevent the known mixed-cycle case, and which
   counterexamples survive them? Define the conservative rejection behavior when
   the required evidence is absent.
3. Is there a documented way to retain command boundaries or retrieve converter
   configuration that reduces ambiguity? Account for firmware-specific features
   and variable-length replies; do not assume a firmware upgrade.
4. Which observations must be retained to support rollback and future reprocessing
   without reinterpreting delayed data? Review revision and tag lifetime limits.
5. Which remaining questions are answerable from public documentation, which need
   a vendor response, and which actually require our physical devices?

The consultation is complete when every proposed guarantee has a source or an
explicit assumption, counterexamples have defined outcomes, and remaining bench
questions have a capture procedure. A second broad review is warranted only if
that process exposes a materially different design.

Independent readiness review found no blocking concerns. It requested the
explicit PAYVER/DATAUP and ChirpStack event matrices now included above. This
document changes no runtime behavior; prose lint and whitespace checks passed.
