# VIA Chameleon — Hardware & Protocol Reference

**Date:** 2026-04-30
**Status:** Reference (pre-firmware research)
**Source material:** [/home/phil/kDrive/OSI OS/Hardware/Chameleon/](file:///home/phil/kDrive/OSI%20OS/Hardware/Chameleon/) (vendor-supplied library, API doc, and calibration spreadsheet)

> Purpose: capture every practical fact known about the VIA Chameleon Module
> before we commit to a Dragino LSN50 custom-firmware design. This doc is
> intended to be a single-page reference for the firmware author and for the
> server-side ingest path that will store and convert the readings.

---

## 1. What the Chameleon Module is

The **VIA Chameleon Module** is a small interface board supplied by VIA
([via.farm](https://via.farm)) that conditions and reads three resistive soil-moisture
sensors (gypsum-block / Watermark-style) plus an on-board temperature sensor,
and exposes the results over I²C.

| Property | Value |
|---|---|
| Slave MCU | ATtiny814 (Microchip megaAVR-0) |
| Role on the bus | I²C slave (always slave) |
| I²C address | `0x08` (`CHAM_SLAVE_ADDR`) |
| I²C bus speed | 400 kHz (set by master) |
| Logic / supply | 3.3 V or 5 V (per the Arduino example sketch) |
| Soil-sensor channels | 3 (resistive; one set of three per probe assembly) |
| Temperature sensor | 1× DS18B20 (1-Wire, exposes 64-bit ROM code) |
| Reading model | One-shot, master-triggered (does **not** free-run) |
| Status timeout | Stored reading goes "stale" 5 min after the last measurement |

The module is *not* a smart sensor in its own right: it is an analogue front-end
plus a tiny MCU that exposes a minimal command set. All scheduling, conversion
to soil-water tension, and reporting are the master's responsibility.

### Vendor calibration

Each physical module ships with **9 calibration coefficients** — three per soil
channel `(a, b, c)`. They are specific to one module's three sensor circuits
and must travel with the unit (vendor stores them by module ID). They are
**not** stored inside the ATtiny — the I²C protocol returns ohms only.
Conversion to soil-water tension (kPa) happens off-board.

---

## 2. Wiring (LSN50 master → Chameleon slave)

From the vendor's Arduino reference (Uno/Nano pin names; map to the LSN50
equivalent during the firmware design phase):

| Master signal | Chameleon (ATtiny814 pin) | Notes |
|---|---|---|
| SDA | `PA6` | I²C data |
| SCL | `PA7` | I²C clock |
| GND | GND | Common ground required |
| VCC | 3.3 V or 5 V | LSN50 normally exposes 3.3 V; vendor confirms 3.3 V is supported |
| Pull-ups | — | 4.7 kΩ to VCC on **SDA** and **SCL** if the carrier doesn't already provide them |

The vendor library calls `Wire.begin()` then `Wire.setClock(400000)`. There is
no clock-stretching guidance from the vendor; assume the master must tolerate
slave processing delays via the documented poll-for-status pattern below.

---

## 3. I²C protocol

The protocol is intentionally tiny. Every interaction is one of:

- **Write a single command byte** (write-only commands) — e.g. trigger.
- **Write command byte + repeated start + read N bytes** (read commands).

All multi-byte numeric responses are **little-endian**.

### 3.1 Command summary

| Cmd  | Direction | Bytes | Type | Meaning |
|------|-----------|-------|------|---------|
| `0x01` | read  | 2 | `int16`  | Raw temperature; divide by 100 → °C |
| `0x11` | read  | 4 | `uint32` | Sensor 0 resistance, **temperature-compensated**, ohms |
| `0x12` | read  | 4 | `uint32` | Sensor 1 resistance, temperature-compensated, ohms |
| `0x13` | read  | 4 | `uint32` | Sensor 2 resistance, temperature-compensated, ohms |
| `0x21` | read  | 4 | `uint32` | Sensor 0 resistance, **uncompensated (raw)**, ohms |
| `0x22` | read  | 4 | `uint32` | Sensor 1 resistance, raw, ohms |
| `0x23` | read  | 4 | `uint32` | Sensor 2 resistance, raw, ohms |
| `0x30` | read  | 8 | `uint8[8]` | DS18B20 64-bit ROM code (sensor identity) |
| `0x40` | write | 0 | — | **Trigger** a fresh measurement cycle |
| `0x41` | read  | 1 | `uint8`  | **Status**: `0x01` = data fresh, `0x00` = stale or busy |

Notes:

- Resistance values are in **ohms** (not kΩ). Divide by 1000 for kΩ.
- The "compensated" registers (`0x11`-`0x13`) apply an internal temperature
  correction using the on-board DS18B20 reading. The vendor library exposes
  both raw and compensated; both should be logged so the server can re-derive
  if needed.
- The example output from the vendor library shows the raw and compensated
  values are typically equal in the sample data — the compensation appears to
  apply only at temperature extremes.
- Status byte semantics are binary: any value other than `0x01` should be
  treated as "not ready". Do not attempt to read sensor data while status is
  not `0x01`.

### 3.2 Required interaction sequence

```
1. (boot)                         slave performs ONE measurement, status = 0x01
2. master writes 0x40             slave starts a measurement, status = 0x00
3. master polls 0x41 every ~50 ms until it returns 0x01 (or timeout)
4. master reads 0x01, 0x11..0x13, 0x21..0x23, 0x30 in any order
5. ... no further activity for >5 min → status decays to 0x00
6. before next read cycle, repeat from step 2
```

Vendor library default poll interval is **50 ms**; default timeout is
**2000 ms** (`waitForReady(2000)`). These are sane starting values for the
LSN50 firmware. A real measurement cycle is typically well under 2 s based on
the example output (back-to-back successful reads at 3 s loop interval).

### 3.3 Bytewise format

- **Temperature** (`0x01`): `int16` little-endian, two's complement.
  `°C = value / 100.0`.
  Example: `0x07C3` (LE: `C3 07`) → `1987` → `19.87 °C`.
- **Resistance** (`0x11`–`0x13`, `0x21`–`0x23`): `uint32` little-endian, ohms.
  `kΩ = value / 1000.0`.
- **DS18B20 ID** (`0x30`): 8 raw ROM bytes, byte-order as returned by 1-Wire
  (vendor library prints them sequentially without reversal). The first byte
  is the family code (`0x28` for DS18B20).

---

## 4. Failure modes & sentinel values

Observed in the vendor's `Example output.txt` and inferred from the library
source:

| Symptom | Returned value | Meaning |
|---|---|---|
| DS18B20 not connected / busted | Temp = `-127.00 °C` (raw `-12700` = `0xCE04` LE) | Standard DS18B20 "no device" sentinel; trust as fault indicator |
| DS18B20 not connected / busted | ID = `FF FF FF FF FF FF FF FF` | 1-Wire bus pulled high; treat as missing |
| Soil sensor disconnected / open | Resistance = `10 000 000 Ω` (10 MΩ, prints as `10000.0 kΩ`) | Hard-coded ceiling sentinel; do **not** convert to tension |
| Slave not present on bus | I²C address probe (zero-byte transmission) NACKs | Library prints "Chameleon NOT found at 0x08" |
| Slave busy or expired | Status `0x41` returns anything ≠ `0x01` | Re-trigger and wait |
| Read times out | Library returns `false` from `waitForReady()` | LSN50 firmware should skip the cycle, not block forever |

**Rule for the firmware author:** never publish sensor readings if any of the
sentinels above are present. Better to publish a "device error" telemetry
event than to publish `10000 kΩ` and let the server convert it to a wildly
negative tension.

---

## 5. Resistance → soil-water tension conversion

The vendor's Excel sheet (`conversion resistance tension.xlsx`) documents the
calibration model used downstream:

```
y = a * ln(x) + b * x + c

  where  x = resistance (kΩ)
         y = tension (kPa)
         a, b, c are per-sensor calibration coefficients
```

- **Three (a, b, c) triples per module**, one per soil channel. They are
  measured at the factory and printed/recorded against the module's serial.
- Coefficients vary slightly per channel and per module; they cannot be
  hard-coded firmware-side. Treat them as device metadata stored alongside
  the gateway/device record on the server.
- Example coefficients from the vendor calibration sheet:

  | Module ID | Ch 1 (a, b, c) | Ch 2 (a, b, c) | Ch 3 (a, b, c) |
  |---|---|---|---|
  | 9F33 | 10.52, 0.14, 6.93 | 10.54, 0.15, 7.38 | 10.46, 0.13, 7.72 |
  | A3D2 | 10.81, 0.13, 6.05 | 10.89, 0.13, 6.52 | 10.55, 0.12, 6.53 |
  | ABB0 | 10.32, 0.14, 7.35 | 10.37, 0.12, 7.16 | 10.29, 0.14, 7.60 |
  | FB88 | 10.71, 0.13, 7.18 | 10.40, 0.13, 7.31 | 10.33, 0.12, 7.21 |

  Verified against the spreadsheet's own computed values: e.g. FB88 ch1
  with x=0.4 kΩ → y = 10.71·ln(0.4) + 0.13·0.4 + 7.18 ≈ −2.58 kPa, which
  matches the spreadsheet cell.

- The formula can produce **negative tension** at very low resistance
  (saturated soil). The spreadsheet shows values down to ≈ −9.4 kPa as a
  practical floor.
- The formula's domain excludes `x = 0` (because of `ln(x)`). The 10 MΩ
  sentinel for a disconnected sensor produces a nonsense large positive
  tension — another reason to detect the sentinel server-side and drop the
  reading.

**Recommendation:** keep raw resistance (and, ideally, the compensated value
too) on the wire; let the server hold the calibration table and compute kPa.
That keeps the LSN50 payload simple and lets us re-process historical data
if a calibration is corrected.

---

## 6. Reference Arduino library (vendor)

Source: `/home/phil/kDrive/OSI OS/Hardware/Chameleon/VIAChameleonI2CMaster/`
(also available as `VIAChameleonI2CMaster.zip`).

| File | Role |
|---|---|
| `VIAChameleonI2C.h` | Public class definition + protocol constants |
| `VIAChameleonI2C.cpp` | Implementation (uses Arduino `Wire`) |
| `VIAChameleonI2CMaster.ino` | Demo sketch: `setup()` probes, `loop()` triggers and prints |
| `Example output.txt` | Two cycles of real serial output — one with the DS18B20 disconnected (sentinel values), one with a working probe |

Public API to mirror in our LSN50 firmware (or call directly if we keep the
Arduino-flavoured runtime):

```cpp
bool        begin();                              // probe at 0x08, set 400 kHz
void        triggerReading();                     // 0x40, write-only
bool        isReady();                            // 0x41, returns status == 0x01
bool        waitForReady(uint16_t timeout_ms);    // poll every 50 ms
uint8_t*    getAddressID();                       // 0x30, 8 bytes
float       getTemperatureC();                    // 0x01 / 100
float       getResistanceOhmsRaw(uint8_t ch);     // 0x21..0x23
float       getResistanceOhmsCal(uint8_t ch);     // 0x11..0x13
float       getResistancekOhmsRaw(uint8_t ch);    // /1000
float       getResistancekOhmsCal(uint8_t ch);    // /1000
```

Implementation details worth keeping for our port:

- `begin()` does a zero-byte I²C transmission to the slave address; if
  `Wire.endTransmission()` returns `0`, the slave is present.
- `isReady()` uses a **repeated start** (`Wire.endTransmission(false)`) before
  the read — this is required by the protocol. Plain stop-then-start may not
  work depending on the master implementation.
- All multi-byte reads are little-endian, manually shifted (no `memcpy`).
- The library halts the demo sketch if `begin()` fails (`while (1) delay(...)`)
  — for LSN50 firmware we instead want to publish a fault event and continue
  to the next duty cycle.

---

## 7. Example serial output (annotated)

From `Example output.txt`:

```
====================
Scanning for Chameleon Module...
Chameleon NOT found at 0x08 !          ← first run: bus probe failed
*** NO CHAMELEON MODULE DETECTED ***
====================
Scanning for Chameleon Module...
Chameleon found at 0x08                 ← second run: slave present
Chameleon Module Ready
====================
Triggering fresh reading...
ID: FFFFFFFFFFFFFFFF                    ← DS18B20 missing sentinel
Temperature: -127.00 C                  ← DS18B20 missing sentinel
Resistance raw/cal (kOhms):
  S1: 10000.0 / 10000.0 kOhm            ← all three channels open-circuit
  S2: 10000.0 / 10000.0 kOhm
  S3: 10000.0 / 10000.0 kOhm
====================
Triggering fresh reading...
ID: 286D6ADB0F0000F1                    ← real DS18B20 ROM (family 0x28)
Temperature: 19.87 C                    ← realistic
Resistance raw/cal (kOhms):
  S1: 1.1 / 1.1 kOhm                    ← wet soil
  S2: 10.1 / 10.1 kOhm                  ← drying
  S3: 101.2 / 101.2 kOhm                ← dry / deep
====================
```

The "raw == cal" equality is normal at room temperature; compensation only
diverges materially at temperature extremes.

---

## 8. VIA Cloud API (read-only, optional reference)

Source: `VIA - API.pdf`, `API commands.txt`.

We are **not** required to integrate with the VIA cloud — the Chameleon module
itself is a local I²C slave and produces all data we need. The cloud API is
documented here only because the user has an account and may want to
cross-reference field calibrations or historical data.

| Item | Value |
|---|---|
| Base URL | `https://via.farm/api/` |
| Auth | `Authorization: Token <token>` (per-user) |
| Token endpoint | `POST /api/token_auth/` with `username` + `password` |
| Capabilities | Read-only (vendor states write/edit will come "when there's a use case") |
| Scope | Only resources the authenticated user owns are visible |

Useful endpoints (from `API commands.txt`):

- `GET /api/farm/`
- `GET /api/irrigationbay/` and `/api/irrigationbay/<id>/`
- `GET /api/sensorarray/`
- `GET /api/sensordata/`
- `GET /api/crop/`

Models the vendor explicitly **excludes** from the public API include
`HardwareVersion`, `FirmwareVersion`, `SensorArrayTestType`, `ArrayResult`,
`TestRig*`, `FieldRigSensorData`, `RainEvent`, `IrrigationEvent`,
`Project*`, `Statistic`. So calibration coefficients are not retrievable
programmatically — they must come from the physical paperwork shipped with
each module.

> **Security note:** `API commands.txt` in the kDrive folder contains a real
> token in plaintext. If we ever script against the API, that token belongs
> in a secrets store, not in the repo.

---

## 9. Implications for the LSN50 custom firmware

These are open design points, not decisions — flagged for the design spec
that follows this reference.

1. **Bus & power**
   - The LSN50 (PB6/PB7 expose I²C1 on the standard pinout) can host a 3.3 V
     I²C slave at 400 kHz with 4.7 kΩ pull-ups. We need to confirm the LSN50
     carrier exposes SDA/SCL on the chosen MOD or external connector and
     supplies 3.3 V continuously to the Chameleon (or wakes it).
   - Power budget: the slave performs a single measurement on demand and idles
     between cycles. If the LSN50 cuts VCC between wakeups, treat boot status
     `0x01` as a free first reading; otherwise re-trigger every cycle.

2. **Cycle pattern**
   - Wake → trigger (`0x40`) → poll status (`0x41`) every 50 ms up to ~2 s →
     read temp (`0x01`), 6 resistances (`0x11–0x13`, `0x21–0x23`), DS18B20 ID
     (`0x30`, only on first cycle or on change) → assemble LoRaWAN payload →
     sleep.
   - First-boot behaviour: the slave already has data ready (`0x01`) — we can
     read immediately, but for consistency it's cleaner to always trigger.

3. **Payload sizing (LoRaWAN, AS923/EU868)**
   - Minimal raw set per cycle: 2 B temp + 6 × 4 B resistance = **26 B**.
   - Plus DS18B20 ID (8 B) on join / on change only.
   - Plus battery + flags, ~4 B.
   - Total ~30 B per uplink — fits SF7..SF10 frames comfortably; SF12 needs
     more care or fewer channels per frame.
   - We can drop one of {raw, compensated} if size becomes a constraint;
     keeping both means we can post-correct on the server.

4. **Server-side conversion**
   - Store per-device calibration coefficients in the existing osi-server
     device metadata (or a new `via_chameleon_calibration` table keyed by
     `deveui` and channel index 0–2).
   - Compute kPa server-side using `y = a·ln(x) + b·x + c`. Apply only to
     resistance values within a sane window (e.g. 0.05 ≤ x_kΩ ≤ 1000); drop
     `10 MΩ` sentinels and any `x ≤ 0`.
   - Persist raw, compensated, **and** computed kPa so future calibration
     fixes can re-derive history.

5. **Database / device-type integration**
   - Add a new `type_id` for the Chameleon: e.g. `VIA_CHAMELEON`
     (3 channels of `swt` per device — extend `device_data` schema or use the
     existing `swt_wm1`/`swt_wm2` plus a new `swt_wm3`, or normalise into a
     channel-keyed table).
   - The LSN50 housing/EUI is what ChirpStack sees; the Chameleon itself has
     no LoRaWAN identity. Treat the LSN50+Chameleon pair as one logical
     device.

6. **Failure handling on the wire**
   - Sentinel resistance (`10 000 kΩ`) and sentinel temp (`-127 °C` /
     ID `0xFF*8`) must be detected and either dropped or sent with a fault
     flag. The default React dashboard cards already swallow `null` cleanly;
     prefer `null` over publishing the sentinel.

7. **Calibration coefficient provisioning**
   - These come on paper from VIA, per module. We need a workflow (probably
     in the dashboard's gateway-admin section, or via the existing CSV /
     bootstrap pipeline) to enter `(a, b, c)` × 3 channels for each
     LSN50+Chameleon pair. This is a UX/onboarding concern that overlaps with
     the firmware design but is not the firmware's job.

---

## 10. Open questions for the vendor / next steps

Before locking the firmware design, we should confirm:

1. **Power-cycle behaviour.** Does the slave require a settling delay after
   VCC ramps before responding to I²C? (LSN50 may toggle sensor power.)
2. **Compensation model.** What does "temperature-compensated" do internally
   — is it an empirical correction or a fixed dR/dT slope? Affects whether we
   need to log raw at all.
3. **Reading time.** Worst-case time from `0x40` to status `0x01`? Drives the
   LSN50 wake budget.
4. **Multiple modules per master.** Is the I²C address (`0x08`) configurable?
   If we want >1 Chameleon per LSN50, we either need address selection or an
   I²C mux. Vendor library hard-codes `0x08`.
5. **DS18B20 sample timing.** Is the on-board DS18B20 sampled in the same
   trigger cycle as the soil channels, or independently? Affects whether the
   reported temp lines up with the resistance compensation.
6. **Calibration file format.** Does VIA supply `(a, b, c)` × 3 in a
   structured file (CSV/JSON) or only on a printed sheet? Matters for
   provisioning UX.

---

## 11. Source files (for re-checking)

All under `/home/phil/kDrive/OSI OS/Hardware/Chameleon/`:

- `VIAChameleonI2CMaster/VIAChameleonI2C.h` — protocol constants & class
- `VIAChameleonI2CMaster/VIAChameleonI2C.cpp` — implementation
- `VIAChameleonI2CMaster/VIAChameleonI2CMaster.ino` — demo sketch
- `VIAChameleonI2CMaster/Example output.txt` — real serial output, two cycles
- `VIA - API.pdf` — VIA cloud read-only REST API
- `API commands.txt` — token + curl examples (contains a live token; treat as secret)
- `conversion resistance tension.xlsx` — calibration coefficients per module + working sheet
- `Questionaire Chameleon.docx`, `Interviews/`, `presentation.pdf` — non-technical context (farmer interviews, vendor presentation, invoices)
