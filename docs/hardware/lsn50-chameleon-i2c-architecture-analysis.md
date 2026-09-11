# LSN50v2.3 + VIA Chameleon I2C: root cause and recommended architecture

**Date:** 2026-08-15
**Status:** Analysis complete. No firmware implemented; §6 is a requirements spec, not code.
**Scope:** Root-cause assessment of the three attempted reader topologies, full pin/net audit of the LSN50 v2.3 board, candidate architectures, one recommended design with fallback, firmware requirements, staged test plan, go/no-go gates, and open vendor questions.

## Executive summary

Why each attempt failed:

1. **Switched 5 V (first wiring).** The LSN50 has permanent 10 kΩ resistors from PB6/PB7 to its always-on battery rail. With the 5 V rail off, those resistors kept feeding the reader through the I2C wires, holding it half-powered at ~1.4 V. It never got a clean restart, so it sometimes woke up broken. This is a board-level property; no firmware or pin setting can remove it.
2. **Always-on power (June rewire).** Electrically fine, but the reader's 8.5 mA drains the stock 4 Ah battery in about 20 days. The node that went silent most likely ran its battery down; a watchdog reset loop may have helped it along.
3. **PB13/PB14 (current experiment).** PB14 has a factory-fitted 0.1 µF capacitor to ground (part of Dragino's door-sensor interrupt circuit). It slows the I2C data line about 400× past the allowed limit, so the STM32 reports "arbitration lost" (the 0x201 code) on every attempt. With the capacitor staying, this pin can never carry I2C. Note PB15 has the same capacitor since board v2.3.

What to build instead: switch the reader's power with one small P-channel MOSFET fed from the battery rail (control on PA1), and run the I2C bus in software on **PB13 + PB12**, the only two exposed pins with nothing else attached. The reader's own pull-up resistors are the only ones on the bus, so when its power is off the whole bus sits at 0 V and nothing can back-feed. Sensor failures only set a fault flag; the uplink always goes out. Fallback if that disappoints on the bench: back to PB6/PB7 hardware I2C with a small isolation-switch chip.

Do this now, before any of it: check kaba100 Chameleon 1's battery. It has been on the always-on wiring since June 28, which is roughly its entire battery budget, and the voltage reading will look healthy until the day it dies.

Watch out for, when building: a `DEBUG` firmware build grounds PB12–PB15 and would kill the new bus; the Dragino manual has the SDA/SCL names swapped and uses old terminal numbering (trust the schematic and the v2 pin drawing); and the boot watchdog fix exists only as unpushed commit `7153161` and must ship first.

Sections 7–8 define the bench, fault, battery, and 4-week field tests with pass/fail numbers; nothing goes to the fleet before those pass.

---

Every load-bearing claim below is labeled **F** (fact, with citation), **I** (inference, with reasoning), or **U** (unknown). "The board" means the Dragino LSN50v2 rev 2.3a in the field; Dragino publishes no 2.3a revision, and its hardware repo jumps from v2.3 to v3.0, so 2.3a is treated as electrically identical to the published v2.3 schematic (**I**; confirm per §9.3).

## 0. Sources

| Source | Version | Where |
|---|---|---|
| Dragino LSN50 v2.3 schematic, `LoRa ST Sensor Node v2.3.sch` (EAGLE, printed mirrored; flip before reading) | 2021-10-28 | github.com/dragino/Lora → LSN50/v2.3; local `scratchpad/lsn50_v2.3_sch.pdf` |
| Dragino LSN50 hardware changelog | v2.1–v3.3.1 | same repo, `LSN50/Changelog.txt` |
| LSN50 user manual | v1.7.4, 2021-09-01 | `scratchpad/manual174.pdf` |
| STM32L072xx datasheet DS10689 | Rev 5 | `scratchpad/ds10689.pdf` |
| STM32L0x2 reference manual RM0376 | Rev 7 | `scratchpad/rm0376.pdf` |
| STM32L07xxx/L08xxx errata ES0292 | Rev 7 | `scratchpad/es0292.pdf` |
| NXP I2C-bus specification UM10204 | Rev 7.0 | `scratchpad/UM10204.pdf` |
| EVE ER18505 cell datasheet; EVE SPC1520 battery-capacitor | 2015; ed. 2 | `scratchpad/er18505.pdf`, `spc1520.pdf` |
| VIA vendor reference library | as shipped | `/home/phil/kDrive/OSI OS/Hardware/Chameleon/VIAChameleonI2CMaster/` |
| OSI firmware branches | `feature/chameleon-i2c-reader`, `feature/chameleon-v1.5`, `feature/chameleon-v1.6-switched-i2c2` | `Project-OSI/LoRa_STM32` |
| Field data | 2026-06-28 outage analysis | `docs/operations/kaba100-chameleon1-i2c-outage-analysis-2026-06-28.md` |

All scratchpad-referenced documents are archived durably at `/home/phil/kDrive/OSI OS/Hardware/Chameleon/datasheets-2026-08-15/` (schematic, silkscreen, manual v1.7.4, DS10689, RM0376, ES0292, UM10204, ER18505, SPC1520, v2 pin drawing).

Reader protocol constants used throughout (**F**, `VIAChameleonI2C.h/.cpp`): ATtiny814 slave at address 0x08; trigger 0x40 (write-only), status 0x41 (1 byte, 0x01 = ready), temp 0x01 (int16 LE), compensated ohms 0x11–0x13 and raw ohms 0x21–0x23 (uint32 LE), DS18B20 ROM 0x30 (8 bytes). Reads require repeated start. The vendor demo polls status every 50 ms with a 2000 ms deadline, and the reader performs one unsolicited measurement at power-up. The reader carries its own ~4.7 kΩ pull-ups from SDA/SCL to its VCC rail (**F** that pull-ups to VCC exist, established by the 2026-06-28 analysis; the ~4.7 kΩ value is an OSI bench measurement, corroborated independently by the §1.1 divider reconstruction — the vendor sketch comment "add 4.7 kΩ if not already present" left it ambiguous).

## 1. Root cause of the three attempted topologies

### 1.1 Topology 1: PB5-switched +5 V, hardware I2C1 on PB6/PB7

**Verdict: confirmed back-powering through the board's fixed I2C pull-ups; the reader spends its off-time in an undefined brownout state and sometimes fails to come up sane.** The user-supplied hypothesis is correct, and it survives quantitative checking.

The current path (**F** for every component; **I** for the composite): the v2.3 schematic fits R1 = R2 = 10 kΩ from PB6/PB7 to VDD, where VDD is the raw battery through a PPTC fuse with no regulator and, since v2.3, no series diode (changelog item "Remove D1"). VDD is never switched. When the +5 V rail is off, current flows VDD → 10 kΩ → SDA/SCL wire → reader pin → reader VCC, through two parallel paths on the reader: its own 4.7 kΩ pull-ups and its ESD clamp diodes.

The measured numbers close the loop (**I**, arithmetic on **F** inputs). At the field-measured bus level of 1.95 V and reader VCC of 1.45 V: each 10 kΩ pull-up sources (3.6 − 1.95)/10k ≈ 165 µA; the 4.7 kΩ path carries (1.95 − 1.45)/4.7k ≈ 106 µA; the 0.50 V bus-to-VCC step is the drop of a silicon ESD diode at tens of µA. The implied load on the floating VCC node (2–5 kΩ) is what a partially biased CMOS die looks like. The same two resistor values also predict the healthy-state reading: with the reader at 5 V, the 4.7k-to-5V / 10k-to-VDD divider gives 4.46–4.55 V, and the field log recorded 3.9–4.6 V on SDA/SCL during measurement. One resistor model explains both the fault state and the working state, which is the strongest available confirmation short of desoldering. The 2026-06-28 experiment sealed the mechanism: with VCC disconnected and SDA/SCL still attached, the reader rail sat at ~1.45 V; with SDA/SCL also removed it decayed to ~0 V.

Two corrections to how this failure is usually told:

- The STM32 is a bystander. FT/FTf pins on the L072 have no protection diode to VDD (RM0376 Fig. 22: the upper diode returns to a separate V_DD_FT net; DS10689 Table 60: ≤ 500 nA leakage with the pin at 5 V) (**F**). The back-power current never enters the MCU; it flows entirely through R1/R2. No GPIO mode change can stop it, which is why the fix must break the resistive path rather than reconfigure pins (**I**).
- 4.6 V on the bus did not endanger the MCU. FT pins tolerate VDD + 4.0 V (DS10689 Table 23) (**F**). The victims were the reader (held half-powered, its power-on reset never firing cleanly, so the "one free measurement at boot" contract and the 5-minute status decay ran from an undefined state) and the battery (~0.3–0.7 mA continuous drain through the pull-ups while nominally off) (**I**).

Why it worked for days and then turned intermittent (**I**): whether the ATtiny814 wakes cleanly from 1.4–1.5 V depends on whether its supply dipped below the POR release threshold before the next 5 V enable, which in turn depends on leakage, temperature, and timing. That is a textbook recipe for a fault that appears in blocks (the field data shows 42.9 h and 48.4 h continuous i2c_missing runs) rather than uniformly at random.

### 1.2 Topology 2: continuous VDD, hardware I2C1 on PB6/PB7

**Verdict: electrically sound but energetically fatal on the shipped cell; battery exhaustion is the sufficient explanation for the dead node, with a watchdog-reset contribution plausible but unproven.** This matches the user's framing: the exact stop mechanism remains unknown..

The battery arithmetic (**F** inputs, **I** conclusion): the default LSN50v2 pack is an EVE ER18505 Li-SOCl2 cell, 4.0 Ah nominal at 3 mA drain, 130 mA max continuous, paired with an SPC1520 battery-capacitor for pulses (manual §2.9.4; ER18505 datasheet). The 8500 mAh order option exists (order code ZZ=8; cell undocumented by Dragino, **U** which one a given unit carries). At the bench-measured 8.5 mA continuous reader draw (user measurement; treated as **F** for this unit, unverified against any vendor spec, see §9.1), the ceiling is 4000/8.5 ≈ 470 h ≈ 20 days on the 4 Ah cell, or ~42 days on the 8500 mAh option, before Li-SOCl2 derating. Derating is not minor: 4.0 Ah is specified at 3 mA, and the datasheet halves the yield already at 130 mA; sustained 8.5 mA plus 125 mA TX pulses on a depleting cell brings the real number in under the ceiling. "Worked initially, stopped uplinking weeks later" is exactly this curve, and the flat-then-cliff discharge profile of Li-SOCl2 explains why the last recorded battery voltage still read 3.6 V.

The firmware contribution (**F** for the code, **U** for whether it fired in the field): the v1.5-era acquisition path can outlast the watchdog. `via_chameleon_wait_ready()` counts 50 ms per loop iteration rather than reading a clock, while each iteration's HAL call can block up to its own 1000 ms timeout; a dead bus can stretch the nominal 2 s wait to ~42 s of wall time (`via_chameleon.c:29-40` on that branch). The IWDG is configured for ~25–28 s (prescaler 256, reload 4095; LSI 26–56 kHz spread makes any nominal value −34/+42 %), and it is refreshed from the main loop via an 18 s software timer, so a blocked acquisition starves it. A watchdog firing mid-acquisition produces a reset loop that both stops uplinks and accelerates battery drain. Direct field evidence that this class of hang does trip the IWDG exists from a different path: the 2026-08-13 bench log records the board restarting "after about 20 seconds" stuck in the blocking AT/configuration path. Separately, the Kaba100 frame-counter records show f_cnt=0 restarts bounding the long fault blocks, proving the node reset during fault windows without identifying which reset source (**F** the resets; **U** the cause; note ES0292 §2.1.3 describes a reset on Stop-mode wake that leaves no flag in RCC_CSR when V_DD < 2.7 V with LPSDSR = 1 and the regulator in Range 2/3 — firmware-controlled conditions a low-power LoRa stack typically meets — so a sagging cell can produce resets that are invisible to software post-mortem).

Operational corollary: any unit still wired this way (the June 28 field fix left Kaba100 Chameleon 1 on continuous VDD) is spending its cell at roughly 50–100× the design rate and should be checked now (§9.4).

### 1.3 Topology 3: switched 3.3 V, hardware I2C2 on PB13/PB14, ISR 0x201

**Verdict: confirmed. PB14 carries a 0.1 µF capacitor to ground on the v2.3 board; no pull-up value, bus speed, or firmware change can make it work as SDA. ARLO is the peripheral reporting exactly what the capacitor does to the line.**

The net, verified on the official v2.3 schematic (**F**): terminal 18 → R13 (0 Ω, series strap) → node `PB14-I` → U1 pin 14, with R14 (1 MΩ) and C1 (0.1 µF) from that node to ground. The user's stated claim ("PB14 through R13 = 0 Ω to C1 = 0.1 µF to ground") is correct in substance; the refinement is that R13 is a series jumper and the RC pair sits on the MCU-side node. This is the board's Digital Interrupt input (manual v1.7.4 §2.4.5): R14 is its idle pull-down, C1 its debounce. Dragino's own SHT31 app note tells users to disable this interrupt when I2C misbehaves, so the vendor has met this pin's interaction with I2C before (**F**).

The physics (**I**, arithmetic on **F** limits): with the reader's 4.7 kΩ pull-up, τ = 470 µs and the I2C-defined 30 %→70 % rise time is 0.8473 · τ ≈ 398 µs, against limits of 1000 ns (100 kHz) and 300 ns (400 kHz) (UM10204 Table 11). That is 398× and 1327× over. The capacitor alone is 250× the 400 pF bus budget. The strongest legal pull-up (~1.1 kΩ, bounded by VOL = 0.4 V at 3 mA sink) still yields ~93 µs. Even the fall time through the master's open-drain FET (25–100 Ω into 0.1 µF gives 2.1–8.5 µs) exceeds the 2.5 µs bit period at 400 kHz. The pin is out of reach in both directions.

The ISR decode (**F**, RM0376 §27.7.7 and §27.4.17): I2C_ISR resets to 0x0001, so TXE = 1 is the idle state and carries no information; 0x201 is ARLO plus that idle bit. ARLO sets when the master transmits a high but samples SDA low on an SCL rising edge, checked during address, data, and acknowledge phases (not during START, where the master drives low). Address 0x08 + W is 0x10 on the wire, so the first transmitted high bit is bit 4: the peripheral emits START plus three clean SCL pulses, then loses arbitration on the fourth, every time. Two corroborating details make this diagnosis firm rather than plausible. First, BUSY = 0 inside 0x201: BUSY sets on a detected START edge (SDA falling while SCL high), and a capacitor-clamped SDA never makes that edge, so the register value is internally consistent with a line that cannot move. Second, ES0292 contains no erratum for spurious ARLO (unlike BERR, which §2.12.4 documents as untrustworthy), so an ARLO on this part reflects a real bus-level event (**F**). One nuance from the firmware audit (**I**): the polling-mode HAL never reads or clears ARLO (`stm32l0xx_hal_i2c.c:4473-4630` handles only NACK and timeout), and the branch clears it only via the per-session peripheral force-reset, so a logged 0x201 could be stale from an earlier transfer in the same session. It changes nothing here: with C1 on the pin, the first address byte cannot get past bit 4 regardless of which transfer the captured value belonged to.

The field-debug build that captured 0x201 ran the bus at 100 kHz (`chameleon_lsn50_hw.c:166-174` selects TIMINGR 0x10A13E56 under CHAMELEON_FIELD_DEBUG), which closes the "maybe 400 kHz was just too fast" escape: it fails identically at both speeds, as the arithmetic says it must (**F**/**I**).

Everything else about the v1.6 design was sound (**F**, from the branch): rail-off/isolate/rail-on/settle/init/probe/measure/deinit/isolate/rail-off session lifecycle, analog-mode pin parking when off, wall-clock waits, RCC force-reset of the peripheral per session, uplink proceeding with fault flags. The architecture below keeps that skeleton and moves it off the dead pin.

## 2. Pin/net conflict audit (LSN50 v2.3, every exposed GPIO)

Net list read from the v2.3 schematic; terminal numbers per Dragino's v2 pin-definition drawing, which shows terminal 26 = PA4 (**F**; the schematic headers are 12-pin symbols while the drawing labels 26 terminals, so confirm PA4 continuity with a DMM before relying on it). The audit covers board nets and stock-firmware pin ownership; the firmware claims noted below assume the MOD3-only enforcement that the chameleon branches carry.

| Term. | Pin | Attached components (beyond a per-pin ESD diode) | I2C capability (DS10689 T17/18) | Usable for this project? |
|---|---|---|---|---|
| 2 | PA0 | none | — | Free, but stock/MOD3 ADC input; avoid |
| 3 | PA1 | R15 12 Ω to GND unpopulated | — | **Clean. Candidate power-enable GPIO.** Stock MOD3 samples PA1 as ADC channel 1 into the legacy `ADC_1` payload field, so with the gate here that field reports the gate-node voltage instead of floating-pin noise; benign, and usable as free gate telemetry |
| 4 | PA2 | R9 10 kΩ→VDD; JP5-2 | — | USART2/JP5, pull-up; no |
| 5 | PA3 | R10 10 kΩ→VDD; JP5-1 | — | USART2/JP5, pull-up; no |
| 6 | PB6 | **R1 10 kΩ→VDD** | I2C1_SCL AF1, FTf | Only with continuous power or bus isolation (§3) |
| 7 | PB7 | **R2 10 kΩ→VDD** | I2C1_SDA AF1, FTf | same |
| 8 | PB3 | R7 4.7 kΩ→VDD | — | pull-up; no |
| 9 | PB4 | R8 10 kΩ unpopulated | **I2C3_SDA AF7**, FTf | Clean pin, but its I2C3 partner PA8 is not (below) |
| 10 | PA9 | R3 4.7 kΩ→VDD | I2C1_SCL AF6 | AT console TX + pull-up; no |
| 11 | PA10 | R4 4.7 kΩ→VDD | I2C1_SDA AF6 | AT console RX + pull-up; no |
| 16 | PA8 | R11 0 Ω series; **R18 2 kΩ + green LED1 to GND**; R12/C2 unpopulated | **I2C3_SCL AF7**, FTf | Doubly blocked: the LED loads the net (with a 4.7 kΩ pull-up the high level settles near 2.48 V vs VIH = 0.7·VDD ≈ 2.52 V), and PA8 is `RADIO_ANT_SWITCH` — the radio BSP drives it push-pull around every TX/RX (`stm32l0xx_hw_conf.h:108`, `sx1276mb1las.c:265-308`). A board mod alone does not free it |
| 17 | PA13 | R19 unpopulated | — | SWDIO; no |
| 18 | PB14 | **R13 0 Ω; R14 1 MΩ→GND; C1 0.1 µF→GND** | I2C2_SDA AF5, FTf | **Dead for I2C** (§1.3) |
| 19 | PB15 | **R26 1 MΩ→GND; C8 0.1 µF→GND** (added in v2.3) | — | **Dead for I2C, same RC as PB14.** Any plan that picked PB15 as SDA fails identically |
| 20 | PB12 | ESD only | I2C2_SMBA AF5 (no SCL/SDA) | **Clean. Candidate SDA (software I2C).** Stock firmware uses PB12 as `ULT_TRIG`/`WEIGHT_DOUT` in other work modes only; the verdict is conditional on the MOD3-only enforcement the chameleon branches already carry |
| 21 | PB13 | ESD only | I2C2_SCL AF5, FTf | **Clean. Candidate SCL** |
| 22 | PA14 | R20 unpopulated | — | SWCLK; no |
| 23/24 | PA11/PA12 | none | — | USB DM/DP; PA12 reflects the flash switch; no |
| 25 | NRST | C7 0.1 µF; reset switch | — | — |
| 26 | PA4 | R23 1 MΩ→GND; C3 0.1 µF→GND (added in v2.3) | — | Dead for I2C (interrupt RC); usable as a slow enable at most |
| — | PB5 | R22 1 kΩ→T1 PMOS gate (R25 100 kΩ→VDD); R5 1 kΩ→Q8 BSS138 gate | — | Committed to the +5 V switch |

Hardware I2C exhausts as follows (**F** pin maps, **I** verdicts). I2C1: PB6/PB7 and PA9/PA10 both carry fixed pull-ups to the always-on rail; PB8/PB9 are not brought out. I2C2: PB13 is clean but its only exposed SDA partner PB14 is capacitor-clamped; PB10/PB11 are not brought out; I2C2 also lacks the SMBus timeout hardware and an independent kernel clock (RM0376 Table 114), so it was the weakest instance to build on even before the pin problem. I2C3: bonded out on this package as PA8 + PB4 (a correction to the earlier draft analysis, confirmed twice: DS10689 AF tables and RM0376 SYSCFG_CFGR2 bit 14), but PA8 is both loaded by the status-LED network, which drags the idle-high below VIH, and owned by the radio BSP as the antenna switch, so freeing it would take a board mod plus a radio-driver change. **Conclusion: on an unmodified v2.3 board there is no exposed, electrically clean hardware-I2C pin pair.** The clean pins that do exist, PB12 and PB13, happen to be adjacent terminals (20/21).

Board-level facts that shape the design (**F**): VDD is the raw cell (3.6 V fresh, no regulator, no diode since v2.3; the wiki's "battery + diode" text is stale). The +5 V rail is a PB5-gated PMOS feeding an RT9266 boost with 100 µF input and 110 µF output capacitance; enabling it steps a ~210 µF charge demand onto a cell rated 130 mA continuous, i.e. a guaranteed VDD sag event on the same rail that feeds the MCU and every fixed pull-up. The manual's own I2C app note powers sensors from VDD, not +5 V. The user manual's §2.4.6 swaps the SDA/SCL labels for PB6/PB7 (schematic and app note agree: PB6 = SCL, PB7 = SDA); any field wiring done from the manual text alone is crossed.

## 3. Candidate architectures

### 3.1 Viable

**A. Switched-VDD rail via dedicated high-side P-FET; software (bit-banged) I2C on PB13 = SCL, PB12 = SDA; pull-ups only on the reader side. Recommended; detailed in §4–5.**
The only exposed clean pin pair carries the bus; the reader's own 4.7 kΩ resistors to its switched VCC are the only pull-ups, so an unpowered reader means an unpulled bus at 0 V and no current path anywhere. A discrete P-FET from VDD replaces both the +5 V boost (rejected below) and the back-powering topology. Bit-banging removes the entire class of hardware-peripheral failure modes this project has actually hit (ARLO semantics, HAL blocking waits, ES0292 §2.12.2/2.12.9 stalls) in exchange for ~40 bytes of trivially rate-insensitive protocol per cycle. Cost: one FET, three resistors, and a software I2C module that must be written carefully (per-edge wall-clock timeouts, SCL read-back).

**B. Hardware I2C1 on PB6/PB7 with a bus-isolation switch, same switched-VDD power. Fallback.**
Keeps the proven I2C1 peripheral (which, unlike I2C2, has SMBus TIMEOUTR: a hardware SCL-low timeout up to 25 ms usable in master mode, RM0376 §27.4.13) and the existing 10 kΩ pull-ups for the on-state. A dual analog bus switch (TS5A23157-class, or a PCA9306 level translator used as an enable-gated pass gate) sits between PB6/PB7 and the reader; its enable is tied to the reader power enable, so the off state breaks the resistive path that killed topology 1. On-state bus high = VDD (raw cell), as in the June-fixed wiring that measured clean. Cost: one more IC than A, an adapter board either way, and the firmware must still be hardened against the HAL's ARLO-blind polling and the Stop-mode/TXDR errata. Choose B over A only if bit-banging fails validation (§7 stage 1) or if the hardware SCL-low timeout is judged worth the extra part.

**C. Continuous VDD power on PB6/PB7, as running on Kaba100 since 2026-06-28. Interim only.**
Electrically clean (0/31 fault rows in the post-fix window) and zero new hardware, but the 8.5 mA reader draw gives a 20-day ceiling on the 4 Ah cell (§1.2). Viable long-term only with external power (mains/solar) or a vendor sleep mode that does not currently exist (**U**, §9.1). Legitimate as the bench-comparison baseline and as a bridge while A is validated, provided batteries are treated as consumables and monitored.

### 3.2 Rejected

| Option | Why rejected |
|---|---|
| Hardware I2C2 on PB13/PB14, any speed, any pull-up | C1 = 0.1 µF on SDA: 398 µs rise vs 1 µs/300 ns limits; 250× the capacitance budget; even fall time exceeds the 400 kHz bit period; strongest legal pull-up still ~93 µs (§1.3). C1 stays per constraints |
| Hardware I2C3 on PA8/PB4 | PA8's LED network (2 kΩ + green LED to GND) holds idle-high ≈ 2.48 V, under VIH ≈ 2.52 V at 3.6 V rail, with the margin worsening as the cell sags; and independently, PA8 is the radio antenna switch (`RADIO_ANT_SWITCH`), driven push-pull by the SX1276 BSP around every TX/RX. Reaching I2C3 would take a board mod plus a radio-BSP rework; not worth it while clean bit-bang pins exist |
| Tap the pre-boost switched-VDD node (T1 drain), reusing PB5 and the fitted PMOS | Attractive on paper: T1 + R25 + PB5 control is exactly the recommended power stage and already populated. Fails on the board: the node is not brought to any terminal, C5 = 100 µF hangs on it (inrush step on every enable), and R6 = 10 MΩ enables the RT9266 boost whenever T1 conducts, so the converter starts unless L1 or D2 is removed (board mod). A dedicated external FET costs three parts and avoids all of it |
| I2C1 on PA9/PA10 (AF6) | 4.7 kΩ fixed pull-ups to VDD recreate the back-power path, and it is the AT-command console used for provisioning |
| Reader on +5 V boost (v1.6 "Variant B": PB5 → +5 V → inline 3.3 V regulator) | The boost enable dumps a ~210 µF charge step onto a 130 mA-max Li-SOCl2 cell: a VDD sag event per sample on the rail shared with the MCU, worst on a cold or passivated cell. ~38 µA converter overhead while on. Two conversions (3.6→5→3.3 V) to reach a voltage the cell already provides |
| 5 V supply + bidirectional level shifter, continuous | Solves logic levels but keeps the 8.5 mA budget problem and adds parts; strictly worse than A/B |
| Driving PB6/PB7 low (or analog/floating) while the reader is off, no other change | The current flows through the board pull-ups, not the MCU: output-low costs 720 µA continuously into R1/R2; analog parking still leaves the divider through the reader's clamps (~330 µA and the 1.45 V brownout state). No pin mode fixes a resistor (§1.1) |
| Bridge MCU (UART-attached I2C proxy) | Everything it isolates, the P-FET plus clean-pin bus already isolates for less: no second firmware image, no second BOM line, no second failure domain. Reconsider only if the sensor protocol outgrows the LSN50 (many buses, local processing) |
| Different logger (LSN50 v3.x, other vendor) | Fleet consistency, decoder/payload compatibility, and reprovisioning cost are all real; no evidence the v3.3 board solves anything A doesn't; the v2.3 board has clean pins available |
| Reader hardware redesign (sleep mode, isolation on the reader PCB) | Right long-term ask for VIA (§9.1) and would make architecture C viable, but not actionable on OSI's timeline |

## 4. Recommended design (A) and fallback (B)

### 4.1 Architecture A

Power: a high-side P-channel MOSFET switches raw VDD to the reader. Gate pulled to VDD by 100 kΩ (default off, including during MCU reset when all GPIOs revert to analog, RM0376 §9.3.1); driven low by PA1 (terminal 3, push-pull) to turn on. A 10 kΩ bleeder from the switched rail to ground gives the off state a defined discharge: the reader's input capacitance drains in well under a second instead of floating at the 1.4 V zombie level topology 1 produced. FET drop at 8.5 mA with Rds(on) ≤ 100 mΩ is under 1 mV; the reader sees effectively the full cell voltage, which it tolerates (it ran on VDD continuously from June 28) (**F**). One bounded caveat: the array's DS18B20 is specified for 3.0–5.5 V, so below a 3.0 V cell the temperature channel leaves its spec window (**F** the DS18B20 rating; **I** the consequence). A Li-SOCl2 cell spends nearly all its life at 3.4–3.6 V and collapses quickly at the end, the failure is sentinel-flagged (−127 °C, temp-fault bit) rather than silent, and resistance readings continue; accepting a degraded temperature channel in the cell's final weeks beats adding an LDO whose dropout would carve into the healthy range. Ask VIA for the reader's own qualified VCC range regardless (§9.1).

Bus: PB13 (SCL) and PB12 (SDA), bit-banged open-drain at ≈ 50 kHz with the reader's own 4.7 kΩ pull-ups to its switched VCC as the only pull-ups. With realistic field cable (≤ 2 m, ≤ 200 pF) the rise time is ~0.8 µs, comfortable inside a 10 µs half-bit at 50 kHz (**I**). The master samples SCL after releasing it and waits for it to actually read high before proceeding (bounded per §6.2), which makes the design tolerant of both slow edges and any slave clock stretching, documented or not (the ATtiny814's stretching behavior is unspecified by the vendor, **U**). Repeated start is implemented explicitly; the protocol requires it for every read (**F**, vendor library).

Off state: PA1 released (gate rises to VDD, FET off), PB12/PB13 to analog mode (the L072's lowest-leakage pin state, ±100 nA class, and the reset state) (**F**). With no pull-up source on the bus and the bleeder on the rail, every reader-side node rests at 0 V. The go/no-go gate in §8 makes this measurable: off-state reader VCC < 0.1 V, SDA/SCL < 0.1 V.

Why software I2C is the primary rather than the fallback, stated plainly: this project's failure history is not "bit-bang was flaky", it is three generations of hardware-peripheral integration where the HAL blocked past the watchdog, ignored ARLO, and required per-session force-resets. The Chameleon protocol moves ~41 bytes per sample at any speed above ~5 kHz without affecting the duty cycle. A 200-line bit-bang master with a wall-clock deadline on every edge is auditable line-by-line, immune to ES0292 §2.12.2/2.12.3/2.12.9 by construction, and cannot lose arbitration because it never arbitrates; it just reads the pin and gives up cleanly when the deadline passes.

Duty-cycle energy (**I**): reader on ~4–8 s per 20-min cycle averages 28–57 µA, a battery-life change from 20 days (topology 2) to multi-year territory; even a 5-min cadence stays between 113 and 227 µA. The gate divider (100 kΩ + driver) adds ~36 µA only while on.

### 4.2 Fallback B, and when to fall back

B replaces the bit-banged pins with PB6/PB7 + I2C1 and inserts the analog bus switch, keeping the identical power stage, session lifecycle, timeouts, and payload. Fall back if stage-1 validation of A shows the bit-bang master failing electrically (edge quality on real cable runs, EMI on long buried leads) or if implementation review finds the software module untrustworthy. B's firmware must then add: TIMEOUTR armed for SCL-low detection, PE=0 before every Stop-mode entry (ES0292 §2.12.2), TXDR pre-load per §2.12.9's workaround, BERR ignored as a sole fault source per §2.12.4, and the existing per-session RCC force-reset retained. Note the ES0292 §2.12.3 clock floor (I2CCLK ≥ 4 MHz for standard mode) when choosing the clock tree.

Both A and B keep the v1.6 acquisition skeleton, the V1 44-byte payload, the status-flag semantics, and MOD3 enforcement unchanged; the payload layout and the decoder are untouched (**F**, `chameleon_payload.h`, identical across branches). One field changes meaning rather than shape (**I**): the legacy `ADC_1` value, which MOD3 samples from PA1 each cycle, will report the gate-node voltage instead of a floating pin. Nothing downstream consumes `ADC_1` today; treat it as free telemetry or have the firmware stub it, but decide explicitly.

## 5. Wiring and required component properties

```
LSN50 v2.3                                      Chameleon reader (ATtiny814)
-----------                                     ----------------------------
VDD (term.13) ──┬── S   P-FET   D ──┬────────── VCC
                │      (Q_PWR)      │
                └─ R_G1 100 kΩ ─ G ──┤          [reader's own 4.7 kΩ pull-ups
                          │         │           from SDA and SCL to its VCC]
PA1 (term.3) ── R_G2 1 kΩ ┘         ├─ R_BL 10 kΩ ─ GND
                                    └─ C_LOC 100 nF ─ GND  (at reader end)
PB13 (term.21) ──────────────────────────────── SCL   (ATtiny PA7)
PB12 (term.20) ──────────────────────────────── SDA   (ATtiny PA6)
GND (term.12/15) ─────────────────────────────── GND
```

| Ref | Part class | Required properties | Why |
|---|---|---|---|
| Q_PWR | P-channel MOSFET, SOT-23 (e.g. DMP2045U or SI2301 class; DMG3415U is end-of-life per the 2026-08-14 review session) | Fully enhanced at Vgs = −2.4 V (cell at end-of-life 2.5 V); Rds(on) ≤ 100 mΩ at Vgs = −2.5 V; Igss leakage < 1 µA | Must switch cleanly across the whole cell voltage range. The off state holds Vgs = 0 through R_G1, so no minimum-threshold floor is needed; any Vgs(th) inside the −0.4 to −1.0 V windows of the named parts is fine |
| R_G1 | 100 kΩ | to VDD at the FET gate, not at the MCU pin | Guarantees off during MCU reset/analog parking; 36 µA only while PA1 drives low |
| R_G2 | 1 kΩ series from PA1 | — | Edge-rate/ESD decoupling of the gate from the pin |
| R_BL | 10 kΩ bleeder, switched rail → GND | 0.36 mA extra while on at 3.6 V (tolerable next to 8.5 mA); τ = 100 ms against a 10 µF reader input | Forces the off state to a real 0 V; kills the 1.4 V zombie state class |
| C_LOC | 100 nF ceramic at the reader end of the cable | X7R, ≥ 10 V | Local decoupling across the cable inductance |
| Pull-ups | none added | Reader's internal 4.7 kΩ to switched VCC only | Any pull-up to an unswitched rail rebuilds topology 1 |
| R_S | 330 Ω series in SDA and SCL at the MCU end | — | ESD/transient decoupling of the pins from the cable; 330 Ω × 200 pF = 66 ns against a 2 ms edge budget, free at these speeds |
| TVS | bidirectional TVS array on SDA, SCL, and the switched rail at the enclosure entry (e.g. PESD3V3/USBLC6 class, working voltage ≥ 3.6 V) | required, not optional | ES0292 §2.1.7 rates this MCU HBM 1 kV / CDM 250 V, weaker than most STM32s, and the cable is permanent outdoor wiring |
| FET-short telemetry | jumper the switched rail to terminal 26 (PA4) | PA4's existing 1 MΩ + 0.1 µF network is a 3.6 µA load that doubles as extra off-state bleed | MOD3 already samples PA4 into the legacy `ADC_2` payload field every uplink, so a Q_PWR failed short (which silently recreates the 20-day battery drain of architecture C) and a stuck-on rail become visible in routine telemetry |
| Cable | ≤ 2 m twisted or ribbon, SDA/SCL not adjacent if flat cable | keep Cb ≤ 200 pF/line | tr ≈ 0.8 µs at 4.7 kΩ/200 pF; budget collapses if capacitance grows |

Wiring rules: SDA/SCL may only ever connect to PB12/PB13 (terminals 20/21); nothing else attaches to those terminals. The reader's VCC must have no second source (no VDD terminal jumper left from the June interim fix). PB6/PB7 return to stock use (or nothing). PB14/terminal 18 stays reserved for the stock digital-interrupt function and must stay off the harness. Label the harness against the schematic names and the v2 pin-definition drawing, not the manual: the manual's SDA/SCL text for PB6/PB7 is swapped, and the manual's terminal table uses the v1 layout, where terminals 20/21 are PB13/PB12 (the reverse of the v2 board) and terminal 23 is PB14. A tech wiring from the manual's table crosses the bus and can land a lead on the capacitor pin.

## 6. Firmware requirements (specification only)

### 6.1 Preconditions, before any field build

Two items, both hard requirements.

Prohibit `DEBUG` builds in the field. `DBG_Init()` runs unconditionally from `main.c`, and under `#ifdef DEBUG` it configures PB12–PB15 as push-pull outputs driven low (`src/debug.c:56-76`). On the recommended pinout that grounds SDA and SCL permanently: ~0.77 mA per line sunk from the reader's pull-ups whenever the rail is on, and a 100 % i2c_missing signature indistinguishable from a dead harness. This team ships instrumented field builds (the 0x201 capture ran `CHAMELEON_FIELD_DEBUG`), so this is a live trap, not a hypothetical: `CHAMELEON_FIELD_DEBUG` must never imply `DEBUG`, the build system should refuse the combination, and stage 0.1's off-state measurement runs on the actual field binary.

Port the unpushed fix for the unbounded LSI-measurement wait. `GetLSIFrequency()` busy-waits forever on two timer captures before `HAL_IWDG_Init()` runs, i.e. before any watchdog exists; a hang there is unrecoverable without physical power-cycling. All three chameleon branches carry it verbatim (`iwdg.c:161-163`); the fix (100 ms deadline + 37 kHz fallback + host test) exists only as local commit `7153161` in `LoRa_STM32-claude` and must land on whatever branch ships next (**F**).

### 6.2 Timeouts, all wall-clock

| Budget | Value | Rationale |
|---|---|---|
| Single bus edge (SCL released → reads high) | 2 ms | Covers both the rise time (2000× the worst expected edge) and any slave clock stretching between bytes, which an interrupt-serviced ATtiny TWI slave performs by construction; a miss means the bus is dead or the slave has stalled far beyond normal service time |
| Single byte transfer | 10 ms | 9 bits at 50 kHz is 180 µs; 50× margin |
| Status poll cadence / deadline | 50 ms / 2000 ms | vendor library contract |
| Reader power-on settle before first probe | start at 100 ms, tune per §7 stage 1 | v1.6's 25 ms is unvalidated; ATtiny SUT fuse can add ~64 ms and the vendor never answered the settling question (**U**) |
| Full acquisition session, including one power-cycle retry | ≤ 8 s hard cap | IWDG floor is 28.3 s nominal −34 % LSI tolerance ≈ 18.7 s; 8 s leaves the TX path its own margin |
| Off time before power-cycle retry | ≥ 1 s | ≥ 5·τ of the bleeder against a 10 µF reader input, so the retry is a real POR |

Every wait in the acquisition path reads `TimerGetCurrentTime()`; iteration counting is prohibited (that bug is topology 2's ~42 s stall, §1.2).

### 6.3 Watchdog

IWDG refreshed at a dedicated point inside the acquisition loop at least every 5 s of session time, in addition to the existing 18 s main-loop timer. Sizing rule: any single blocking region must be provably shorter than the IWDG period at the slow-LSI corner (26 kHz → nominal × 0.66). Keep the v1.6 boot print of `RCC_FLAG_IWDGRST` and the RTC backup-register breadcrumbs; add a persistent consecutive-failed-sessions counter so a reader that dies in the field is visible in telemetry, not only in absence of SWT values.

### 6.4 Power sequencing and off-state discipline

On: PB12/PB13 from analog to open-drain-high (bus idles released), then PA1 low, then the settle delay, then probe. Off, in strict order: bus pins back to analog, then PA1 released. The off order matters: releasing power first with the bus still driven would source the reader through PB12/PB13's driven-high state.

Two boundary rules. After any reset, hardware defaults keep everything off with no firmware help (all pins revert to analog and R_G1 holds the gate at VDD; that property is the test in §7 stage 0.3). Stop mode gives no such guarantee: GPIO configuration and output latches are retained in Stop, so a path that enters Stop mid-session with PA1 still low leaves the reader powered for the whole sleep with no watchdog on the drain. The firmware must run the full off sequence before every Stop entry, and §7 stage 2 injects exactly this case. Likewise the rail must be off before the LoRa TX path is entered: 8.5 mA of reader on top of ~125 mA of TX approaches the cell's 130 mA continuous rating, the same sag mechanism that disqualified the +5 V boost.

### 6.5 Failure handling and recovery ladder

Per session: at most one power-cycle retry. Escalation inside an attempt: edge timeout → abort the transaction, issue 9 SCL pulses + STOP (bit-bang bus clear per UM10204 §3.1.16; it costs nothing even though it cannot fix a capacitor or an unpowered slave) → power-cycle retry → mark I2C_MISSING or TIMEOUT and stop touching the bus until the next cycle. The uplink transmits unconditionally on schedule with the fault flags; no sensor state may delay, skip, or retry the LoRa path. No retry storms: fault or success, one session per uplink cycle. Payload stays V1 44-byte, flags unchanged (constraint: preserve the Chameleon protocol and payload).

If fallback B ships instead: additionally arm TIMEOUTR (SCL-low, ~25 ms) on I2C1, force PE=0 before every Stop entry, pre-load TXDR before transfers, never fault on BERR alone, keep the per-session peripheral force-reset, and cut the per-call HAL timeout from the historical 1000 ms to 25–50 ms so a dead bus costs milliseconds per call instead of seconds (ES0292 §§2.12.2, 2.12.3, 2.12.4, 2.12.9; RM0376 §27.4.7). B also carries a bench prerequisite: no bus-switch datasheet quantifies disconnected-state leakage at these levels (checked for PCA9306, TCA9517A, PCA9508 in the 2026-08-14 review), so the §7 stage 0.1 off-state measurement is the acceptance test for whichever switch is chosen, not a formality.

## 7. Staged test plan

Do not advance a stage on a partial pass. A successful address ACK, a short bench run, or a clean build proves nothing about field reliability and does not gate anything here; only the counted criteria below do.

**Stage 0: electrical, no protocol.** (0.1) Off state, measured while running the actual field binary (not a bench build; see the `DEBUG` trap in §6.1): reader VCC, SDA, SCL each < 0.1 V; current into the reader branch < 5 µA, measured at the harness. (0.2) On state: switched rail within 50 mV of VDD at 8.5 mA load; scope SDA/SCL at the reader end, rise 30–70 % < 1.5 µs with the real cable. (0.3) Reset behavior: hold NRST low, verify the FET stays off (gate at VDD); release and verify no rail glitch. (0.4) Enable transient: VDD sag at the MCU < 100 mV during rail-on with a cold cell (passivation worst case, §2).

**Stage 1: protocol bench.** (1.1) Settle-time sweep: power-on delay 10/25/50/100/200 ms × 50 trials each; find the shortest delay with 50/50 first-probe ACKs, ship 4× that (**U** resolved empirically since VIA won't answer it). (1.2) Endurance: ≥ 500 acquisition sessions at 1-min cadence: zero MCU resets (RCC_CSR checked each boot), zero sessions over the 8 s cap, ≥ 99 % clean acquisitions, and every failure carrying the correct flag. (1.3) Values sanity: resistances match the June-known-good ranges; array ID stable.

**Stage 2: fault injection.** Each case: 20 uplink cycles, node must uplink every cycle with correct flags, never reset, and recover within one cycle of the fault being removed. Cases: SDA open mid-session; SCL shorted to GND; SDA shorted to GND; array unplugged (open-channel sentinels); reader VCC wire cut; reader hot-plugged mid-session; cable extended to the max field length; a forced Stop-mode entry mid-session (verify the off sequence ran and the rail is at 0 V throughout the sleep, per §6.4). Verify the 9-pulse + power-cycle ladder engages by instrumented counts, and that a permanently absent reader costs the battery nothing beyond the session budget (no retry storms).

**Stage 3: power.** ≥ 24 h at field cadence on a current logger: average added consumption ≤ 60 µA at 20-min cadence (≤ 250 µA at 5-min), session energy profile matching §4.1 arithmetic, off-state floor ≤ 5 µA. On a deliberately cold-soaked unit (0 °C): stage 0.4 sag figure still holds.

**Stage 4: field soak.** Two units minimum, ≥ 4 weeks, real soil arrays, normal uplink cadence. Pass: i2c_missing < 0.5 % of rows and no fault block > 30 min; zero unexplained f_cnt=0 events (every reset accounted for); battery voltage flat (no measurable slope at Li-SOCl2 resolution); SWT values plausible against the co-located reference. The June incident produced 44–56 % i2c_missing and multi-day blocks; this gate is what "fixed" means. Only stage 4 closes the investigation: topology 1 also passed its first days.

## 8. Go/no-go criteria

| Gate | Go | No-go → action |
|---|---|---|
| Schematic assumptions vs the physical 2.3a board (§9.3) | R13 = 0 Ω, R14 = 1 MΩ, C1 = 0.1 µF confirmed by DMM; PB12/PB13 terminals confirmed bare | Any mismatch: stop, re-run the §2 audit against reality before building harnesses |
| Stage 0 | all four criteria met | Off-state voltage > 0.1 V means a leakage path exists somewhere: find the resistor, do not proceed (this is exactly the measurement that would have caught topology 1 before deployment) |
| Stage 1 | 1.1–1.3 met, settle time ≤ 400 ms at 4× margin | Bit-bang electrically marginal → fallback B. Reader needs > 400 ms settle → revisit session budget, ask VIA |
| Stage 2 | every case: 20/20 uplinks, 0 resets | Any reset = the sensor path can still kill the node; fix before field |
| Stage 3 | ≤ 60 µA added at 20-min cadence | 2–5× over: acceptable only with a documented battery-replacement schedule; > 5× over: design error, stop |
| Stage 4 | all four criteria over 4 continuous weeks | i2c_missing ≥ 0.5 % or any reset regression: back to stage 2 with field captures; do not paper over with retries |
| Fleet rollout | stage 4 passed on both units | — |

## 9. Missing information and vendor questions

### 9.1 For VIA (via.farm)

1. Reader current profile: confirm the ~8.5 mA continuous draw (OSI bench measurement; no vendor figure exists) and state what consumes it while idle. Is a firmware sleep mode feasible? A ≤ 50 µA idle would make continuously-powered VDD wiring (architecture C) viable and is the single most valuable change VIA could ship.
2. Qualified supply range for the reader board as a whole: the array's DS18B20 is rated 3.0–5.5 V, so is the reader itself qualified below 3.0 V, and what degrades first? This bounds direct-cell powering at end-of-life (§4.1).
3. Power-up timing: guaranteed delay from VCC valid to first I2C ACK, and whether the boot measurement (status = 0x01) is complete at that point. Asked once already (open question 1 in the 2025 reference doc), never answered; we will measure it regardless (§7 stage 1.1) but a spec beats a measurement.
4. Brown-out behavior: ATtiny814 BOD fuse setting on production readers. With BOD disabled, a slow VCC decay (the topology-1 zombie state) can corrupt RAM/EEPROM state; with BOD at 1.8/2.6 V the reader would have held reset instead. This single fuse bit explains much of §1.1's intermittency (**I**, needs vendor confirmation).
5. Clock stretching: does the ATtiny TWI slave firmware ever stretch SCL, and what is the worst-case per-byte stall?
6. Power-cycling per measurement cycle (tens of thousands of cycles/year): any objection, and does the trigger/status contract hold from a cold boot every time?
7. I2C address configurability (future multi-reader gateways) and maximum recommended bus/cable length.

### 9.2 For Dragino

1. Is a board stamped "2.3a" electrically identical to the published v2.3 schematic? No 2.3a exists in the public repo.
2. Is PA4 wired to terminal 26 on v2.3? The schematic's header symbols show 24 signals; the pin-definition drawing shows 26 terminals.
3. Can units be ordered with R18/LED1 (or R11) unpopulated? Low priority: this removes only the electrical blocker on PA8, and PA8 is also the radio antenna-switch pin in the stock BSP, so reaching hardware I2C3 (the best-featured peripheral for this job, with TIMEOUTR) would additionally require a radio-driver rework on our side. Worth knowing the answer, not worth pursuing while the bit-bang design holds.
4. Which cell ships in the 8500 mAh (ZZ = 8) option? No datasheet in the battery folder covers it.
5. Manual v1.7.4 §2.4.6 labels PB6 = SDA / PB7 = SCK, contradicting the schematic and the SHT31 app note. Confirm the schematic is authoritative (and fix the manual).

### 9.3 To verify on the physical board (no vendor needed)

DMM checks before any harness is built: R13/R14/C1 values at terminal 18; terminals 20/21 show no DC path to any rail (> 1 MΩ); terminal 26 continuity to PA4's RC network; actual cell part number under the shrink wrap. Also verify which battery option the deployed units carry, since it changes every energy number by 2.1×.

### 9.4 Immediate operational item (independent of this design)

Any deployed unit still on the June continuous-VDD interim wiring is draining its cell at ~8.5 mA (~50–100× design rate) and its Li-SOCl2 voltage telemetry will read a healthy 3.6 V until the cliff. Check Kaba100 Chameleon 1's cumulative on-time now and schedule a battery swap alongside the rewiring, or accept a dead node mid-season.

### 9.5 Residual unknowns in the root-cause record

Topology 2's terminal event remains formally open (**U**): battery exhaustion is sufficient and best-supported, a watchdog reset loop is plausible and demonstrated possible on the bench, and ES0292 §2.1.3 adds a third, software-invisible reset path below 2.7 V. If the dead unit is recovered, a cell voltage measurement under 100 mA load would settle it. Nothing in the recommended design depends on which of the three it was; A removes the continuous drain, the blocking waits, and the sag exposure together.
