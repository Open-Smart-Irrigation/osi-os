# Daily Agronomy Parity E2b: Stage Start Date GUI and Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The edge GUI shows the stage start date in the zone settings (pre-filled with today on a stage change, editable, emptied for "Not set") and three new Water tab lines: the FAO-56 curve source, the stage-overrun line and the lines of a shared-mode day OSI Cloud computed. The eleven texts are the cloud's translations, embedded from the cloud plans and checked against the cloud's bundles.

**Architecture:** Plan E2a delivered the backend: the zone route stores and returns `stage_started_on`, and `osi-zone-env` gives each water day `stageOverrun` and `demandComputedBy`. This plan changes only `web/react-gui` (the `IrrigationZone` type, `normaliseZone`, `ZoneConfigModal`, `WaterDay`, `WaterTab`), the seven `devices.json` bundles, the Luganda ledger and one cross-repo text check. The eleven texts come verbatim from plan CB Task 8 (`zoneConfigModal.stageStartedOn.*`) and plan CC2 Task 3 (`OWN`), written into this plan, so it needs no cloud checkout at run time (controller ruling on the edge plan review); `scripts/test-shared-agronomy-locales.js` compares them with the cloud's bundles whenever `OSI_SERVER_ROOT` names an osi-server checkout, locally and in `migrations.yml`.

**Tech Stack:** React + TypeScript + vitest + i18next (seven locales), `tsx --test`, Node.js 22 (`node:test`).

**Spec:** `docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md` (B5 GUI bullet, B9, C10's cloud-only texts "added on the edge too for shared mode", E row "E2").

**Prerequisites (check before Task 1):**

1. Plan E2a is done on this branch: `grep -c "stage_started_on: r.stage_started_on || null" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` prints `1`, and `osi-zone-env`'s `DEMAND_FIELDS` names `stageOverrun` and `demandComputedBy`.
2. Sub-project 3's Task 8 is in the base (the zone settings weather provider selector): `grep -A1 "weatherSource?: string;" web/react-gui/src/services/api.ts | grep -c "Promise<IrrigationZone>"` prints `1`. The GUI anchors below are written against that state (plan review E2-E4 I1).
3. `npm ci` has run once in `web/react-gui` (it installs and does not build).
4. Only the text check of Task 1 Step 4 and Task 3 reads the cloud, and only when `OSI_SERVER_ROOT` is set. It passes once plans CB and CC2 have written their texts on osi-server `feat/daily-agronomy-parity`; the adopted execution order runs both before this plan.

## Global Constraints

From the spec, verbatim:

- "GUI explanations in tooltips only; new strings in seven locales, `lg` in English and listed in `docs/i18n/pending-luganda-translations.md`".
- B5: "When the user picks a different stage, the input is pre-filled with today's date in the browser's local time, and stays editable (ruling R5); when the stage is set to "Not set" the input is emptied." "sent only when it differs from the stored value."
- B9: "No day number is shown (spec decision)."
- The texts: one translation per key across the two GUIs (controller ruling, plan review CC M5); the cloud plans author them, this plan embeds them, and the parity test keeps them equal (controller ruling on the edge plan review).

Operational rules:

- Work only in `<osi-os>/.worktrees/daily-agronomy-parity`; every command runs from its root unless a step says otherwise. Never `cd` into `<osi-os>` or `<osi-server>`. Never bare `git stash`. Never push. Commits use `git -c user.name=Project-OSI commit`.
- `$SCRATCH` is the session scratchpad; one-shot scripts live there and are never committed.
- GUI gates: `npm run typecheck` and `npm run test:unit` in `web/react-gui`, single files through `npx vitest run <file>` or `npx tsx --test <file>`. Never `npm run build`: the workstation runs out of memory.
- Pin the test counts the runner prints.
- Prose passes `node .claude/skills/anti-slop-writing/slop-check.js`.

## Review Focus

1. **A stage change late in the evening.** The pre-fill is the browser's local date, not the UTC date: at 23:30 local time on 21 May the field reads `2026-05-21`. Pinned in Task 1 ("pre-fills today on a stage change …", fake clock).
2. **A save that changes only the notes.** The date is not sent, so the server keeps it. Pinned in Task 1 ("sends the start date only when it changed").
3. **A crop without a Table 11 length for the stage** (`grass` late season). The HelpTip leaves out the length instead of printing "(null days)". Pinned in Task 1 ("names the typical stage length in the HelpTip, and leaves it out …").
4. **Shared mode with a cloud day for a date the gateway has no demand for.** The day shows "OSI Cloud applies the crop coefficient" and the accuracy note; a gateway day shows neither. Pinned in Task 2 ("marks a shared-mode day OSI Cloud computed …", "shows neither cloud line on a day the gateway computed").
5. **A later text fix on one side only.** The shared-texts check fails until both sides agree. Pinned in Task 1 Step 4 and Task 3 (`test-shared-agronomy-locales.js` with `OSI_SERVER_ROOT`).

## File Map

| File | Change | Task |
|---|---|---|
| `web/react-gui/src/types/farming.ts`, `src/services/api.ts`, `src/components/farming/ZoneConfigModal.tsx` and its test, `public/locales/*/devices.json`, `tests/zoneFormLocales.test.ts`, `tests/waterCardLocales.test.ts`, `docs/i18n/pending-luganda-translations.md` | the date field and the eleven texts | 1 |
| `scripts/test-shared-agronomy-locales.js` (new), `.github/workflows/migrations.yml` | the cross-repo text check | 1 |
| `web/react-gui/src/types/farming.ts` (`WaterDay`), `src/components/farming/environment/WaterTab.tsx` and its trend test | the three tooltip lines | 2 |
| `docs/superpowers/plans/2026-09-27-daily-agronomy-parity-edge-execution-report.md` | the E2b section | 3 |

---

### Task 1: The stage start date in the zone settings (GUI)

**Files:**
- Modify: `web/react-gui/src/types/farming.ts` (`IrrigationZone`), `src/services/api.ts` (`normaliseZone`, `updateConfig` payload type), `src/components/farming/ZoneConfigModal.tsx`, `src/components/farming/__tests__/ZoneConfigModal.test.tsx`, the seven `public/locales/*/devices.json`, `tests/zoneFormLocales.test.ts`, `tests/waterCardLocales.test.ts`, `docs/i18n/pending-luganda-translations.md`, `.github/workflows/migrations.yml`
- Create: `scripts/test-shared-agronomy-locales.js`
- Scratch: `$SCRATCH/gui-zone-settings.py`, `$SCRATCH/stage-date-locales.js`, `$SCRATCH/luganda-doc.py`

Paths below are relative to `web/react-gui/` unless they start with `docs/`.

**Interfaces:**
- Consumes: `stage_started_on` on `GET /api/irrigation-zones` rows and `PUT …/config` accepting `stageStartedOn` (plan E2a Task 2); `stageLengths(cropId)` (plan E1).
- Produces: `IrrigationZone.stage_started_on?`, `stageStartedOn?: string | null`; `normaliseZone` maps `stageStartedOn: z.stageStartedOn ?? z.stage_started_on ?? null`; the `updateConfig` payload type gains `stageStartedOn?: string | null`; `ZoneConfigModal.tsx` exports `localTodayIso(now?: Date): string`; four `zoneConfig.*` keys and seven `environment.water.*` keys in seven bundles (Task 2 renders the water keys); `scripts/test-shared-agronomy-locales.js`, which compares those eleven texts with the cloud's when `OSI_SERVER_ROOT` is set.

- [ ] **Step 1: Write the failing tests**

In `src/components/farming/__tests__/ZoneConfigModal.test.tsx`: the testing-library import stays as sub-project 3 left it (`import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';` already imports `cleanup`), the modal import becomes `import { ZoneConfigModal, localTodayIso } from '../ZoneConfigModal';`, and in the test `'writes the FAO key when the user picks a stage, and labels stages by crop family'` the last line becomes
```tsx
    // Another stage starts today unless the user edits the pre-filled date.
    await waitFor(() => expect(irrigationZonesAPI.updateConfig).toHaveBeenCalledWith(42, { phenologicalStage: 'late_season', stageStartedOn: localTodayIso() }));
```
Then append inside the `describe`:
```tsx

  it('keeps the stage start date input disabled until a stage is chosen', () => {
    render(React.createElement(ZoneConfigModal, { isOpen: true, zone: { ...zone, cropType: 'maize' }, onClose: vi.fn(), onSaved: vi.fn() }));
    const startedOn = screen.getByLabelText('Stage started on') as HTMLInputElement;
    expect(startedOn.type).toBe('date');
    expect(startedOn).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Phenological stage'), { target: { value: 'development' } });
    expect(startedOn).not.toBeDisabled();
  });

  it('pre-fills today on a stage change, keeps the field editable and sends the edited date', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2026, 4, 21, 23, 30));
      render(React.createElement(ZoneConfigModal, { isOpen: true, zone: { ...zone, cropType: 'maize', phenologicalStage: 'initial', stageStartedOn: '2026-04-10' }, onClose: vi.fn(), onSaved: vi.fn() }));
      fireEvent.change(screen.getByLabelText('Phenological stage'), { target: { value: 'development' } });
      const startedOn = screen.getByLabelText('Stage started on') as HTMLInputElement;
      expect(startedOn.value).toBe('2026-05-21');
      fireEvent.change(startedOn, { target: { value: '2026-05-18' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(irrigationZonesAPI.updateConfig).toHaveBeenCalledWith(42, { phenologicalStage: 'development', stageStartedOn: '2026-05-18' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('empties the date when the stage is set to Not set, and sends the clear', async () => {
    render(React.createElement(ZoneConfigModal, { isOpen: true, zone: { ...zone, cropType: 'maize', phenologicalStage: 'late_season', stageStartedOn: '2026-08-01' }, onClose: vi.fn(), onSaved: vi.fn() }));
    fireEvent.change(screen.getByLabelText('Phenological stage'), { target: { value: '' } });
    expect((screen.getByLabelText('Stage started on') as HTMLInputElement).value).toBe('');
    expect(screen.getByLabelText('Stage started on')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(irrigationZonesAPI.updateConfig).toHaveBeenCalledWith(42, { phenologicalStage: 'default', stageStartedOn: null }));
  });

  it('sends the start date only when it changed', async () => {
    render(React.createElement(ZoneConfigModal, { isOpen: true, zone: { ...zone, cropType: 'maize', phenologicalStage: 'development', stageStartedOn: '2026-05-01' }, onClose: vi.fn(), onSaved: vi.fn() }));
    expect((screen.getByLabelText('Stage started on') as HTMLInputElement).value).toBe('2026-05-01');
    fireEvent.change(screen.getByPlaceholderText('Any additional info about this zone…'), { target: { value: 'n' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(irrigationZonesAPI.updateConfig).toHaveBeenCalledWith(42, { notes: 'n' }));
  });

  it('names the typical stage length in the HelpTip, and leaves it out when the crop has none for the stage', () => {
    render(React.createElement(ZoneConfigModal, { isOpen: true, zone: { ...zone, cropType: 'maize', phenologicalStage: 'development' }, onClose: vi.fn(), onSaved: vi.fn() }));
    fireEvent.click(screen.getByRole('button', { name: 'About the stage start date' }));
    expect(screen.getByText(/after the typical length for this crop \(40 days\) Kc stays at the stage's end value/)).toBeInTheDocument();
    cleanup();
    render(React.createElement(ZoneConfigModal, { isOpen: true, zone: { ...zone, cropType: 'grass', phenologicalStage: 'late_season' }, onClose: vi.fn(), onSaved: vi.fn() }));
    fireEvent.click(screen.getByRole('button', { name: 'About the stage start date' }));
    expect(screen.getByText(/after the typical length for this crop Kc stays at the stage's end value/)).toBeInTheDocument();
    expect(screen.queryByText(/days\)/)).not.toBeInTheDocument();
  });
```

In `tests/zoneFormLocales.test.ts`, append to `KEYS` (after its last entry):
```ts
  // Daily agronomy parity (plan E2b): the stage start date of the FAO-56 Kc curve.
  'zoneConfig.stageStartedOn',
  'zoneConfig.stageStartedOnHelpLabel',
  'zoneConfig.stageStartedOnHelp',
  'zoneConfig.stageStartedOnHelpNoLength',
```
In `tests/waterCardLocales.test.ts`, append to `DEVICES_KEYS` (after `'environment.water.kcSourceByCrop',`):
```ts
  // Daily agronomy parity (plan E2b): the FAO-56 curve, the overrun flag and a
  // shared-mode day OSI Cloud computed; the values are the cloud's translations.
  'environment.water.kcSource.fao56_curve',
  'environment.water.stageOverrun',
  'environment.water.et0Tier.open_meteo_daily',
  'environment.water.computedBy.edge',
  'environment.water.computedBy.cloud',
  'environment.water.modelAccuracyNote',
  'environment.water.meteoswissCloudNote',
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `(cd web/react-gui && npx vitest run src/components/farming/__tests__/ZoneConfigModal.test.tsx; npx tsx --test tests/zoneFormLocales.test.ts tests/waterCardLocales.test.ts)`
Expected: the modal file `Tests  6 failed | 14 passed (20)` (the five new tests and the changed stage test: vitest imports the missing `localTodayIso` as `undefined`, and the field does not exist yet); the two locale tests `# fail 8`, `# pass 2`, the first messages `en devices.json missing zoneConfig.stageStartedOn` and `en devices.json missing environment.water.kcSource.fao56_curve`.

- [ ] **Step 3: Types, the API normaliser and the modal**

`$SCRATCH/gui-zone-settings.py`:
```python
# One-shot (plan E2b, Task 1): the stage start date in the zone settings (the
# IrrigationZone type, the API normaliser, ZoneConfigModal). Paths relative to web/react-gui/.
# Every file's anchors are checked in memory first; nothing is written unless all match,
# so a failed run leaves the tree unchanged and can simply be re-run.
import pathlib
PLANNED = []
def patch(path, swaps):
    p = pathlib.Path(path)
    s = p.read_text(encoding="utf-8")
    for old, new in swaps:
        if s.count(old) != 1:
            raise SystemExit(f"{path}: expected one match for: {old[:80]} (nothing written)")
        s = s.replace(old, new)
    PLANNED.append((p, s))

patch("src/types/farming.ts", [
    ("  prediction_card_enabled?: boolean | null;\n",
     "  prediction_card_enabled?: boolean | null;\n"
     "  /** YYYY-MM-DD: the day the current growth stage began (FAO-56 Kc curve), or null. */\n"
     "  stage_started_on?: string | null;\n"),
    ("  // Compat aliases (server uses camelCase)\n",
     "  // Compat aliases (server uses camelCase)\n"
     "  stageStartedOn?: string | null;\n"),
])

patch("src/services/api.ts", [
    ("    calibrationKey:    z.calibrationKey    ?? z.calibration_key    ?? null,\n",
     "    calibrationKey:    z.calibrationKey    ?? z.calibration_key    ?? null,\n"
     "    stageStartedOn:    z.stageStartedOn    ?? z.stage_started_on   ?? null,\n"),
    # Sub-project 3 Task 8 ends the updateConfig payload type with weatherSource (plan review
    # E2-E4 I1); the anchor is that line, so the field goes last.
    ("    weatherSource?: string;\n  }): Promise<IrrigationZone> => {",
     "    weatherSource?: string;\n    stageStartedOn?: string | null;\n  }): Promise<IrrigationZone> => {"),
])

patch("src/components/farming/ZoneConfigModal.tsx", [
    ("  formCropValue,\n  normalizeStage,\n} from '../../agronomy/cropKc';",
     "  formCropValue,\n  normalizeStage,\n  stageLengths,\n  type StageId,\n} from '../../agronomy/cropKc';"),
    # Two swaps below anchor on "interface Props {": this first one inserts localTodayIso
    # before it and keeps exactly one occurrence, so the last swap still matches once.
    ("interface Props {\n",
     "/** Today in the browser's local time as YYYY-MM-DD (the stage start date pre-fill). */\n"
     "export function localTodayIso(now: Date = new Date()): string {\n"
     "  const pad = (n: number) => String(n).padStart(2, '0');\n"
     "  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;\n"
     "}\n\n"
     "interface Props {\n"),
    ("  const [phenologicalStage, setPhenologicalStage] = useState<string>(normalizeStage(zone.phenologicalStage) ?? '');\n",
     "  const [phenologicalStage, setPhenologicalStage] = useState<string>(normalizeStage(zone.phenologicalStage) ?? '');\n"
     "  const [stageStartedOn, setStageStartedOn] = useState(zone.stageStartedOn ?? '');\n"),
    ("    setPhenologicalStage(normalizeStage(zone.phenologicalStage) ?? '');\n    setCalibrationKey",
     "    setPhenologicalStage(normalizeStage(zone.phenologicalStage) ?? '');\n    setStageStartedOn(zone.stageStartedOn ?? '');\n    setCalibrationKey"),
    ("      phenologicalStage?: string | null;\n      calibrationKey?: string | null;\n",
     "      phenologicalStage?: string | null;\n      stageStartedOn?: string | null;\n      calibrationKey?: string | null;\n"),
    ("    if ((normalizeStage(zone.phenologicalStage) ?? '') !== phenologicalStage) payload.phenologicalStage = phenologicalStage || 'default';\n",
     "    if ((normalizeStage(zone.phenologicalStage) ?? '') !== phenologicalStage) payload.phenologicalStage = phenologicalStage || 'default';\n"
     "    // Sent only when it differs from the stored date; empty clears it.\n"
     "    if ((zone.stageStartedOn ?? '') !== stageStartedOn) payload.stageStartedOn = stageStartedOn || null;\n"),
    ("              value={phenologicalStage}\n              onChange={e => setPhenologicalStage(e.target.value)}\n",
     "              value={phenologicalStage}\n"
     "              onChange={e => {\n"
     "                const next = e.target.value;\n"
     "                // Another stage starts today unless the user says otherwise; \"Not set\" has no start date.\n"
     "                if (!next) setStageStartedOn('');\n"
     "                else if (next !== phenologicalStage) setStageStartedOn(localTodayIso());\n"
     "                setPhenologicalStage(next);\n"
     "              }}\n"),
    ("""              {STAGES.map(stage => (
                <option key={stage} value={stage}>{stageOptionLabel(t, cropType, stage)}</option>
              ))}
            </select>
          </div>
""", """              {STAGES.map(stage => (
                <option key={stage} value={stage}>{stageOptionLabel(t, cropType, stage)}</option>
              ))}
            </select>
          </div>

          {/* Stage start date: FAO-56 Kc curve (spec 2026-09-27-daily-agronomy-parity B5) */}
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <label htmlFor={id('stageStartedOn')} className="block text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wide">
                {t('zoneConfig.stageStartedOn', { defaultValue: 'Stage started on' })}
              </label>
              <HelpTip label={t('zoneConfig.stageStartedOnHelpLabel', { defaultValue: 'About the stage start date' })}>
                {stageLengthDays != null
                  ? t('zoneConfig.stageStartedOnHelp', { days: stageLengthDays, defaultValue: STAGE_STARTED_ON_HELP })
                  : t('zoneConfig.stageStartedOnHelpNoLength', { defaultValue: STAGE_STARTED_ON_HELP.replace(' ({{days}} days)', '') })}
              </HelpTip>
            </div>
            <input
              id={id('stageStartedOn')}
              type="date"
              value={stageStartedOn}
              disabled={!phenologicalStage}
              onChange={e => setStageStartedOn(e.target.value)}
              className="w-full bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] rounded-lg px-3 py-2 text-sm disabled:opacity-50"
            />
          </div>
"""),
    ("  const canRequestDeviceLocation = Boolean(",
     "  const stageLengthDays = phenologicalStage && phenologicalStage !== 'dormancy'\n"
     "    ? stageLengths(cropType)?.[phenologicalStage as Exclude<StageId, 'dormancy'>] ?? null\n"
     "    : null;\n\n"
     "  const canRequestDeviceLocation = Boolean("),
    ("interface Props {\n",
     "const STAGE_STARTED_ON_HELP = \"The date the current stage began (day 1). In the development and late-season stages Kc moves along the FAO-56 curve from this date; in the other stages it stays at the stage's value. The stage never advances by itself: after the typical length for this crop ({{days}} days) Kc stays at the stage's end value until you choose the next stage. After leaf fall or harvest choose Dormancy (Kc 0.25, bare soil); in spring choose Initial with the green-up date. Changes to crop, stage or start date apply to days calculated after the change. Leave empty to use the stage's table value.\";\n\n"
     "interface Props {\n"),
])
for p, s in PLANNED:
    p.write_text(s, encoding="utf-8")
print("stage start date in types, api.ts and ZoneConfigModal.tsx")
```
Run: `(cd web/react-gui && python3 "$SCRATCH/gui-zone-settings.py")`. Expected: `stage start date in types, api.ts and ZoneConfigModal.tsx`. The anchors were written against the files as sub-project 3's Task 8 leaves them (`api.ts` ends the payload type with `weatherSource?: string;`) and checked on the rebased branch (3a918101c on sub-project 3's 719c4ce29): each matches once. The script writes nothing when one fails. The field sits directly under the stage select: a label row with a `HelpTip`, then a native date input, disabled while the stage is "Not set". No caption, note or banner. The HelpTip reads `zoneConfig.stageStartedOnHelp` with `{{days}}` from `stageLengths(crop)[stage]`, or `zoneConfig.stageStartedOnHelpNoLength` when the crop has no length for the stage (dormancy included).

- [ ] **Step 4: The locale keys, the cloud's texts embedded**

`$SCRATCH/stage-date-locales.js`:
```js
// One-shot (plan E2b, Task 1): the stage start date and Water tab keys in the seven edge
// devices.json bundles. The values are the cloud's own translations, copied verbatim from the
// plan texts that write them on osi-server: plan CB Task 8 (zoneConfigModal.stageStartedOn.*)
// and plan CC2 Task 3's OWN table (environment.water.*), so the two GUIs carry one translation
// of each key (controller rulings, plan review CC M5 and the edge plan review) and this plan
// needs no cloud checkout. lg carries the English text (edge lg policy).
// scripts/test-shared-agronomy-locales.js compares the result with the cloud's bundles.
'use strict';
const fs = require('fs');
const path = require('path');
const EDGE_LOCALES = 'web/react-gui/public/locales';
// Edge key -> text per locale. The cloud keys: zoneConfigModal.stageStartedOn.{label,
// helpLabel, help, helpNoLength} for the four zoneConfig.* keys, the same names for the seven
// environment.water.* keys.
const TEXTS = {
  "zoneConfig.stageStartedOn": {
    "en": "Stage started on",
    "de-CH": "Phase begonnen am",
    "fr": "Début du stade",
    "it": "Inizio della fase",
    "es": "Inicio de la etapa",
    "pt": "Início da fase"
  },
  "zoneConfig.stageStartedOnHelpLabel": {
    "en": "About the stage start date",
    "de-CH": "Info zum Startdatum der Phase",
    "fr": "À propos de la date de début du stade",
    "it": "Informazioni sulla data di inizio della fase",
    "es": "Acerca de la fecha de inicio de la etapa",
    "pt": "Sobre a data de início da fase"
  },
  "zoneConfig.stageStartedOnHelp": {
    "en": "The date the current stage began (day 1). In the development and late-season stages Kc moves along the FAO-56 curve from this date; in the other stages it stays at the stage's value. The stage never advances by itself: after the typical length for this crop ({{days}} days) Kc stays at the stage's end value until you choose the next stage. After leaf fall or harvest choose Dormancy (Kc 0.25, bare soil); in spring choose Initial with the green-up date. Changes to crop, stage or start date apply to days calculated after the change. Leave empty to use the stage's table value.",
    "de-CH": "Das Datum, an dem die aktuelle Phase begonnen hat (Tag 1). In der Entwicklungsphase und in der Spätphase folgt Kc ab diesem Datum der FAO-56-Kurve; in den anderen Phasen bleibt er beim Wert der Phase. Die Phase wechselt nie von selbst: Nach der typischen Dauer für diese Kultur ({{days}} Tage) bleibt Kc beim Endwert der Phase, bis Sie die nächste Phase wählen. Wählen Sie nach dem Laubfall oder der Ernte die Ruhephase (Kc 0,25, offener Boden); wählen Sie im Frühling die Anfangsphase mit dem Datum des Austriebs. Änderungen an Kultur, Phase oder Startdatum gelten für Tage, die nach der Änderung berechnet werden. Leer lassen, um den Tabellenwert der Phase zu verwenden.",
    "fr": "La date à laquelle le stade actuel a commencé (jour 1). Aux stades de développement et d’arrière-saison, le Kc suit la courbe FAO-56 à partir de cette date ; aux autres stades, il garde la valeur du stade. Le stade ne change jamais de lui-même : après la durée typique pour cette culture ({{days}} jours), le Kc reste à la valeur de fin du stade jusqu’à ce que vous choisissiez le stade suivant. Après la chute des feuilles ou la récolte, choisissez Dormance (Kc 0,25, sol nu) ; au printemps, choisissez Phase initiale avec la date du débourrement. Les changements de culture, de stade ou de date de début s’appliquent aux jours calculés après le changement. Laissez vide pour utiliser la valeur du tableau pour ce stade.",
    "it": "La data in cui è iniziata la fase attuale (giorno 1). Nella fase di sviluppo e nella fase finale il Kc segue la curva FAO-56 a partire da questa data; nelle altre fasi resta al valore della fase. La fase non avanza mai da sola: dopo la durata tipica per questa coltura ({{days}} giorni) il Kc resta al valore finale della fase finché non scegli la fase successiva. Dopo la caduta delle foglie o la raccolta scegli Dormienza (Kc 0,25, suolo nudo); in primavera scegli Fase iniziale con la data del germogliamento. Le modifiche a coltura, fase o data di inizio valgono per i giorni calcolati dopo la modifica. Lascia vuoto per usare il valore di tabella della fase.",
    "es": "La fecha en que comenzó la etapa actual (día 1). En las etapas de desarrollo y final de temporada, el Kc sigue la curva FAO-56 a partir de esta fecha; en las demás etapas se mantiene en el valor de la etapa. La etapa nunca avanza por sí sola: tras la duración típica para este cultivo ({{days}} días), el Kc se queda en el valor final de la etapa hasta que elija la etapa siguiente. Tras la caída de las hojas o la cosecha, elija Reposo (Kc 0,25, suelo desnudo); en primavera, elija Etapa inicial con la fecha de brotación. Los cambios de cultivo, etapa o fecha de inicio se aplican a los días calculados después del cambio. Déjelo vacío para usar el valor de tabla de la etapa.",
    "pt": "A data em que a fase atual começou (dia 1). Nas fases de desenvolvimento e final, o Kc segue a curva FAO-56 a partir desta data; nas outras fases mantém o valor da fase. A fase nunca avança sozinha: após a duração típica para esta cultura ({{days}} dias), o Kc fica no valor final da fase até escolher a fase seguinte. Após a queda das folhas ou a colheita, escolha Dormência (Kc 0,25, solo nu); na primavera, escolha Fase inicial com a data do abrolhamento. As alterações de cultura, fase ou data de início aplicam-se aos dias calculados depois da alteração. Deixe vazio para usar o valor da tabela para a fase."
  },
  "zoneConfig.stageStartedOnHelpNoLength": {
    "en": "The date the current stage began (day 1). In the development and late-season stages Kc moves along the FAO-56 curve from this date; in the other stages it stays at the stage's value. The stage never advances by itself: after the typical length for this crop Kc stays at the stage's end value until you choose the next stage. After leaf fall or harvest choose Dormancy (Kc 0.25, bare soil); in spring choose Initial with the green-up date. Changes to crop, stage or start date apply to days calculated after the change. Leave empty to use the stage's table value.",
    "de-CH": "Das Datum, an dem die aktuelle Phase begonnen hat (Tag 1). In der Entwicklungsphase und in der Spätphase folgt Kc ab diesem Datum der FAO-56-Kurve; in den anderen Phasen bleibt er beim Wert der Phase. Die Phase wechselt nie von selbst: Nach der typischen Dauer für diese Kultur bleibt Kc beim Endwert der Phase, bis Sie die nächste Phase wählen. Wählen Sie nach dem Laubfall oder der Ernte die Ruhephase (Kc 0,25, offener Boden); wählen Sie im Frühling die Anfangsphase mit dem Datum des Austriebs. Änderungen an Kultur, Phase oder Startdatum gelten für Tage, die nach der Änderung berechnet werden. Leer lassen, um den Tabellenwert der Phase zu verwenden.",
    "fr": "La date à laquelle le stade actuel a commencé (jour 1). Aux stades de développement et d’arrière-saison, le Kc suit la courbe FAO-56 à partir de cette date ; aux autres stades, il garde la valeur du stade. Le stade ne change jamais de lui-même : après la durée typique pour cette culture, le Kc reste à la valeur de fin du stade jusqu’à ce que vous choisissiez le stade suivant. Après la chute des feuilles ou la récolte, choisissez Dormance (Kc 0,25, sol nu) ; au printemps, choisissez Phase initiale avec la date du débourrement. Les changements de culture, de stade ou de date de début s’appliquent aux jours calculés après le changement. Laissez vide pour utiliser la valeur du tableau pour ce stade.",
    "it": "La data in cui è iniziata la fase attuale (giorno 1). Nella fase di sviluppo e nella fase finale il Kc segue la curva FAO-56 a partire da questa data; nelle altre fasi resta al valore della fase. La fase non avanza mai da sola: dopo la durata tipica per questa coltura il Kc resta al valore finale della fase finché non scegli la fase successiva. Dopo la caduta delle foglie o la raccolta scegli Dormienza (Kc 0,25, suolo nudo); in primavera scegli Fase iniziale con la data del germogliamento. Le modifiche a coltura, fase o data di inizio valgono per i giorni calcolati dopo la modifica. Lascia vuoto per usare il valore di tabella della fase.",
    "es": "La fecha en que comenzó la etapa actual (día 1). En las etapas de desarrollo y final de temporada, el Kc sigue la curva FAO-56 a partir de esta fecha; en las demás etapas se mantiene en el valor de la etapa. La etapa nunca avanza por sí sola: tras la duración típica para este cultivo, el Kc se queda en el valor final de la etapa hasta que elija la etapa siguiente. Tras la caída de las hojas o la cosecha, elija Reposo (Kc 0,25, suelo desnudo); en primavera, elija Etapa inicial con la fecha de brotación. Los cambios de cultivo, etapa o fecha de inicio se aplican a los días calculados después del cambio. Déjelo vacío para usar el valor de tabla de la etapa.",
    "pt": "A data em que a fase atual começou (dia 1). Nas fases de desenvolvimento e final, o Kc segue a curva FAO-56 a partir desta data; nas outras fases mantém o valor da fase. A fase nunca avança sozinha: após a duração típica para esta cultura, o Kc fica no valor final da fase até escolher a fase seguinte. Após a queda das folhas ou a colheita, escolha Dormência (Kc 0,25, solo nu); na primavera, escolha Fase inicial com a data do abrolhamento. As alterações de cultura, fase ou data de início aplicam-se aos dias calculados depois da alteração. Deixe vazio para usar o valor da tabela para a fase."
  },
  "environment.water.kcSource.fao56_curve": {
    "en": "{{crop}}, {{stage}} (FAO-56 curve)",
    "de-CH": "{{crop}}, {{stage}} (FAO-56-Kurve)",
    "fr": "{{crop}}, {{stage}} (courbe FAO-56)",
    "it": "{{crop}}, {{stage}} (curva FAO-56)",
    "es": "{{crop}}, {{stage}} (curva FAO-56)",
    "pt": "{{crop}}, {{stage}} (curva FAO-56)"
  },
  "environment.water.stageOverrun": {
    "en": "Past this stage's typical length ({{days}} days, FAO-56 Table 11): the stage may be out of date; choose the next stage when the crop reaches it.",
    "de-CH": "Über der typischen Dauer dieser Phase ({{days}} Tage, FAO-56, Tabelle 11): Die Phase ist möglicherweise veraltet; wählen Sie die nächste Phase, sobald die Kultur sie erreicht.",
    "fr": "Au-delà de la durée typique de ce stade ({{days}} jours, tableau 11 de la FAO-56) : le stade n’est peut-être plus à jour ; choisissez le stade suivant quand la culture l’atteint.",
    "it": "Oltre la durata tipica di questa fase ({{days}} giorni, tabella 11 della FAO-56): la fase potrebbe non essere aggiornata; scegli la fase successiva quando la coltura la raggiunge.",
    "es": "Supera la duración típica de esta etapa ({{days}} días, tabla 11 de FAO-56): la etapa puede estar desactualizada; elija la etapa siguiente cuando el cultivo llegue a ella.",
    "pt": "Além da duração típica desta fase ({{days}} dias, quadro 11 da FAO-56): a fase pode estar desatualizada; escolha a fase seguinte quando a cultura lá chegar."
  },
  "environment.water.et0Tier.open_meteo_daily": {
    "en": "Open-Meteo weather model, daily FAO-56",
    "de-CH": "Open-Meteo-Wettermodell, tägliche FAO-56",
    "fr": "Modèle météo Open-Meteo, FAO-56 journalier",
    "it": "Modello meteo Open-Meteo, FAO-56 giornaliero",
    "es": "Modelo meteorológico Open-Meteo, FAO-56 diario",
    "pt": "Modelo meteorológico Open-Meteo, FAO-56 diário"
  },
  "environment.water.computedBy.edge": {
    "en": "Calculated on the gateway",
    "de-CH": "Auf dem Gateway berechnet",
    "fr": "Calculé sur la passerelle",
    "it": "Calcolato sul gateway",
    "es": "Calculado en el gateway",
    "pt": "Calculado no gateway"
  },
  "environment.water.computedBy.cloud": {
    "en": "ET0 from the Open-Meteo weather model (not measured at this farm); OSI Cloud applies the crop coefficient",
    "de-CH": "ET0 aus dem Open-Meteo-Wettermodell (nicht auf diesem Betrieb gemessen); OSI Cloud wendet den Kulturkoeffizienten an",
    "fr": "ET0 du modèle météo Open-Meteo (non mesurée sur cette exploitation) ; OSI Cloud applique le coefficient cultural",
    "it": "ET0 dal modello meteo Open-Meteo (non misurata in questa azienda); OSI Cloud applica il coefficiente colturale",
    "es": "ET0 del modelo meteorológico Open-Meteo (no medida en esta finca); OSI Cloud aplica el coeficiente de cultivo",
    "pt": "ET0 do modelo meteorológico Open-Meteo (não medida nesta exploração); o OSI Cloud aplica o coeficiente cultural"
  },
  "environment.water.modelAccuracyNote": {
    "en": "Model-based ET0 can differ from a local station by 10-20 % on a single day, most on cloudy, windy or mountain days; weekly totals agree better.",
    "de-CH": "Modellbasierte ET0 kann an einem einzelnen Tag um 10-20 % von einer lokalen Station abweichen, am stärksten an bewölkten und windigen Tagen oder in den Bergen; Wochensummen stimmen besser überein.",
    "fr": "L’ET0 issue d’un modèle peut s’écarter de 10-20 % d’une station locale sur une seule journée, surtout par temps nuageux ou venteux et en montagne ; les totaux hebdomadaires concordent mieux.",
    "it": "L’ET0 da modello può discostarsi del 10-20 % da una stazione locale in un singolo giorno, soprattutto nelle giornate nuvolose o ventose e in montagna; i totali settimanali concordano meglio.",
    "es": "La ET0 de un modelo puede diferir un 10-20 % de una estación local en un solo día, sobre todo en días nublados o ventosos y en montaña; los totales semanales coinciden mejor.",
    "pt": "A ET0 de um modelo pode diferir 10-20 % de uma estação local num único dia, sobretudo em dias nublados ou ventosos e na montanha; os totais semanais coincidem melhor."
  },
  "environment.water.meteoswissCloudNote": {
    "en": "This zone uses MeteoSwiss on the gateway; OSI Cloud's own history uses Open-Meteo until MeteoSwiss history is available in the cloud.",
    "de-CH": "Diese Zone nutzt auf dem Gateway MeteoSchweiz; die eigene Historie von OSI Cloud nutzt Open-Meteo, bis die MeteoSchweiz-Historie in der Cloud verfügbar ist.",
    "fr": "Cette zone utilise MétéoSuisse sur la passerelle ; l’historique propre d’OSI Cloud utilise Open-Meteo jusqu’à ce que l’historique MétéoSuisse soit disponible dans le cloud.",
    "it": "Questa zona usa MeteoSvizzera sul gateway; lo storico di OSI Cloud usa Open-Meteo finché lo storico MeteoSvizzera non è disponibile nel cloud.",
    "es": "Esta zona usa MeteoSwiss en el gateway; el historial propio de OSI Cloud usa Open-Meteo hasta que el historial de MeteoSwiss esté disponible en la nube.",
    "pt": "Esta zona usa a MeteoSwiss no gateway; o histórico próprio do OSI Cloud usa a Open-Meteo até o histórico da MeteoSwiss estar disponível na nuvem."
  }
};
const set = (o, p, value) => { const ks = p.split('.'); let n = o; for (const k of ks.slice(0, -1)) n = n[k] ??= {}; n[ks.at(-1)] = value; };
for (const locale of ['en', 'de-CH', 'fr', 'it', 'es', 'pt', 'lg']) {
  const file = path.join(EDGE_LOCALES, locale, 'devices.json');
  const before = fs.readFileSync(file, 'utf8');
  const bundle = JSON.parse(before);
  if (JSON.stringify(bundle, null, 2) + '\n' !== before) throw new Error(`${file} does not round-trip`);
  for (const [key, byLocale] of Object.entries(TEXTS)) set(bundle, key, byLocale[locale === 'lg' ? 'en' : locale]);
  fs.writeFileSync(file, JSON.stringify(bundle, null, 2) + '\n');
}
console.log(`${Object.keys(TEXTS).length} keys written into 7 bundles`);
```
```bash
node "$SCRATCH/stage-date-locales.js"
```
Expected: `11 keys written into 7 bundles`. The English `zoneConfig.stageStartedOnHelp` equals the modal's `STAGE_STARTED_ON_HELP` default of Step 3, and `helpNoLength` is `help` without ` ({{days}} days)` in each language, as plan CB derives it.

`scripts/test-shared-agronomy-locales.js`, the parity check the controller ruled for both repositories (a later text fix on either side must reach the other):
```js
#!/usr/bin/env node
'use strict';

// The eleven texts the edge and the cloud GUIs share for daily agronomy parity
// (plan E2b). The edge embeds the cloud's translations; this test keeps the two
// equal after a later text fix on either side. It compares the edge's
// web/react-gui/public/locales/<locale>/devices.json with the cloud's
// frontend/public/locales/<locale>/devices.json in the osi-server checkout that
// OSI_SERVER_ROOT names, for every shared key the edge carries. Without
// OSI_SERVER_ROOT it skips.
//
// Run: OSI_SERVER_ROOT=/path/to/osi-server node --test scripts/test-shared-agronomy-locales.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const CLOUD = process.env.OSI_SERVER_ROOT ? path.resolve(process.env.OSI_SERVER_ROOT) : null;
const LOCALES = ['en', 'de-CH', 'fr', 'it', 'es', 'pt', 'lg'];
// edge key (devices.json) -> cloud key (devices.json)
const SHARED = [
  ['zoneConfig.stageStartedOn', 'zoneConfigModal.stageStartedOn.label'],
  ['zoneConfig.stageStartedOnHelpLabel', 'zoneConfigModal.stageStartedOn.helpLabel'],
  ['zoneConfig.stageStartedOnHelp', 'zoneConfigModal.stageStartedOn.help'],
  ['zoneConfig.stageStartedOnHelpNoLength', 'zoneConfigModal.stageStartedOn.helpNoLength'],
  ...['kcSource.fao56_curve', 'stageOverrun', 'et0Tier.open_meteo_daily', 'computedBy.edge', 'computedBy.cloud', 'modelAccuracyNote', 'meteoswissCloudNote']
    .map((key) => [`environment.water.${key}`, `environment.water.${key}`]),
];
const get = (o, p) => p.split('.').reduce((v, k) => (v == null ? undefined : v[k]), o);
const bundle = (root, dir, locale) => JSON.parse(fs.readFileSync(path.join(root, dir, locale, 'devices.json'), 'utf8'));

test('the texts the edge shares with the cloud equal the cloud\'s in seven locales', { skip: CLOUD ? false : 'OSI_SERVER_ROOT is not set' }, () => {
  let compared = 0;
  for (const locale of LOCALES) {
    const edge = bundle(ROOT, 'web/react-gui/public/locales', locale);
    const cloud = bundle(CLOUD, 'frontend/public/locales', locale);
    for (const [edgeKey, cloudKey] of SHARED) {
      const mine = get(edge, edgeKey);
      // An edge without plan E2b carries none of these keys: nothing to compare yet.
      if (mine === undefined) continue;
      assert.equal(get(cloud, cloudKey), mine, `${locale}: edge ${edgeKey} vs cloud ${cloudKey}`);
      compared += 1;
    }
  }
  // node --test prints this line as '# compared 77 shared texts'.
  console.log(`compared ${compared} shared texts`);
});
```

In `.github/workflows/migrations.yml`, after the line `      - run: node scripts/verify-agronomy-contract.js osi-server` (plan E1 Task 5), add (the `migrations` job checks out the same-named osi-server branch at `osi-server/` before its first step):
```yaml
      # Daily agronomy parity: the GUI texts the edge shares with the paired osi-server branch.
      - run: node --test scripts/test-shared-agronomy-locales.js
        env:
          OSI_SERVER_ROOT: osi-server
```
```bash
node --test scripts/test-shared-agronomy-locales.js
OSI_SERVER_ROOT=<osi-server>/.worktrees/daily-agronomy-cloud node --test scripts/test-shared-agronomy-locales.js
```
Expected: the first run `# skipped 1`; the second `# compared 77 shared texts` and `# pass 1` once plans CB and CC2 have written their texts on the cloud branch (at the re-anchoring, 2026-09-28, the cloud worktree already carried them and the check passed). Before that it fails with the first key the cloud lacks, and the step waits for those plans; the texts themselves are already in the edge bundles. After the merges, CI compares osi-os with osi-server main, and an edge without these keys compares nothing.

`$SCRATCH/luganda-doc.py`:
```python
# One-shot (plan E2b, Task 1): the eleven new devices.json keys in the Luganda ledger.
import pathlib
p = pathlib.Path("docs/i18n/pending-luganda-translations.md")
lines = p.read_text(encoding="utf-8").split("\n")
def insert_after(prefix, row):
    hits = [i for i, line in enumerate(lines) if line.startswith(prefix)]
    if len(hits) != 1:
        raise SystemExit(f"expected one row starting with {prefix}, found {len(hits)}")
    lines.insert(hits[0] + 1, row)
insert_after("| `environment.water.demandNoSource`",
             "| `environment.water.kcSource.fao56_curve`, `stageOverrun`, `et0Tier.open_meteo_daily`, `computedBy.edge`, `computedBy.cloud`, `modelAccuracyNote`, `meteoswissCloudNote` (7 keys in `devices.json`) | Added by daily agronomy parity (the FAO-56 Kc curve, the stage-overrun flag and the days OSI Cloud computes in shared mode, 2026-09-27). The values are the cloud's translations, embedded from the cloud plans, so the two GUIs carry one translation of each key; `test-shared-agronomy-locales.js` keeps them equal. No human Luganda pass yet, so `lg` ships the English source text. |")
insert_after("| `zoneConfig.stage.unset`",
             "| `zoneConfig.stageStartedOn`, `stageStartedOnHelpLabel`, `stageStartedOnHelp`, `stageStartedOnHelpNoLength` (4 keys in `devices.json`) | Added by daily agronomy parity (the stage start date of the FAO-56 Kc curve in the zone settings, 2026-09-27). The values are the cloud's `zoneConfigModal.stageStartedOn.*` texts, embedded from plan CB. No human Luganda pass yet, so `lg` ships the English source text. The keys are listed in `zoneFormLocales.test.ts`. |")
p.write_text("\n".join(lines), encoding="utf-8")
print("pending-luganda-translations.md: two rows")
```
```bash
python3 "$SCRATCH/luganda-doc.py"
node .claude/skills/anti-slop-writing/slop-check.js docs/i18n/pending-luganda-translations.md
```
Expected: `pending-luganda-translations.md: two rows`; `slop-check: PASS (no tier-1 findings)`.

- [ ] **Step 5: Run the gates**

```bash
(cd web/react-gui && npx vitest run src/components/farming/__tests__/ZoneConfigModal.test.tsx src/components/farming/__tests__/ZoneConfigModalI18n.test.tsx && npx tsx --test tests/zoneFormLocales.test.ts tests/waterCardLocales.test.ts && npm run typecheck && npm run test:unit)
```
Expected: the modal file green, `Tests  20 passed (20)` (sub-project 3's 15 and the five new ones), `ZoneConfigModalI18n` green (2), both locale tests `# pass 10`, `# fail 0` (every value present in seven bundles, placeholders match, translated in the five European locales, `lg` equals `en`, no ß in de-CH), typecheck exit 0, `test:unit` green: the tsx runner `# pass 183` and vitest `Tests  2173 passed (2173)` on the re-anchored base (pin the counts the runner prints).

- [ ] **Step 6: Commit**

```bash
git add web/react-gui/src web/react-gui/tests web/react-gui/public/locales docs/i18n/pending-luganda-translations.md scripts/test-shared-agronomy-locales.js .github/workflows/migrations.yml
git -c user.name=Project-OSI commit -m "feat(gui): stage start date in zone settings, pre-filled on a stage change; shared texts checked against the cloud"
```

---

### Task 2: The Water tab shows the curve, the overrun and a cloud-computed day

**Files:**
- Modify: `web/react-gui/src/types/farming.ts` (`WaterDay`), `src/components/farming/environment/WaterTab.tsx`, `src/components/farming/environment/__tests__/WaterTab.trend.test.tsx`
- Scratch: `$SCRATCH/watertab.py`

**Interfaces:**
- Consumes: `stageOverrun` and `demandComputedBy` per day (plan E2a Task 5); the seven `environment.water.*` keys (Task 1); `stageLengths` (plan E1).
- Produces: `WaterDay.stageOverrun?: boolean | null`, `WaterDay.demandComputedBy?: 'edge' | 'cloud' | null`, `WaterDay.et0Tier` accepts `'open_meteo_daily'`. The tooltip: the Kc line names `(FAO-56 curve)` through `kcSource.fao56_curve`; a day with `stageOverrun === true` shows `environment.water.stageOverrun` with `{{days}}` from `stageLengths(cropType)[stage]`; a day with `demandComputedBy === 'cloud'` and a demand shows `computedBy.cloud` and `modelAccuracyNote`, and its source line reads `et0Tier.open_meteo_daily` with the Open-Meteo credit. No day number is shown (spec B9). `computedBy.edge` and `meteoswissCloudNote` ship in the bundles for the shared texts but no edge line renders them: an edge day needs no attribution on the edge, and the Water tab has no zone to read `weather_source` from.

- [ ] **Step 1: Write the failing tests**

Append to `src/components/farming/environment/__tests__/WaterTab.trend.test.tsx`:
```tsx

describe('WaterTab contract v2 lines', () => {
  it('names a day on the FAO-56 curve and flags a stage past its typical length', () => {
    const w = buildWater({
      daily: demandWeek((index) => (index === 3 ? {
        demandMm: 3.1, demandSource: 'calculated', et0Mm: 4, et0Source: 'open_meteo_hourly_sum', et0Tier: 'provider_hourly_sum',
        kc: 0.77, kcSource: 'fao56_curve', cropType: 'maize', phenologicalStage: 'development', stageOverrun: true,
      } : {})),
    });
    tooltipFor(buildWaterChartRows(w)[3], w);
    expect(screen.getByText('Open-Meteo model · ET0 4.0 mm · Kc 0.77 (Maize (grain), Crop development (FAO-56 curve))')).toBeInTheDocument();
    expect(screen.getByText("Past this stage's typical length (40 days, FAO-56 Table 11): the stage may be out of date; choose the next stage when the crop reaches it.")).toBeInTheDocument();
  });

  it('marks a shared-mode day OSI Cloud computed from model ET0, with the accuracy note', () => {
    const w = buildWater({
      daily: demandWeek((index) => (index === 2 ? {
        demandMm: 2.2, demandSource: 'calculated', demandComputedBy: 'cloud', et0Mm: 3.1, et0Source: 'provider_native', et0Tier: 'open_meteo_daily',
        kc: 0.71, kcSource: 'fao56_crop', cropType: 'maize', phenologicalStage: 'development',
      } : {})),
    });
    tooltipFor(buildWaterChartRows(w)[2], w);
    expect(screen.getByText(/^Open-Meteo weather model, daily FAO-56 · ET0 3\.1 mm/)).toBeInTheDocument();
    expect(screen.getByText('ET0 from the Open-Meteo weather model (not measured at this farm); OSI Cloud applies the crop coefficient')).toBeInTheDocument();
    expect(screen.getByText(/Model-based ET0 can differ from a local station by 10-20 % on a single day/)).toBeInTheDocument();
    expect(screen.getByText('Weather data by Open-Meteo.com, CC BY 4.0')).toBeInTheDocument();
  });

  it('shows neither cloud line on a day the gateway computed', () => {
    const w = buildWater({ daily: demandWeek((index) => (index === 2 ? { demandComputedBy: 'edge', kc: 1.2, kcSource: 'fao56_crop', cropType: 'maize', phenologicalStage: 'mid_season' } : {})) });
    tooltipFor(buildWaterChartRows(w)[2], w);
    expect(screen.queryByText(/OSI Cloud applies the crop coefficient/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Model-based ET0/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Past this stage's typical length/)).not.toBeInTheDocument();
  });
});
```

Run: `(cd web/react-gui && npx vitest run src/components/farming/environment/__tests__/WaterTab.trend.test.tsx)`
Expected: `Tests  2 failed | 37 passed (39)`: the curve test fails on the missing overrun line, the cloud-day test on the missing source label and the two cloud lines; the third passes already.

- [ ] **Step 2: The type and the tooltip**

`$SCRATCH/watertab.py`:
```python
# One-shot (plan E2b, Task 2): WaterDay gains stageOverrun and demandComputedBy, and the
# Water tab tooltip gains the curve, overrun and cloud-day lines. Paths relative to web/react-gui/.
import pathlib
t = pathlib.Path("src/types/farming.ts")
ts = t.read_text(encoding="utf-8")
for old, new in [
    ("  et0Tier?: 'station_fao56' | 'provider_hourly_sum' | 'hargreaves_station' | null;\n",
     "  et0Tier?: 'station_fao56' | 'provider_hourly_sum' | 'hargreaves_station' | 'open_meteo_daily' | null;\n"),
    ("  /** Why a day has no demand: `pending`, `partial_day`, `no_source`, `no_location`, ... */\n  nullReason?: string | null;\n}\n",
     "  /** Why a day has no demand: `pending`, `partial_day`, `no_source`, `no_location`, ... */\n  nullReason?: string | null;\n"
     "  /** The day is past its stage's FAO-56 Table 11 length (the stage may be out of date). */\n"
     "  stageOverrun?: boolean | null;\n"
     "  /** Who computed a past day's demand: this gateway, or OSI Cloud from model ET0 (shared mode). */\n"
     "  demandComputedBy?: 'edge' | 'cloud' | null;\n}\n"),
]:
    if ts.count(old) != 1:
        raise SystemExit("farming.ts: expected one match for: " + old[:80])
    ts = ts.replace(old, new)
t.write_text(ts, encoding="utf-8")
p = pathlib.Path("src/components/farming/environment/WaterTab.tsx")
s = p.read_text(encoding="utf-8")
def swap(old, new):
    global s
    if s.count(old) != 1:
        raise SystemExit("expected one match for: " + old[:80])
    s = s.replace(old, new)
swap("import { cropById, normalizeStage } from '../../../agronomy/cropKc';",
     "import { cropById, normalizeStage, stageLengths } from '../../../agronomy/cropKc';")
swap("""  } else if (row.et0Source === 'meteoswiss_hourly_sum') {""",
     """  } else if (row.et0Tier === 'open_meteo_daily') {
    // A day OSI Cloud computed from Open-Meteo's daily ET0 (shared mode, plan CC).
    et0 = t('environment.water.et0Tier.open_meteo_daily', { defaultValue: 'Open-Meteo weather model, daily FAO-56' });
  } else if (row.et0Source === 'meteoswiss_hourly_sum') {""")
swap("""  const credits: string[] = [];
  if (row.et0Source === 'open_meteo_hourly_sum') {""",
     """  const stage = normalizeStage(row.phenologicalStage);
  const overrunDays = row.stageOverrun === true && stage && stage !== 'dormancy'
    ? stageLengths(row.cropType)?.[stage] ?? null
    : null;
  // Only a shared-mode day the gateway has no demand for carries 'cloud'.
  const cloudDay = row.demandComputedBy === 'cloud' && row.demandMm != null && Number.isFinite(row.demandMm);
  const credits: string[] = [];
  if (row.et0Source === 'open_meteo_hourly_sum' || row.et0Tier === 'open_meteo_daily') {""")
swap("""      {source && <p className="text-xs text-[var(--text-secondary)]">{source}</p>}
""", """      {source && <p className="text-xs text-[var(--text-secondary)]">{source}</p>}
      {cloudDay && (
        <p className="text-xs text-[var(--text-secondary)]">
          {t('environment.water.computedBy.cloud', { defaultValue: 'ET0 from the Open-Meteo weather model (not measured at this farm); OSI Cloud applies the crop coefficient' })}
        </p>
      )}
      {row.stageOverrun === true && (
        <p className="mt-1 text-xs text-amber-800">
          {t('environment.water.stageOverrun', { days: overrunDays ?? '', defaultValue: "Past this stage's typical length ({{days}} days, FAO-56 Table 11): the stage may be out of date; choose the next stage when the crop reaches it." })}
        </p>
      )}
      {cloudDay && (
        <p className="mt-1 text-xs text-[var(--text-secondary)]">
          {t('environment.water.modelAccuracyNote', { defaultValue: 'Model-based ET0 can differ from a local station by 10-20 % on a single day, most on cloudy, windy or mountain days; weekly totals agree better.' })}
        </p>
      )}
""")
p.write_text(s, encoding="utf-8")
print("WaterTab: curve, overrun and cloud-day lines")
```
Run: `(cd web/react-gui && python3 "$SCRATCH/watertab.py")`. Expected: `WaterTab: curve, overrun and cloud-day lines`.

- [ ] **Step 3: Run the gates**

```bash
(cd web/react-gui && npx vitest run src/components/farming/environment/__tests__ && npm run typecheck && npm run test:unit)
```
Expected: the environment tests green (`Tests  61 passed (61)`, the trend file 39 of them), typecheck exit 0, `test:unit` green (vitest `Tests  2176 passed (2176)`; pin what the runner prints).

- [ ] **Step 4: Commit**

```bash
git add web/react-gui/src
git -c user.name=Project-OSI commit -m "feat(gui): Water tab names the FAO-56 curve, flags an overrun stage and marks a cloud-computed day"
```

---

### Task 3: Gates and the execution report section

**Files:**
- Modify: `docs/superpowers/plans/2026-09-27-daily-agronomy-parity-edge-execution-report.md` (plan E2a Task 6 created it)

- [ ] **Step 1: Run the gates of E2b's surface**

```bash
(cd web/react-gui && npm run typecheck && npm run test:unit)
node --test scripts/test-shared-agronomy-locales.js
OSI_SERVER_ROOT=<osi-server>/.worktrees/daily-agronomy-cloud node --test scripts/test-shared-agronomy-locales.js
node scripts/verify-agronomy-contract.js
node .claude/skills/anti-slop-writing/slop-check.js docs/i18n/pending-luganda-translations.md
```
Expected: typecheck exit 0 and `test:unit` green; the text check `# skipped 1` without the variable and `# compared 77 shared texts`, `# pass 1` with it; the agronomy verifier OK; `slop-check: PASS (no tier-1 findings)`. E2b changes no flow, schema or sync contract, so plan E2a Task 6's gates stand.

- [ ] **Step 2: Append the E2b section**

Append an **E2b** section to `docs/superpowers/plans/2026-09-27-daily-agronomy-parity-edge-execution-report.md`: per task what was built and its commit, the test counts the runner printed, the text check's result against the cloud branch (with the osi-server commit it ran against), and every deviation from the plan with its reason. No customer instance, customer branch or live deployment hash (osi-os is public).

```bash
node .claude/skills/anti-slop-writing/slop-check.js docs/superpowers/plans/2026-09-27-daily-agronomy-parity-edge-execution-report.md
git add docs/superpowers/plans/2026-09-27-daily-agronomy-parity-edge-execution-report.md
git -c user.name=Project-OSI commit -m "docs: edge execution report, E2b section"
```
Expected: `slop-check: PASS (no tier-1 findings)`.

---

## Spec coverage

| Spec item | Task |
|---|---|
| B5 GUI field, HelpTip with and without length, pre-fill, clearing, payload only when changed, keys, `normaliseZone`, `IrrigationZone` | 1 |
| B9 WaterDay fields, the three tooltip lines, no day number | 2 |
| C10 cloud-only texts on the edge for shared mode (`computedBy.edge` and `meteoswissCloudNote` ship without an edge line) | 1, 2 |
| One translation per shared key, checked across the repositories | 1, 3 |
| Testing: GUI modal and Water tab tests, locale tests | 1, 2 |
| Execution report (E2b section) | 3 |
