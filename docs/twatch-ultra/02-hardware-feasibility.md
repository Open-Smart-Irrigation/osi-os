# T-Watch Ultra hardware feasibility for a LoRaWAN survey firmware

Research date: 2026-08-31. All retrieval dates in this document are 2026-08-31 unless
stated otherwise.

The LILYGO T-Watch Ultra can host an OSI LoRaWAN coverage-survey firmware, and the two
decisions that shape the project are settled by hardware, not by software: the radio sits
on a swappable 12-pin module whose RF matching is invisible from outside, and LILYGO sells
the watch as three band-specific SKUs. Everything else on the feasibility list resolves
favourably. GNSS, LoRa, SD, display and Wi-Fi share one board without a pin conflict that
blocks the survey use case; RadioLib's LoRaWAN layer already exposes the exact primitives a
survey needs (LinkCheckReq margin and gateway count, per-downlink RSSI and SNR, session and
nonce persistence buffers); and ChirpStack v4 carries per-gateway RX metadata in its uplink
event.

The risks are concentrated in three places: an under-firmware-control RF switch that can
silently route transmit power away from the antenna, a documented board-level deep-sleep
floor around 840 µA that dominates any battery estimate, and a vendor library that is
young, thinly staffed and internally inconsistent about its own dependency versions.

## How claims are tagged

Every load-bearing statement below carries exactly one tag.

| Tag | Meaning |
|---|---|
| `[F]` | Verified fact, traceable to a cited primary source |
| `[I]` | Strong inference, with the reasoning stated |
| `[P]` | Design proposal for the OSI firmware, not a claim about the hardware |
| `[Q]` | Unresolved question, repeated in the consolidated list at the end |

Source numbers in brackets, for example `[S3]`, refer to the source list at the end of the
document.

## Where LILYGO's documentation contradicts itself

LILYGO's material for this product is thin in places and self-contradictory in others. The
contradictions are listed here rather than smoothed over, because several of them change
what a firmware author does.

| Topic | Conflict | Resolution used here |
|---|---|---|
| Radio part | `docs/hardware/lilygo-t-watch-ultra.md` names "Semtech SX1262" in the feature table but "SX1262 or SX1280" in the pin table `[S3]`; the documentation-repo product page lists five selectable modules `[S4]`; the LILYGO store sells SX1262 only `[S8]` | The footprint accepts five parts `[F]`; only SX1262 is sold for this watch `[F]` |
| Expander pin map | `docs/hardware` assigns XL9555 GPIO10 to touchpad reset and GPIO12 to SD-insert detect `[S3]`; `pins_arduino.h` defines `EXPANDS_TOUCH_RST` as 8 and `EXPANDS_SD_DET` as 10 `[S5]` | Treat the header as authoritative; it is what compiles `[I]` |
| Library versions | `library.json` pins RadioLib 7.1.2 and lvgl 9.2.2 `[S2]`; `docs/third_party.md` lists RadioLib 7.4.0 and lvgl 9.4.0 `[S6]`; the wiki quick-start also says 7.4.0 and 9.4.0 `[S7]` | Follow the quick-start and third-party list `[I]` |
| NFC capacitive sensing | LILYGO states the ST25R3916 "does not have an integrated capacitive sensor" `[S3]`; ST's datasheet lists a capacitive sensor block and low-power capacitive card detection `[S13]` | The chip has it; LILYGO is describing the board, which evidently does not wire a sense electrode `[I]` |
| Schematic I2C labels | Sheet notes read `SCL------IO3 / SDA------IO2`, inverted against the real connection, reported and closed as LilyGoLib issue #7 `[S9]` | SCL is GPIO2, SDA is GPIO3 `[F]` |
| Display size | LILYGO says 2.06 inch `[S3]`; CNX Software's launch coverage says 2.01 inch `[S17]` | LILYGO's own figure `[I]` |

Two further documentation defects were reported and closed by the maintainer: issue #26,
which found the power-rail table disagreed with the schematic about which rail backs the
RTC and which backs GNSS, and issue #27, which found the deep-sleep current table's timer
rows inverted against its button rows `[S9]` `[F]`. Both are corrected in the copy of
`docs/hardware/lilygo-t-watch-ultra.md` retrieved on 2026-08-31, so the tables quoted below
are the fixed versions `[F]`.

## Product lineage, and how to avoid reading the wrong page

Documentation for four LILYGO watches lives in one repository, and the pin maps differ
`[F]` `[S6]`. Reading the T-Watch S3 page while holding an Ultra is a live hazard.

| Model | MCU | Display | LoRa | GNSS | NFC | Motion | RTC | Touch |
|---|---|---|---|---|---|---|---|---|
| T-Watch 2020 (V1/V3) | ESP32 | LCD | SX1276 on some variants | no | no | BMA423 | PCF8563 | FT6236 |
| T-Watch S3 | ESP32-S3 | LCD | SX1262 | no | no | BMA423 | PCF8563 | FT6336U |
| T-Watch S3 Plus | ESP32-S3 | LCD | SX1262 | MIA-M10Q or Quectel LS550G | no | BMA423 | PCF8563 | FT6336U |
| **T-Watch Ultra** | ESP32-S3 | AMOLED, CO5300 | swappable module | MIA-M10Q | ST25R3916 | BHI260AP | PCF85063A | CST9217 |

Rows for T-Watch S3 and S3 Plus are from LilyGoLib's own hardware pages `[F]` `[S6]`; the
Ultra row is from its hardware page and schematic `[F]` `[S3]` `[S1]`. The 2020-series row is
lineage context only and was not verified against a primary LILYGO page in this pass `[Q]`.

Three details separate the Ultra from its siblings in ways that matter to firmware. It is
the only one with NFC `[F]`. It is the only one whose motion sensor is a programmable
sensor hub rather than a plain accelerometer `[F]`. And it is the only one that puts an
XL9555 I2C expander in the path of display power, haptic enable, touch reset and the LoRa
RF switch `[F]` `[S3]`, which means several "GPIO" operations are actually I2C transactions
with I2C latency and I2C failure modes `[I]`.

## Board revision in circulation

The only schematic LILYGO publishes is titled `T-Watch Ultra V1.0 SCH 25-07-24.pdf`, with
"V1.0" in the drawing's revision block `[F]` `[S1]`. The PDF's embedded creation timestamp is
2025-09-02 `[F]`, and the file was last touched in the repository on 2026-08-11 `[F]`. No
second hardware revision is published, and the Arduino board definition exposes no hardware
revision menu `[F]` `[S12]`.

The Arduino "Board Revision" dropdown does not select a PCB revision. It selects which radio
module is fitted, offering Radio-SX1262, Radio-SX1280, Radio-CC1101, Radio-LR1121 and
Radio-SI4432, each of which sets `build.board` to a `LILYGO_LORA_*` value `[F]` `[S12]`. A
reader who equates that menu with silicon revision will mis-order parts `[I]`.

`[I]` One board revision, V1.0, is in circulation as of 2026-08-31. The evidence is
negative rather than positive: a single published schematic, no revision selector in the
board package, and no revision discussion in the issue tracker. `[Q]` Whether LILYGO has
shipped an unpublished respin cannot be settled from documentation.

## Core compute, memory and storage

| Item | Value | Tag | Source |
|---|---|---|---|
| SoC | ESP32-S3, dual-core Xtensa LX7, 240 MHz | `[F]` | `[S3]` `[S12]` `[S14]` |
| Arduino board define | `ARDUINO_T_WATCH_S3_ULTRA`, variant `lilygo_twatch_ultra` | `[F]` | `[S12]` |
| Flash | Winbond W25Q128JVPIQ, 128 Mbit = 16 MB, external QSPI | `[F]` | `[S1]` |
| PSRAM | AP Memory APS6404L-3SQR-ZR, 64 Mbit = 8 MB, external quad SPI | `[F]` | `[S1]` |
| Default partition | `app3M_fat9M_16MB`, 3 MB application, 9.9 MB FATFS | `[F]` | `[S12]` |
| USB identity | VID 0x303A, PID 0x8227, "LILYGO / T-Watch-Ultra" | `[F]` | `[S5]` |
| USB mode | Hardware CDC and JTAG, CDC-on-boot enabled | `[F]` | `[S12]` |
| SD card | SPI on the shared bus, CS GPIO21, FAT32, 32 GB maximum | `[F]` | `[S3]` `[S5]` |

Both flash and PSRAM are discrete parts outside the SoC package, which LILYGO states
explicitly `[F]` `[S3]` and the schematic confirms by part number `[F]` `[S1]`. The practical
consequence is that this is a bare ESP32-S3, not an ESP32-S3R8 or similar in-package
variant, so any board-support code that assumes octal PSRAM will misconfigure the memory
controller `[I]`. The Arduino board definition sets `psram_type=qspi` accordingly `[F]`
`[S12]`.

`[F]` The SD card is on SPI, not SDMMC, and it shares MOSI GPIO34, MISO GPIO33 and SCK
GPIO35 with the LoRa module and the NFC reader `[S3]` `[S5]`. LILYGO restricts it to FAT32 up
to 32 GB `[F]` `[S3]`. `[Q]` Whether exFAT or cards above 32 GB work in practice is untested
here.

`[P]` Budget the 3 MB application partition as the binding constraint on firmware size, and
use the 9.9 MB FATFS area for survey logs. A repartition to a larger app slot is available
in the board menu if LVGL plus RadioLib plus a Wi-Fi uploader overflows 3 MB.

## The radio subsystem

This section carries the decisions that determine whether an OSI survey firmware is worth
building on this platform, so it is traced to the schematic net by net.

### The radio is a module, not a chip on the mainboard

`[F]` The T-Watch Ultra mainboard does not carry a LoRa transceiver. Schematic sheet 5
places a 12-pin footprint designated U3 and labelled `HPB16B3` in the position where a
transceiver would sit `[S1]`. Its pins are:

| Pin | Net | Pin | Net |
|---|---|---|---|
| 1 | VCC (`LORA_VDD`) | 12 | ANT |
| 2 | GND | 11 | GND |
| 3 | NRESET (`LORA_RST`, GPIO47) | 10 | NSS (`LORA_CS`, GPIO36) |
| 4 | BUSY (`LORA_BUSY`, GPIO48) | 9 | SCK (`SPI_SCK`, GPIO35) |
| 5 | DIO1 (`LORA_IRQ`, GPIO14) | 8 | MOSI (`SPI_MOSI`, GPIO34) |
| 6 | DIO3 | 7 | MISO (`SPI_MISO`, GPIO33) |

`[F]` The identical `HPB16B3` footprint with the identical pin functions appears in the
T-LoRa-Pager V1.0 schematic `[S1]`. `[F]` LILYGO sells the T-LoRa-Pager in versions that
differ by radio module, and its documentation describes SX1262, SX1280, CC1101, LR1121 and
SI4432 as module options for that product family `[S4]`.

`[I]` LILYGO uses one common replaceable radio-module footprint across the Ultra and the
Pager. The evidence is the shared designator, the shared pin function assignment, the
five-way compile-time selector in the Arduino board definition, and LILYGO's own
description of the Pager as differing by module. `[Q]` Whether the Ultra's module is
socketed or soldered, and whether LILYGO sells the modules separately for the Ultra, was
not established. The schematic shows a footprint, and a footprint alone does not
distinguish a socket from a solder-down land pattern.

`[F]` Module pin 6, DIO3, is brought out to the footprint but left unconnected on the
mainboard `[S1]`. On a bare SX1262 design DIO3 is the usual TCXO supply pin, so its being a
module pin rather than a mainboard net means any TCXO is inside the module `[I]`.

### What this means for band support

`[F]` Between the module's ANT pin and the RF switch, the mainboard fits only C45 (0 Ω
series) and C110 (100 pF series), with C44 and C46 as unpopulated shunt pads `[S1]`. There
is no inductor, no pi network, no band-defining component anywhere on the mainboard RF
path.

`[I]` The entire band-specific matching network lives inside the `HPB16B3` module. The
mainboard is band-agnostic apart from the antenna and the switch. This is the single most
important RF conclusion in this document, because it means no amount of schematic reading
tells you which bands a given watch is matched for; only the module marking and the SKU do.

`[F]` LILYGO's own store sells the T-Watch Ultra in three band SKUs, all SX1262: 868 MHz
(K253-01), 915 MHz (K253-02) and 920 MHz (K253-04), listed at USD 78.32 and all showing
"Sold out" on 2026-08-31 `[S8]`.

`[I]` Band support is a per-SKU property, not a per-transceiver property. The SX1262 die
covers 150–960 MHz `[F]` `[S10]`, but LILYGO would not maintain three SKUs if one matching
network served all three. Do not describe an 868 MHz watch as supporting US915 or IN865.
An 868 MHz unit is matched for the 863–870 MHz group; IN865 at 865–867 MHz falls inside
that group and is plausible on the same match `[I]`, but that is an inference about a
matching network nobody has published, and it needs a return-loss measurement before anyone
relies on it `[Q]`.

`[P]` For Swiss EU868 development, order the 868 MHz SKU. For a later Uganda deployment,
Uganda's LoRaWAN allocation should be confirmed against the LoRa Alliance regional
parameters before assuming the same watch is legal and matched there `[Q]`.

### If a unit turns out to carry an LR1121

`[F]` LILYGO's documentation-repo product page lists LR1121 among the Ultra's selectable
modules `[S4]`, and the Arduino board package offers a Radio-LR1121 revision `[S12]`. `[F]`
LilyGoLib compiles an `LR1121 radio` object under `ARDUINO_LILYGO_LORA_LR1121` `[S2]`.
`[F]` LILYGO's store offers no LR1121 SKU for this watch `[S8]`, and the repository ships
factory images only for the SX1262 and SX1280 variants of the Ultra, while shipping an
LR1121 image for the Pager `[S2]`.

`[I]` LR1121 is a footprint-supported but not currently retailed option for the Ultra.
Someone could receive one through a non-standard channel, so a firmware should identify the
radio rather than assume.

If a unit does carry an LR1121, three things change:

`[F]` The LR1121 covers 150–960 MHz sub-GHz, 1.9–2.1 GHz S-band and the 2.4 GHz ISM band
`[S11]`. `[F]` It exposes four separate RF pins for these: RFO_HP_LF (pin 32), RFO_LP_LF
(pin 31), the differential receive pair RFI_N_LF0 and RFI_P_LF0 (pins 29 and 30), and
RFIO_HF for 2.4 GHz and S-band `[S11]`. `[F]` Semtech's own reference schematic, Figure 4-1,
is titled "Multi-band EU/US LoRaWAN Using Sub-GHz PAs" and shows three separate matching
networks on the sub-GHz side combining into one LoRa antenna port `[S11]`.

`[I]` A single sub-GHz matching network covering both 868 and 915 MHz is a design Semtech
itself endorses, so genuine EU868-plus-US915 operation from one unit is achievable in
principle. `[I]` It is not achievable through the `HPB16B3` footprint's single ANT pin
without the module combining all four LR1121 RF ports internally, and whether the module's
internal network is the dual-band EU/US design or a single-band one is unpublished `[Q]`.

`[I]` A 2.4 GHz LoRa capability would additionally have to survive the SKY13453 switch and
the watch's antenna, neither of which is characterised at 2.4 GHz for this product. The
switch itself is not the limit; see below.

### RF switch, antenna ports and the transmit-into-nothing hazard

`[F]` The module's ANT pin feeds pin 6 (RFC) of U13, a Skyworks SKY13453-385LF `[S1]`.
`[F]` The SKY13453-385LF is a single-control SPDT switch specified from 0.01 to 6.0 GHz in a
1 × 1 mm 6-pin QFN `[S15]`. `[I]` The switch does not constrain the band; it passes anything
the module and antenna support.

Traced from the schematic `[F]` `[S1]`:

- RFC (pin 6) receives the module output.
- RF1 (pin 2) passes through C111 (100 pF) to test point TP9 and terminates there.
- RF2 (pin 4) passes through C106 (100 pF) to J2, an IPEX/u.FL connector.
- VCTL (pin 5) is driven by net `LORA_SEL`.
- Separately, net `LORA_ANT` reaches C107 (0 Ω) and then J3, a second IPEX/u.FL connector,
  with C108 and C109 unpopulated.
- On sheet 1, `LORA_ANT` connects to the USB-C receptacle's SBU1 (pin A8) and SBU2 (pin B8).

`[F]` `LORA_SEL` is XL9555 port pin P13, with the expander's A0, A1 and A2 tied low giving
I2C address 0x20 `[S1]`. `[F]` LilyGoLib defines `EXPANDS_LORA_RF_SW` as 11 `[S2]`, which is
P13 under the library's linear numbering where P00–P07 map to 0–7 and P10–P17 map to 8–15
`[I]`.

`[F]` LilyGoLib's `setRFSwitch(bool to_usb)` writes the expander pin low for what its own
log message calls the "USB Iface" and high for the "Built-in LoRa Antenna", and
`initLoRa()` calls `setRFSwitch(false)` after a successful `radio.begin()` `[S2]`.

`[I]` The built-in antenna is soldered to TP9 on the RF1 branch, and J2 on the RF2 branch is
an external-antenna connector whose path LILYGO routes onward to the USB-C SBU pins for a
dock or test fixture. The reasoning: the GNSS antenna on the same sheet also terminates at a
bare test point, TP7, with no connector `[F]` `[S1]`, so a test-point antenna feed is this
board's idiom; and `LORA_ANT` demonstrably reaches the USB-C SBU pins, which is the only
thing on the board that could justify the driver's "USB Iface" wording.

`[Q]` Whether a coax jumper between J2 and J3 is fitted in production, and therefore whether
the "USB" switch position reaches anything at all, is not determinable from the schematic.
`[Q]` The switch's truth table direction was not read from the Skyworks datasheet, so the
mapping of VCTL high to RF1 rather than RF2 rests on LilyGoLib's comments alone.

`[P]` Treat the RF switch as a survey-integrity hazard, not a feature. A firmware that
transmits with the switch in the wrong position radiates into a mismatched or open path and
records coverage that is systematically worse than reality, with no error anywhere. Assert
the switch state immediately before every uplink rather than once at boot, and expose the
current state on the survey screen so an operator can see it.

`[P]` Consider whether repeated transmit into a mismatch can damage the PA. The SX1262
tolerates a mismatch better with over-current protection enabled; RadioLib's
`setCurrentLimit()` is available and the LILYGO example sets 140 mA `[F]` `[S2]`.

### Radio interface summary

| Signal | GPIO | Shared with | Tag | Source |
|---|---|---|---|---|
| SCK | 35 | SD card, NFC | `[F]` | `[S5]` |
| MOSI | 34 | SD card, NFC | `[F]` | `[S5]` |
| MISO | 33 | SD card, NFC | `[F]` | `[S5]` |
| NSS / CS | 36 | dedicated | `[F]` | `[S5]` |
| RESET | 47 | dedicated | `[F]` | `[S5]` |
| BUSY | 48 | dedicated | `[F]` | `[S5]` |
| DIO1 / IRQ | 14 | dedicated | `[F]` | `[S5]` |
| RF switch control | XL9555 P13 | I2C bus | `[F]` | `[S1]` `[S2]` |
| Rail | AXP2101 ALDO3 | dedicated | `[F]` | `[S3]` |

`[F]` LilyGoLib's `initLoRa()` calls `radio.begin()` and nothing else `[S2]`. It does not
call `setTCXO()` and does not call `setDio2AsRfSwitch()`, both of which LILYGO's own
SX126x transmit and receive examples do call, with 3.0 V and no argument respectively
`[S2]`. `[F]` The T-LoRa-Pager code path in the same library does call `setTCXO(3.0)` and
`setRfSwitchTable()` `[S2]`.

`[I]` A TCXO is present in the Ultra's module, running at 3.0 V. RadioLib's `SX1262::begin()`
defaults `tcxoVoltage` to 1.6 V and enables the DIO3 TCXO supply on that basis, so a module
with no TCXO would be misconfigured by default and LILYGO's examples would not override to
3.0 V without cause. `[Q]` This is inference from library defaults, not from a published
module datasheet, and it should be confirmed by measuring DIO3 or by reading the module
marking.

`[P]` Call `setTCXO(3.0)` and `setDio2AsRfSwitch()` explicitly after `instance.begin()`
rather than relying on `initLoRa()`. On this board the library's own initialisation is
weaker than its own examples.

## GNSS

`[F]` The receiver is a u-blox MIA-M10Q, U2 on schematic sheet 5 `[S1]` `[S3]`. It is a
4.5 × 4.5 × 1.0 mm 53-pad LGA module `[S16]`.

Constellations and timing, from the u-blox data sheet `[F]` `[S16]`:

| Property | Value |
|---|---|
| Signals | GPS/QZSS L1C/A, Galileo E1-B/C, GLONASS L1OF, BeiDou B1I and B1C |
| Concurrency | 4 GNSS maximum; BeiDou B1I cannot run with B1C or GLONASS |
| Default | GPS + Galileo + BeiDou B1I, with QZSS and SBAS |
| SBAS | EGNOS, GAGAN, MSAS, WAAS, KASS, SouthPAN |
| Cold start (default config) | 27 s |
| Hot start | 1 s |
| AssistNow Online | 1 s |
| Tracking sensitivity | −167 dBm, demonstrated with a good external LNA |

EGNOS coverage over Switzerland makes the default configuration workable for Swiss field
work `[I]`.

`[F]` The MIA-M10Q brings out UART and I2C only. It has no SPI and no USB pads `[S16]`. `[F]`
The Ultra wires the UART: GNSS TX to GPIO43, GNSS RX to GPIO44, and PPS to GPIO13 `[S3]`
`[S5]`. `[I]` The GNSS therefore shares no bus with anything. It is the one major peripheral
on this board with a private interface, which removes it as a source of bus contention.

`[F]` RF_IN (pad B9) reaches the antenna through C102 (0 Ω) from test point TP7, with C104
and C105 unpopulated shunt pads. R36 (10 Ω), L12 and C103 (10 nF) form an active-antenna
bias feed drawn inside a dashed outline `[S1]`.

`[I]` The GNSS antenna is a passive element soldered to TP7, and the active-antenna bias
network is an unpopulated option. u-blox states the MIA-M10Q's internal LNA "provides enough
gain for passive antennas" `[F]` `[S16]`, which makes a passive antenna the expected choice.
`[Q]` The antenna's physical type is unknown. u-blox's recommended list contains 18 × 18 ×
4 mm patches and active antennas and lists no chip antenna `[F]` `[S16]`, and an 18 mm patch
does not fit a 49 mm-wide watch, so whatever LILYGO fitted is outside u-blox's characterised
set. Expect worse than data-sheet sensitivity `[I]`.

`[F]` There is no IPEX connector on the GNSS path `[S1]`. An external GNSS antenna would
require rework at TP7.

`[F]` GNSS is powered from AXP2101 BLDO1, and GNSS backup is on LDO1/VRTC which LILYGO
marks as not switchable off `[S3]`. `[I]` Backup-domain retention across deep sleep is
therefore available by default, which is what makes hot starts at 1 s realistic for a
survey that wakes repeatedly.

`[F]` LilyGoLib's GNSS driver is a subclass of TinyGPSPlus that parses NMEA from the UART
and exposes `init()`, `factory()` and a `loop()` pump `[S2]`. `[I]` There is no UBX
configuration API, so constellation selection, navigation rate and power-save mode all
require the firmware to emit UBX frames itself.

`[F]` LILYGO documents AssistNow for the Ultra as a manual procedure: flash a loopback
firmware, enable an "NMEA to Serial" switch in the factory application, register a u-blox
Thingstream account for a token, then push ephemeris from u-center2 on a PC `[S2]`.
`[I]` There is no on-device AssistNow client. A survey firmware wanting sub-second fixes
after each wake would have to fetch AssistNow Online over Wi-Fi and inject it over the UART
itself.

## Display and touch

| Property | Value | Tag | Source |
|---|---|---|---|
| Panel | AMOLED, 2.06 inch, 410 × 502, 600 nit, 16.7 M colours | `[F]` | `[S3]` |
| Driver IC | CO5300, QSPI | `[F]` | `[S3]` |
| Interface | D0 GPIO38, D1 GPIO39, D2 GPIO42, D3 GPIO45, SCK GPIO40, CS GPIO41, RST GPIO37, TE GPIO6 | `[F]` | `[S5]` |
| Power enable | XL9555 expander pin, plus AXP2101 ALDO2 | `[F]` | `[S3]` `[S5]` |
| Touch | CST9217, I2C address 0x1A | `[F]` | `[S3]` |
| Touch interrupt | GPIO12 | `[F]` | `[S5]` |
| Rotation | 90° and 270° rejected by the driver | `[F]` | `[S2]` |

`[I]` The display is on its own dedicated QSPI bus and shares nothing with the radio, SD
card or NFC. That removes the most common cause of stutter in combined LoRa-plus-GUI
firmware on cheaper boards.

`[F]` The header defines `DISP_WIDTH` as 502 and `DISP_HEIGHT` as 410, transposed relative
to LILYGO's 410 × 502 specification `[S5]` `[S3]`. `[I]` The header is describing the panel in
its native landscape orientation while the marketing figure describes the watch as worn. <!-- slop-allow: "landscape" is the display-orientation term, not the abstract noun -->


`[Q]` Neither the CO5300 nor the CST9217 has a manufacturer datasheet that this research
located. Both are Chinese parts documented only through LILYGO and driver source. Any claim
about their power states beyond what LilyGoLib measures is unverified.

`[F]` LilyGoLib measures the panel asleep with power retained at about 100 µA and the touch
controller at about 3.4 µA `[S2]`.

## NFC

Direction of capability matters here, so it is stated precisely.

`[F]` The chip is an ST ST25R3916, a reader-side NFC controller, not a tag `[S3]` `[S13]`.
ST's data sheet lists its operating modes as reader/writer, card emulation, and active and
passive peer to peer `[F]` `[S13]`.

| Capability | Protocols | Tag |
|---|---|---|
| Reader/writer | NFC-A / ISO14443A to 848 kbit/s; NFC-B / ISO14443B to 848 kbit/s; NFC-F / FeliCa to 424 kbit/s; NFC-V / ISO15693 to 53 kbit/s | `[F]` `[S13]` |
| Card emulation | NFC-A / ISO14443A and NFC-F / FeliCa only | `[F]` `[S13]` |
| Peer to peer | Active and passive initiator and target, to 424 kbit/s | `[F]` `[S13]` |
| Low-level | MIFARE Classic-compatible and custom protocols | `[F]` `[S13]` |

`[F]` The watch can read tags and write tags across all four technology classes, and can
emulate a card in two of them. It cannot emulate an ISO14443B or ISO15693 card `[F]` `[S13]`.

`[F]` Interface is SPI up to 10 Mbit/s, CS on GPIO4 and interrupt on GPIO5, sharing the
bus with the radio and SD card `[S3]` `[S5]` `[S13]`. `[F]` It runs from a 27.12 MHz crystal
`[S1]` `[S13]` and is powered from AXP2101 DLDO1 `[S3]`.

`[F]` ST specifies 2 µA typical in power-down, 4.5 mA in ready mode and 16 mA typical with
everything active at 3.3 V `[S13]`.

`[F]` LILYGO states that on this board a card's presence cannot be detected passively and
the reader must be powered on to read `[S3]`, which contradicts ST's listed low-power
capacitive and inductive card detection `[S13]`. `[I]` The board does not wire a capacitive
sense electrode. `[Q]` Not confirmed against the layout.

`[F]` LilyGoLib's NFC worker call inside the main loop is commented out in the shipped
source `[S2]`. `[I]` NFC is the least exercised subsystem in the library.

`[F]` The NFC driver stack is two forks of ST software, `lewisxhe/ST25R3916-fork` and
`lewisxhe/NFC-RFAL-fork`, both under ST's SLA0052 software licence rather than a permissive
one `[S6]` `[S18]`. `[P]` If OSI ships firmware binaries, review SLA0052 before linking the
NFC stack, or omit NFC from the survey build entirely. A coverage-mapping tool has no need
for it.

## Motion, haptics, audio and physical inputs

| Item | Part | Notes | Tag | Source |
|---|---|---|---|---|
| Motion | Bosch BHI260AP, I2C 0x28, interrupt GPIO8 | Programmable sensor hub with an integrated 6-DoF IMU: 16-bit 3-axis accelerometer and 16-bit 3-axis gyroscope | `[F]` | `[S3]` `[S19]` |
| Magnetometer | none | BHI260AP's 9-DoF rotation vector requires an external magnetometer, and none is fitted | `[F]` `[I]` | `[S19]` `[S3]` |
| Haptics | TI DRV2605, I2C 0x5A, enable on XL9555 | Waveform-library haptic driver for ERM and LRA actuators, not a bare motor drive | `[F]` | `[S3]` |
| Amplifier | MAX98357A, 3.2 W class D, I2S BCLK GPIO9, WCLK GPIO10, DOUT GPIO11 | | `[F]` | `[S3]` `[S5]` |
| Microphone | TDK T3902 PDM, SCK GPIO17, DAT GPIO18 | | `[F]` | `[S3]` `[S5]` |
| RTC | NXP PCF85063A, I2C 0x51, interrupt GPIO1 | | `[F]` | `[S3]` `[S5]` |
| Backup cell | MS621FE-FL11E rechargeable coin cell on VBACKUP | | `[F]` | `[S1]` |
| Expander | XINLUDA XL9555, I2C 0x20 | 16 IO | `[F]` | `[S3]` `[S1]` |

`[F]` The absence of a magnetometer is confirmed twice: LILYGO's parts list contains none
`[S3]`, and Bosch's data sheet footnotes the 9-DoF rotation vector as requiring an external
one `[S19]`.

`[I]` A survey firmware cannot show a magnetic heading. Direction of travel is available
from GNSS course-over-ground while moving, and unavailable while stationary. For a coverage
map that is acceptable; for any antenna-pointing feature it is not.

Physical inputs, from LILYGO's front-panel diagram `[F]` `[S3]`:

- A power button. One second from off turns the watch on; six seconds from on shuts it
  down; the firmware can read its state.
- A GPIO0 button, usable as a custom button or to enter download mode.
- A reset button that the firmware can neither read nor drive.
- A microSD socket and a USB-C receptacle used for charging and programming, with no
  external power output function.

`[F]` There is no rotating crown and no keyboard `[S3]`. `[I]` Touch plus two readable
buttons is the whole input surface, which is thin for a field tool where a gloved or wet
finger may not register on a capacitive panel. `[P]` Map every survey action that must work
in the rain to the power button or GPIO0 button.

## Power management, battery and sleep

`[F]` The PMU is an X-Powers AXP2101 at I2C address 0x34, interrupt on GPIO7 `[S3]` `[S5]`.
It is a single-cell NVDC PMU with a linear charger rated 100 mA to 1 A and an "E-gauge 3.0"
fuel gauge that reports battery percentage from register 0xA4 and learns the cell's
characteristics from a supplied parameter set `[F]` `[S20]`. Its power-off current with the
battery FET open and the RTC LDO on is below 20 µA `[F]` `[S20]`.

`[F]` LilyGoLib ships a 128-byte `BATTER_PARAMS` array for this cell and performs a one-time
gauge calibration recorded in NVS under the `lilygo` namespace `[S2]`. `[I]` State of charge
comes from a modelled gauge, not a coulomb counter, so it will drift under the bursty
transmit load a survey firmware creates.

Rail assignment `[F]` `[S3]`:

| Rail | Load | Rail | Load |
|---|---|---|---|
| DC1 | ESP32-S3 | ALDO4 | Sensor |
| LDO1 (VRTC) | GNSS backup, cannot be switched off | BLDO1 | GNSS |
| ALDO1 | SD card | BLDO2 | Speaker |
| ALDO2 | Display | DLDO1 | NFC |
| ALDO3 | LoRa | VBACKUP | RTC coin cell |

Battery and charging `[F]` `[S3]`:

| Parameter | Value |
|---|---|
| Battery | 3.7 V, 1100 mAh, 4.07 Wh |
| USB-C input | 3.9–6 V |
| Charge current | 0–1024 mA, programmable |
| LILYGO's recommendation | Stay below 500 mA to limit PMU temperature |

`[Q]` The 1100 mAh figure is LILYGO's specification and was not verified against a cell
marking or a discharge test.

### What sleep actually means on this board

LILYGO publishes measured board-level currents `[F]` `[S3]`:

| Mode | Wake sources | Current |
|---|---|---|
| Light sleep | Power button + boot button + touch | 4.6 mA |
| Light sleep | Power button + boot button | 2.1 mA |
| Deep sleep | Power button + boot button, backup on | 1.1 mA |
| Deep sleep | Power button + boot button, backup off | 840 µA |
| Deep sleep | Touch panel | 3.34 mA |
| Deep sleep | Timer, backup off | 850 µA |
| Deep sleep | Timer, backup on | 1.1 mA |
| Power off | Backup only | 77 µA |

`[F]` Espressif specifies the ESP32-S3 itself at 7 µA in deep sleep with RTC memory powered
and RTC peripherals off, and 240 µA in light sleep before adding PSRAM `[S14]`.

`[I]` The SoC contributes about 1% of the board's deep-sleep draw. The other 99% is the
AXP2101's own quiescent consumption plus the peripherals that stay powered, so ESP32-S3
sleep-current optimisation is close to pointless here and the board floor of roughly 840 µA
is what a battery model must use.

`[F]` LilyGoLib's `sleep()` cuts the haptic driver, GNSS, speaker, NFC, sensor, SD card and
radio rails before entering deep sleep, and deliberately leaves the display rail (ALDO2)
powered `[S2]`. Its source comment states that switching the display rail off "will increase
[current] abnormally by about 600 µA", and that keeping the rail up with panel and touch
asleep costs about 103.4 µA instead `[F]` `[S2]`. `[F]` This anomaly is the subject of the
only open issue on the repository, #25, filed 2026-05-09 and unanswered `[S9]`.

`[I]` A known, unexplained power defect sits directly on the path of a battery-powered
survey firmware, and the vendor's workaround is empirical rather than understood. Treat any
runtime figure derived from these numbers as provisional until measured.

`[F]` `sleep()` powers the radio rail down entirely, so the transceiver loses all state
across a deep-sleep cycle `[S2]`. `[I]` A LoRaWAN session cannot be held in the radio; it
must be restored from RTC RAM or NVS on every wake, which is exactly what RadioLib's buffer
API is for.

`[F]` The library's deep-sleep path keeps DC1, the ESP32-S3 rail, powered and calls
`esp_deep_sleep_start()`, so RTC RAM survives `[S2]`. `[I]` `RTC_DATA_ATTR` storage is
therefore usable for the LoRaWAN session, and LILYGO's own LoRaWAN example does exactly this
`[F]` `[S2]`. `[I]` A full power-off, at 77 µA, loses RTC RAM and forces the session to come
from NVS.

`[F]` Wake sources implemented are the power button, the GPIO0 boot button, the touch panel,
the motion sensor and a timer, via EXT1 low-level wakeup or the RTC timer `[S2]`.

`[F]` A source comment says disabling the RTC backup battery charge adds about 200 µA `[S2]`,
while the published table shows backup-off as the lower-current state `[S3]`. `[Q]` These
disagree in sign, and issue #27 shows LILYGO has already had to correct this table once.

## Can everything run in one firmware

`[F]` Every GPIO on the ESP32-S3 is allocated; LILYGO's pin table marks none free `[S3]`.

Bus allocation `[F]` `[S3]` `[S5]`:

| Bus | Members |
|---|---|
| I2C (SDA GPIO3, SCL GPIO2) | CST9217 0x1A, XL9555 0x20, BHI260AP 0x28, AXP2101 0x34, PCF85063A 0x51, DRV2605 0x5A |
| SPI (SCK 35, MOSI 34, MISO 33) | LoRa module CS 36, NFC CS 4, SD card CS 21 |
| QSPI display | dedicated, 8 pins |
| UART | GNSS only, TX 43, RX 44, PPS 13 |
| I2S out | MAX98357A, 3 pins |
| PDM in | T3902, 2 pins |

`[F]` LilyGoLib guards the shared SPI bus with a FreeRTOS mutex exposed as `lockSPI()` and
`unlockSPI()` `[S2]`, and drives all shared-bus chip selects high during initialisation
`[S2]`.

`[I]` Radio, SD and NFC can coexist provided every access takes the mutex. The realistic
failure is a survey firmware writing a log to SD from one task while a LoRaWAN receive
window is open in another. LoRa receive windows are timing-critical, and an SD write can
block the bus for tens of milliseconds.

`[P]` Do not write to SD between an uplink and the close of RX2. Buffer survey records in
PSRAM and flush them after the receive windows close, or after the radio is back in standby.

`[F]` Wi-Fi is 802.11 b/g/n and Bluetooth is Bluetooth 5 LE, both on the ESP32-S3's single
2.4 GHz radio `[S14]`. `[I]` Wi-Fi and BLE share that radio and coexist through Espressif's
software coexistence arbitration, so both are available but neither gets full airtime. `[Q]`
The exact coexistence limits were not read from Espressif's coexistence documentation in
this pass.

`[I]` Wi-Fi or BLE running alongside LoRa is not an RF conflict, because the LoRa path is
sub-GHz and the ESP32-S3 radio is 2.4 GHz. The interaction is electrical and temporal: a
Wi-Fi transmit peak of 340 mA `[F]` `[S14]` on top of an SX1262 transmit of 118 mA `[F]`
`[S10]` pulls close to half an amp from a 1100 mAh cell, and the ESP32-S3's Wi-Fi task can
delay a receive-window interrupt.

`[P]` Schedule Wi-Fi uploads and LoRa uplinks in separate phases. Survey while offline,
upload when parked.

`[F]` RAM budget is 8 MB of external QSPI PSRAM plus the ESP32-S3's internal SRAM `[S3]`
`[S1]`. `[I]` An LVGL 9 frame buffer for 410 × 502 at 16 bpp is about 412 kB for a full
buffer, which fits comfortably in PSRAM alongside RadioLib and a survey log.

`[F]` LilyGoLib disables DMA for the display by default, stating that enabling it raises
frame rate but degrades appearance `[S2]`. `[I]` Display refresh will consume CPU that a
timing-sensitive LoRaWAN receive window also wants.

`[F]` The repository ships examples for LoRaWAN, plain SX1262 transmit and receive, GNSS,
SD card, NFC reading, LVGL, sleep with five wake sources, and BLE `[S2]`. `[Q]` No shipped
example combines GNSS, LoRaWAN and SD logging in one sketch, so the combination is
plausible from the pin map but not demonstrated by the vendor.

## Software framework and board support

`[F]` LilyGoLib is the vendor board-support library, MIT licensed, version 0.2.0, covering
T-Watch Ultra, T-LoRa-Pager, T-Watch-S3 and T-Watch-S3-Plus `[S2]`. `[F]` Its last commit on
2026-08-31 was 2026-08-11, it carries 136 stars, and it has one open issue `[S2]` `[S9]`.

`[I]` This is a young, single-maintainer library. One open issue on a repository this size
signals low traffic rather than high quality, and the closed-issue list is dominated by
documentation errors and toolchain setup problems `[S9]`.

Toolchain requirements from LILYGO's quick-start `[F]` `[S7]`:

| Item | Requirement |
|---|---|
| Arduino-ESP32 core | 3.3.0-alpha1 or later |
| Board | "LilyGo T-Watch-Ultra", not ESP32S3 Dev Module |
| Board Revision menu | Radio-SX1262 for the SX1262 SKU |
| Partition | 16M Flash (3MB APP/9.9MB FATFS) |
| USB | Hardware CDC and JTAG, CDC on boot enabled |
| CPU | 240 MHz |
| LVGL | 9.4.0 |
| RadioLib | 7.4.0 |
| XPowersLib | 0.3.1 |

`[I]` Requiring an alpha core release is a maintenance liability. An OSI firmware pinned to
`3.3.0-alpha1` inherits whatever is unfinished in that release, and LILYGO's instruction not
to upgrade the libraries "until the `helloworld` example runs correctly" `[F]` `[S7]` reads as
a warning that the pinned combination is fragile.

Addendum 2026-09-02 `[F]`: the alpha-core concern is resolved by the passage of time. The
arduino-esp32 3.3.x series is stable (3.3.0 stable since 2025-07-23; 3.3.11 current,
released 2026-07-22), and the `twatch_ultra` board entry (FQBN
`esp32:esp32:twatch_ultra`, revision option `Radio_SX1262`) has shipped in every tagged
release since 3.0.7. LILYGO's "3.3.0-alpha1 or later" line is simply an outdated floor.
The OSI firmware pins `esp32:esp32@3.3.11`. Source: espressif/arduino-esp32 releases and
per-tag `boards.txt`, retrieved 2026-09-02.

`[F]` PlatformIO is served by a separate repository, `LilyGoLib-PlatformIO`, pinned to
Arduino-ESP32 2.0.17, because PlatformIO does not support the 3.x core this device needs
`[S7]`. `[F]` That repository was last pushed 2025-11-04, nine months before the main
repository's last push `[S21]`, and carries no licence file `[S21]`.

`[I]` The PlatformIO path is stale and legally unclear. Arduino IDE with the 3.3.0-alpha
core is the supported path even though it is the worse build environment.

`[F]` ESP-IDF support is not documented in the quick-start `[S7]`. `[I]` Third-party sources
claim ESP-IDF and MicroPython support `[S17]`, but LILYGO's own documentation does not, and
LilyGoLib is an Arduino library by declaration `[S2]`.

Dependency licences `[F]`:

| Library | Version | Licence | Source |
|---|---|---|---|
| LilyGoLib | 0.2.0 | MIT | `[S2]` |
| RadioLib | 7.4.0 required, 7.7.1 current | MIT | `[S6]` `[S22]` |
| LVGL | 9.4.0 | MIT | `[S6]` |
| XPowersLib | 0.3.1 | MIT (lewisxhe) | `[S6]` |
| SensorLib | 0.3.3 | MIT (lewisxhe) | `[S6]` |
| TinyGPSPlus | 1.1.0 | LGPL-2.1 | `[S6]` |
| ST25R3916-fork, NFC-RFAL-fork | 1.1.0, 1.0.1 | ST SLA0052 | `[S6]` `[S18]` |

`[I]` Every library needed for a survey firmware except the NFC stack is permissively
licensed. Dropping NFC removes the only non-permissive dependency.

`[P]` Build the OSI survey firmware on the Arduino path with LilyGoLib as a hardware
abstraction only. Do not adopt its application layer. Pin RadioLib explicitly rather than
inheriting LilyGoLib's `library.json` pin, which is three minor versions behind LILYGO's own
documented requirement `[F]` `[S2]` `[S6]`.

## LoRaWAN stack

### RadioLib

`[F]` RadioLib is MIT licensed, maintained by Jan Gromeš, at version 7.7.1 with its most
recent commit on 2026-08-22 `[S22]`. `[I]` Active maintenance, with releases and commits
inside the last two weeks of the research window.

`[F]` RadioLib implements both LoRaWAN TS001 1.0.4 and 1.1, selected by which keys the
application supplies: passing `nwkKey` activates 1.1, passing `NULL` for it activates 1.0.4
`[S23]`. `[F]` Its regional parameters are RP002 1.0.4, except CN470 which follows RP001 1.1
revision B `[S23]`. `[F]` Supported regions include EU868, US915, AU915, AS923 and its
variants, IN865, KR920 and CN500 `[S2]`.

`[F]` OTAA and ABP are both supported, through `beginOTAA()`/`activateOTAA()` and
`beginABP()` `[S23]`.

Persistence `[F]` `[S22]` `[S23]`:

- `getBufferNonces()` and `setBufferNonces()` move a `RADIOLIB_LORAWAN_NONCES_BUF_SIZE`
  blob, holding the join nonces that must survive a power cycle.
- `getBufferSession()` and `setBufferSession()` move a `RADIOLIB_LORAWAN_SESSION_BUF_SIZE`
  blob, holding the session and frame counters.
- The wiki states persistence is mandatory for a production device and points to a separate
  `radiolib-persistence` repository of platform examples.

`[F]` LILYGO's own LoRaWAN example on this exact hardware stores nonces in NVS through
`Preferences` and the session in `RTC_DATA_ATTR` RAM across deep sleep `[S2]`. `[I]` The
persistence pattern a survey firmware needs is already demonstrated on the target board.

MAC commands relevant to a survey `[F]` `[S22]`:

- `sendMacCommandReq(RADIOLIB_LORAWAN_MAC_LINK_CHECK)` requests LinkCheckReq.
- `getMacLinkCheckAns(uint8_t* margin, uint8_t* gwCnt)` returns the link margin in dB at the
  gateway and the number of gateways that heard the uplink.
- `sendMacCommandReq(RADIOLIB_LORAWAN_MAC_DEVICE_TIME)` and
  `getMacDeviceTimeAns(timestamp, milliseconds, returnUnix)` retrieve network time.
- ADR, DevStatus, LinkADR and RXParamSetup are handled internally.

`[I]` LinkCheck margin and gateway count are the two numbers a coverage survey exists to
collect, and RadioLib hands them over directly. This is the strongest single argument for
RadioLib over the alternatives.

Signal quality `[F]` `[S22]`:

- `LoRaWANEvent_t` carries direction, datarate, frequency, frame counter, port, `nbTrans`
  and a `power` field documented as transmit power for uplinks or RSSI for downlinks.
- SNR is not in the event struct; the reference example reads `radio.getSNR()` and
  `radio.getRSSI()` from the physical layer after a downlink.

`[I]` Per-downlink RSSI and SNR are available, but only for downlinks. Uplink quality as
seen by the network comes from LinkCheck or from ChirpStack, never from the watch.

Duty cycle `[F]` `[S22]`:

- `setDutyCycle(bool enable = true, RadioLibTime_t msPerHour = 0)` and
  `setDwellTime(bool enable, RadioLibTime_t msPerUplink = 0)` exist.
- `dutyCycleEnabled` initialises to `false`, and nothing in the join or activation path sets
  it true.
- With `msPerHour` zero, the band's own value is used.
- When enabled, `uplink()` returns `RADIOLIB_ERR_UPLINK_UNAVAILABLE` rather than
  transmitting early.

`[I]` Duty-cycle enforcement is opt-in and off by default. A survey firmware that forgets
`setDutyCycle(true)` will breach the EU868 1% limit under Swiss regulation, because the
whole point of a survey is to transmit often. This is a compliance defect waiting to be
written.

`[P]` Call `setDutyCycle(true)` unconditionally at startup and make the survey's uplink
scheduler ask `timeUntilUplink()` rather than using a fixed interval. Expose the remaining
duty-cycle budget on screen so the operator understands why the watch is idle.

`[F]` RadioLib's own LoRaWAN notes state that "realtime GPS tracking almost always breaches
FUP and usually legal limits" `[S24]`. `[I]` The document is describing precisely the traffic
pattern a naive coverage-mapping firmware generates.

`[Q]` No open RadioLib issue affecting LoRaWAN frame counters, join behaviour or ESP32
receive-window timing was reviewed in this pass. The issue tracker was not searched.

### Alternatives

`[I]` The alternatives are weaker for this hardware, and none was verified in depth in this
pass, so each entry below is flagged.

`[Q]` MCCI LoRaWAN LMIC targets SX1272/SX1276-class radios; SX126x support was not
confirmed and is generally absent. `[Q]` LacunaSpace basicmac does support SX126x but its
maintenance status was not verified. `[Q]` Semtech's LoRa Basics Modem (SWL2001) supports
SX126x and LR11xx from the vendor directly, but it is an ESP-IDF-scale integration effort
with no Arduino board support for this watch, and its licence was not checked. `[Q]` No
ESP-IDF-native LoRaWAN stack was evaluated.

`[P]` Use RadioLib. It is the only option with LILYGO board support, a working example on
this exact watch, an MIT licence, current maintenance and a direct LinkCheck API.

## ChirpStack v4 interoperability

`[F]` ChirpStack v4 device profiles carry a `mac_version` field whose enum includes
`LORAWAN_1_0_4` and `LORAWAN_1_1_0`, and a `reg_params_revision` field whose enum includes
`RP002_1_0_4` `[S25]`. `[I]` Both of RadioLib's supported specification versions and its
regional-parameters revision are directly selectable in a ChirpStack device profile, so
there is no version mismatch to design around.

`[I]` LoRaWAN 1.1 is the better choice on paper because of its additional keys, but 1.0.4
avoids the join-server and rejoin complexity that 1.1 introduces. For a survey device
enrolled once against a known ChirpStack instance, 1.0.4 with OTAA is sufficient `[P]`.

`[F]` ChirpStack's `UplinkEvent` carries `repeated gw.UplinkRxInfo rx_info`, one entry per
receiving gateway `[S26]`. `[F]` Each `UplinkRxInfo` carries `gateway_id`, `rssi`, `snr`
(LoRa only), `channel`, `rf_chain`, `antenna`, a `location`, gateway and network-server
receive times, and a fine timestamp for TDOA `[S26]`.

`[I]` The network side already produces exactly the dataset a coverage map needs: for every
uplink, which gateways heard it, at what RSSI and SNR, from a gateway whose location
ChirpStack knows. The watch supplies its own position; ChirpStack supplies the reception
quality.

`[P]` Split the survey pipeline. Have the watch transmit a small uplink carrying its GNSS
fix, fix quality and satellite count, and reconstruct coverage on the OSI side by joining
that payload against ChirpStack's per-gateway `rx_info`. Use LinkCheck margin and gateway
count on the watch only for the operator's live display, not as the authoritative record.

`[F]` ChirpStack handles LinkCheckReq in its MAC command layer, dispatching
`lrwn::CID::LinkCheckReq` to a dedicated handler `[S27]`. `[I]` LinkCheckReq will be answered
by a stock ChirpStack v4 deployment. `[Q]` How ChirpStack computes the margin value it
returns was not read from the handler source.

`[Q]` Whether the OSI ChirpStack deployment's integration path preserves the full `rx_info`
array, and whether its device profile is already on RP002 1.0.4, was not checked against the
live configuration.

## Current draw reference

Every number in this section is a datasheet or vendor figure measured under the
manufacturer's conditions, not a measurement of this watch. All of them require on-hardware
confirmation before any battery claim is made.

SX1262, VBAT 3.3 V, 25 °C, DC-DC regulation, 868/915 MHz `[F]` `[S10]`:

| Condition | Current |
|---|---|
| TX +22 dBm, PA configured for +22 dBm | 118 mA |
| TX +17 dBm, PA configured for +22 dBm | 95 mA |
| TX +14 dBm, PA configured for +22 dBm | 90 mA |
| TX +14 dBm, PA optimally configured for +14 dBm | 45 mA |
| RX, LoRa 125 kHz | 4.6 mA |
| RX boosted, LoRa 125 kHz | 5.3 mA |
| STDBY_RC | 0.6 mA |
| STDBY_XOSC | 0.8 mA |
| Sleep, configuration retained | 600 nA |
| Sleep, cold start | 160 nA |

`[F]` Semtech's conditions exclude TCXO and RF switch consumption `[S10]`. `[I]` Add the
module's TCXO current and the SKY13453's supply current to every figure above.

`[I]` The +14 dBm row matters more than the +22 dBm headline. Transmitting at the EU868
legal ceiling of +14 dBm costs 90 mA if the PA is left configured for +22 dBm, and 45 mA if
it is configured for +14 dBm. That is a factor of two on the dominant load. `[Q]` Whether
RadioLib's `setOutputPower(14)` selects the optimal +14 dBm PA configuration on SX1262 was
not verified in the source.

ESP32-S3, 3.3 V, 25 °C `[F]` `[S14]`:

| Condition | Current |
|---|---|
| Wi-Fi TX, 802.11b 1 Mbps at 21 dBm | 340 mA peak |
| Wi-Fi TX, 802.11n HT20 MCS7 at 18.5 dBm | 283 mA peak |
| Wi-Fi RX, 802.11b/g/n HT20 | 88 mA |
| BLE TX at 0 dBm | 176 mA peak |
| BLE RX | 93 mA |
| Modem-sleep, 240 MHz, dual core, 32-bit access, peripheral clocks on | 81.3 mA |
| Modem-sleep, 240 MHz, WAITI, peripheral clocks off | 32.9 mA |
| Light sleep, VDD_SPI and Wi-Fi down | 240 µA, plus PSRAM |
| Deep sleep, RTC memory up, RTC peripherals down | 7 µA |

`[F]` Espressif's light-sleep footnote adds 140 µA for 8 MB 8-line PSRAM at 3.3 V and 40 µA
for 2 MB 4-line PSRAM at 3.3 V `[S14]`. `[Q]` No figure is published for 8 MB 4-line PSRAM,
which is what this board fits.

MIA-M10Q, 3.0 V, 25 °C, default GPS + Galileo + BeiDou B1I with SBAS and QZSS, 1 Hz `[F]`
`[S16]`:

| Condition | I_VCC | I_V_IO |
|---|---|---|
| Acquisition | 12.5 mA | 2.4 mA |
| Tracking, continuous | 10.5 mA | 2.4 mA |
| Tracking, power save cyclic | 5.5 mA | ~2.1 mA |
| Hardware backup at 3.3 V | 28 µA | – |
| Software standby | 120 nA | 46 µA at 3.3 V |

`[F]` Startup inrush reaches 100 mA `[S16]`.

Other loads `[F]`:

| Part | Condition | Current | Source |
|---|---|---|---|
| ST25R3916 | All active, 3.3 V | 16 mA typical, 23 mA max | `[S13]` |
| ST25R3916 | Ready mode | 4.5 mA typical | `[S13]` |
| ST25R3916 | Power down | 2 µA typical | `[S13]` |
| BHI260AP | Step counter | 98 µA | `[S19]` |
| BHI260AP | Game rotation vector, 25 Hz | 1.068 mA | `[S19]` |
| BHI260AP | Wakeup gesture | 261 µA | `[S19]` |
| Display panel | Asleep, rail powered | ~100 µA | `[S2]` |
| Touch controller | Asleep | ~3.4 µA | `[S2]` |
| Display | Awake, LILYGO's own note | ~10 mA in the driver's sleep path comment | `[S2]` |
| AXP2101 | Power off, BATFET open, RTC LDO on | under 20 µA | `[S20]` |

### A first-order battery model

`[P]` The arithmetic below is a design estimate built from the figures above, not a
measurement. It exists to size the problem, and every number in it needs replacing with a
measured one.

Deep-sleep endurance, using LILYGO's measured 840 µA board floor and the 1100 mAh cell:
1100 / 0.84 ≈ 1310 hours, about 54 days. At the 1.1 mA backup-on figure it is about 41 days.

A duty-cycled survey cycle, per fix and uplink, using datasheet figures:

| Phase | Duration | Current | Charge |
|---|---|---|---|
| GNSS hot-start acquisition and tracking | 5 s | ~13 mA | 18 mAs |
| ESP32-S3 awake, display off | 6 s | ~40 mA | 240 mAs |
| SX1262 TX at +14 dBm, SF7, PA optimal | 0.1 s | 45 mA | 4.5 mAs |
| RX1 and RX2 windows | 2 s | 5 mA | 10 mAs |
| Board deep sleep, remainder of a 60 s cycle | 47 s | 0.84 mA | 39 mAs |

Total per 60 s cycle is roughly 310 mAs, or 86 µAh. At 60 cycles per hour that is about
5.2 mAh per hour, giving roughly 210 hours of continuous surveying from a full charge before
display use is counted. `[I]` Turning the AMOLED on collapses that figure, because the panel
awake is the largest single load on the board.

`[I]` A one-minute survey cadence at SF7 also breaches the EU868 1% duty cycle at higher
spreading factors and breaches most fair-use policies at any spreading factor, so the real
cadence will be set by regulation rather than by the battery.

## Price and availability

| Channel | Price | Status | Tag | Source |
|---|---|---|---|---|
| LILYGO official store | USD 78.32 | Sold out, all three band SKUs | `[F]` | `[S8]` |
| AliExpress, LILYGO store | about USD 95 for the SX1262 868 MHz version | listed | `[F]` | `[S28]` |
| OpenELAB | EUR 120.95 | Pre-sale | `[F]` | `[S28]` |

`[I]` Supply is intermittent. The official store showed every variant sold out on
2026-08-31, and reseller listings were still marked pre-sale four months after the April
2026 launch coverage `[S17]`. Plan procurement lead time into any project schedule.

`[Q]` No FCC or CE declaration for the T-Watch Ultra was located, and LILYGO makes no
certification statement on the product page `[S8]`. `[I]` This is a development board.
Deploying it as a field instrument in Switzerland or Uganda is a regulatory question that
sits outside what documentation can answer.

`[F]` LILYGO's dimensions are 63.5 × 49 × 22 mm without the strap `[S4]`. `[F]` The IP65
claim comes from tech press coverage `[S17]`; LILYGO's own hardware page does not state an IP
rating `[S3]`. `[Q]` The IP65 rating is unconfirmed from a primary source.

## Hardware identification procedure

Documentation cannot tell you which radio is inside a specific watch, because the module is
a separate part behind a common footprint and the Arduino toolchain selects the driver at
compile time with no runtime detection `[F]` `[S12]` `[S2]`. Run this procedure on every unit
before trusting a survey measurement from it.

**Step 1, external markings.** Record the SKU code from the packaging or invoice. LILYGO's
codes are K253-01 for 868 MHz, K253-02 for 915 MHz and K253-04 for 920 MHz `[F]` `[S8]`. A
unit with no SKU record proceeds to step 2 with nothing assumed.

**Step 2, factory firmware.** Before flashing anything, boot the shipped firmware and record
what the radio screen reports. The repository's factory images are named by radio
(`factory.watch.ultra.sx1262.20260424.bin` and `factory.watch.ultra.sx1280.20260323.bin`)
`[F]` `[S2]`, so the factory application knows its own radio and will name it. Photograph the
screen. This step is destroyed by the first reflash, so do it first.

**Step 3, board revision.** Open the case only if steps 1 and 2 disagree. Confirm the
mainboard silkscreen reads V1.0, and read the marking on the module in the U3 position. That
marking is the only physical statement of which transceiver and which band matching are
fitted `[I]`.

**Step 4, antenna and connector census.** Record whether J2 and J3, the two IPEX/u.FL
positions, are populated, and whether a coax jumper links them `[F]` `[S1]`. Record whether a
wire or flex antenna is soldered at TP9 (LoRa) and TP7 (GNSS) `[F]` `[S1]`. This determines
which `setRFSwitch()` position actually reaches an antenna, which the schematic alone does
not settle `[Q]`.

**Step 5, radio identification probe.** Flash a minimal sketch that attempts each driver in
turn and reports which one answers.

`[F]` `SX126x::findChip()` resets the module, reads a 16-byte version string from
`RADIOLIB_SX126X_REG_VERSION_STRING`, and compares the first six characters against the
expected chip type, retrying ten times before returning `RADIOLIB_ERR_CHIP_NOT_FOUND`
`[S22]`. `[F]` `RADIOLIB_SX1262_CHIP_TYPE` is the string `"SX1261"` `[S22]`.

`[I]` The probe cleanly separates an SX126x-family part from an LR11x0, CC1101 or Si4432,
because only the SX126x returns that version string. It does not separate SX1261 from
SX1262, since RadioLib expects the same string for both. If SX1261 versus SX1262 matters,
read the module marking instead.

`[F]` For the LR11x0 family, `getVersionInfo()` fills an `LR11x0VersionInfo_t` carrying
hardware revision, a device identifier, and base and Wi-Fi firmware versions `[S22]`. `[I]`
A successful `getVersionInfo()` with a plausible device byte identifies an LR1121
positively.

`[P]` Build the probe sketch with the Radio-SX1262 board revision, call `radio.begin()`, and
report the result code. On `RADIOLIB_ERR_CHIP_NOT_FOUND`, rebuild with Radio-LR1121 and call
`getVersionInfo()`. Report both outcomes and the module marking together.

**Step 6, band confirmation by transmission.** Identification of the chip does not identify
the band matching. Confirm the band empirically.

`[P]` With the RF switch commanded to the built-in antenna, transmit a known LoRa packet at
+14 dBm on the band the SKU claims, and observe it on a spectrum analyser, an SDR, or a
ChirpStack gateway whose received RSSI can be read. Repeat on a band the SKU does not claim.
A unit matched for its labelled band shows a clear RSSI advantage on that band. Keep power
at the legal ceiling for the band under test and use a shielded enclosure or a separation
under 1 m so the test itself stays legal.

`[P]` Where a vector network analyser is available, measure return loss at the J2 connector
across 860–930 MHz instead. That answers the matching question directly and is the only
method that settles whether an 868 MHz unit is usable at 865 MHz for IN865.

**Step 7, record the result.** Store SKU, module marking, probe result, connector census and
band-confirmation evidence against the unit's serial. `[P]` A survey firmware should refuse
to record measurements from a unit whose identification record is missing, because an
unidentified radio produces unattributable coverage data.

## Showstopper risks

`[I]` None of these blocks the project. Each one can invalidate the survey data if it is
ignored.

**The RF switch can silently misroute transmit power.** `LORA_SEL` sits on an I2C expander,
and an I2C failure leaves the switch in an unknown state with no error path back to the
radio `[F]` `[S1]` `[S2]`. A survey recorded through a mismatched path understates coverage
everywhere, consistently, and looks like real data.

**Band matching is unverifiable from documentation.** The matching network is inside an
undocumented module `[F]` `[S1]`. A unit bought as 868 MHz and used at 868 MHz is fine; any
cross-band ambition needs measurement first.

**Duty-cycle enforcement is off by default in RadioLib** `[F]` `[S22]`, and a coverage survey
is exactly the application that will breach the EU868 1% limit without it.

**An unexplained 600 µA deep-sleep anomaly is open at the vendor** `[F]` `[S2]` `[S9]`, on the
rail a battery-powered survey firmware most wants to switch off.

**The vendor toolchain requires an alpha Arduino core** `[F]` `[S7]`, and the PlatformIO
alternative is nine months stale and unlicensed `[F]` `[S21]`.

**The SPI bus is shared between the radio, the SD card and the NFC reader** `[F]` `[S3]`. An
SD write during a LoRaWAN receive window will drop downlinks, including the LinkCheckAns a
survey depends on.

**There is no magnetometer** `[F]` `[S3]` `[S19]`, so heading is unavailable while stationary.

**Supply is intermittent and no certification is published** `[F]` `[S8]`. Procurement and
regulatory clearance are project risks independent of the engineering.

## Unresolved questions

Ordered by how much each one would change the design.

1. What is inside the `HPB16B3` module? No datasheet for it was located. Its matching
   network, its TCXO, and whether it is socketed or soldered all follow from this.
2. Is the module's matching usable at 865–867 MHz for IN865 on an 868 MHz SKU? Requires a
   return-loss measurement at J2.
3. Which switch position reaches a real antenna? Whether a J2-to-J3 coax jumper is fitted in
   production, and whether the SKY13453 truth table maps VCTL high to RF1 as LilyGoLib's
   comments assume.
4. Is there a TCXO, and at what voltage? Inferred at 3.0 V from LILYGO's own examples
   overriding RadioLib's 1.6 V default, not confirmed by measurement.
5. Does `setOutputPower(14)` on RadioLib select the optimal +14 dBm PA configuration? The
   difference is 45 mA against 90 mA, a factor of two on the dominant load.
6. Why does switching the display rail off in deep sleep add about 600 µA? LilyGoLib issue
   #25, open and unanswered since 2026-05-09.
7. Does the backup domain raise or lower deep-sleep current? LILYGO's table and LILYGO's
   source comment disagree in sign.
8. Has LILYGO shipped an unpublished board respin beyond V1.0?
9. What GNSS antenna is fitted at TP7? It is outside u-blox's characterised set, so
   sensitivity is unknown.
10. Are there open RadioLib issues affecting LoRaWAN frame counters, join behaviour or
    ESP32 receive-window timing? The issue tracker was not searched.
11. What are the ESP32-S3's documented Wi-Fi and BLE coexistence limits? Espressif's
    coexistence documentation was not read.
12. What is the ESP32-S3 light-sleep adder for 8 MB 4-line PSRAM? Espressif tabulates 8 MB
    8-line and 2 MB 4-line only.
13. Is the IP65 rating real? It appears only in tech press, not in LILYGO's own hardware
    documentation.
14. Is the 1100 mAh capacity real? Not verified against a cell marking or a discharge test.
15. Do the alternative LoRaWAN stacks support SX126x, and under what licences? basicmac,
    LoRa Basics Modem and any ESP-IDF-native stack were not evaluated.
16. How does ChirpStack compute the LinkCheckAns margin it returns?
17. Does the OSI ChirpStack deployment preserve the full `rx_info` array through its
    integration path, and is its device profile on RP002 1.0.4?
18. Does SD or exFAT support extend beyond LILYGO's stated 32 GB FAT32 limit?
19. Are the CO5300 and CST9217 documented anywhere outside LILYGO and driver source?
20. What is Uganda's LoRaWAN band allocation, and does an 868 MHz unit satisfy it?

## Sources

All retrieved 2026-08-31.

| Ref | Source |
|---|---|
| S1 | LILYGO, *T-Watch Ultra V1.0 SCH 25-07-24.pdf* and *T-Lora Pager V1.0 SCH 25-06-13.pdf*, in the LilyGoLib repository. https://github.com/Xinyuan-LilyGO/LilyGoLib/tree/master/schematic |
| S2 | LilyGoLib source, examples, firmware images, `library.json` and `LICENSE`, commit `38e6f8d` of 2026-08-11. https://github.com/Xinyuan-LilyGO/LilyGoLib |
| S3 | LILYGO, *LilyGo T-Watch-Ultra* hardware page. https://github.com/Xinyuan-LilyGO/LilyGoLib/blob/master/docs/hardware/lilygo-t-watch-ultra.md |
| S4 | LILYGO documentation repository, T-Watch Ultra product index. https://github.com/Xinyuan-LilyGO/documentation/blob/master/en/products/t-watch-series/t-watch-ultra/index.md |
| S5 | Espressif arduino-esp32, `variants/lilygo_twatch_ultra/pins_arduino.h`. https://github.com/espressif/arduino-esp32/blob/master/variants/lilygo_twatch_ultra/pins_arduino.h |
| S6 | LILYGO, *LilyGo Third party* dependency list. https://github.com/Xinyuan-LilyGO/LilyGoLib/blob/master/docs/third_party.md |
| S7 | LILYGO wiki, *T-Watch Ultra Quick Start*. https://wiki.lilygo.cc/products/t-watch-series/t-watch-ultra/quick-start.html |
| S8 | LILYGO store, T-Watch Ultra product page. https://lilygo.cc/products/t-watch-ultra |
| S9 | LilyGoLib issue tracker, issues #7, #25, #26, #27 and #33. https://github.com/Xinyuan-LilyGO/LilyGoLib/issues |
| S10 | Semtech, *SX1261/2 Data Sheet*, Rev 2.2, Dec 2024, tables 3-5 and 3-6. https://www.semtech.com/products/wireless-rf/lora-connect/sx1262 |
| S11 | Semtech, *LR1121 Datasheet*, Rev 2.0, Dec 2023, tables 3-4 to 3-6 and Figure 4-1. https://www.semtech.com/products/wireless-rf/lora-connect/lr1121 |
| S12 | Espressif arduino-esp32, `boards.txt`, `twatch_ultra` entries including the Revision menu. https://github.com/espressif/arduino-esp32/blob/master/boards.txt |
| S13 | STMicroelectronics, *ST25R3916 / ST25R3917 Datasheet*, DS12484 Rev 3, June 2020. https://www.st.com/en/nfc/st25r3916.html |
| S14 | Espressif, *ESP32-S3 Series Datasheet*, v2.2, tables 5-7 to 5-10. https://www.espressif.com/en/products/socs/esp32-s3 |
| S15 | Skyworks, *SKY13453-385LF: 0.01 to 6.0 GHz Single Control SPDT Switch*, document 202830G. https://www.skyworksinc.com/-/media/SkyWorks/Documents/Products/1901-2000/SKY13453-385LF_202830G.pdf |
| S16 | u-blox, *MIA-M10Q Data sheet* UBX-22015849 R08 and *MIA-M10Q Integration manual* UBX-21028173 R05, both 30-Jan-2026. https://content.u-blox.com/sites/default/files/documents/MIA-M10Q_DataSheet_UBX-22015849.pdf and https://content.u-blox.com/sites/default/files/documents/MIA-M10Q_IntegrationManual_UBX-21028173.pdf |
| S17 | CNX Software, *LILYGO T-Watch Ultra*, 2026-04-20. https://www.cnx-software.com/2026/04/20/lilygo-t-watch-ultra-an-ip65-rated-esp32-s3-smartwatch-with-2-01-inch-amoled-lora-and-gnss/ |
| S18 | `lewisxhe/ST25R3916-fork` and `lewisxhe/NFC-RFAL-fork`, licence file SLA0052 Rev 3. https://github.com/lewisxhe/ST25R3916-fork |
| S19 | Bosch Sensortec, *BHI260AP Datasheet*, BST-BHI260AP-DS000-02 Rev 1.1, table 14. https://www.bosch-sensortec.com/products/smart-sensor-systems/bhi260ap/ |
| S20 | X-Powers, *AXP2101 Single Cell NVDC PMU with E-gauge* datasheet. http://www.x-powers.com/en.php/Info/product_detail/article_id/95 |
| S21 | `Xinyuan-LilyGO/LilyGoLib-PlatformIO`, repository metadata, last push 2025-11-04. https://github.com/Xinyuan-LilyGO/LilyGoLib-PlatformIO |
| S22 | RadioLib source at commit `187ef24` of 2026-08-22, version 7.7.1: `src/protocols/LoRaWAN/`, `src/modules/SX126x/`, `src/modules/LR11x0/`, `examples/LoRaWAN/`. https://github.com/jgromes/RadioLib |
| S23 | RadioLib wiki, *LoRaWAN: versions and revisions* and *License*. https://github.com/jgromes/RadioLib/wiki/LoRaWAN:-versions-and-revisions |
| S24 | RadioLib, `examples/LoRaWAN/LoRaWAN_Starter/notes.md`. https://github.com/jgromes/RadioLib/blob/master/examples/LoRaWAN/LoRaWAN_Starter/notes.md |
| S25 | ChirpStack API protobuf definitions, `common.proto` (`MacVersion`, `RegParamsRevision`) and `device_profile.proto`. https://github.com/chirpstack/chirpstack/tree/master/api/proto |
| S26 | ChirpStack API protobuf definitions, `integration.proto` (`UplinkEvent`) and `gw.proto` (`UplinkRxInfo`). https://github.com/chirpstack/chirpstack/tree/master/api/proto |
| S27 | ChirpStack source, `chirpstack/src/maccommand/mod.rs` and `link_check.rs`. https://github.com/chirpstack/chirpstack |
| S28 | Reseller listings used only to establish SKUs, prices and stock status: OpenELAB T-Watch Ultra product page (https://openelab.io/products/lilygo-t-watch-ultra-lora) and AliExpress LILYGO official store listings. |
