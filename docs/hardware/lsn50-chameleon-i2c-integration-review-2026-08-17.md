# LSN50V2 + VIA Chameleon I2C integration: first-principles review

**Date:** 2026-08-17
**Status:** Analysis only. No firmware or hardware changes are authorized by this document.
**Scope:** Root-cause the three fielded topologies, audit every exposed LSN50 v2.3(a) pin/net, evaluate candidate architectures, and define the recommended design, firmware contract, test plan, and go/no-go gates.
**Supersedes:** `docs/hardware/lsn50-chameleon-i2c-architecture-analysis.md` (untracked draft from 2026-08-15; contains unsourced claims and wrong document numbers — do not cite it).
**Extends:** `docs/operations/kaba100-chameleon1-i2c-outage-analysis-2026-06-28.md` (field data used here as evidence).

Every statement is tagged: **[F]** fact verified against a primary source or repo code, **[I]** inference from tagged facts, **[U]** unknown / not yet measured. Citations use the short names in the source table.

## Sources

| Short name | Document | Rev / date |
|---|---|---|
| SCH-2.3 | Dragino "LoRa ST Sensor Node v2.3" schematic PDF, sheet dated 2021-10-28 (`LSN50_v2.3_schematic.pdf`, dragino.com download area) | v2.3 |
| SCH-2.0 | Dragino LSN50 v2.0 Eagle files (`LSN50_v2.0.sch/.brd`, netlists machine-read) | v2.0 |
| HW-LOG | Dragino LSN50 hardware change log (bundled with schematic downloads) | through v3.3.1 |
| MAN | LSN50 LoRa Sensor Node User Manual v1.7.4 (`dragino.com/downloads/downloads/LSN50-LoRaST/LSN50_LoRa_Sensor_Node_UserManual_v1.7.4.pdf`, verified reachable 2026-08-17) | v1.7.4 |
| WIKI | Dragino Documentation Center, "LSN50v2" page (pinout, power consumption, battery sections) | fetched 2026-08-15 |
| DS | ST datasheet STM32L072x8/xB/xZ, **DS10689 Rev 5** (Nov 2019; the superseded draft's "DS12289" was wrong) | Rev 5 |
| RM | ST reference manual STM32L0x2, **RM0376 Rev 7** (Feb 2022) | Rev 7 |
| ES | ST errata STM32L07xxx/L08xxx, **ES0292 Rev 8** (the superseded draft's "ES0237" was wrong) | Rev 8 |
| I2C-SPEC | NXP UM10204, I2C-bus specification and user manual, **Rev 7.0, 2021-10-01** | Rev 7 |
| AVR | Microchip ATtiny214/414/814 datasheet **DS40001912C** | rev C |
| VIA-LIB | VIAChameleonI2CMaster Arduino library + demo + example output (`/home/phil/kDrive/OSI OS/Hardware/Chameleon/VIAChameleonI2CMaster/`); summarized in `docs/hardware/chameleon-reference.md` | as shipped |
| FW-v1 | `LoRa_STM32-claude` branch `feature/chameleon-i2c-reader` | n/a |
| FW-v1.5 | same repo, `feature/chameleon-v1.5` | — |
| FW-v1.6 | same repo, `feature/chameleon-v1.6-switched-i2c2` incl. `README-chameleon-v1.6-switched-power.md` and `docs/superpowers/specs/2026-08-09-lsn50-chameleon-dual-power-design.md` | — |
| FIELD | Kaba100 outage analysis + its underlying DB extracts (2026-06-28) | n/a |

---

## 1. Root-cause assessment of the three attempted topologies

### 1.1 Topology 1 — PB5-switched +5 V rail, I2C1 on PB6/PB7

**Verdict: confirmed electrical root cause: back-powering through fixed board pull-ups, with a brown-latched ATtiny814 as the intermittency mechanism. The user's hypothesis is verified, with one correction: the LSN50 pull-ups are 10 kΩ (R1/R2), and the off-state feed comes from the always-on VDD rail, not from the STM32 pins themselves.**

Evidence chain:

1. SCH-2.3 shows R1 = 10 kΩ on PB6 and R2 = 10 kΩ on PB7, both to VDD, plus ESD diodes D7/D8 to GND. MAN §1.5 pin table rows 6–7 say the same ("10k pull up to VCC"). [F]
2. VDD is the raw battery rail: BATTERY → JP1/JP2 → F1 (MF-NSMF050-2, 500 mA PTC) → VDD, no regulator; D1 was removed in v2.3 (HW-LOG). MAN §2.4.5 states "The VDD pin of LSN50v2 is connected to the Battery directly." [F]
3. The reader's 4.7 kΩ pull-ups terminate at its own VCC (user measurement; consistent with VIA-LIB guidance that pull-ups go to the reader supply). [F]
4. With the +5 V rail off, the only DC paths are VDD → 10 kΩ → SDA/SCL → reader pin ESD structure → reader VCC, and VDD → 10 kΩ → SDA/SCL → reader 4.7 kΩ → reader VCC. ATtiny814 absolute maximum pin voltage is VDD+0.5 V (AVR §34.2); with reader VCC ≈ 0, a 3.6 V-pulled line violates this and conducts through the protection diode. [F]
5. Field measurement (FIELD): reader VCC 1.4–1.5 V and SDA/SCL 1.9–2.0 V with the rail off. Per-line feed current ≈ (3.6 − 1.95)/10 kΩ ≈ 165 µA, ~330 µA total. The 0.5 V drop between SDA and reader VCC matches one diode drop. [F for voltages; I for the exact internal path]
6. ATtiny814 POR threshold on rising VDD is 1.4–1.8 V (AVR §34.8, Table 34-11). The measured 1.4–1.5 V parks the slave MCU exactly on the POR boundary: sometimes in reset, sometimes half-running, TWI state machine undefined. [F for thresholds; I for the internal state]
7. FW-v1 has no bus recovery: HAL calls are bounded (1000 ms per transaction, 2000 ms measurement timeout; FW-v1 `bsp.c` and `via_chameleon.c`), but a NACK/stuck slave is never cleared by power cycling within a run, and the rail is only re-cycled on the next 5-minute sample. A brown-latched slave therefore produces multi-hour `i2c_missing` blocks, matching FIELD's 42.9 h and 48.4 h blocks. [F for code, F for field pattern, I for causation completeness]
8. With +5 V on, SDA/SCL highs measured ~4.6 V (FIELD). PB6/PB7 are FTf pins: DS Table "current injection characteristics" rates FT/FTf injection −5/+0 mA — positive injection is not possible — and VIN max is 5.5 V (DS §6.2/6.3.12). The STM32 was not at risk; the violation was on the reader side and against I2C-SPEC levels. [F]

The "worked for weeks, then intermittent" pattern is expected: brown-latching is probabilistic, and every sample cycle re-rolls the dice. [I]

### 1.2 Topology 2: reader continuously on VDD, I2C1 on PB6/PB7

**Verdict: battery exhaustion is the quantitatively supported primary cause; a wedged-bus/watchdog loop is a plausible secondary that cannot be excluded without the dead node's logs. The bus wiring itself was electrically legal this time.**

Evidence chain:

1. Reader draws ~8.5 mA continuously (user measurement). [F]
2. MAN §2.7: sensors on VDD must sleep below 50 µA "to get a long battery life." 8.5 mA is 170× that ceiling. [F]
3. Battery is ER18505-class Li-SOCl₂, 4000 mAh (or 8500 mAh) plus a super-capacitor in the pack (MAN §2.8.1, §2.8.4). 4000 mAh / 8.5 mA = 470 h ≈ 19.6 days of ideal capacity for the reader alone; 8500 mAh gives ≈ 1000 h ≈ 42 days. Real capacity under continuous mid-rate drain plus 44–125 mA TX pulses (WIKI §1.2 power table) is lower due to passivation and voltage delay. [F for inputs; I for field-life estimate]
4. "Initially worked, then the complete LSN50 stopped uplinking" fits a Li-SOCl₂ pack that reads ~3.6 V under light load right until collapse: flat curve, then a cliff. FIELD's battery-flat observation does not contradict drain — it is what this chemistry shows before the cliff. [I]
5. Secondary mechanism: with the reader always powered there is no power-cycle recovery path. A mid-transaction brown-out of the reader (TX pulse on a passivated cell) can wedge its TWI slave; the STM32 side then sees NACKs or a held bus. FW-v1's bounded-but-recovery-free driver reports `i2c_missing` and continues — that alone does not stop uplinks. Total silence needs the whole node down: empty battery, or a reset loop. A blocking vendor path that trips the ~28 s IWDG exists as a class in this codebase: FW-v1.6's bench history records "the board restarted after about 20 seconds when its watchdog expired in the blocking vendor AT/configuration path." [F for the bench event; U for which mechanism fired in the field]

Recommendation implication: any continuously-powered variant of this reader is disqualified by arithmetic, independent of firmware quality. [I]

### 1.3 Topology 3: I2C2 on PB13/PB14, switched 3.3 V reader power

**Verdict: confirmed hardware root cause: C1 (0.1 µF) on the PB14 net makes PB14 unusable as SDA at any standard I2C speed. The user's conclusion is verified against the v2.3 schematic, the manual, and the I2C specification. ISR 0x201 is the expected symptom.**

Evidence chain:

1. SCH-2.3 (resistor/interrupt section, visually inspected): PB14 — R13 (0 Ω) — PB14-I, with R14 = 1 MΩ to GND and **C1 = 0.1 µF to GND** on the PB14-I node. C1 sits on the connector side of a zero-ohm jumper, so it loads any wire attached to the PB14 terminal. [F]
2. MAN's interrupt retrofit note tells owners of older boards to solder "R14 with 10M resistor and C1 (0.1uF)"; HW-LOG v2.1 changed R14 to 1 MΩ and v2.3 re-footprinted R11/R13/C1 (populated, not deleted). The physical v2.3a board has C1 (user inspection). Three independent sources agree on 0.1 µF. [F]
3. Rise time: I2C-SPEC §7.1 gives tr(30%→70%) = 0.8473 × Rp × Cb. With the reader's 4.7 kΩ pull-up and C1 = 100 nF: tr = 0.8473 × 4700 × 1e-7 ≈ **398 µs**. Table 10 limits: 1000 ns (Standard-mode), 300 ns (Fast-mode); Cb limit 400 pF. This net exceeds the slowest legal rise time by ~400× and the capacitance limit by 250×. [F]
4. RM §27.4.17: "An arbitration loss is detected when a high level is sent on the SDA line, but a low level is sampled on the SCL rising edge"; the master then releases both lines, clears START, and drops to slave mode. With C1, SDA cannot reach the high threshold within a bit cell at 100 kHz (10 µs period), so the first '1' bit the master sends sets ARLO. RM §27.7.7: ISR bit 9 = ARLO, bit 0 = TXE → 0x201, exactly the observed value; TXE stays set because the transfer aborted before the data byte loaded. [F]
5. Not a firmware bug and not fixable in software at standard speeds. The STM32 I2C peripheral has no "wait longer for SDA" option; the arbitration comparator runs every SCL rising edge. Even at the lowest TIMINGR settings (~10 kHz), tr ≈ 398 µs ≫ bit time. [F for peripheral behavior; I for the exhaustive-speed claim — no ST document states a minimum fSCL for master mode, but the arbitration mechanism fails first]
6. PB13 itself is clean (SCH-2.3: no pull-up, no RC, only an ESD diode). The net that fails is PB14 only. [F]

One correction to the superseded draft and to intuition: R14 is a 1 MΩ pull-**down** (SCH-2.0 netlist: R14.2 in the GND net; MAN's interrupt example ties the sensor between PB14 and VDD). It does not source current into the reader; it slightly discharges C1. The fatal element is C1 alone. [F]

Secondary v1.6-era notes (for the record, not causes): I2C2 lacks the SMBus timeout hardware that I2C1/I2C3 have (DS §3.17.1, Table 12); ES §2.12.3 requires I2CCLK ≥ 4 MHz (Sm) / ≥ 10 MHz (Fm) for correct SDA sampling; ES §2.12.9 documents a peripheral stall that only PE=0 or reset clears — FW-v1.6's per-session deinit/init already satisfies that workaround. [F]

---

## 2. Complete LSN50 pin/net conflict analysis

Terminal numbers follow MAN §1.5 (the manual numbers 1–27 across both blocks; the PCB silkscreen uses JP3/JP4 pin numbers that disagree with the manual — identify pins by signal name and continuity, per FW-v1.6's README warning). Net contents are from SCH-2.3, cross-checked against SCH-2.0 netlists plus HW-LOG deltas. [F unless noted]

| MAN # | Signal | On the net (v2.3) | I2C alternate functions (DS Tables 16–18) | Verdict for Chameleon use |
|---|---|---|---|---|
| 1, 13 | VDD | Battery rail via F1 (500 mA PTC); no regulator; feeds R1/R2 and the module | — | Power source for recommended design |
| 27 | +5V | RT9266 boost output; C4/C11; enabled by PB5 LOW (T1 PMOS + Q8 BSS138 + R25/R6 network); off = boost disabled, rail decays through reader/load | — | Usable only behind an external regulator (Variant-B power) |
| 12, 26 | GND | n/a | n/a | n/a |
| 2 | PA0 | Clean (ESD only); ADC_IN0, WKUP1 | none | Reserve: stock ADC0; sacrificable in a dedicated image |
| 3 | PA1 | R15 = 12 Ω NC to GND; ESD | none | Reserve: stock ADC1 |
| 4, 5 | PA2/PA3 | 10 kΩ pull-ups to VDD; ESD; USART2 (debug/AT) | none | Avoid: UART + pull-ups |
| 6 | PB6 | **R1 = 10 kΩ to VDD**; D7 ESD | I2C1_SCL (AF1); FTf | Bus candidate only with continuous power or an isolation IC |
| 7 | PB7 | **R2 = 10 kΩ to VDD**; D8 ESD | I2C1_SDA (AF1); FTf | Same as PB6 |
| 8 | PB3 | R7 = 4.7 kΩ to VDD (SCH-2.3; MAN says "10k" — documentation mismatch [U]); ESD | none (SPI1_SCK etc.) | Avoid: pull-up; no I2C AF |
| 9 | PB4 | R8 = 10 kΩ **NC** on v2.3; ESD | I2C3_SDA (AF7); FTf | Electrically clean, but its I2C3 partner PA8 is LED-loaded |
| 10, 11 | PA9/PA10 | R3/R4 = 4.7 kΩ to VDD (HW-LOG v2.1); ESD; USART1 (AT/bootloader) | I2C1_SCL/SDA (AF4) | Avoid: kills AT-command UART; pull-ups |
| 15 | PA4 | **R23 = 1 MΩ + C3 = 0.1 µF to GND** (v2.3, HW-LOG); ESD | none (TC type, ADC/DAC) | Not usable for data; usable as slow rail-enable if ever needed |
| 16 | NRST | C7 0.1 µF, RESET button | none | Off-limits |
| 17, 18 | PA12/PA11 | USB D_P/D_N nets; no ESD diodes listed in SCH-2.0 netlist [U for v2.3 DSE coverage] | none | Last-reserve bit-bang pair; weaker ESD story |
| 19 | PA14 | SWCLK; R20 = 10 kΩ NC to GND | none | Avoid: debug port |
| 24 | PA13 | SWDIO; R19 = 10 kΩ NC to VDD | none | Avoid: debug port |
| 20 | **PB13** | Clean; ESD only | I2C2_SCL (AF5); FTf | **Recommended: SCL** |
| 21 | **PB12** | Clean; ESD only | I2C2_SMBA only; FT | **Recommended: SDA (bit-bang)** |
| 22 | PB15 | **R26 = 1 MΩ to VDD + C8 = 0.1 µF to GND** (v2.3, HW-LOG); ESD | none (SPI2_MOSI etc.) | Not usable for data; **usable as rail-enable output** (R26 doubles as default-off gate bias) |
| 23 | PB14 | **R13 = 0 Ω + R14 = 1 MΩ to GND + C1 = 0.1 µF to GND**; ESD | I2C2_SDA (AF5); FTf | Dead for I2C while C1 stands |
| 25 | PA8 | LED1 GREEN via R18 = 2 kΩ to GND; R11 = 0 Ω to PA8-I (C2/R12 NC on v2.3) | I2C3_SCL (AF6); FTf | Avoid: LED load clamps a driven line |

Key structural facts behind the table:

- v2.3 added interrupt RC networks on PA4 and PB15 (HW-LOG: "Add C3,C8 0.1uF; Add R23,R26 1M so pin PA4 and PB15 can be used as interrupt"). The superseded draft called PB15 clean; on v2.3(a) it is not. [F]
- ESD diodes were added to each I/O in v2.1 (HW-LOG); their part number and capacitance are not printed on SCH-2.3's readable area [U]. Budget ≤ 100 pF per line until measured.
- Every hardware-I2C pair is blocked: I2C1 (PB6/PB7 pull-ups; PB8/PB9 not exposed; PA9/PA10 = UART + pull-ups), I2C2 (PB14 C1; PB10/PB11 not exposed), I2C3 (PA8 LED; PC0/PC1 not pinned out on the LoRa-ST module). [F]

---

## 3. Architecture options

### Viable

**A — Software (bit-bang) I2C on PB13 + PB12, reader VCC switched from VDD by an external high-side PMOS gated by PB15. Recommended; detailed in §4–§5.**
The back-power problem disappears structurally: the bus's only pull-up source is the reader's own 4.7 kΩ pair to its *switched* rail. Reader off ⇒ SDA/SCL sit near 0 V; the STM32 FT/FTf pins cannot be damaged (no positive injection path exists on FT/FTf, DS §6.3.12) and the ATtiny814 pins never exceed their own VCC. No level shifter, no bus switch IC, no board rework. Bit-bang gives exact edge control, trivial bus-clear (I2C-SPEC §3.1.16), and immunity to the I2C-peripheral errata (ES §2.12 series). CPU cost at 50–100 kHz is milliseconds per cycle. [I — design judgement on verified nets]

**B — Same bit-bang bus (PB13/PB12); power from the stock +5 V boost through an external 3.3 V regulator.** This is FW-v1.6's Variant-B power backend re-based onto clean pins: PB5 drives the on-board boost (LOW = on, MAN pin 27 note), an external LDO (with output discharge, or a 10 kΩ bleed) produces the reader rail. Pros: regulated 3.3 V keeps the reader's DS18B20 in spec down to the battery's end of life; PB15 stays free; zero change to LSN50 power wiring conventions. Cons: boost + LDO quiescent and conversion losses during the acquisition window, two more failure points (regulator reverse leakage, slow output decay — both flagged in FW-v1.6 README), switcher noise near an analog front-end. [I]

**C — Hardware I2C1 on PB6/PB7 + external two-channel bus switch + high-side load switch.** A 74LVC2G66-class analog switch (Ioff-capable) or a TCA4307/PCA9511A hot-swap buffer isolates SDA/SCL while the reader is unpowered; a PMOS or load switch cuts reader VCC. Keeps the proven HAL I2C1 path at 100–400 kHz and the stock net usage. Costs one more IC, one more enable sequencing step, and inherits ES §2.12.3/§2.12.9 handling duties. Electrically sound; loses to A on part count and on having nothing left to verify on the pin side. [I]

**D — Bridge MCU on a small adapter** (e.g., a second tiny AVR): owns the reader on a private I2C segment, buffers results, answers the LSN50 over USART1 (PA9/PA10) or a second bit-banged pair. Complete electrical decoupling from LSN50 pin conflicts; can power-gate the reader itself. Adds a second firmware, a programming flow, and BOM. Technically clean; operationally heavy for this fleet size. Defer unless A–C fail validation. [I]

### Rejected

| Option | Reason |
|---|---|
| Hardware I2C2 on PB13/PB14 | C1 = 0.1 µF: tr ≈ 398 µs vs 1000/300 ns limits (I2C-SPEC Table 10, §7.1). [F] |
| Bit-bang I2C2 through PB14 at ~500 Hz | Electrically possible (ATtiny TWI has no minimum fSCL stated; AVR §26) but every edge waits on a 470 µs time constant; fragile across temperature and tolerance; keeps a poisoned net in the signal path. Strictly dominated by PB13/PB12. [I] |
| PB15 or PA4 as data line | C8/C3 = 0.1 µF on v2.3 — same rise-time failure as PB14. [F] |
| PA8 + PB4 as I2C3 | PA8 drives LED1 through 2 kΩ; a driven SCL would be clamped by the LED. [F/I] |
| PA9/PA10 as I2C1 | Removes the AT-command/bootloader UART; 4.7 kΩ pull-ups to VDD re-create back-feed when reader is off. [F] |
| PB8/PB9, PB10/PB11, PC0/PC1 | Not exposed on connectors (SCH-2.3; DS pin table); LQFP soldering is not a field option. [F] |
| Continuous VDD power on PB6/PB7 | 8.5 mA × 24 h against a 4000 mAh cell: ~20 days ideal, less in the field (MAN §2.7's 50 µA guidance, §2.8). [F arithmetic] |
| Switched +5 V direct to reader (Topology 1) | Back-powering through SDA/SCL; brown-latch at POR boundary (§1.1). [F/I] |
| Series resistors as the only back-power fix | Field measurement shows the brown state persists through 10 kΩ already; series R only reduces current, never eliminates the ESD path. [F measurement, I conclusion] |
| Powering the reader from a GPIO | 8.5 mA exceeds the per-pin 8 mA rating (DS Table 24) and ignores inrush into the reader's rail capacitance. [F] |
| Low-side (GND) switching | Lifts the bus ground reference; SDA/SCL highs then sit a diode drop above reader ground, re-creating injection into the reader. [I] |
| Keep FW-v1.6 I2C2 image as-is | Its own README gates it on C1 removal, which the constraint forbids. [F] |

---

## 4. Recommended design and fallback

**Recommended: Architecture A.** Bit-bang I2C on PB13 (SCL) / PB12 (SDA), reader powered from VDD through an external high-side PMOS whose gate PB15 drives. It is the only option that needs no isolation silicon, no 5 V, no boost runtime, and no clean hardware-I2C pair — because it does not need one. Its known weakness is the reader's DS18B20 minimum supply (~3.0 V per FW-v1.6 README): at end-of-battery-life the temperature channel degrades first and fails flagged, not silently. [I]

**Fallback: Architecture B.** Identical bus and firmware backend, power backend swapped to the stock PB5 +5 V output feeding an external 3.3 V regulator. Choose B if bench work shows the PMOS-on-VDD variant underperforming at low battery, or if a future reader revision requires a regulated 3.3 V. The two share one acquisition state machine; the constraint "separate firmware images may use different power or bus backends" maps onto the existing dual-image build structure from FW-v1.6. [I]

Architecture C remains the escape hatch if a future requirement (e.g., 400 kHz timing for a different slave) forbids bit-bang.

---

## 5. Recommended design: schematic-level wiring

### 5.1 Wiring diagram

```text
LSN50 v2.3a (terminals per MAN §1.5)          adapter board (new)              VIA Chameleon reader
─────────────────────────────────         ─────────────────────────        ──────────────────────
                                         ┌───────────┐
VDD  (#1)  ──────────────────────────────┤ S       D ├──────────┬─────────► reader VCC
                                         │  Q1 PMOS  │          │
PB15 (#22) ──[ R_A1 = 1 kΩ ]─────────────┤ G         │          ├────[ R_A4 = 10 kΩ bleed ]── GND
                                         └───────────┘          │
                  R_A2 = 100 kΩ gate pull-up (gate to source)   │
GND  (#12) ────────────────────────────────────────────┬───────┴─────────► reader GND
                                         ┌─────────────┘
PB13 (#20) ──[ R_A5 = 100 Ω, optional ]──┴────────────────────────────────► reader SCL
PB12 (#21) ──[ R_A6 = 100 Ω, optional ]──────────────────────────────────► reader SDA

Bus pull-ups: the reader's own 4.7 kΩ pair to its (switched) VCC. No pull-ups on the LSN50 side.
```

### 5.2 Component properties and rationale

| Part | Required property | Why |
|---|---|---|
| Q1 | P-channel MOSFET, VDS ≥ −20 V, ID ≥ 200 mA, RDS(on) specified at VGS = −2.5 V and ≤ 150 mΩ, VGS(th) between −0.5 V and −1.5 V, IDSS ≤ 1 µA (AO3401A / Si2301DS class) | VGS at turn-on is −VDD (−3.0…−3.6 V over pack life); drop at 8.5 mA is < 2 mV; off-leakage sets the floor on phantom power [I] |
| R_A1 | 1 kΩ, gate series | Limits C8 (100 nF on PB15, on-board) discharge/charge pulses through the STM32 pin to ~3.6 mA; with C8 forms ~100 µs gate ramp → free inrush limiting into the reader rail [F for C8; I for values] |
| R_A2 | 100 kΩ, gate→source | Default-off even if PB15 is tri-stated; on-board R26 (1 MΩ to VDD) already biases toward off, R_A2 makes it explicit [F for R26] |
| R_A4 | 10 kΩ bleed, reader VCC to GND | Defined off-state; discharge τ ≈ 10 kΩ × ~10 µF ≈ 100 ms, inside the 200 ms cold-off window used by FW-v1.6 [I — reader capacitance unmeasured, U] |
| R_A5/R_A6 | 100 Ω series, optional | Limits transient injection into STM32 pins from the outdoor cable; invisible to the bus against 4.7 kΩ pull-ups [I] |
| Cable | ≤ 3 m, twisted pair for SDA/GND preferred | Keep total line capacitance ≤ ~300 pF so tr ≤ ~1.2 µs at 4.7 kΩ; bit-bang at ≤ 100 kHz keeps 4× margin to the 1000 ns Standard-mode limit [I] |

Predicted off-state (GO criterion, to be bench-verified): reader VCC < 0.2 V within 300 ms of PB15 release; SDA/SCL < 0.3 V; current into the reader VCC pin < 1 µA. No node in this design can sit at the 1.4–1.5 V brown state from Topology 1, because no net connects an always-on rail to the reader through any resistance. [I — prediction from the verified netlist]

Power-up sequence per cycle: PB15 drives low → Q1 on → ≥ 25 ms settle (FW-v1.6 constant; validate against actual reader boot-to-ready, §9) → probe 0x08 (≤ 1500 ms window) → if status ready, read immediately (the reader measures at power-up per VIA-LIB); else trigger 0x40 and poll 0x41 (50 ms, ≤ 2 s) → read registers → PB12/PB13 to analog → PB15 releases → Q1 off. [F for the protocol order; I for the fast path]

---

## 6. Firmware requirements (no implementation yet)

1. **Bus backend.** Bit-banged open-drain emulation on PB13/PB12 (drive-low = output-0, release = input). Nominal 50–100 kHz. After every release of SDA or SCL, wait ≥ the scoped rise time before sampling. Tolerate slave clock stretching on every SCL release with a bounded wait (ATtiny TWI supports stretching, AVR §26.3.2.6; whether the VIA firmware stretches is [U]).
2. **Deadlines, not retries.** Every phase has an absolute wall-clock deadline computed from the time server, as FW-v1.6's `bounded_probe` does; the FW-v1.6 spec's review finding (50 ms polls × 1 s HAL timeouts ≠ wall-clock bound) stays fixed. Worst-case acquisition: settle 25 ms + probe ≤ 1.5 s + wait ≤ 2 s + reads ≈ 10 ms + one cold retry (200 ms off + repeat) ≈ ≤ 8 s.
3. **Recovery ladder.** (a) transaction error → finish cycle with flags, uplink proceeds; (b) SDA seen low before START → 9 SCL pulses + STOP (I2C-SPEC §3.1.16) once; (c) still failing → rail power-cycle (the UM10204 §3.1.16 remedy for a held bus and the only reset the ATtiny reliably obeys); (d) still failing → set `i2c_missing`, skip sensor until next cycle. Never reset the MCU to fix the sensor.
4. **Watchdog budget.** IWDG ≈ 28.3 s (4095 × 256 / 37 kHz), refreshed at 18 s (FW-v1 code). The ≤ 8 s worst case leaves > 3× headroom; acquisition code must not suppress the refresh timer and must not run inside an interrupt. [F for the timer math]
5. **Boot and sleep states.** At reset and before STOP: PB12/PB13 analog no-pull, PB15 input (R26 + R_A2 hold Q1 off). The dedicated image owns PB12/PB13/PB15: mask their EXTI lines and remove stock digital-interrupt handling for PB15 — the same ownership pattern FW-v1.6 applied to PB14. Do not enable I2C/USART wake-from-Stop (ES §2.1.4: unexpected reset); disable peripherals before Stop (ES §2.12.2 pattern, moot for bit-bang but keep the UART rule).
6. **Protocol preservation.** Address 0x08; command set 0x01/0x11–0x13/0x21–0x23/0x30/0x40/0x41 with repeated-start reads; sentinel handling (−127 °C, all-FF ID, 10 MΩ open) exactly as FW-v1.6 and the osi-os decoder expect; payload stays V1 44-byte or V2 compact — both decode today (`dragino_lsn50_decoder.js`). MOD3 lock and downlink behavior unchanged. The only intentional behavioral delta: skip 0x40 when the power-up measurement is already ready (status 0x01 in the probe window), which halves typical on-time; gate this behind a bench check that the reader's power-up readiness holds on the bench (§9 question to VIA).
7. **Counters.** Persist/report: acquisitions, NACK/ARLO-equivalent (bit-bang: NACK, stuck-SDA, timeout) counts, bus-clear invocations, cold retries, last IWDG reset cause (FW-v1.6 already logs `iwdg` vs `other` at boot). These feed the field go/no-go.

## 7. Staged verification plan

No stage uses "address ACK," "short bench run," or "successful build" as evidence. Each stage has a quantitative pass gate.

**S0 — bench, power path only (no reader).** Verify with a DMM and scope: PB15 LOW ⇒ rail on, released ⇒ rail off; off-state rail < 0.2 V within 300 ms; gate-net pulses within STM32 pin limits; rail ramp monotonic, no double-bounce (PMOS gate RC). Pass: all polarities as designed, off-leakage < 1 µA. [mirrors FW-v1.6 README bench gates 1–3]

**S1 — bench, electrical with reader.** Scope SDA/SCL at the reader end of the deployed cable: rise/fall times, high/low levels at the chosen bit-bang speed (target tr ≤ 1 µs, i.e., inside Standard-mode). Measure reader on-current profile and the LSN50's full-cycle energy with a PPK2-class instrument; measure sleep current with the reader attached vs detached (must be equal within 1 µA). Pass: timing margins ≥ 4×; no phantom current.

**S2 — fault injection.** Each fault below must leave LoRa uplinks on schedule and must not produce an IWDG reset (check reset-cause logging each boot): SDA shorted to GND; SCL shorted to GND; SDA↔SCL swapped; reader disconnected mid-transaction; all three soil channels open; DS18B20 absent; reader browned — ramp 0→5→0 V slowly and dwell 60 s at 1.4–1.5 V (the Topology-1 brown state) before restore; battery at 2.7 V; 10 000 acquisition cycles with randomized 100 ms power glitches on the reader rail. Pass: bounded completion and correct flags in 100 % of runs; recovery without operator action after fault removal.

**S3 — accelerated battery.** Fresh ER18505 + super-cap pack, 5-minute cadence, ≥ 2 weeks continuous: log pack voltage daily, scope the TX-pulse droop weekly (passivation check), compute average current from instrumented windows. Pass: average whole-node current matches the ≤ ~40 µA-above-baseline budget; no brown-out resets.

**S4 — field, ≥ 2 nodes, ≥ 6 weeks.** One node per power variant (A and B) at real sites, 5–15 min cadence. Track `i2c_missing` / `timeout` / `data_invalid` rates, cold-retry and bus-clear counters, array-ID stability, and battery slope. Pass: zero node-loss events; no multi-hour missing blocks of the FIELD kind; miss rate statistically at the transient-noise floor (target < 0.1 % of cycles, unexplained misses = 0).

## 8. Go/no-go criteria

**GO (all required):**
- Off-state: reader VCC < 0.2 V, SDA/SCL < 0.3 V, reader-pin feed current < 1 µA.
- Bus: rise/fall inside Standard-mode limits at the shipped speed, measured on the deployed cable.
- S2 suite: uplinks uninterrupted in every injected fault; zero IWDG resets attributable to the sensor path; recovery always automatic.
- S3: projected pack life ≥ 3 years on the 4000 mAh pack at the site's reporting cadence.
- S4: 6 weeks, both variants, no node loss, missing-rate at noise floor, battery slope on budget.
- Code review: no unbounded wait anywhere on the acquisition path; recovery ladder present; protocol bytes match the decoder contract.

**NO-GO (any one):** any persistent intermediate rail voltage with the rail off; any uplink gap caused by the sensor subsystem; an unbounded wait found in review; SDA/SCL rise beyond Standard-mode at shipped speed; any unexplained watchdog reset in S2–S4; S3/S4 energy over budget.

## 9. Missing information and vendor questions

**For Dragino:**
1. Publish the v2.3a schematic or the v2.3 → v2.3a delta. All analysis here is on the v2.3 document plus visual confirmation of C1 on a v2.3a board. [U]
2. Which interrupt networks ship populated on v2.3a production units: C1/R14 on PB14, C8/R26 on PB15, C3/R23 on PA4? [U]
3. ESD diode part number and capacitance on JP3/JP4 I/Os (DSE designators). Needed for the final bit-bang speed margin. [U]
4. Confirm PB12/PB13 have no other on-board function on v2.3a, and confirm the JP4 pin-9 signal is PA13 (SWDIO). [F on v2.3 docs; U on 2.3a]
5. RT9266 quiescent current, EN behavior when Q8/T1 are off, and residual +5 V leakage (needed only if Variant B power is fielded). [U]
6. Reconcile MAN ("10k pull up" on PB3) vs SCH-2.3 (R7 = 4.7 kΩ on PB3). Cosmetic, but the pin table is cited everywhere. [U]
7. Does the shipped battery pack always include the super-capacitor, and its spec? [U]

**For VIA:**
1. Reader firmware version and source availability; MCU confirmed as ATtiny814. [F for ATtiny814 from VIA-LIB context; U for firmware]
2. Power-up to I2C-ready time, and whether the power-up measurement (status 0x01 without 0x40) is guaranteed behavior. Gates the fast path in §6.6. [U]
3. Worst-case 0x40 → ready time over supply (3.0–3.6 V) and temperature. Current bound is 2 s by assumption. [U]
4. Does the reader's TWI slave use clock stretching? Minimum SCL frequency? [U]
5. Behavior under slow VDD ramps and mid-transaction power loss; any internal watchdog or only POR/BOD recovery. [U]
6. Confirm the 4.7 kΩ pull-ups to VCC and whether a no-pull-up build is available. [F for the measured value; U for options]
7. Current profile breakdown of the ~8.5 mA (excitation peaks during measurement?) and any lower-power reader variant. [U]
8. On-board DS18B20 minimum supply versus the temperature-compensation validity floor. [U]

**Internal measurements still owed:** C1 actual value/tolerance on the v2.3a fleet sample; harness capacitance; reader rail capacitance; true custom-image STOP current; deployed packs' passivation state.

## Appendix A: corrections to the superseded 2026-08-15 draft

The untracked draft at `docs/hardware/lsn50-chameleon-i2c-architecture-analysis.md` contains thinking-aloud artifacts and these factual errors: datasheet "DS12289" → actually DS10689 Rev 5; errata "ES0237" → actually ES0292 Rev 8; "RM0376 rev 6" → Rev 7; PB15 called clean → v2.3 adds R26/C8 (1 MΩ + 0.1 µF); I2C3 presented as a maybe-available option → on LQFP-48 I2C3 needs PA8 (LED-loaded on LSN50) or PC0/PC1 (not exposed); LSN50 I2C1 pull-ups guessed 10 kΩ → confirmed 10 kΩ (R1/R2) but the draft's mechanism text also floated 4.7 kΩ, which is the reader's pair. This review replaces it in full.

## Appendix B: one-line answer

No usable hardware-I2C pair survives the v2.3 net audit, and every failure to date traces to power, not protocol: bit-bang I2C on the two verified-clean pins (PB13/PB12), switch the reader's VDD with a high-side PMOS on PB15, keep the Chameleon protocol and payload byte-identical, and gate the design on the staged electrical and fault-injection plan above.
