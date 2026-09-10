# T-Watch Ultra for OSI: independent use-case analysis

Status: independent discovery analysis, 2026-08-31. No prior proposal was consulted; a
separate hardware-verification phase runs in parallel. Hardware claims below are
provisional and marked as such. Nothing in this document commits OSI to build anything.

## Summary

The LILYGO T-Watch Ultra earns a place in OSI as a field instrument for the trained
layer of the organisation (installers, super-users, technicians, researchers), and it
earns that place through one capability no phone has: an SX1262 LoRa radio on the
wrist. In OSI's target deployments the hub dashboard is reachable only over IP, which
in practice means standing near the hub or having internet for the cloud mirror. The
LoRa footprint of a hub extends up to 15 km (OSI pitch, slide 6); the IP footprint of
an offline Ugandan hub extends a few tens of metres. Every use case ranked highly
below exploits that gap. Use cases that a phone already covers are rejected, whatever
the watch could technically do.

The recommended product identity: a commissioning and radio-survey instrument first, a
wrist-worn alert receiver second, and a guarded actuation requester last, issued per
super-user rather than per farmer. A farmer-facing OSI smartwatch is explicitly
rejected on cost and interface grounds.

## Hardware baseline

The parallel hardware phase owns verification. This analysis assumes the following,
cross-checked against launch coverage ([CNX Software](https://www.cnx-software.com/2026/04/20/lilygo-t-watch-ultra-an-ip65-rated-esp32-s3-smartwatch-with-2-01-inch-amoled-lora-and-gnss/),
[LinuxGizmos](https://linuxgizmos.com/lilygo-t-watch-ultra-features-esp32-s3-amoled-display-gnss-and-lora-connectivity/)):

| Component | Assumption | Confidence |
|---|---|---|
| MCU | ESP32-S3, 16 MB flash, 8 MB PSRAM | Reported at launch |
| Display | 2.06" AMOLED, 410x502, capacitive touch | Reported at launch |
| LoRa | Semtech SX1262, band variant per SKU | Reported; SKU-to-band mapping unverified |
| GNSS | u-blox MIA-M10Q | Reported; field accuracy unverified |
| NFC | Present | Reported; reader mode vs tag emulation unverified |
| Battery | 1100 mAh Li-ion, AXP2101 PMU | Reported; endurance unverified |
| Other | Wi-Fi 2.4 GHz, BLE 5.0, microSD, IMU (BHI260AP), microphone, haptics, RTC, USB-C, IP65 | Reported |
| Camera | None | Confirmed absent in all coverage |
| Price | ~USD 100-130 retail | Approximate |

Three unverified items are decision-relevant and are flagged per use case where they
matter: NFC reader mode, GNSS accuracy under canopy, and real-world battery endurance
with periodic LoRaWAN polling. The absent camera is a hard constraint: no QR scanning,
no photo capture, so device-key entry and photo documentation stay on phones.

Regional note: the SX1262 covers the sub-GHz range, but antenna matching is per SKU.
OSI's ChirpStack region is set per deployment via `CS_REGION` (default EU868, used for
Swiss development); procurement must match watch SKU to deployment region and must not
assume one unit serves both an EU868 and a US915 site.

Licence note: a viable MIT-compatible firmware stack exists without writing a radio
stack from scratch. ESP-IDF is Apache-2.0, RadioLib (with LoRaWAN support) is MIT,
Semtech's LoRaMac-node is BSD-3-Clause, and LVGL for the UI is MIT. Meshtastic is
GPL-3; vendoring its code would drag the firmware licence, so it is a reference, not a
dependency, if OSI holds to the MIT-compatible preference.

## The structural argument

One fact organises this whole analysis: OSI is offline-first, and the only long-range
data path on an offline farm is LoRa. The hub serves its React dashboard at
`:1880/gui` over IP; the cloud mirror needs internet; cloud-to-edge commands travel
only by REST polling. A super-user standing at a valve 2 km from the hub, on a farm
with no cellular coverage, has no way to see hub state or reach hub logic with a
phone. The same person wearing a watch that is itself a LoRaWAN device on that hub's
ChirpStack has a working, if narrow, data path: tens of bytes per message, Class A
timing, duty-cycle limited. Alerts, confirmations, link measurements, and short
requests fit that pipe. Live charts and configuration screens do not, and no use case
below pretends they do.

The second organising fact is who can afford and operate the watch. OSI targets
smallholders; a USD 100-130 wearable per farmer fails the cost-effectiveness
requirement in OSI's own catalogue (pitch, slide 4). Per super-user the maths invert:
the roadmap targets 10 super-users in 2026 and about 110 by 2030 (pitch, slide 8), so
even full fleet coverage is roughly USD 14k of hardware across four years, less than
the cost of the repeat site visits the device is meant to prevent. Every use case
below therefore names a trained person as the primary user, and the one farmer-facing
idea is in the rejected section.

A third fact sets the competitive baseline: OSI already operates a dedicated LoRaWAN
field tester. The fleet deploy post-checks verify a RAK10701 is provisioned in
ChirpStack, and that class of device retails around USD 200 (approximate). The watch
does not need to beat a phone at being a phone; it needs to beat the RAK10701 at being
a field tester while adding what the RAK10701 lacks: a screen you wear while both
hands hold a ladder, an alert channel, and a GNSS log.

## How the watch would talk to the hub

This section is a proposal, not a description of existing software. The watch joins
the hub's ChirpStack as a normal OTAA Class A device with its own device profile
(working name `OSI_WATCH`), following the existing "Adding a new device type"
checklist in AGENTS.md: profile in ChirpStack, ingest branch in `flows.json` guarded
by `deviceProfileName`, catalog entry, schema additions via the migration runner. Hub
responses and alerts ride the ChirpStack downlink queue and are delivered in the RX
windows after a watch uplink, so the watch controls latency by controlling its poll
cadence.

The arithmetic works. A 13-byte payload at SF7/125 kHz costs roughly 50 ms of airtime
(approximate). Under the 1% EU868 duty cycle that permits a sustained poll about every
50 s, so a commissioning session polling every 10 s for ten minutes spends about 3 s
of airtime and stays legal, and a background cadence of one poll per 5 min is
negligible. Downlinks in EU868 can use the 10% RX2 sub-band, so a handful of alert
deliveries per hour costs the gateway nothing meaningful. Class A polling does mean
alert latency equals poll interval: minutes, not seconds. That constraint is stated
per use case rather than hidden.

Security rides the existing rails plus one hub-side addition. LoRaWAN OTAA gives each
watch its own session keys and frame-counter replay protection; the proposed addition
is a hub-side authorization table mapping watch DevEUI to an operator account and a
narrow role, with revocation when a watch is lost (an unclaim flow analogous to the
existing `UNCLAIM_DEVICE` command). The watch never holds valve session keys and never
addresses a valve directly; every actuation-shaped message is a request the hub
validates against the same permission, interlock, runtime-cap, and audit logic the GUI
uses. The safety rule that irrigation logic stays on the hub survives untouched
because the watch is architecturally just another client, and the narrowest one.

## Scoring criteria

Ten dimensions, each scored 1-5. On every scale 5 is favorable, including the cost
scales: development effort 5 means low effort, battery impact 5 means negligible
drain, safety risk 5 means negligible risk, maintenance burden 5 means low ongoing
burden. This uniform polarity makes rows comparable at a glance; it also means a
dangerous or expensive use case scores low, not high, on those columns.

| Dimension | 5 means | 1 means |
|---|---|---|
| Direct value to OSI | Removes a recurring, costed field problem | Nice-to-have |
| Technical feasibility | Buildable with the assumed hardware and known stacks | Depends on unverified or unlikely capability |
| Form-factor fit | The wrist is the right place for this | A watch actively hinders it |
| Offline capability | Works with no internet anywhere | Needs cloud connectivity |
| Field durability | Survives dirt, water splash, gloves, sun glare | Fragile in normal farm work |
| Development effort | Days to weeks on top of the shared base firmware | Months of dedicated work |
| Battery impact | Event-driven, negligible standby cost | Continuous radio or GNSS drain |
| Safety risk | Cannot affect water, crops, or credentials | Could open water or leak credentials if wrong |
| Maintenance burden | No new fleet-management or hub surface to keep alive | New moving parts on hub and watch forever |
| Advantage over phone/laptop/dedicated device | Does something those cannot | An existing device does it as well or better |

The numbers summarise the prose; where a score hides a judgment call, the use-case
text carries it. Do not rank by column sums alone.

## Use cases

### UC1: LoRa site survey and coverage mapping

Installers and super-users must answer "will a sensor placed here reach the hub"
before mounting hardware, and today the honest answers are a RAK10701 field tester or
mounting the device and waiting to see. The question recurs at every new farm inside a
hub's radius, at every antenna change, and at every mystery of a sensor that joined in
the dry season and vanished when the maize grew. LoRaWAN has a built-in answer: the
`LinkCheckReq` MAC command returns demodulation margin and gateway count with zero
custom hub code, so a v1 of this use case needs only watch firmware and a normal
device registration.

The wrist is the right place for it. Surveys happen on ladders, on poles, and while
pacing a field with a hoe or a sensor stake in hand; a glanceable margin number beats
a phone retrieved from a pocket, and beats the RAK10701 by also logging GNSS position
to microSD so the dev team can later render a coverage map of the community. A phone
contributes nothing here because a phone cannot transmit LoRa at all.

Facts: hardware needed is SX1262, GNSS (contingent on accuracy only for the map, not
the live readout), display, microSD. Hub integration: none for v1; an optional
Node-RED branch could later store survey points server-side. Fully offline. Frequency:
every installation and every coverage complaint, so weekly-to-monthly per super-user.
Safety: none; the watch transmits test frames. Effort: this use case carries the cost
of the shared base firmware (LoRaWAN stack, UI shell, power management), estimated in
months once; the survey feature itself is thin on top.

### UC2: commissioning verifier

Joining a new device is a two-place problem: the evidence (join accepted, first uplink
decoded, plausible payload) lives on the hub, while the person and the device are in a
field. Today the installer either carries the hub's IP footprint with them (impossible
beyond WiFi range) or walks back, checks the dashboard, and walks out again for each
retry. The watch closes the loop at the mounting point: an armed "commissioning mode"
polls the hub, and the hub queues downlinks reporting join events and first decoded
values for the device under installation.

Key entry stays off the watch by design. DevEUI and AppKey entry needs a camera or a
keyboard, and the watch has neither worth using; registration continues to happen in
the GUI beforehand. The watch verifies outcomes, which is the half of commissioning
that currently forces the walking.

Facts: hardware is SX1262 plus display. Hub integration (proposal): a small flows.json
branch that, when a watch arms commissioning mode for a DevEUI, mirrors that device's
join and uplink events into the watch's downlink queue. Fully offline. Frequency:
every new device, so bursty around installations. Safety: read-only, low risk;
the commissioning stream must not leak keys, only events. Effort: modest on top of the
base firmware; the hub branch is the kind of guarded MQTT-event consumer the flow
already contains several of.

### UC3: sensor trench verification before backfill

Buried sensors punish wiring mistakes with excavation. The kaba100 Chameleon outage
(documented in `docs/operations/kaba100-chameleon1-i2c-outage-analysis-2026-06-28.md`)
came down to a powering detail on the I2C reader, and the current LSN50 v1.7 bench
work is again about which pins and which rail; a miswired array reads `no_device`
after the trench is closed and the site visit is already spent. The check that
prevents this is simple: do not backfill until the hub has decoded a plausible value
from this exact device. That check needs hub evidence at the trench, which is UC2's
delivery mechanism pointed at payload content instead of join events.

Form factor matters more here than anywhere else: both hands are in the soil, the
phone is in a bag on the field edge, and the mounting point may be outside any IP
coverage. A wrist readout of "swt_1 = 23 kPa, 4 min ago" is the difference between
closing the trench with evidence and closing it with hope. The limiting factor is
sensor uplink cadence; an LSN50 reporting every 20 min makes a slow verification loop,
so the workflow pairs naturally with the existing `SET_LSN50_*` command family to
shorten the interval during installation and restore it afterwards (hub-mediated,
proposal).

Facts: hardware is SX1262 plus display. Hub integration (proposal): same event-mirror
branch as UC2, extended to forward last-decoded values; optionally a guarded
"installation cadence" toggle. Fully offline. Frequency: every buried-sensor install
and every repair visit. Safety: the cadence toggle must auto-revert or battery life of
the sensor suffers; otherwise read-only. Effort: small increment over UC2.

### UC4: offline alert receiver for super-users

The hub already detects conditions worth interrupting a human for, and then has
nowhere offline to send them. `valve_actuation_expectations` reconciliation can
conclude a valve failed to close; the gateway health sampler records undervoltage via
the `get_throttled` bitfield; a sensor going silent for hours is visible in
`device_data.recorded_at`. On a connected Swiss farm these can reach a phone through
the cloud. On an offline Ugandan hub they reach whoever next stands in front of the
dashboard, which may be days later, while a stuck-open valve drains the tank. A watch
polling the hub every few minutes, vibrating on a critical downlink, is the only
long-range push channel the architecture has.

Latency and expectation-setting are the honest costs. Class A polling every 5 min
means an alert arrives minutes late, and a watch left on a shelf receives nothing;
the feature must present itself as "the hub can now reach you in the field", never as
a guaranteed pager. Hub-side, this use case needs real design work: which conditions
qualify, how they are prioritised into a few downlink bytes, deduplication, and
acknowledgement so the hub knows an alert was seen. That engine does not exist today
and is the bulk of the effort.

Facts: hardware is SX1262, haptics, display. Hub integration (proposal): an alert
selection and queueing engine in flows.json with an acknowledgement uplink path.
Fully offline. Frequency: daily wear, alerts ideally rare. Safety: moderate; the risk
is misplaced trust in delivery, mitigated by acknowledgements and by never using the
watch as the only channel for anything catastrophic. Battery: the periodic poll is
the watch's standing drain and sizes the whole power budget (estimate: low single-digit
mAh per day for the radio at 5 min cadence, screen use dominating; hardware phase to
confirm). Effort: the largest hub-side item in this document.

### UC5: emergency stop from the field

A person watching water go wrong is often kilometres from anything that can stop it.
A burst line, a stuck valve, a flooding bed: today the responses are walk, ride, or
phone someone who is nearer, and on an offline farm the third option may not exist.
The watch can send a stop request as an uplink (immediate, no polling wait), the hub
validates identity and scope, executes its normal cancellation path (the semantics of
`POST /api/v1/valves/:deveui/cancel`: flush the ChirpStack queue, mark the expectation
`CANCELLED`), and confirms by downlink. Stopping is the fail-safe direction, which is
why this use case is acceptable long before UC6 is.

Two design rules keep it sane. First, the watch requests, the hub decides; a stop
request for a valve outside the wearer's scope dies at the hub with an audit row.
Second, the UI must make accidental triggering hard (press-and-hold plus confirm)
because a false stop interrupts legitimate irrigation, an annoyance that erodes trust
in the device. The residual risk is expectation risk: the wearer must know the valve's
own LoRa link can be down, so the confirmation downlink, not the button press, is the
signal that water stopped.

Facts: hardware is SX1262, display, haptics. Hub integration (proposal): map watch
identity to cancellation permission; the cancellation machinery itself exists.
Fully offline. Frequency: rare, high consequence. Safety: good direction, but the
authentication and revocation model of the watch fleet must exist first. Effort:
small once UC4's identity model is built.

### UC6: supervised valve test actuation

Valve maintenance wants a short test open while a human watches the water: after
cleaning a filter, after replacing a battery, after re-plumbing a line. Today that
means coordinating with someone at a dashboard or walking back and forth. The watch
version sends a request; the hub applies the full existing discipline (STREGA opens
are `OPEN_FOR_DURATION` only, never a bare close, per the repo's standing rule),
clamps the duration to a test cap, checks the wearer's scope, writes the audit row,
and only then queues the valve downlink.

This is the use case where the watch first touches water on purpose, and it is scored
accordingly. A lost, unrevoked watch would hold a remote-open capability; mitigations
are a PIN or IMU-based on-wrist detection (contingent), hub-side rate limits (N test
opens per hour, short caps), and the unclaim flow from the security section. None of
that is exotic, all of it must exist before this ships, and the value (saved walking
during maintenance) is real but smaller than UC1-UC5. Build it last.

Facts: hardware is SX1262, display, haptics. Hub integration (proposal): request
validation, test-open caps, per-watch rate limits, audit. Fully offline. Frequency:
maintenance visits, monthly-ish per site. Safety: the lowest safety score in this
document by design. Effort: moderate, mostly hub-side policy.

### UC7: field navigation to buried and mounted assets

Sensors are deliberately invisible: buried arrays, dendrometers in canopy, valves in
boxes under vegetation. A new technician (or the same super-user two seasons later)
spends time finding assets before spending time fixing them. The data model already
carries zone locations (`UPSERT_ZONE_LOCATION` is an existing command type), and
asset coordinates captured at install time (by UC1's GNSS logging) would let the watch
render a bearing-and-distance arrow, an interface that suits a 2" screen well.

The score stays modest for two reasons. Consumer GNSS at a few metres of error is fine
for finding a valve box and marginal for a sensor buried at 30 cm, so the feature
guides to the neighbourhood and human memory does the last metre (accuracy is
explicitly hardware-contingent). And a phone with an offline map app plus a saved pin
does most of this today; the watch's advantage shrinks to convenience and to sharing
one asset database with the hub instead of a private pin collection.

Facts: hardware is GNSS (contingent), IMU for heading, display. Hub integration
(proposal): an asset-coordinates export to the watch, synced over WiFi when near the
hub rather than over LoRa. Fully offline. Frequency: occasional, spikes with staff
turnover. Safety: none. Battery: GNSS is the hungriest subsystem aboard; navigation
sessions must be short-lived by design. Effort: moderate.

### UC8: structured field observations and journal capture

Researchers and super-users generate ground truth that the sensor network cannot:
crop stage, visible stress, pest presence, "the farmer irrigated by hand this
morning". Agroscope's trial methodology and the AquaMind data partnership both gain
from labelled observations attached to time and place, and the current capture path
is paper or a phone form filled in later, with the losses later entry implies. The
watch can capture a structured observation in four taps (zone, category, severity,
confirm) with timestamp and GNSS position, queue it, and deliver it to the hub as a
tiny uplink; voice notes recorded to microSD can follow whenever the watch next meets
WiFi.

The honest caveat is that OSI's field journal is cloud-primary in its current design,
while a watch observation arrives at the edge; the integration either buffers
edge-side into a new table (proposal: `field_observations`) for the normal outbox path
to mirror, or waits for the journal architecture to settle. Phones with camera and
keyboard remain better for rich entries; the watch wins only the low-friction,
in-the-row capture where a phone form would simply not be filled in.

Facts: hardware is SX1262, GNSS (nice-to-have), microphone, microSD, display. Hub
integration (proposal): an observation ingest branch writing an edge table that syncs
outward. Fully offline for capture and edge delivery; cloud is eventual. Frequency:
daily during trials, weekly otherwise. Safety: low; observations are data, and
position data about people should stay coarse in anything exported. Effort: moderate.

### UC9: OSI Academy radio-propagation teaching aid

Radio is invisible and the OSI Academy has to teach it anyway: why the hub antenna
goes high, why a valley farm gets a bad link, why the maize matters. A trainer holding
a watch that displays live link margin while a trainee walks away with it turns
propagation from a diagram into an experience, and it is UC1's firmware used verbatim
in a classroom. Zero additional engineering beyond maybe a large-digits display mode.

The value is real but derivative; nobody buys the watch for this, and it scores as the
cheap bonus it is. A phone cannot substitute because a phone has no LoRa radio, which
is precisely the teaching point.

Facts: hardware is SX1262, display. Hub integration: none beyond UC1. Fully offline.
Frequency: training sessions. Safety: none. Effort: near zero increment.

### UC10: developer protocol test node

The Zurich dev team exercising join flows, decoder branches, downlink queues, and
region settings benefits from a scriptable LoRaWAN end node, and the watch firmware is
one. But a USD 20 ESP32+SX1262 dev board is the same test node without a screen, the
RAK10701 already exists in the fleet, and a bench tool gains nothing from being
wearable. This use case is listed because it is free (the base firmware doubles as it)
and ranked low because it justifies nothing.

Facts: hardware is SX1262, USB-C. Hub integration: none. Offline. Frequency: dev-team
internal. Safety: test traffic only, against dev hubs. Effort: zero increment.

### UC11: NFC asset tags

Cheap NFC stickers on valve boxes and enclosures, tapped with the watch to pull up
that asset's identity and status, would remove the "which of these three boxes is
V-07" class of error during maintenance. The idea survives to this list because the
tap gesture suits a wrist perfectly and asset misidentification is a real audit
hazard. It scores low anyway: whether the watch's NFC chip supports reader mode (as
opposed to tag emulation) is unverified and historically the weak point of watch-class
NFC, field-mounted tags degrade and walk away, phones read NFC too, and a laminated
printed label plus UC7's navigation covers most of the need without a tag fleet to
maintain.

Facts: hardware is NFC reader mode (contingent, decision-critical for this use case
only), SX1262 for the status lookup. Hub integration: reuses UC2/UC4 query paths.
Offline. Frequency: maintenance visits. Safety: low; tags must hold identifiers, never
credentials. Effort: moderate, plus tag logistics forever.

## Score matrix

All scales: 5 is favorable (for effort, battery, safety, and maintenance columns, 5
means low cost or low risk).

| Use case | Value | Feasibility | Form factor | Offline | Durability | Effort | Battery | Safety | Maintenance | vs phone |
|---|---|---|---|---|---|---|---|---|---|---|
| UC1 site survey | 5 | 5 | 4 | 5 | 4 | 3 | 4 | 5 | 4 | 5 |
| UC2 commissioning verifier | 4 | 4 | 4 | 5 | 4 | 3 | 4 | 5 | 4 | 4 |
| UC3 trench verification | 4 | 4 | 5 | 5 | 4 | 3 | 4 | 5 | 4 | 5 |
| UC4 alert receiver | 5 | 4 | 5 | 5 | 4 | 2 | 3 | 4 | 3 | 4 |
| UC5 emergency stop | 4 | 4 | 5 | 5 | 4 | 3 | 5 | 4 | 4 | 5 |
| UC6 test actuation | 3 | 4 | 4 | 5 | 4 | 2 | 5 | 2 | 3 | 4 |
| UC7 asset navigation | 3 | 3 | 4 | 5 | 4 | 3 | 2 | 5 | 4 | 2 |
| UC8 field observations | 3 | 4 | 3 | 5 | 4 | 3 | 4 | 5 | 3 | 3 |
| UC9 academy teaching aid | 3 | 5 | 4 | 5 | 4 | 5 | 4 | 5 | 5 | 4 |
| UC10 dev test node | 2 | 5 | 2 | 5 | 5 | 4 | 5 | 5 | 4 | 2 |
| UC11 NFC asset tags | 3 | 2 | 4 | 5 | 3 | 3 | 4 | 4 | 2 | 3 |

Where the numbers mislead: UC9's strong row reflects near-zero cost, not high value,
and would rank first on a naive sum; UC4's weak effort and maintenance scores buy the
single most-used feature of the device, which is what those columns cannot express;
UC6's safety score of 2 is a build-order instruction, not a rejection.

## Rejected ideas

Farmer-facing OSI smartwatch. A general dashboard-on-the-wrist for farmers fails
OSI's own accessibility requirement: the mobile web dashboard already targets farmers
on phones they own, while the watch costs USD 100-130 per person, has no camera for
the journal's photo workflows, and adds a charging and breakage burden to the least
technical user group. Rejected on cost per farmer, not on technical grounds.

Direct watch-to-valve control. Technically the SX1262 can transmit on the valve's
frequencies; architecturally the watch must never hold valve session keys, because
distributing them to a pocketable device would convert every lost watch into an
unaudited irrigation controller and would break the standing rule that interlocks,
runtime caps, and audit live on the hub. Rejected absolutely; UC5/UC6 exist precisely
to route these desires through hub validation.

LoRaWAN repeater or range extender. A single-channel Class A end node cannot relay a
multi-channel network, and pretending otherwise burns the battery to create coverage
that lies. Rejected as architecturally unsound.

Geofenced proof-of-visit tracking for super-users. The membership funding model
reports impact to donors, and GNSS traces of super-user movement would technically
enrich those reports. Rejected on mission grounds: OSI's relationship with super-users
is training and trust, and turning their reward hardware into a surveillance device
poisons that for a reporting convenience. If visit data is ever wanted, it must be an
explicit, consented, self-initiated check-in, which UC8 already covers.

Always-listening Class C pager. Class C would cut alert latency from minutes to
seconds at the cost of continuous receive, which on a 1100 mAh wearable means daily
charging at best (estimate; hardware phase to confirm). Rejected in favour of Class A
polling; if a future need demands sub-minute alerts, that is a mains-powered siren on
the hub, not a watch.

Hub maintenance console. When a person is physically at the hub, a phone on the hub's
own WiFi reaching `:1880` is a strictly better console than any watch screen.
Rejected for redundancy; the watch shows hub-health alerts (UC4) but does not try to
be the hub UI.

Offline authentication token (TOTP or NFC credential for hub login). The hub's local
auth is a password with an offline verifier, which works with no extra hardware; a
watch-based factor adds a lockout mode (dead watch, lost watch) to an offline system
whose failure mode is a farmer unable to irrigate. Rejected as risk without need.

Passive uplink sniffer as a primary diagnostic. The SX1262 can promiscuously receive
nearby uplinks and prove "this node transmits", but a single-channel radio camping on
one of eight channels misses most frames, and payloads are encrypted anyway. The
capability may appear as a debug screen inside UC1; as a headline use case it
over-promises. Rejected as primary, retained as a footnote feature.

Voucher or input-reward wallet. Super-users are rewarded with agricultural inputs, and
an NFC wallet on the watch could carry entitlements. Custody of value on a hackable
hobbyist device, in an organisation without payment infrastructure, is a liability
with no upside over paper vouchers. Rejected as out of domain.

## Ranked shortlist

1. UC1, site survey and coverage mapping. It needs no hub changes in v1, replaces a
   dedicated device the fleet already pays for, produces the coverage maps that
   community-scale planning around a 15 km hub radius needs, and it forces the
   creation of the base firmware every other use case rides on. If only one thing is
   built, build this.
2. UC4, offline alert receiver. The highest recurring value on the list, because it
   gives the offline hub its first long-range push channel to a human, and the reason
   a super-user wears the watch daily rather than storing it with the tools. Ranked
   second not first because it carries the largest hub-side build and its worth
   depends on the alert engine being designed with restraint.
3. UC2 plus UC3, commissioning and trench verification. One firmware feature pair
   that attacks the most expensive failure OSI's field history documents: the closed
   trench over a miswired sensor and the repeat site visit that follows. Ranked
   third because its value concentrates in installation weeks rather than daily use.
4. UC5, emergency stop. Rare use, outsized consequence, fail-safe direction, and
   cheap once UC4's identity model exists. It is also the feature that makes the
   watch legible to non-technical bystanders: the thing on the wrist that can stop
   the water.
5. UC8, field observations. The data-partnership and research value is real and no
   other device captures in-the-row ground truth with this little friction, but the
   journal-architecture dependency and the small-screen input ceiling keep it behind
   the four above.

UC9 ships free with UC1 and should simply be included. UC6 waits until the
authentication, revocation, and rate-limit machinery has field mileage. UC7, UC10,
and UC11 are backlog: worth keeping, not worth scheduling.

## Product identity recommendation

This device should be OSI's field instrument for trained personnel: a commissioning
and radio-survey tool that is also the hub's messenger when no other channel exists.
Concretely, one watch per installer and per super-user, introduced through the OSI
Academy as part of the toolkit, with a firmware whose v1 scope is UC1 plus UC9
(no hub changes), a v2 that adds the `OSI_WATCH` device profile with UC2/UC3 and the
UC4 alert engine, and actuation (UC5, then UC6) only after the watch identity model
has survived contact with the field. It should not be a smartwatch in any consumer
sense: no farmer-facing dashboard, no notification platform, no app store ambitions,
and every screen designed for gloves, glare, and a five-second glance.

The main reason to say no instead is developer capacity, and the decision should be
made on that axis rather than on the hardware's appeal. The Zurich team is small, the
base firmware (radio stack, power management, UI shell on ESP32-S3) is months of work
before the first field benefit, and that time competes directly with the 1.0 release
and the Uganda scale-up on the roadmap. Two mitigations keep the door open: v1's
zero-hub-change scope means the firmware can proceed without touching the edge
codebase or its verification gates, and the MIT-compatible stack (RadioLib, LVGL,
ESP-IDF) fits the open-source release intent without licence surgery. If the parallel
hardware phase falsifies a load-bearing assumption (an SX1262 SKU mismatch for EU868,
battery endurance under polling, or LoRaWAN stack instability on this board), the
correct outcome is to keep the RAK10701 and spend the months elsewhere; the analysis
above is an argument that the watch is worth building only as the narrow instrument
described, never as a platform.

## Sources

- OSI mission documents: Practice Abstract, OSI pitch, OSI x AquaMind executive
  summary (extracted text, 2026).
- `AGENTS.md`, this repo: architecture, sync endpoints, device catalog, valve rules,
  gateway health, live-deploy guardrails.
- `docs/operations/kaba100-chameleon1-i2c-outage-analysis-2026-06-28.md`: buried-array
  failure precedent.
- T-Watch Ultra launch coverage: [CNX Software](https://www.cnx-software.com/2026/04/20/lilygo-t-watch-ultra-an-ip65-rated-esp32-s3-smartwatch-with-2-01-inch-amoled-lora-and-gnss/),
  [LinuxGizmos](https://linuxgizmos.com/lilygo-t-watch-ultra-features-esp32-s3-amoled-display-gnss-and-lora-connectivity/)
  (specifications provisional pending the hardware-verification phase).
- LoRaWAN L2 1.0.x specification: `LinkCheckReq`/`LinkCheckAns` MAC commands, Class A
  timing, EU868 duty-cycle bands. Airtime and battery figures in this document are
  estimates and are marked as such.
