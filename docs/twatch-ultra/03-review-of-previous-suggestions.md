# Review of the previous suggestions

Date: 2026-09-01. Inputs: the previous proposal ("OSI Field Companion" with "LoRa
Surveyor" as its first application, reproduced as Appendix A of the project brief), the
independent use-case analysis ([01-independent-use-case-analysis.md](01-independent-use-case-analysis.md)),
the hardware feasibility research ([02-hardware-feasibility.md](02-hardware-feasibility.md)),
and a sweep of the osi-os and osi-server repositories for existing integration surfaces.

## How anti-anchoring was executed

The independent analysis was written by an agent whose context contained the OSI mission
documents, the repository, and provisional hardware assumptions, and did not contain
Appendix A or the instruction that the first release must be a network tester. Its
conclusions are therefore evidence, not compliance: where it converges with Appendix A,
two separate analyses reached the same place; where it diverges, the difference needs a
reasoned verdict rather than a merge. This document supplies those verdicts.

The headline result is convergence on the core. The independent analysis ranked LoRa
site survey and coverage mapping first out of eleven candidate use cases without knowing
it was the required capability, on the grounds that it needs no hub changes in v1,
replaces the RAK10701 field tester the fleet already provisions, and funds the base
firmware every other feature rides on. The previous proposal's product identity survives
review; several of its methods survive with modification; three of its secondary uses do
not survive at all.

## What each analysis found that the other missed

Ideas that emerged independently in both: survey as the flagship capability; OTAA join
testing; `LinkCheckReq` as a primary measurement; unconfirmed uplinks for bulk samples;
maps rendered in OSI OS rather than on the watch; the watch as a normal ChirpStack
device; actuation only as a hub-validated request; rejection of repeater and
farmer-smartwatch ideas; offline operation as a core requirement.

Ideas found only in Appendix A, all of them methodological: logging every planned
transmission locally before transmitting; matching those local attempts against server
receptions after the survey; recording missing packets as first-class data; the named
mode set (stationary benchmark, gateway-overlap, target-device emulation); GeoJSON and
CSV as the export formats; the map-layer list; recording installation depth during
commissioning. The attempt-before-transmit method is the single most valuable item in
Appendix A. The independent analysis proposed live `LinkCheckReq` readouts and GNSS logs
but never closed the loop on packets the network could not report because it never
received them. Without the attempt log, a coverage map is a map of successes and cannot
show a dead zone as anything but absence of data.

Ideas found only in the independent analysis: the offline alert receiver as the reason a
super-user wears the watch daily; emergency stop as the first actuation-shaped feature,
chosen because stopping is the fail-safe direction; trench verification paired with the
existing `SET_LSN50_*` cadence commands; the RAK10701-replacement economics (roughly USD
14k of hardware across the 2030 roadmap against the cost of repeat site visits); an
explicit exit clause tying the go decision to developer capacity rather than hardware
appeal.

Ideas neither analysis had, surfaced by the repository sweep and the hardware research:

- The hub already runs a complete field-tester backend. `@rakwireless/field-tester-server`
  v0.2.4 is wired into `flows.json` (node id `95ced3f73fa8a692`, parser `cs34`), decodes
  the disk91 WioLoRaWANFieldTester payload, stores per-gateway RSSI/SNR in
  `field_tester_rxinfo`, stores GPS fixes in `field_tester_uplinks`, answers each uplink
  with a downlink carrying sequence number, min/max RSSI, min/max gateway distance and
  gateway count, and serves a CSV export at `GET /download-fieldtest`. `chirpstack-bootstrap.js`
  provisions the matching application and device profile on every gateway. A watch that
  speaks this existing protocol gets live on-wrist gateway feedback with zero hub
  changes. Neither Appendix A nor the independent analysis knew this existed.
- The RF switch is a data-integrity hazard. `LORA_SEL` sits on an I2C expander, and a
  wrong or stale switch state routes transmit power into a mismatched path, producing a
  survey that understates coverage everywhere while looking like real data
  (02-hardware-feasibility, "Showstopper risks").
- RadioLib ships with duty-cycle enforcement off by default, and a survey is precisely
  the application that breaches the EU868 1% limit without it.
- EU868 gateways are half-duplex. Every downlink the survey requests punches a hole in
  the gateway's uplink reception for the whole farm network, which turns "keep downlinks
  sparse" from politeness into an operational requirement.

## Verdicts on the survey capability (A.1)

| Suggestion | Verdict |
|---|---|
| Test the complete LoRaWAN service, not raw signal strength | Accept |
| Quick probe mode | Accept |
| Walk survey mode | Accept |
| Stationary point benchmark mode | Accept |
| Bidirectional uplink/downlink test | Accept with modification |
| Gateway-overlap test | Accept with modification |
| Target-device emulation | Accept with modification; fidelity claims require measurement |
| OTAA join testing | Accept with modification |
| Unconfirmed uplinks for most route samples | Accept |
| Periodic confirmed uplinks or application acknowledgements | Accept with modification |
| `LinkCheckReq` / `LinkCheckAns` | Accept |
| ChirpStack reception metadata | Accept |
| Local storage of every attempt before transmitting | Accept, as a hard requirement |
| Post-survey matching of attempts against receptions | Accept |
| Recording missing packets | Accept |
| GeoJSON and CSV export | Accept |
| Detailed maps in OSI OS, not on the watch | Accept |

**End-to-end service testing.** Accepted, with the layer discipline made explicit in the
section below. The suggestion is right that raw LoRa RSSI is not a service measurement;
the design must equally resist the opposite collapse, where "coverage" silently comes to
mean "uplink delivery" and downlink reliability goes unmeasured. The MVP design defines
the tested layers one by one (05-mvp-design, section "What a network test means").

**Quick probe, walk survey, stationary benchmark.** Accepted as the minimum mode set.
The stationary benchmark earns its place through the hardware finding that a wrist-worn
watch and a mounted actuator see different channels: the benchmark mode is the one where
the operator places the watch at the planned mounting position and height, steps away,
and lets it run, which no phone-centric method reproduces.

**Bidirectional test.** Accepted with two modifications. First, downlink success is
sampled, not measured continuously: the gateway half-duplex cost and the EU868 duty
budget on the RX2 sub-band make per-sample downlinks unaffordable, so the mode requests
a downlink for one sample in N and reports downlink statistics with their own, smaller,
sample count. Second, the primary downlink vehicle is the application-layer response the
existing field-tester backend already sends, not LoRaWAN confirmed uplinks; the
confirmed-uplink machinery retransmits on a missing acknowledgement, which corrupts the
packet-delivery statistic the survey exists to compute.

**Gateway-overlap test.** Accepted as an analysis, rejected as a transmission mode.
ChirpStack's `UplinkEvent.rx_info` carries every receiving gateway for every uplink, so
gateway overlap falls out of the ordinary walk survey at zero marginal airtime; on the
watch, the live gateway count arrives in `LinkCheckAns` and in the field-tester
downlink. A separate mode transmitting extra frames to measure overlap would spend duty
cycle to learn what the stored data already shows. What survives is a map layer and a
filter, not a mode.

**Target-device emulation.** Accepted for radio parameters, bounded for physics. A
profile can honestly reproduce a target device's data rate, transmit power, payload
length, uplink interval and acknowledgement pattern. It cannot reproduce the antenna,
the enclosure, the mounting height, soil proximity or canopy, and the hardware research
adds a sharper limit: the watch's own antenna is an uncharacterised element soldered to
a test point, so the watch's absolute numbers do not transfer to any other device even
at identical radio settings. Emulation is therefore presented as "the watch, configured
like device X, at position Y", never as "device X would see this". Calibrating a
per-profile offset against a real reference device is listed in the test plan and is a
measurement task, not a design assumption.

**OTAA join testing.** Accepted as a deliberate, operator-triggered mode rather than a
per-survey routine. Every join consumes a DevNonce from a monotonically growing
sequence, costs several seconds of airtime and receive windows, and churns session state
that the rest of the survey wants stable. The join test earns its keep at
commissioning-shaped moments ("can a device join from here at all"), while route surveys
run on a persisted session. This also disciplines the storage design: nonces and session
state must survive reboot (RadioLib's persistence buffers, demonstrated on this exact
board by LILYGO's own example), or every crash silently becomes a join test.

**Attempt-before-transmit logging.** Accepted and promoted to the load-bearing
requirement of the whole design. The network server cannot report what it never
received; only the watch knows what it tried. Every transmission is assigned its
identity (session, sequence, frame counter) and written to local storage before the
radio is keyed, and the correlation between local attempts and ChirpStack receptions is
the definition of the packet-delivery ratio (05-mvp-design, "Attempt logging and
correlation").

**Exports and mapping split.** Accepted as proposed. The repository sweep adds one
correction to the effort estimate: the React GUI has no map library today, no offline
tile source, and no GeoJSON precedent, so "OSI OS produces the detailed map" is new
surface, not an extension of existing map code. The cloud's only map is the Mapbox-based
Terra field-boundary editor, which is internet-dependent and out of scope for an
offline-first survey view.

## Verdicts on the other suggested uses (A.2)

| Suggestion | Verdict |
|---|---|
| NFC-based asset identification | Defer |
| Device commissioning | Accept (release 2) |
| Recording device location and installation depth | Accept with modification (release 2) |
| Verification of the first device uplink | Accept (release 2) |
| Navigation to field devices | Defer |
| Maintenance history on the watch | Reject |
| Valve service tests routed through OSI hub safety logic | Accept with modification (late release) |
| Short operational dashboard | Reject |
| Gateway-health panel over local Wi-Fi | Reject |
| Maintenance and field-observation logging | Defer |
| OSI Academy installation checklists | Defer |
| Repeatable research survey routes | Accept |
| Haptic alerts | Accept with modification |

**NFC asset identification: defer.** The hardware question resolved in NFC's favour: the
ST25R3916 is a genuine reader/writer across NFC-A/B/F/V, so the capability exists. Three
things still push it out of the early releases. The NFC driver stack (two ST forks under
SLA0052) is the only non-permissive dependency in the whole build, and dropping NFC
makes the firmware cleanly MIT-compatible; the independent analysis ranked the use case
near the bottom on tag logistics and phone substitutability; and the survey MVP has no
need for it. Revisit when commissioning workflows (release 2) create a concrete demand,
and resolve the licence question before linking the stack.

**Commissioning, first-uplink verification, location and depth capture: accept into
release 2.** Both analyses converged on commissioning as the second-strongest use case.
The modification concerns depth: `devices` already carries `chameleon_swt[123]_depth_cm`
columns with a dedicated depth endpoint, so depth capture must write the existing
fields through the existing API rather than inventing a parallel record. Device
location capture at install time reuses the watch's GNSS fix and the existing
lat/lng columns.

**Navigation: defer.** The hardware research removed the feature's main affordance:
there is no magnetometer, so a stationary operator gets no heading, and course over
ground exists only while walking. A bearing arrow that only points while you are
already moving, toward an asset a phone pin also finds, is not worth its screen and
maintenance cost in the first year.

**Maintenance history: reject.** Reading service records is a stationary, two-handed,
decision-making activity that the phone GUI on hub Wi-Fi already serves. The watch
adds a worse screen at the same location. Nothing offline-first argues for it: the hub
is reachable whenever its records are.

**Valve service tests: accept with modification, last.** The suggestion already routes
through hub safety logic, which both analyses require. The modification is ordering and
prerequisites, taken from the independent analysis: a watch-initiated valve open ships
only after the watch identity, revocation and rate-limit machinery has field mileage,
and after the fail-safe-direction feature (emergency stop) has proven the request path.
STREGA rules apply unchanged (`OPEN_FOR_DURATION` only, never a bare close).

**Short operational dashboard and gateway-health panel: reject.** Both collapse under
the same argument. Within Wi-Fi range of the hub, a phone reaching the existing GUI is
a strictly better console; beyond Wi-Fi range, the only channel is LoRa at tens of
bytes per message, which cannot carry a dashboard. What survives of the intent is the
alert channel from the independent analysis: the hub pushes a few prioritised bytes
about conditions worth interrupting a human for, which is a different feature with a
different design and its own release.

**Field-observation logging: defer.** The value case (research ground truth, the
AquaMind data set) is real, but the field journal is cloud-primary in its current
architecture while watch observations arrive at the edge; building the edge-side buffer
table before that architecture settles risks a second migration. Defer until the
journal inversion project lands, then design against its final shape.

**Academy checklists: defer.** Training value is plausible, but a 2-inch touch screen
under sunlight is a poor checklist medium against the Academy's printed materials and
phones, and no evidence yet says trainers want it. What the Academy gets for free in
release 1 is the propagation teaching mode the independent analysis identified: the
survey screen itself, in the hands of a trainee walking away from a gateway.

**Repeatable research routes: accept.** Session comparison is designed into the MVP
data model (two surveys over the same route, diffed by grid cell), and route
repeatability is a documented survey procedure plus a stored route trace rather than
firmware machinery.

**Haptic alerts: accept with modification.** The DRV2605 is a waveform-library haptic
driver, so distinct patterns are cheap. The modification is the discipline the brief
itself demands: haptics confirm local events (sample stored, survey complete, watch
buzzed because a downlink arrived) and never assert remote success. The pattern
vocabulary is defined once in the MVP design and deliberately small.

## Verdicts on the suggested constraints (A.3)

Every constraint in A.3 is accepted. Five deserve annotation rather than a bare accept:

- **"Confirm the exact radio variant"** was executed and returned more than the
  suggestion anticipated: the radio is a swappable module (`HPB16B3` footprint), band
  matching lives inside the module and is undocumented, and LILYGO sells three
  band-specific SX1262 SKUs. The constraint therefore hardens into a per-unit
  identification procedure (02-hardware-feasibility, "Hardware identification
  procedure") and a firmware refusal to record surveys from unidentified units.
- **"Do not assume watch coverage equals sensor or valve coverage"** gains a mechanism:
  target profiles carry the radio-parameter half, the stationary benchmark mode carries
  the position-and-height half, and the uncharacterised watch antenna means absolute
  transfer claims are banned in UI copy and export metadata alike.
- **"Keep downlinks sparse"** gains its real justification: half-duplex gateways serving
  a production sensor fleet, plus the 10% RX2 sub-band budget shared with everything
  else the hub sends.
- **"Keep credentials out of NFC tags, source code, and survey exports"** extends to a
  finding the suggestion could not have known: survey files and exports also must not
  contain the LoRaWAN session keys that RadioLib's persistence blobs hold; those blobs
  live in NVS, never on the SD card a technician might hand to someone.
- **"Keep the data model independent of Node-RED"** has repository precedent to follow:
  `field_tester_uplinks` and `gateway_health_samples` are plain SQLite tables written by
  thin flow nodes, with schema owned by the migration runner. The survey backend
  follows that pattern, with decoding in a versioned plain-JS module under
  `/usr/share/node-red/` rather than logic buried in flow wiring.

## What the proposed survey method actually measures

Appendix A says the survey should test "the complete LoRaWAN service rather than only
raw LoRa signal strength". Accepted, provided the design names its layers, because the
methods on offer measure different things and no single method covers the stack:

| Layer | What proves it | Measured by the MVP? |
|---|---|---|
| Radio transmission attempted | Local attempt record | Yes, always |
| Frame received by ≥1 gateway | ChirpStack uplink event exists | Yes, at sync time |
| Frame received by N gateways | `rx_info` array length | Yes, at sync time |
| Demodulation margin at best gateway | `LinkCheckAns` | Yes, live on the watch |
| OTAA join accepted | Join test mode | Yes, on demand |
| Uplink processed by the survey application | Row in the survey tables, decode status | Yes, at sync time |
| Uplink processed by wider OSI logic | Application-specific | No; out of scope |
| Downlink queued vs transmitted vs received | Queue record vs `txack` vs watch log | Sampled, not continuous |
| Confirmed-frame acknowledgement | LoRaWAN confirmed machinery | No; deliberately avoided in bulk |
| Complete end-to-end service | All of the above for one test point | Composite verdict, shown as separate results |

Two consequences follow. First, the watch's live display and the post-sync analysis are
different measurements: `LinkCheckAns` margin and gateway count tell the operator "the
network heard me just now", while packet-delivery ratio exists only after attempts and
receptions are matched. The UI must not present the former as the latter. Second,
"uplink works" and "downlink works" are separate results end to end, with separate
sample counts, and every screen, export and map layer keeps them separate; a green
uplink indicator with an unknown downlink state is displayed as exactly that.

## Consolidated verdict

The previous proposal's core is confirmed by an analysis that did not know about it:
survey first, maps on the hub, hub-mediated everything, trained users only. Its
methodological spine (attempt logging, correlation, missing packets as data) is
adopted wholesale and was the piece the independent analysis lacked. Its secondary
feature list loses three items (dashboard, gateway-health panel, maintenance history),
defers four (NFC, navigation, observations, checklists), and keeps commissioning and
guarded valve testing in later releases. The largest additions come from outside both
documents: the already-deployed field-tester backend that gives release 1 a
zero-hub-change compatibility path, and the hardware findings (RF switch integrity,
per-SKU band matching, duty-cycle default, shared SPI bus) that turn several soft
suggestions into hard requirements.
