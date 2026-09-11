# T-Watch Ultra for OSI: decision package

Date: 2026-09-01. Entry point for the investigation into a custom OSI firmware for
the LILYGO T-Watch Ultra. Method note: the use-case analysis (document 01) was
produced without access to the prior proposal, so its agreement with that proposal is
evidence rather than echo; document 03 reconciles the two.

## Executive recommendation

**Conditional go.** Build R0 ("bench truth", 3–4 person-weeks) now; commit to the
Surveyor MVP only if the G0 gate passes. The use case is real and twice-derived, the
software stack is viable and MIT-clean, and the hub already runs half the backend
(the RAK10701 field-tester pipeline). The conditions exist because the three
decisive risks are physical and cheap to test but impossible to paper over: RF-path
integrity on an undocumented radio module, measured power against a vendor sleep
anomaly, and procurement of a sold-out SKU. The strongest argument against is not
technical: R1 costs roughly 16–22 person-weeks that compete with the 1.0 release and
the Uganda scale-up, and the gates are designed so stopping is cheap at every stage.

## Product identity

A field instrument for OSI's trained layer (installers, super-users, technicians,
researchers, the Academy), issued per person through the Academy toolkit. Not a
consumer smartwatch, not a farmer interface, not a gateway, never a bypass of hub
safety logic. Its one structural advantage over every phone: it is itself a LoRaWAN
device on the hub's ChirpStack, so it works at LoRa range on farms where IP reaches
only tens of metres.

## Top use cases (ranked, from documents 01 and 03)

1. **LoRaWAN site survey and coverage mapping** — the MVP (document 05).
2. **Commissioning and trench verification** — release R2; evidence at the mounting
   point before backfill or descent.
3. **Offline alert receiver** — release R3; the offline hub's first push channel to
   a human, and the reason the watch is worn daily.
4. **Emergency stop request** — R3; rare, high-consequence, fail-safe direction,
   hub-validated.
5. **Supervised valve test actuation** — R4, last by design, after the identity
   model has field mileage.

Rejected outright: farmer smartwatch, direct valve control, repeater, Class C pager,
watch dashboards, proof-of-visit tracking (reasons in documents 01 and 03).

## Recommended first MVP: OSI Surveyor

Quick probe, stationary point test, walk survey and join test on the watch; every
attempt logged before transmission; target-device profiles; Wi-Fi (or SD) sync to
the hub; hub-side correlation against ChirpStack per-gateway receptions; map,
session comparison and GeoJSON/CSV export in the OSI OS GUI; fully offline; EU868.
A compatibility mode speaks the disk91 field-tester protocol the hub already
serves, so a watch is useful against unmodified hubs from day one. Full definition,
protocols, schemas, UI, power, security and acceptance criteria: document 05.

## Key architecture decisions

| ADR | Decision | Rationale (detail) |
|---|---|---|
| Firmware framework | Arduino-ESP32 (pinned core), built with arduino-cli; LilyGoLib as HAL only | Only vendor-tested path; PlatformIO fork stale/unlicensed; ESP-IDF undocumented for this board (05 §7.8) |
| LoRaWAN stack | RadioLib 7.7.x, LoRaWAN 1.0.4, OTAA | Only candidate with board support, LinkCheck API, first-class persistence, MIT licence, active maintenance (02, 05 §7.8) |
| Storage format | Fixed 64-byte CRC records, append-only, internal FATFS primary; SD as export | Write-ahead with bounded latency; torn-write recovery by scan; SD absence tolerated (05 §7.9) |
| Synchronisation | Wi-Fi to hub AP/LAN URL, resumable chunked HTTP; SD + GUI import fallback | Hub AP exists; no mDNS on hubs; idempotent by (session, seq) (05 §7.12) |
| Backend implementation | Node-RED wiring around a versioned plain-JS module (`osi-survey-helper`); schema via migration runner | Repo precedent (field-tester tab, osi-chirpstack-helper); data model independent of Node-RED (05 §7.11) |
| Mapping responsibility | Watch: live numbers + trace. Hub GUI: Leaflet map, grid aggregates, comparison, exports. No interpolation | Wrist screens are for glancing; samples only, missing packets visible (05 §7.7) |
| Credential provisioning | Per-unit AppKey over USB serial provisioning mode; keys in NVS; pairing code → scoped bearer token | No camera for QR; no keys over Wi-Fi; revocation table hub-side (05 §7.15) |
| OTA strategy | None in MVP (USB flashing); signed-image OTA committed as the only acceptable future form | Avoids shipping unsigned OTA "temporarily" (05 §7.15) |
| Initial LoRaWAN region | EU868 (868 MHz SKU), Swiss development; no multi-band claims | Band matching is per-SKU inside an undocumented module; Uganda band question explicitly open (02) |
| Raw LoRa testing in MVP | Excluded | Measures no OSI service layer; needs extra hardware; LoRaWAN methods cover the stack (05 §7.2) |

## Main technical unknowns

From document 02 (full list of 20 there), the five that would change the design:
what is inside the `HPB16B3` radio module (matching, TCXO, socketed or soldered);
which RF-switch position reaches a real antenna; whether RadioLib's
`setOutputPower(14)` picks the optimal PA configuration (2× on the dominant load);
the unexplained 600 µA deep-sleep anomaly (open vendor issue); and whether the
868 MHz SKU is usable at 865–867 MHz (any IN865/Uganda ambition). All five are R0
bench items. Non-technical unknowns: SKU availability (all sold out at research
date) and the absence of published CE/FCC for the watch.

## Roadmap summary (document 04)

R0 bench truth (3–4 pw, gate G0) → R1 Surveyor MVP (16–22 pw, gate G1 with field
validation against a RAK10701) → R2 commissioning verifier (4–6 pw) → R3 alerts +
emergency stop (6–9 pw) → R4 optional items, each behind its own demand gate. Every
gate has stop conditions; the default at R4 is not building.

## Documents

| Doc | Content |
|---|---|
| [01-independent-use-case-analysis.md](01-independent-use-case-analysis.md) | Anti-anchored discovery: 11 scored use cases, 9 rejections, product identity |
| [02-hardware-feasibility.md](02-hardware-feasibility.md) | Primary-source hardware research, tagged fact/inference/proposal/question, identification procedure |
| [03-review-of-previous-suggestions.md](03-review-of-previous-suggestions.md) | Verdicts on every prior suggestion; what each analysis missed |
| [04-product-roadmap.md](04-product-roadmap.md) | R0–R4 with goals, effort, risks, exit criteria, decision gates |
| [05-mvp-design.md](05-mvp-design.md) | Implementation-ready Surveyor design: §7.1–§7.17 |
| [06-implementation-backlog-and-tests.md](06-implementation-backlog-and-tests.md) | Epics, tasks, effort, test matrix, pilot field protocol |

## Go / conditional go / no-go

**Conditional go.** Order two 868 MHz units now; run R0; hold the R1 commitment
until G0 evidence and an explicit capacity decision against the 1.0/Uganda schedule.
If G0 fails or procurement stalls, the RAK10701 remains OSI's field tester, the
documents remain the record, and the total spend is under a month.
