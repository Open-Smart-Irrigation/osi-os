# STREGA Enclosure Temperature and Humidity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the temperature and humidity a Gen1 STREGA valve already reports, and state plainly in the interface that Gen2 valves do not measure them.

**Architecture:** No new ingestion. The edge already decodes, normalises and stores both values for Gen1 valves; the only gap is that nothing reads them back out. This plan widens the valve-list query, carries the two values through the API and types, and renders them on the valve tile with an explicit "not measured on this generation" state for Gen2.

**Tech Stack:** Node-RED flows.json function nodes, the `osi-valve-control` seam module, React 18 + TypeScript + Vite, SQLite (`device_data`).

**Spec:** No separate spec. The controlling facts are the two vendor decoders in `docs/hardware/strega-codecs/` and the SV2 manual at `/home/phil/kDrive/OSI OS/Hardware/STREGA/Gen2/HHW_SV2_STREGA_Smart_valve_Manual.pdf` (payload format, pp. 51-53; specifications, p. 110).

## Global Constraints

- **Gen2 (SV2) does not measure temperature or humidity, and no amount of decoding will produce them.** Verified three ways: the Gen2 vendor decoder emits no such field; the manual's periodical uplink is 3 bytes of battery millivolts plus one info-status byte (Class, Power, DI_1/LSC, DI_0/LSO, valve-connection, valve-position), optionally followed by a counter; and the specification's "Data Read" list names only valve state, battery, device ID, digital inputs, counter, alarm and RSSI. Never infer, estimate, or borrow these values for a Gen2 valve.
- **The Gen1 measurement is enclosure climate, not field weather.** The vendor decoder's own variables are `box_temp` and `box_hum`. Label it as the valve's enclosure, never as air temperature for the zone, and never feed it into agronomy calculations.
- **Missing data stays missing.** `null` means unavailable. The edge already treats the sentinel pair 125 °C / 100 % as "no sensor fitted" and stores `null`; the interface must render that as unknown, never as `0 °C`.
- **A Gen2 valve's absent reading is a different state from a Gen1 valve that has not reported yet.** The first is "this hardware cannot measure it"; the second is "we do not know yet". Do not collapse them into one message.
- **`flows.json` is edited only by a one-shot Node script** with the byte-identical roundtrip guard, and both hardware profiles must end identical (`osi-flows-json-editing` skill).
- **Every gate is judged by exit code** (`node script; echo $?`), never by the last printed line.
- **No `npm run build`** — the workstation OOMs. Use `npm run typecheck` and `npm run test:unit`.
- **`valve-ack-fn` is at 4085/4096 characters** and is ceiling-capped with no allowance path. This plan does not touch it; if you find yourself editing it, stop and reconsider.
- **Commit, do not push.**

## What already exists (do not rebuild)

Verified in the working tree before this plan was written:

| Stage | Status |
|---|---|
| Gen1 decoder emits `Temperature` and `Hygrometry` | shipped |
| `strega-process-fn` normalises both, with the 125/100 no-sensor sentinel | shipped |
| `strega-sql-fn` writes `device_data.ambient_temperature` and `relative_humidity` | shipped |
| Anything reads them back | **missing — this plan** |

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `osi-valve-control/store.js` | Widen `VALVE_LIST_SQL` with the latest reading per valve | 1 |
| `osi-valve-control/api.js` | Carry the two values into the valve payload | 1 |
| `web/react-gui/src/services/api.ts`, `src/types/farming.ts` | Types and normalisation | 2 |
| `web/react-gui/src/components/farming/valves/ValveTile.tsx` | Render the reading, or the honest absence | 2 |
| `web/react-gui/public/locales/*/valves.json` | Labels in 7 locales | 2 |
| `.claude/skills/osi-agronomy-sensors-reference/SKILL.md`, both system maps | Record the generational difference | 3 |

---

### Task 1: Expose the stored reading through the valve API

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/store.js` (+ the bcm2709 mirror, `diff -rq`-identical)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/api.js` (+ mirror)
- Test: the module's existing `*.test.js` files, in their established style

**Interfaces:**
- Produces: each valve in `GET /api/valves` gains `enclosure_temperature_c` (number | null), `enclosure_humidity_pct` (number | null) and `enclosure_measured_at` (ISO string | null). Task 2 consumes exactly these three names.

- [ ] **Step 1: Write the failing store test**

`VALVE_LIST_SQL` currently selects `last_uplink_at` with a correlated subquery over `device_data`. The new columns follow the same shape, but must come from the **most recent row that actually carried a reading** — the newest row overall may be a state-only uplink with both columns null, and reading that would erase a good value. Add to the module's store test file, matching its existing `node:sqlite` harness:

```js
test('valve list reports the newest non-null enclosure reading, not the newest row', async () => {
  const db = await freshDb();               // use the file's existing helper
  await seedValve(db, { deveui: 'AA', userId: 1 });
  await db.run("INSERT INTO device_data (deveui, recorded_at, ambient_temperature, relative_humidity) VALUES ('AA','2026-08-20T10:00:00.000Z', 21.5, 48.2)");
  await db.run("INSERT INTO device_data (deveui, recorded_at, ambient_temperature, relative_humidity) VALUES ('AA','2026-08-20T11:00:00.000Z', NULL, NULL)");
  const [valve] = await store.listValvesForUser(db, 1);
  assert.equal(valve.enclosure_temperature_c, 21.5);
  assert.equal(valve.enclosure_humidity_pct, 48.2);
  assert.equal(valve.enclosure_measured_at, '2026-08-20T10:00:00.000Z');
});

test('valve list reports nulls when no reading was ever stored', async () => {
  const db = await freshDb();
  await seedValve(db, { deveui: 'BB', userId: 1 });
  await db.run("INSERT INTO device_data (deveui, recorded_at) VALUES ('BB','2026-08-20T10:00:00.000Z')");
  const [valve] = await store.listValvesForUser(db, 1);
  assert.equal(valve.enclosure_temperature_c, null);
  assert.equal(valve.enclosure_humidity_pct, null);
  assert.equal(valve.enclosure_measured_at, null);
});
```

Read the test file first and reuse its real helper names; the two above are illustrative of the assertions, not of the harness.

- [ ] **Step 2: Run the module tests and watch them fail**

```bash
cd conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control
node --test; echo "exit=$?"
```
Expected: `exit=1`, the two new tests failing on undefined properties. (Use bare `node --test`; `node --test .` fails on Node v22.23.1.)

- [ ] **Step 3: Widen the query**

In `VALVE_LIST_SQL`, beside the existing `last_uplink_at` subquery:

```sql
       (SELECT dd.ambient_temperature FROM device_data dd WHERE dd.deveui = d.deveui AND dd.ambient_temperature IS NOT NULL ORDER BY dd.recorded_at DESC LIMIT 1) AS enclosure_temperature_c,
       (SELECT dd.relative_humidity FROM device_data dd WHERE dd.deveui = d.deveui AND dd.relative_humidity IS NOT NULL ORDER BY dd.recorded_at DESC LIMIT 1) AS enclosure_humidity_pct,
       (SELECT MAX(dd.recorded_at) FROM device_data dd WHERE dd.deveui = d.deveui AND (dd.ambient_temperature IS NOT NULL OR dd.relative_humidity IS NOT NULL)) AS enclosure_measured_at,
```

Note the two readings are selected independently: a valve can legitimately report one and not the other, and pinning both to a single row would discard the other. `enclosure_measured_at` is the newest row carrying either.

- [ ] **Step 4: Carry them through the API**

In `api.js`, in the object that shapes each valve for the response (the same place `strega_generation` is mapped, around line 121), add the three fields, passing `null` through unchanged. Do not round, clamp, or default here — `strega-process-fn` already normalised the values on the way in, and a second normalisation is a second place for the rules to drift.

- [ ] **Step 5: Run the tests and the module gates**

```bash
cd conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control && node --test; echo "exit=$?"
cd /home/phil/Repos/osi-os
diff -rq conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control \
         conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-valve-control; echo "mirror exit=$?"
for s in scripts/verify-helper-registration.js scripts/verify-sync-flow.js scripts/test-strega-gen2-reconcile.js; do node "$s" >/dev/null 2>&1; echo "$(basename $s) exit=$?"; done
```
Expected: every line exit=0.

- [ ] **Step 6: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-valve-control
git commit -m "feat(valves): expose the stored enclosure temperature and humidity"
```

---

### Task 2: Show the reading, and say plainly when there is none

**Files:**
- Modify: `web/react-gui/src/types/farming.ts`, `web/react-gui/src/services/api.ts`
- Modify: `web/react-gui/src/components/farming/valves/ValveTile.tsx`
- Modify: `web/react-gui/public/locales/{en,de-CH,fr,es,it,lg,pt}/valves.json` (enumerate the real directories with `ls` first)
- Test: `web/react-gui/src/components/farming/valves/__tests__/`, in its established harness

**Interfaces:**
- Consumes: `enclosure_temperature_c`, `enclosure_humidity_pct`, `enclosure_measured_at` from Task 1.

- [ ] **Step 1: Write the failing component tests**

Four cases, because there are four genuinely different states and the whole point of this task is telling them apart:

```tsx
it('shows the enclosure reading when a Gen1 valve has reported one', () => {
  render(<ValveTile {...props({ stregaGeneration: 'GEN1', enclosureTemperatureC: 21.5, enclosureHumidityPct: 48.2 })} />);
  expect(screen.getByText(/21[.,]5/)).toBeInTheDocument();
  expect(screen.getByText(/48/)).toBeInTheDocument();
});

it('renders a measured zero rather than treating it as missing', () => {
  render(<ValveTile {...props({ stregaGeneration: 'GEN1', enclosureTemperatureC: 0, enclosureHumidityPct: 0 })} />);
  expect(screen.getByText(/0/)).toBeInTheDocument();
});

it('says the reading is unavailable for a Gen1 valve that has not reported it', () => {
  render(<ValveTile {...props({ stregaGeneration: 'GEN1', enclosureTemperatureC: null, enclosureHumidityPct: null })} />);
  expect(screen.getByText(/no reading|kein Messwert|aucune mesure/i)).toBeInTheDocument();
});

it('says a Gen2 valve does not measure it, and never shows a number', () => {
  render(<ValveTile {...props({ stregaGeneration: 'GEN2', enclosureTemperatureC: null, enclosureHumidityPct: null })} />);
  expect(screen.getByText(/not measured|misst|ne mesure/i)).toBeInTheDocument();
});
```

The measured-zero case is the one that catches a `||` fallback: 0 °C is a real winter reading and 0 % is a real (if unlikely) humidity. Match the real prop names from the component.

- [ ] **Step 2: Run them and watch them fail**

```bash
cd web/react-gui && npx vitest run src/components/farming/valves --silent; echo "exit=$?"
```
Expected: exit=1.

- [ ] **Step 3: Extend the types and the normaliser**

In `types/farming.ts`, add to the valve summary type:

```ts
  enclosureTemperatureC: number | null;
  enclosureHumidityPct: number | null;
  enclosureMeasuredAt: string | null;
```

In `services/api.ts`, map them in `normaliseValveSummary` using an explicit null/undefined check, never `||` or `??`-into-a-number — a measured `0` must survive:

```ts
    enclosureTemperatureC: row?.enclosure_temperature_c ?? null,
    enclosureHumidityPct: row?.enclosure_humidity_pct ?? null,
    enclosureMeasuredAt: row?.enclosure_measured_at ?? null,
```

(`??` is correct here: it passes `0` through and only replaces `null`/`undefined`.)

- [ ] **Step 4: Render the four states in `ValveTile`**

Match the tile's existing typography and the ≥44 px touch-target conventions; this is a read-only line, so it needs no interactive sizing. The branch order matters:

```tsx
const climate =
  valve.stregaGeneration === 'GEN2'
    ? t('tile.enclosureNotMeasured')
    : valve.enclosureTemperatureC == null && valve.enclosureHumidityPct == null
      ? t('tile.enclosureNoReading')
      : [
          valve.enclosureTemperatureC != null ? t('tile.enclosureTemp', { value: valve.enclosureTemperatureC }) : null,
          valve.enclosureHumidityPct != null ? t('tile.enclosureHumidity', { value: valve.enclosureHumidityPct }) : null,
        ].filter(Boolean).join(' · ');
```

Gen2 is checked first and unconditionally: even if a Gen2 valve somehow carried a stored value from a mis-registration, the honest statement is that this hardware does not measure it.

- [ ] **Step 5: Add the locale keys in every directory**

English:

```json
"tile": {
  "enclosureTemp": "{{value}} °C in the housing",
  "enclosureHumidity": "{{value}} % humidity",
  "enclosureNoReading": "No housing reading yet",
  "enclosureNotMeasured": "Gen2 valves do not measure housing climate"
}
```

de-CH (no ß):

```json
"enclosureTemp": "{{value}} °C im Gehäuse",
"enclosureHumidity": "{{value}} % Feuchte",
"enclosureNoReading": "Noch kein Messwert aus dem Gehäuse",
"enclosureNotMeasured": "Gen2-Ventile messen das Gehäuseklima nicht"
```

French (vouvoiement, *vanne*/*boîtier*):

```json
"enclosureTemp": "{{value}} °C dans le boîtier",
"enclosureHumidity": "{{value}} % d'humidité",
"enclosureNoReading": "Pas encore de mesure dans le boîtier",
"enclosureNotMeasured": "Les vannes Gen2 ne mesurent pas le climat du boîtier"
```

`es`, `it`, `lg`, `pt` mirror English, consistent with how this namespace already handles untranslated keys (osi-os#168). Merge into the existing `tile` object if one exists; never create a duplicate key.

- [ ] **Step 6: Verify**

```bash
cd web/react-gui
npx vitest run src/components/farming/valves --silent; echo "vitest exit=$?"
npm run typecheck; echo "typecheck exit=$?"
npm run test:unit; echo "test:unit exit=$?"
```
Expected: all exit=0, the full suite still green (≥714 tests plus your four).

- [ ] **Step 7: Commit**

```bash
cd /home/phil/Repos/osi-os
git add web/react-gui/src web/react-gui/public/locales
git commit -m "feat(valves): show enclosure climate, and say when the hardware cannot measure it"
```

---

### Task 3: Write down what the hardware does and does not measure

**Files:**
- Modify: `.claude/skills/osi-agronomy-sensors-reference/SKILL.md` (STREGA section)
- Modify: `docs/architecture/system-map-technical/03-edge-backend-flows.md`, `docs/architecture/system-map/03-edge-backend-flows.md`

- [ ] **Step 1: Record the generational split in the sensor reference**

State: Gen1 reports enclosure temperature and humidity, derived from two 16-bit fields as `(v/65536)*165-40` and `(v/65536)*100`, and the pair 125 °C / 100 % is the vendor's "no sensor fitted" sentinel which the edge stores as null. State that Gen2 (SV2) reports neither, citing the manual's payload format (3 bytes battery millivolts plus one info-status byte, optional counter) and its "Data Read" specification list. State that the measurement is enclosure climate — the vendor's own `box_temp`/`box_hum` — and must not be used as zone air temperature or fed into agronomy calculations.

- [ ] **Step 2: Update both system maps**

Add one line to the Valve Control section of each: the valve list exposes the enclosure reading for Gen1 valves, and the interface states explicitly that Gen2 does not measure it.

- [ ] **Step 3: Run the prose gate**

```bash
cd /home/phil/Repos/osi-os
node .claude/skills/anti-slop-writing/slop-check.js \
  .claude/skills/osi-agronomy-sensors-reference/SKILL.md \
  docs/architecture/system-map-technical/03-edge-backend-flows.md \
  docs/architecture/system-map/03-edge-backend-flows.md; echo "exit=$?"
```
Expected: `slop-check: PASS`, exit=0.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/osi-agronomy-sensors-reference/SKILL.md docs/architecture
git commit -m "docs: STREGA enclosure climate is Gen1-only, and what it is not"
```

---

## Deferred, deliberately

- **History charts for the enclosure reading.** `isEnvironmentSource` in `osi-history-helper` already has a value-based fallback that a valve carrying these numbers would satisfy, so a valve may appear as an environment source once real data arrives. Whether that is wanted — a housing thermometer sitting beside field weather stations in the same chart — is a product decision, and it should be made against live data rather than guessed at now.
- **The cloud mirror.** `device_data` rows already sync, so the values reach the cloud today; whether AgroLink surfaces them is separate work.
- **Any Gen2 temperature or humidity.** Not deferred — impossible. The hardware does not measure it.
