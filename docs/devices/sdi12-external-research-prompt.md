# Parallel sensor protocol audit

Copy the following prompt into the external agent. Supply the referenced repository
documents if that agent cannot read this checkout.

---

Act as an independent sensor integration researcher and critical consultant for
OSI OS. We want to finish as much SDI-12 integration work as public documentation
permits before bench testing. We cannot access the physical sensors now.

The implementation team owns the shared Dragino transport replay lab, assembly
policy, and later persistence/UI work. Your parallel assignment is sensor-specific
protocol evidence. Do not edit implementation files, contact manufacturers, access
live systems, or claim that a documented example validates our installed hardware.
You may split the research among independent agents if available.

Read these context documents, supplied with this prompt:

- `docs/superpowers/specs/2026-10-03-sdi12-review-decisions.md`
- `docs/superpowers/specs/2026-10-04-sdi12-prebench-readiness.md`
- `docs/devices/sdi12-offline-preview.md`
- `docs/devices/dragino-sdi12.md`

Audit these packages independently so missing HydraScout evidence does not block
PR2 or TEROS:

1. Delta-T PR2/4 and PR2/6: command families and units, identification and calibration
   readback, per-position coefficients, D-block order/count/length, CRC options,
   power/startup and measurement waits, stale-result behavior and errors. Distinguish
   permittivity, fractional VWC and percent VWC. Assess variable-length replies and
   whether a fixed cut can ever be justified for the selected command mode.
2. METER TEROS 11 and 12, then ecoTech Tensiomark: separate model and firmware
   contracts. For TEROS verify the meaning of the raw SDI-12 field, conversion
   equations and units, temperature/EC mapping, all error codes and whether an error
   invalidates one field or the whole observation. Compare the Dragino example's
   firmware 1.12 with current METER documentation; do not transfer assumptions
   between versions. For Tensiomark establish calibrated variant, pF/hPa semantics,
   response order, valid limits, startup/measurement timing, minimum interval,
   power demand and errors. Separate the May 2014 variant-1 evidence from other
   variants or editions.
3. HSTI HydraScout (also search the user's spelling “Hydrascrout”): establish exact
   product families and authoritative protocol availability. Seek command tables,
   model/depth identification, moisture/temperature/conductivity groups, units,
   calibration, ordering, D-block lengths, timing and errors. The Banner example
   alone does not establish a general wire contract or conductivity semantics.

Starting references; verify their actual contents and edition:

- Delta-T: https://delta-t.co.uk/wp-content/uploads/2016/09/PR2_SDI-12-_User_Manual_version_4_1.pdf
- METER: https://publications.metergroup.com/Integrator%20Guide/18224%20TEROS%2011-12%20Integrator%20Guide.pdf
- METER: https://publications.metergroup.com/Manuals/20587_TEROS11-12_Manual_Web.pdf
- ecoTech-authored manual: https://www.stevenswater.com/resources/documentation/Stevens_Tensiomark_Manual.pdf
- Banner application note: https://info.bannerengineering.com/cs/groups/public/documents/literature/b_4182045.pdf
- HydraScout: https://www.hydrascout.co/?lang=en
- Dragino examples: https://wiki.dragino.com/docs/LoRaWAN-End-Node/io-controllers-sensor-nodes/sdi-12-lb/
- SDI-12 standard: https://www.sdi-12.org/current_specification/SDI-12%20Specification%201.4%20February%2020%202023.pdf

Deliver a concise decision report plus machine-readable JSON fixtures where source
material permits. For each consequential claim record: exact model/firmware,
document title/edition, URL, page or section, brief supporting text, derived rule,
test input/expected result, confidence, and unresolved limitation. Hash references
you download; record access date for mutable pages. Prefer manufacturer documents;
identify partner-hosted manufacturer manuals and third-party application examples.

Transcribe published command/reply exchanges faithfully, retaining addresses,
terminators and block boundaries where shown. Mark every absent detail unknown.
Keep vendor transcripts, independent calculations and synthetic edge cases in
separate categories; never invent a plausible reply and label it vendor evidence.
Provide independent numerical checks of every proposed conversion, including
zero, boundary and error cases. Visually inspect relevant PDF tables/screenshots.

For each sensor propose the smallest defensible offline recipe contract, its
capability requirements, response/command/power/time budgets and refusal cases.
Do not produce a copy-and-run live configuration recipe while required facts are
unknown. Compare options where documentation leaves a difficult decision; give a
recommendation, its assumptions and a concrete counterexample that defeats it.

Finish with three lists: work implementable now from documents; questions requiring
a manufacturer answer (draft exact questions, do not send); and questions requiring
our hardware (give the shortest capture procedure and expected distinguishing
outcomes). Prioritize the five findings most likely to prevent wasted bench time.
This is a targeted protocol audit, not another broad code review.
