# Plan — Journal Slice D: Crop-cycle lifecycle

**Spec:** [2026-07-20-journal-capture-streamlining-design.md](../specs/2026-07-20-journal-capture-streamlining-design.md) (D5–D13; §5.1, §6; R2, R3, R4, R7)
**Branch:** `design-sync/agrolink` · **Risk:** high · **Migrations:** `0025__journal_crop_cycles.sql` (schema) + `0026__journal_catalog_v4.sql` (catalog v4: crop additions + `attr.variety`). Slots/versions are LOCKED in spec §8.1 — do not renumber.

> Largest slice — split into **D-1 (schema + vocab)**, **D-2 (edge lifecycle + resolution)**, **D-3 (GUI)**. Each sub-slice is independently testable; deploy + kaba100 re-test after D-2 and again after D-3. Follow osi-schema-change-control for the migration and osi-live-ops-runbook for deploy.

## Goal

Seeding a plot opens a crop cycle (crop + variety); later activities on that plot inherit the crop read-only; harvest closes it; re-seeding a *different* crop auto-closes and reopens; partial harvest closes only selected plots. Crop is a controlled list (Agroscope 26 + farmer additions, admin-extensible); variety is free-text with per-crop autocomplete. Resolution is live-by-date while open (backdating retroactive), frozen at harvest.

## D-0 — Reconcile pre-existing crop-identity mechanisms (do FIRST)

Three crop-identity surfaces already exist and must be explicitly superseded/integrated — the new plot-level cycle model is **not** the only "what crop is this" answer today (Fable plan-review Blocking-1):

- **`zone_seasons` + `resolveSeason()`/`coveringSeason()`** (`lifecycle.js:~480-490`): zone-keyed, checked **first**, returns early on any covering row — even one with `crop_type = NULL`. `scripts/repair-pi-schema.js:~516` backfills exactly such a NULL-crop default season (whole calendar year, `is_active=1`) for every zone lacking one, as part of the routine live-Pi repair path — **so it is very likely already present on kaba100** and will silently shadow the new cycle logic unless the precedence is changed.
- **`journal_plots.crop_hint`** (`0018:143`): a second, free-text crop field, read/written in `osi-journal/api.js` plot create/update.
- **`cropForPlot()`** (`JournalCaptureFlow.tsx:~145`): client resolves `zoneCrops[zone_uuid] || plot.crop_hint` to seed the flow's `crop` state today.

**Task D0.1 — decide & document precedence, then implement:** when a plot has an open `journal_crop_cycles` membership, it wins over `zone_seasons`/`crop_hint`/`cropForPlot()`. Make `resolveSeason()` consult the cycle model **before** `coveringSeason()`, and treat a NULL-crop `zone_seasons` row as "no crop" (not a covering match). Migrate/deprecate `crop_hint` (keep as legacy read-only, or fold into an initial cycle) — owner-visible choice, document it.
**Task D0.2 — kaba100 pre-check (live):** before D deploys, query kaba100 for the default-season backfill on its zones (`SELECT zone_id,crop_type,is_active FROM zone_seasons WHERE is_active=1`) and confirm the new precedence handles it. Add to the live re-test.

## D-1 — Schema + vocabulary

### Task D1.1 — Crop-cycle tables (migration 0025)
- **Files:** `database/migrations/ordered/0025__journal_crop_cycles.sql` (+ CHECKSUMS). Create `journal_crop_cycles` and `journal_crop_cycle_plots` exactly per spec §5.1 (per-plot `ends_on`/`closed_by_entry_uuid`/`close_reason IN ('harvest','reseed','manual')`; partial index on open memberships). Additive risk class.
- **Tests:** applies on a v0024 DB; FK/CHECK enforced; open-membership index used by the resolution query (EXPLAIN).

### Task D1.2 — Controlled crop list + variety (catalog delta)
- **Files:** `scripts/journal-catalog-core.js` (+ generator). Adopt the existing 26 `agroscope.crop.*` choices as the global `attr.crop` list; add farmer-facing choices (Permanent grassland, Field vegetable, Green manure/cover crop, Fallow, Other) with farmer-friendly `labels_json`. Add `attr.variety` (text, maxlength 120, `autocomplete: 'variety_by_crop'`). Register as **catalog v4, migration `0026__journal_catalog_v4.sql`** (LOCKED, spec §8.1) — version = next GLOBAL integer, unconditional (BC/v3 has already shipped by the time D runs).
- **⚠️ OPEN (owner decision, blocks only the admin-gating sub-task, not the cycle):** admin-only crop extension assumes an `admin` role that **does not exist** in the current schema (`users` in `0001` has no role/`is_admin` column) — Fable Blocking-2. **Default resolution (recommended):** ship the crop list **fixed/seeded** in v1; defer in-app crop editing until the scoped-multiuser role work lands (`docs/superpowers/specs/2026-07-19-agrolink-scoped-multiuser-design.md`). Alternative: add a minimal `users.role` column (its own osi-schema-change-control-scoped migration, not currently slotted). Confirm before D-3.
- **Tests:** generator `--check` OK; crop choices resolve under `attr.crop`; variety attribute present; `0019`/`0022`/`0023` byte-identical.

## D-2 — Edge lifecycle + resolution

### Task D2.1 — Cycle open/close/reseed
- **Files:** `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/lifecycle.js` (+ `index.test.js`). Mirror to the bcm2709 profile (byte-identical).
- On a `seeding` (or `planting_transplanting`) final entry: open a `journal_crop_cycles` row (`opened_by_entry_uuid`, `starts_on` = occurred date, crop/variety) and one `journal_crop_cycle_plots` row per target plot. **R4:** if a plot already has an open cycle of the **same** crop, do not auto-close — the GUI has asked "continue or new" (D3.2); honor the caller's `cycle_action` flag (`continue`|`new`). If **different** crop → auto-close prior membership (`close_reason='reseed'`, `ends_on` = new seeding date) then open new.
- On a `harvest` entry: close the covering membership for each target plot (`close_reason='harvest'`, `ends_on` = occurred date, `closed_by_entry_uuid`). **D10:** only the selected plots. **R7:** if >1 open cycle covers a plot (intercrop), require the entry to name `cycle_uuid`.
- **R3 manual close:** a `tillage_soil_work`/`mowing`/`plant_protection_application` entry carrying `ends_crop_cycle: true` closes the covering membership with `close_reason='manual'`, `ends_on` = its occurred date.
- **Tests:** open on seed; harvest closes selected only; different-crop reseed auto-closes; same-crop continue leaves open; manual close; intercrop requires cycle_uuid.

### Task D2.2 — Live-vs-frozen resolution (supersedes always-snapshot)
- **Files:** `lifecycle.js` `resolveSeason()` + read path (`api.js`, `context.js`).
- While a plot's covering cycle is **open**, entry crop is resolved **live** (join `journal_crop_cycles`/`_plots` on `starts_on ≤ occurred_date AND (ends_on IS NULL OR ends_on ≥ occurred_date)`); do **not** write `season_crop`/`season_variety` yet (defer snapshot). At **harvest close**, freeze: write `season_crop/season_variety` on every covered entry in the closed span. After close, reads use the frozen snapshot. This makes **D11 backdating retroactive** (live resolution) and protects closed records.
- **D13/R7 cascades:** correct seeding crop/variety → update the open cycle row (live displays follow); void seeding → soft-delete its cycle, warn if it has dependents (dependent = final entry inheriting it); void harvest → clear `ends_on/closed_by/close_reason`, un-freeze its snapshots, **collision check** if a reseed cycle is already open on the plot.
- **Tests:** backdated seeding retro-applies to earlier entries; correction propagates; freeze-at-harvest; void-harvest reopen + collision guard; void-seeding dependent warning.

## D-3 — GUI

### Task D3.1 — Group-first seeding + group-select (D7)
- **Files:** `web/react-gui/src/components/journal/where/{PlotPicker,PlotGroupChips,StationGrid}.tsx`.
- Seeding: "Create group" → name + range input (`1,5,8,9,10-13`, reuse U7 control) → proceed to seeding form (crop dropdown from controlled list + variety autocomplete). Single-plot seeding stays available. Later activities: active groups (e.g. "Winter Barley") one-tap; selecting carries the crop/variety.
- **Tests:** range parse; group create → members; group-select inherits crop.

### Task D3.2 — Same-crop reseed prompt (R4)
- On seeding a plot/group with an open same-crop cycle, prompt "Continue this cycle or start new?" → sends `cycle_action`.
- **Tests:** prompt shown only on same-crop overlap; choice threads through.

### Task D3.3 — Inherited-crop banner with inline correction (D8/R2)
- **Files:** capture `EntryForm.tsx` + a new inline correction sheet.
- Non-seeding activity on a cropped plot: read-only banner `🌱 <crop> · <variety> · seeded <date>`. crop·variety text tappable → lightweight inline sheet that writes the correction to the **seeding entry** (single source). seeded-date also links to the seeding entry. No crop input on the activity form.
- **Tests:** banner renders from live resolution; inline edit posts to the seeding entry; note field not used for crop.

### Task D3.4a — Harvest UI (partial + intercrop)
- Harvest UI: plot/group multi-select subset (D10); intercrop → pick which cycle to close (R7); after a whole-group harvest, offer resolve-group (U7). **First audit `web/react-gui/src/components/journal/where/HarvestGroupNudge.tsx`** — it may already cover part of the resolve-group affordance.
- **Tests:** partial harvest closes only the selected subset; intercrop harvest names the cycle; resolve-group offered after whole-group harvest.

### Task D3.4b — Manual close + admin crop-list gate
- Manual-close affordance (R3) on `tillage_soil_work`/`mowing`/`plant_protection_application` + from the banner (sends `ends_crop_cycle: true`). Admin-only "add crop" in the crop dropdown — **gated per the D1.2 OPEN decision** (default: not shipped in v1; the "add crop" control is simply absent until roles exist).
- **Tests:** manual close writes `close_reason='manual'`; if admin-gating deferred, no "add crop" control renders for anyone.

## Verification

- Catalog `--check` OK, both-profile parity; migration 0025 runner dry-run + `integrity_check`; `npm run test:unit` + edge `index.test.js` green; `npm run build` clean; both edge profiles byte-identical.
- **Live (kaba100)** — full lifecycle on fresh plots:
  1. Create group "Winter Barley" (plots via range), seed with crop+variety → cycle opens.
  2. Fertilize the group → crop inherited as read-only banner; inline-correct variety → seeding entry updated.
  3. Backdate a seeding → earlier same-plot entries retro-show the crop.
  4. Partial harvest 2 of 5 plots → those close, rest stay open; re-seed a different crop → prior auto-closed as `reseed`.
  5. Manual close via tillage; void a harvest → reopens (collision-guarded).

## Out of scope

Full/Research field scoping (E); BBCH/weather/tank-mix (F).
