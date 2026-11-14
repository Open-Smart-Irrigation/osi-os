# Public simulator v2: port onto main and polish the first visit

Sol review: approved with the binding amendments in
[the plan review](2026-11-12-public-simulator-ux-polish-review.md).
Those amendments take precedence over conflicting instructions below.

Planner: Opus (plan only). Reviewer: Sol. Executor: Luna. Written 2026-11-12
against `origin/main` 103e4c547 (AGENTS.md blob a7348fe7, last changed in
b0a5e3cfa). Nothing in this plan has been built or run; every count and
behaviour below is either read from source (marked **source**) or an
assumption to check (marked **assumption**).

The public simulator that the website serves is built from a branch that is on
no remote and is 122 commits behind main. This plan moves its demo-owned source
onto current main without a blind merge, closes the verified findings of the
2026-11 UX audit, and produces a website integration package. It ends at a
reviewed, verified release artifact. Live website changes stay with the owner.

## 1. Source provenance

| Ref | SHA | What it is | Use |
|---|---|---|---|
| `feat/public-simulator-v1` (osi-01 transfer bundle) | 26fe14d594257f81a602f29178405e32a1f08324 | Last local simulator release branch, 82 commits on base 2e8beead6 (2026-10-10). | **Authoritative source** for the port. |
| `feat/public-simulator` (same bundle) | 202b15a6ffa9e0066c59e4b22e97c7c4f1d91a86 | Expanded device realism ("B"), 37 commits not in v1, 8 unique. | Out of scope; ledger L1. |
| `origin/cloud/public-simulator-v1` | 5c2bd1650 | Squash snapshot of v1 as of 2026-10-11 20:50, before the 10-12 work. | Do not use: 3153 insertions and 639 deletions behind 26fe14d59 (**source**, `git diff --shortstat`). |
| `origin/cloud/public-simulator-devices` | e174c586a | Squash snapshot of the device branch; lacks `demo/website/*` sources. | Do not use. |
| `origin/main` | 103e4c547 | Current base; demo is presentation-only. | Base. |

Facts behind the table:

- **source**: the bundle `osi-os-ALL-REFS.bundle` in the osi-01 transfer
  archive lists `refs/heads/feat/public-simulator-v1` at 26fe14d59. Its
  merge base with main is 2e8beead6; `rev-list --left-right` gives 122 main-only
  and 82 branch-only commits.
- **source**: 26fe14d59 contains the website sources the cloud snapshots lack:
  `web/react-gui/demo/website/{invitation.js,invitation.css,invitation.html,osi-os-preview.png,preview.html,embed.html,package.mjs}`
  and `docs/website/osi-os-demo-plugin.php`.
- **source** (private handover in the maintainers' knowledge repository,
  verified 2026-11-07 by `curl`): the live site serves badge assets under
  `osi-os-demo/v1-26fe14d59…` and `/simulator/` built from that commit. This
  plan has not re-fetched the site. **Assumption**: it still does.
- **source**: the handover records that the final whole review at ecd0a5a96
  returned REVISE (W1–W4); the W1–W4 source recheck went GREEN on 10-12, but the
  W4 Firefox CSV browser proof and verifier commands 5–9 never ran. The ported
  source is therefore unaccepted until this plan's gate passes.
- **source**: main's `web/react-gui/demo` changed in two files since 2e8beead6
  (`demo/locales/lg-valves.json` dropped `settingsDialog.title`;
  `demo/tests/valve-locale.test.ts` pins conditional-irrigation and CMD-04 keys
  to English in the demo). The port must keep both.
- **source**: 26fe14d59 adds no npm dependencies relative to its base; it only
  adds scripts to `web/react-gui/package.json`. The lockfile is untouched.

## 2. Integration decision

Build a new branch from current `origin/main` and import an explicit path list
from 26fe14d59. Do not rebase or merge the 82 commits: they touch 24 files that
main also changed (**source**, `comm` of both name lists), carry private review
directories (`docs/reviews/*`, `.superpowers/*`) that the pre-push guard
rejected on 2026-10-11, and predate main's valve 0.8.1 restoration (#648),
conditional irrigation (#515) and CMD-04 plan snapshots (#506).

The production `src/` edits on 26fe14d59 are not imported wholesale. Each gets a
disposition in Slice 2. The default is "drop": the simulator must show the
production GUI as it is on main, with its gaps.

## 3. Audit findings and disposition

"Main" means checked against main's source by this planner. "Live" means the
finding was observed on the deployed 26fe14d59 build.

| # | Finding | Status | Where it is handled |
|---|---|---|---|
| F1 | `/simulator/` shell has no links | Live; **source** (26fe14d59 `demo/public/index.html` has no `<a>`) | Slice 7 |
| F2 | Homepage entrance is a small floating badge | Live; website source in 26fe14d59 | Slice 11 |
| F3 | Desktop phone scaled to 74 % at 1280×800, 319 px expanded | **source**: `fitPhone()` in `demo/public/host.ts` scales a 402×856 frame by `min(1, availableHeight/856)`; (800−164)/856 = 0.743 | Slice 5 |
| F4 | Mobile hides intro and guidance | Live; **source**: `host.css` media rules (Luna to cite) | Slice 5 |
| F5 | No "simulated farm" notice; no guided path; first controls far down | Live | Slices 6, 8 |
| F6 | Time controls hidden in a Controls dialog; host clock in browser time zone | **source**: host formats `time` with `Intl.DateTimeFormat(language)` and no `timeZone`; runtime pins `osi.defaults.timezone` to `Africa/Kampala` | Slice 6 |
| F7 | Schedule dialog: focus stays on opener, Tab reaches background | Live (Sol confirmed); **main source**: `ValveScheduleDialog.tsx` traps focus only for the delete confirmation, not for the outer `role="dialog"` | Slice 3 |
| F8 | Seven empty week cards precede the create forms | **main source**: week grid renders before the forms | Slice 3 |
| F9 | White on teal primary, 1.86:1 in dark theme | Live only. **main source**: fixed by #596 and #598 with `tests/primaryTextContrast.test.ts` and `tests/uiCoreContrast.test.ts`. The host shell (`host.css`) is not covered by those tests | Slice 5 measures; no re-fix unless the measurement fails |
| F10 | Advice "Moist 45 kPa" next to "Irrigate today" with a 30 kPa threshold | Explanation gap, not a label bug. **source**: `docs/operations/conditional-irrigation.md` states that irrigation presets and soil-status labels use different boundaries | Slice 8 copy |
| F11 | Account and Add device forms look real | Live | Slice 9 |
| F12 | Luganda partly English; app `html lang` stays `en` | **source**: 26fe14d59's `demo/public/host.ts` updates `lang` on the host document only; the iframe's `app.html` keeps `lang="en"` because neither `src/` nor `demo/mount.tsx` sets it | Slices 6, 10 |
| F13 | Reset is immediate and drops the language | **source**: reset handler calls `updateCopy('en')` and reloads | Slice 6 |
| F14 | History affordances and empty states | Partly live; missing data must stay missing | Slices 4, 8 |
| F15 | Zone settings order; Loam card vs editor | Reported by one reviewer, not verified | Slice 4 investigation only |
| F16 | Soil values differ between surfaces | Investigative | Slice 4 investigation |
| F17 | Sample history looks synthetic | Investigative | Ledger L6 |
| F18 | No meta description or Open Graph tags | **source**: 26fe14d59 `index.html` has only title and viewport | Slice 7 |

Excluded as disproven by the audit: missing mobile demo link, unlabeled
schedule inputs, silent AddZone failure, a prechecked "publicly share" box.
A conditional trigger that did not run after "next event" is not evidence of an
engine defect and is not a finding.

## 4. Risk decisions

The product surfaces here are demo-owned files plus a short list of production
GUI files. No schema, flows, sync, deploy, bootstrap or edge runtime change is
in scope. Any slice that finds it needs one stops (section 9).

| ID | Decision | Reason |
|---|---|---|
| D1 | Production locale files get no simulator keys. Simulator copy lives in demo overlays loaded by `demo/i18n.ts`. | 26fe14d59 wrote `demoNotice`, `demoHelp` and `publicInvalid*` into `public/locales/lg/*.json`; `docs/i18n/pending-luganda-translations.md` forbids machine Luganda there. |
| D2 | `src/pages/Login.tsx` and `src/pages/AccountLink.tsx` are not edited. | Auth pages are a playbook risk class. The public build sets `VITE_OSI_SERVER_URL` to `https://cloud.example.test` through `define`, the runtime shows a notice in the existing `#demo-notice` element, and the model accepts the demo credentials. |
| D3 | Every surviving production hook uses `isPublicSimulatorBuild()`; none reads `document.documentElement.dataset.publicSimulator`. The production build must define `import.meta.env.VITE_PUBLIC_SIMULATOR` as the constant `"false"` if Slice 2 step 0 shows the hooks otherwise ship. | A runtime dataset check always ships. **source**: 26fe14d59's `check-build-isolation.mjs` only checks the inert session marker and `demo/` module references; it never proved the `02F1` prefix or the flag branches are absent, and main's `vite.config.js` defines no such key. Removal is therefore unproven. |
| D4 | The production build of PR A must equal main's production build file-for-file, or every differing file is listed with a reason in the PR. The marker-absence check in Slice 2 is a hard gate either way. | Isolation evidence that the port changes nothing for farmers. |
| D5 | Conditional irrigation remains unqualified (503 on enable); the supported legacy daily scheduler remains simulated only where source parity is established. DENDRO dispatch follows the current flow action and duration factors, not a separate sensitivity/response-mode controller. | **main source**: `osi-irrigation-policy/api.js` lines 845–846 throw that error. The flow keeps its 06:00 legacy schedule path and excludes zones with active conditional policies. |
| D6 | The schedule-dialog fix (Slice 3) touches a component that issues actuator commands. Its diff must not change any handler that calls `valvesAPI`; a payload-invariance test is required. Standard loop; Sol may escalate it to council. | Playbook risk classes include actuator commands. |
| D7 | New Luganda strings for host and guide copy may be machine-drafted under the historical simulator-only authorization, shown with the existing review notice. Keys that main's `valve-locale.test.ts` pins to English stay English. If Sol or the owner withdraws the authorization, new `lg` host strings ship as English. | Contradiction C1. |
| D8 | Browser suites run locally under `osi-heavy`, results attached to the PR. Node-level demo tests already run in `.github/workflows/typecheck.yml`. A source-build workflow (no browsers) is added with path filters. | 26fe14d59's workflow adds a 45-minute hosted Playwright job; hosted minutes are not budgeted. |
| D9 | Outbound destinations come from one allowlist module and are limited to `/`, `/osi-system/`, `https://github.com/Open-Smart-Irrigation/osi-os` and its `#device-setup` README anchor. No releases link (ledger L8). | No invented contact or partner pages. `/osi-system/` is the page the release runbook names for the persistent link. |
| D10 | Copy may say the simulator does not connect to a server or device only after the network-capture test in Slice 9 passes. | Audit requirement; **source**: runtime blocks `fetch`, XHR, WebSocket, EventSource and `sendBeacon`; the hosting config sets `connect-src 'none'`. |
| D11 | Guide steps navigate and highlight only. They never press a control that changes farm state. | Free exploration stays the default; manual consequences stay the visitor's. |

## 5. Owned paths

Luna may edit these, and nothing else without a plan amendment:

- `web/react-gui/demo/**` (imported, then edited)
- `web/react-gui/vite.demo.config.ts`
- `web/react-gui/scripts/generate-sdi12-profiles.mjs` (imported)
- `web/react-gui/package.json` (`scripts` block only)
- `web/react-gui/.gitignore` (two build-output lines)
- `web/react-gui/src/vite-env.d.ts` or the existing env type file, for `VITE_PUBLIC_SIMULATOR`
- `web/react-gui/vite.config.js`: one `define` entry for `import.meta.env.VITE_PUBLIC_SIMULATOR`, only if Slice 2 step 0 requires it
- `web/react-gui/src/utils/publicSimulatorDeviceDefaults.ts`, `web/react-gui/src/utils/publicSimulatorInvalidation.ts` (new on main)
- Production files with an accepted disposition in Slice 2: `src/App.tsx`, `src/pages/SettingsPage.tsx`, `src/pages/FarmingDashboard.tsx`, `src/components/farming/AddDeviceModal.tsx`, `src/components/farming/ZoneDeviceModal.tsx`, `src/components/farming/IrrigationZoneCard.tsx`, `src/components/farming/environment/EnvironmentCard.tsx`, and their `__tests__`
- Slice 3 only: `src/components/farming/valves/ValveScheduleDialog.tsx`, its tests, `src/services/api.ts` (`downloadHistoryCsv` only), `data-testid` attributes on the History control and `IrrigationOutcomesPanel`
- `docs/website/osi-os-demo-plugin.php`, `docs/website/osi-os-demo-page.md`, `docs/website/osi-os-demo-embed.html` (imported, then edited)
- `docs/operations/public-simulator-release.md` (imported, then edited)
- `.github/workflows/public-simulator.yml` (new, source builds only)
- This plan file

Never import: `docs/reviews/**`, `.superpowers/**`, `docs/operations/public-simulator-cloud-handoff.md`,
`docs/superpowers/plans/2026-10-*`, `docs/superpowers/specs/2026-10-*`,
`docs/images/osi-os-simulator.png`, any `public/locales/**` change, any edge
file under `conf/`.

## 6. Pull requests

| PR | Title | Slices | Changes production bundle |
|---|---|---|---|
| A | `feat(simulator): port the public simulator onto current main` | 0, 1, 2, 4 | Only listed, flag-gated hooks (D4) |
| B | `fix(gui): keep focus inside the valve schedule dialog and put creation first` | 3 | Yes |
| C | `feat(simulator): readable desktop layout, guided first visit and farm-time controls` | 5–10 | No |
| D | `feat(website): prominent simulator entry and release package` | 11, 12 | No |

B is independent of A and can merge first. C stacks on A and needs B: the
guide targets B's `data-testid` attributes and the keyboard suite needs B's
focus trap.

## 7. Slices

All commands run from the repository root unless a `cd` is shown. Set once:

```bash
HEAVY=/home/phil/projects/osi-workstation-config/bin/osi-heavy
GUI=web/react-gui
```

Heavy jobs (builds, Vitest, Playwright) run one at a time through
`"$HEAVY" run --label <label> bash -c '<command>'`, with at most two test
workers. Record each job's exit status and summary line in the PR.

### Slice 0: provenance and import ref

1. Rerun startup readiness; stop on MISMATCH.
2. Fetch the source commit into a ref outside `refs/heads` so no push can carry it:

   ```bash
   BUNDLE=~/kDrive/osi-01-transfer/git/osi-os/osi-os-ALL-REFS.bundle
   git bundle list-heads "$BUNDLE" | grep 26fe14d594257f81a602f29178405e32a1f08324
   git fetch --no-tags "$BUNDLE" refs/heads/feat/public-simulator-v1:refs/osi-local/public-simulator-v1
   test "$(git rev-parse refs/osi-local/public-simulator-v1)" = 26fe14d594257f81a602f29178405e32a1f08324
   ```

   Expected: the grep prints one line; the test exits 0. Never check out this ref.
3. Create the work branch: `git switch -c feat/public-simulator-v2 origin/main`
   in a T3 worktree reserved for this task (not a shared root).
4. Commit this plan as the first commit (`docs: plan public simulator v2 port and UX polish`).

### Slice 1: import demo-owned files

1. Import the path list, nothing else:

   ```bash
   SRC=refs/osi-local/public-simulator-v1
   git restore --source=$SRC --staged --worktree -- \
     web/react-gui/demo \
     web/react-gui/vite.demo.config.ts \
     web/react-gui/scripts/generate-sdi12-profiles.mjs \
     web/react-gui/src/utils/publicSimulatorDeviceDefaults.ts \
     web/react-gui/src/utils/publicSimulatorInvalidation.ts \
     docs/website docs/operations/public-simulator-release.md
   ```

   A directory restore also removes files the source lacks. Check:
   `git diff --name-status --diff-filter=D origin/main -- web/react-gui/demo docs/website`
   must print nothing; restore any listed file from `origin/main` and note it in
   `PROVENANCE.md`.
2. Restore main's two demo changes on top: `git restore --source=origin/main --staged --worktree -- web/react-gui/demo/locales/lg-valves.json web/react-gui/demo/tests/valve-locale.test.ts`.
   Then `git diff --stat origin/main -- web/react-gui/demo/locales/lg-valves.json web/react-gui/demo/tests/valve-locale.test.ts` must print nothing.
3. Hand-merge `package.json`: add only the `demo:*` script lines that 26fe14d59
   adds (`demo:generate-sdi12-profiles`, the changed `demo:build` and
   `demo:test`, `demo:build:public`, `demo:serve:public`, `demo:test:public`,
   `demo:build:website`). Keep every main dependency, script and the pinned
   `@playwright/test` version. Add `public-demo-build/` and `website-demo-build/` to `web/react-gui/.gitignore`.
4. Write `web/react-gui/demo/PROVENANCE.md`: source SHA, the path list above,
   and the output of `git ls-tree -r $SRC -- <paths>` reduced to blob SHA and
   path. State that the source commit is on no remote (ledger L2).
5. Move simulator keys out of production locales (D1). 26fe14d59's `demo/public`
   code reads `auth.login.demoHelp`, `accountLink.form.demoNotice` and
   `accountLink.errors.publicInvalid*` only from the dropped Login/AccountLink
   edits; confirm with `git grep -n "demoHelp\|demoNotice\|publicInvalid" -- web/react-gui`
   that no imported file still references them. If one does, put the key in a
   new `web/react-gui/demo/locales/public-copy/<lang>.json` overlay and load it
   in `demo/i18n.ts` next to `public-advisory`.
6. Do not run any build yet. Commit: `chore(simulator): import public simulator source from 26fe14d59`.

### Slice 2: production hook dispositions

Write `web/react-gui/demo/PRODUCTION-HOOKS.md` with one row per production file
26fe14d59 changed, its disposition and the reason. Pre-decided rows:

| File(s) | Disposition |
|---|---|
| `src/App.tsx` route redirects for `/analysis`, `/network`, `/journal`, gateway card detail | Port via three-way edit against main; compile-time flag |
| `src/pages/SettingsPage.tsx` experimental module rows hidden | Port; compile-time flag |
| `AddDeviceModal.tsx`, `ZoneDeviceModal.tsx` fictional DevEUI prefill | Port; three-way against main's #544 change |
| `FarmingDashboard.tsx` / `IrrigationZoneCard.tsx` `initiallyExpanded` for zone 1 | Port; compile-time flag |
| Invalidation subscription in `IrrigationZoneCard.tsx`, `EnvironmentCard.tsx` | Port; move the flag check into `subscribePublicSimulatorInvalidation` as `isPublicSimulatorBuild()` |
| `EnvironmentCard.tsx` request sequencing | Port only if a simulator test shows a stale response overwriting a fresh one; otherwise ledger L5 |
| UC512 unassigned section and `Uc512DeviceCard.tsx` | If main already renders unassigned UC512 devices, drop. Otherwise port with an i18n key added to all seven production locales, `lg` as English, and an entry in `docs/i18n/pending-luganda-translations.md` plus its test allowlist |
| `Login.tsx`, `AccountLink.tsx` | Drop (D2) |
| `NetworkPage.tsx` load sequencing | Drop: route is redirected in the public build; ledger L5 |
| `Sdi12SettingsModal.tsx` and the `sdi12SettingsDeviceEui` change | Drop; production candidate, ledger L5 |
| `api.ts` `today-liters` source mapping | Drop. The model returns exactly what the edge route returns; a GUI mismatch is a production bug, ledger L5 |
| `api.ts` `downloadHistoryCsv` delayed revoke | Moves to Slice 3 (PR B) |
| `IrrigationActuation.zoneId` nullable, outcomes null guard | Drop unless the edge contract emits a null zone id |
| `StregaValveCard.tsx`, `waterChart.ts`, `WaterTab.tsx` flow-meter changes | Drop; production agronomy display, ledger L5 |
| `AgronomicTab.tsx`, `WeatherTab.tsx`, `sourceLabels.ts`, `HistorySourcePopover.tsx`, `AnalysisSeriesTray.tsx` literal-string localization | Drop. The model emits the literals the edge emits; any English literal is a production gap, ledger L5 |
| `ZoneConfigModal.tsx` location messages | Drop; make `demo/public/device-location.ts` return production's own messages |
| `SenseCapWeatherCard.tsx` wrap, `DraginoTempCard.tsx` rain monitor | Drop; ledger L5 |
| `AdvancedScheduleDrawer.tsx` public evaluation display and `demo/locales/public-advisory/*` | Drop (D5, no fake calculated advice). Remove the overlay files and their loader lines |
| `types/farming.ts` additions | Keep main's types; add a field only if a ported hook needs it |

Steps:

0. Measure dead-code removal before porting anything else. Write the marker
   test from step 2 first. Port only `publicSimulatorDeviceDefaults.ts` and the
   `AddDeviceModal.tsx` hook, run `npm run build` under `osi-heavy`, then
   `grep -rl "02F1" web/react-gui/build`. If it prints a file, add
   `define: {'import.meta.env.VITE_PUBLIC_SIMULATOR': JSON.stringify('false')}`
   to `web/react-gui/vite.config.js`, rebuild, and confirm the grep prints
   nothing. Record both outputs in the PR. If the define does not remove the
   marker, stop (section 9).
1. For each "port" row, write the failing test first (Vitest under the file's
   `__tests__`), apply the hunk against main by hand, watch it pass.
2. Extend `demo/check-build-isolation.mjs` and `demo/tests/build-isolation.test.ts`:
   the production bundle must contain none of `02F1`, `publicSimulator`,
   `osi-demo:revalidate`, `cloud.example.test`, `osi-mobile-simulator-v1`.
3. Set `VITE_OSI_SERVER_URL` to `https://cloud.example.test` in the public
   `define` block of `vite.demo.config.ts`; test it in `build-isolation.test.ts`.
4. Commit per file group, `fix(simulator): …` or `feat(simulator): …`.

### Slice 3 (PR B): schedule dialog focus, order, CSV download

Tests first, in `src/components/farming/valves/__tests__/ValveScheduleDialog.focus.test.tsx`:

- opening the dialog moves focus to the dialog container (`tabIndex={-1}`, labelled by the title);
- Tab from the last focusable element goes to the first; Shift+Tab from the first goes to the last;
- a `focusin` outside the dialog is pulled back inside;
- while the delete confirmation is open, its existing trap wins and the outer trap does nothing;
- closing (button, Escape, backdrop) returns focus to the element that had focus before opening, if still connected;
- with `schedules.length === 0`, the weekly and one-time forms precede the week section in DOM order and the seven day cards are inside a collapsed `<details>` whose summary reuses `scheduleDialog.week`; with one or more schedules the current order is unchanged;
- after a successful weekly save, focus moves to the new list row (which already shows the push state);
- payload invariance: for a weekly save, one-time save, update and delete, the mocked `valvesAPI` functions receive exactly the arguments the current main code sends (record them first against unmodified main, then assert after the change).

Then, after checking that main's current `downloadHistoryCsv` still revokes
synchronously (`grep -n "revokeObjectURL" web/react-gui/src/services/api.ts`;
drop this item if it does not), `src/services/__tests__/downloadHistoryCsv.revoke.test.ts`: with fake
timers, `URL.revokeObjectURL` is not called synchronously after `click()` and
is called once after `setTimeout(0)`.

Implement in `ValveScheduleDialog.tsx` with no new strings. Add `data-testid`
attributes `zone-history-link` and `irrigation-outcomes-panel` (attribute-only)
for Slice 8. Run:

```bash
"$HEAVY" run --label pr-b-unit bash -c 'cd web/react-gui && npm run typecheck && npm run test:unit:tsx-runner && npm run test:unit:vitest -- --maxWorkers=2'
"$HEAVY" run --label pr-b-build bash -c 'cd web/react-gui && npm run build'
```

Expected: all pass; `git diff origin/main -- web/react-gui/src | grep -c valvesAPI` matches only test files.

### Slice 4: model parity with main

The 26fe14d59 model answers the API of 2026-10-10. Main's GUI calls routes the
model does not know (**source**: diff of `src/services/api.ts` since 2e8beead6),
including `/api/irrigation-zones/:zone/irrigation-policy` and its `decisions`,
`pause` and `retry-valve` children, `/api/irrigation-zones/:id/rain-source`,
`/api/valve/:eui/cancel`, `/api/valves/:eui/scheduler-status`,
`/api/devices/:eui/strega/*`, and `/api/users`.

1. Write `demo/tests/route-inventory.test.ts`: parse the route templates in
   every `src/services/*.ts` (`api.ts` and `journalApi.ts` at least) with the TypeScript compiler API (as `check-build-isolation.mjs`
   already uses `typescript`), and assert every template is in exactly one of
   two exported lists in `demo/model/route-dispositions.ts`: `SIMULATED` or
   `UNSUPPORTED_IN_SIMULATOR` (each entry with a one-line reason). Run it first;
   it fails listing the new routes.
2. For each route reachable on the public path (dashboard, zone card, valve
   panel, schedule dialog, policy editor, zone History, Settings, account link,
   add device), write a failing contract test in `demo/tests/v1-native-contracts.test.ts`
   whose expected shape comes from the edge module's own tests, never from
   guesswork: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-irrigation-policy/api.test.js`,
   `osi-valve-control/*.test.js`, and `scripts/test-valve-v081-equivalence.js`.
   Cite the fixture path in each test.
3. Conditional irrigation (D5): status returns `qualification.qualified: false`
   with production's reason; enabling a conditional policy returns 503
   `qualification_unavailable`. Test that advancing the clock across a
   threshold crossing and across a schedule opportunity creates no actuation.
4. Legacy automatic triggers: find whether main still dispatches them
   (`grep -n "trigger" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json | head -40`
   and the scheduler module that owns the decision). If main does not, disable
   `evaluateAutomaticTriggers` in `demo/model.ts` and test that no automatic
   actuation occurs. If main does, keep it and cite the code. If the answer is
   unclear, stop (section 9).
5. Valve semantics, each as a model test citing `demo/controller-semantics.md`
   and the agronomy skill: a timed open sent to an already-open STREGA leaves it
   open and does not close it later; only CLOSE ends it; a timed close is the
   valve's own close, not a bare CLOSE; cancel follows #648 (an ordinary open is
   taken out of the queue).
6. Soil response: a soil reading changes only on a new sensor report at the
   model's report cadence, never at the moment of a click. Test: open a valve,
   read the soil tile value before the next scheduled report, assert unchanged.
7. Missing data: extend `demo/tests/history-api.test.ts` so gaps return `null`
   and History renders them as gaps; no interpolated values.
8. F15/F16 investigation, model side only: record in `PRODUCTION-HOOKS.md`
   which value each soil surface shows (zone tile, device card, History) with
   source, depth, aggregation and timestamp. Fix the model if it returns
   inconsistent readings for the same report. If the difference is production
   display logic, record it for ledger L5. For the Loam card, check that the
   model's soil type value is one the editor's option list contains.
9. Run the full Slice 13 gate for PR A.

### Slice 5: desktop and mobile layout

Tests first in `demo/tests/public/layout.spec.ts`:

- at 1280×800 and 1440×900 in phone view, the iframe has no CSS transform, its client width is 390 px or more, and a known app text node's rendered height equals its computed line height (scale 1);
- in expanded view at 1280×800, the iframe client width is at least 1024 px or the available width, whichever is smaller, still unscaled;
- toggling the view while a zone-rename input holds typed text keeps the text, the hash route and the iframe's `performance.timeOrigin` (no reload);
- at 390×844 the simulated-farm notice and a "Guide" button are visible above the app without scrolling, and the app still fills the width;
- dark theme: contrast of every host button and of the app's primary Open, Save and Add buttons is at least 4.5:1, measured from computed colours.

Implementation: replace `fitPhone()` scaling with a native-scale frame whose
height follows the viewport and scrolls inside; expanded view widens the same
iframe. Mobile gets a one-line notice bar and a collapsible guide sheet.

### Slice 6: farm time, contextual skip, reset

Protocol first (`demo/protocol.ts`, `demo/tests/public/host-protocol.test.ts`).
`demo/protocol.ts` is shared with the presentation host: update `demo/host.ts`
and `demo/tests/protocol.test.ts` in the same commit, and run the presentation
browser suite (gate step `sim-4`) before committing.

- `time` becomes `{value: number, timeZone: string}`; the validator rejects a missing or non-IANA zone (check with `Intl.DateTimeFormat(undefined, {timeZone})` in a try block);
- new app message `next-event` `{at: number | null, kind: 'valve-close' | 'schedule-start' | 'report' | null}`;
- new host command `guide` `{step: GuideStep}` with a closed enum (Slice 8).

Then:

- host clock formats in the farm zone with weekday and date, labelled "farm time"; test in `demo/tests/public-datetime.test.ts` that `Date.UTC(2026, 10, 12, 3, 30)` in `Africa/Kampala` renders 06:30 with the weekday;
- after a valve command is queued or a schedule saved, the host shows "Skip to <event> (<weekday date time> farm time)" next to the app; it sends the existing `next-event` command; the Controls dialog keeps speed and pause;
- reset opens a host `<dialog>` that states what is cleared (farm changes, valve history, schedules) and that the language stays; confirm reloads `app.html?lang=<code>`; `demo/i18n.ts` reads `lang` from the URL and accepts only `DEMO_LANGUAGES`; test both;
- `demo/mount.tsx` sets `document.documentElement.lang` on `languageChanged`.

### Slice 7: shell links and metadata

- `demo/public/links.ts` exports the D9 allowlist with labels per role: visitor
  ("What OSI OS is" → `/osi-system/`), installer ("Set up a gateway" → README
  `#device-setup`), developer ("Source code" → repository), plus "Home" → `/`.
- `demo/tests/public-links.test.ts` asserts the rendered `index.html` contains only these hrefs and that external links carry `rel="noopener"`.
- Header gets Home; the guide's last step and the desktop side panel get the role links.
- `index.html` gains `meta name="description"`, `og:title`, `og:description`, `og:image` (the existing preview image). The public Vite config sets
`publicDir: false` and `check-build-isolation.mjs` rejects non-entry files
outside `assets/`, so import the image so Vite emits it under `assets/`, and
reference that URL. `hosting.spec.ts` checks all four tags and that the image
returns 200.
- At implementation time, run one read-only `curl -sI` per destination and paste the status lines into the PR. A non-200 site path falls back to `/`.

### Slice 8: simulated-farm notice and guided path

Host-owned, in `demo/public/guide.ts` with copy in `demo/public/locales/*.json`.
Steps (closed enum `GuideStep`):

1. `inspect-plot`: highlight `water-today-card` in zone 1.
2. `explain-advice`: highlight `water-action-tile`; host text explains where
   the advice comes from (Luna writes it from `demo/model/water-action.ts` and
   the production tile, citing both in a code comment) and that soil-status
   labels and irrigation presets use different boundaries.
3. `history`: highlight `zone-history-link`.
4. `timed-irrigation`: highlight `valve-actions` and say which control opens a timed run.
5. `skip-to-result`: point at the host skip control from Slice 6.
6. `result`: highlight `irrigation-outcomes-panel`.
7. `schedule`: highlight the schedule control; explain that the run happens at
   the scheduled time and the skip control jumps there.
8. `next-steps`: show the Slice 7 links.

The runtime handles `guide` by navigating to `#/dashboard` if needed, expanding
zone 1, scrolling the target into view, focusing it and adding a demo-only
outline class from `demo/app.css`. A missing target shows a host message and
leaves the step in place. Tests: `demo/tests/public-guide.test.ts` for the step
machine; `demo/tests/public/guide.spec.ts` asserts each step's target is
visible and focused and that the farm state (zones, devices, actuations,
schedules) is identical before and after the full tour without visitor input
(D11). The persistent notice text: "Simulated farm. Nothing here controls real
equipment." Wording subject to anti-slop and Sol review.

### Slice 9: simulator treatment for account and device forms

- Runtime shows `#demo-notice` on `#/account-link` and while the Add device or
  zone device modal is open: "Example values only. Use the prefilled fictional
  identifiers."
- Model accepts the demo credentials and returns production-shaped errors for
  empty input (the GUI already localizes those).
- `demo/tests/public/boundary.spec.ts`: record every request during the full
  guided path plus an account-link submit and an add-device submit; assert only
  same-origin GETs under `/simulator/`. Only after it passes may the notice add
  "This simulator does not connect to any server or device" (D10).

### Slice 10: languages and keyboard core flow

- Host and guide copy in all seven files; `host-copy.test.ts` asserts identical key sets and no `en` value reused in another locale except an explicit allowlist (brand names, units).
- `lg` follows D7; the review notice stays visible in `lg`.
- `demo/tests/public/keyboard.spec.ts`, parameterized over `en`, `de-CH`, `fr`, `it`, `es`, `pt`, `lg`, keyboard only: switch language from the app menu, check `html[lang]` in both documents, run the guide, open a timed irrigation dialog and confirm, skip to its end, open the schedule dialog, assert Tab never leaves it, create a weekly window, close with Escape and assert focus returns to the opener, reset and confirm the language survives.

### Slice 11: website package (deliverable, not installation)

Sources in `web/react-gui/demo/website/`:

- `cta.html` and `cta.css`: an inline section (heading, one sentence, primary
  link "Try the OSI OS simulator" → `/simulator/`, secondary link → `/osi-system/`),
  static, no script, for a hero or content block.
- `docs/website/osi-os-demo-plugin.php`: add a shortcode `[osi_simulator_cta]`
  that prints the static markup with escaped attributes and enqueues
  `cta.css` from the versioned directory; keep the fail-closed version
  placeholder; bump the prefix from `v1-` to `v2-`.
- Keep the badge; raise its caption to at least 16 px and its hit target to at least 44×44 px.
- Add a navigation-menu step to `docs/operations/public-simulator-release.md`
  as an editor action in the WordPress menu screen. The theme header source is
  not in this repository; the only known anchors are `#osiUHeader` and
  `#osiUBurger`, which `invitation.js` already uses. Do not script the header.
- `package.mjs` copies the new inputs; `website-packager.test.ts` and
  `invitation.spec.ts` cover them; `preview.html` shows hero CTA and badge for screenshots.
- If `php` is installed, `php -l` the rendered plugin; otherwise record "not run".

### Slice 12: release artifact

Per the runbook, from a clean tree at the reviewed commit:
`npm run demo:build:public`, `npm run demo:build:website`, archive as
`osi-public-simulator-v2-<commit>.tar.gz`, write SHA-256 for the archive and
every file. No upload. The runbook update lists the live steps for the owner.

### Slice 13: verification gate

Fresh servers, serial, zero skipped public tests:

```bash
"$HEAVY" run --label sim-1 bash -c 'cd web/react-gui && npm run demo:test'
"$HEAVY" run --label sim-2 bash -c 'cd web/react-gui && ./node_modules/.bin/tsc -p demo/tsconfig.json --noEmit && npm run typecheck'
"$HEAVY" run --label sim-3 bash -c 'cd web/react-gui && npm run test:unit:tsx-runner && npm run test:unit:vitest -- --maxWorkers=2'
"$HEAVY" run --label sim-4 bash -c 'cd web/react-gui && npm run demo:build && CI=1 ./node_modules/.bin/playwright test --config demo/playwright.config.ts --workers=1'
"$HEAVY" run --label sim-5 bash -c 'cd web/react-gui && npm run build && npm run demo:build:public'
"$HEAVY" run --label sim-6 bash -c 'cd web/react-gui && node demo/check-build-isolation.mjs --production build --public public-demo-build --source src'
"$HEAVY" run --label sim-7 bash -c 'cd web/react-gui && CI=1 ./node_modules/.bin/playwright test --config demo/playwright.public.config.ts --workers=1'
node scripts/verify-doc-hygiene.js
node .claude/skills/anti-slop-writing/slop-check.js docs/superpowers/plans/2026-11-12-public-simulator-ux-polish.md docs/operations/public-simulator-release.md web/react-gui/demo/PROVENANCE.md web/react-gui/demo/PRODUCTION-HOOKS.md
git diff --check origin/main
```

D4 check for PR A: build `build/` on `origin/main` in a scratch worktree, then
`diff -r` against the branch's `build/`; list any difference in the PR.

The presentation suite rewrites `demo/screenshots/*.png`; restore those it
regenerates unless the slice intends a change. The W4 Firefox CSV test must
pass in `firefox-desktop`, not be skipped.

### Screenshot verification

Capture with Playwright into `web/react-gui/test-results/screens/` (ignored),
attach to the PR, and have a reviewer that can read images inspect them:

| Viewport | Theme | Languages | States |
|---|---|---|---|
| 1280×800 | light, dark | en, lg | landing, guide step 2, schedule dialog open, expanded view |
| 1440×900 | light | en | landing, expanded view |
| 390×844 | light, dark | en, lg | landing, guide sheet open, schedule dialog open |
| 1280×800 and 390×844 | light | en | website `preview.html` with hero CTA and badge |

### Luna verification, 2026-11-13

| Gate | Result |
|---|---|
| Demo model, contract and protocol suite (`npm run demo:test`) | 378 passed, 0 failed, 0 skipped; 83.0 s. |
| Demo and GUI type checks | `tsc -p demo/tsconfig.json --noEmit` and `npm run typecheck` passed. |
| GUI unit suites | TSX runner: 347 passed. Vitest: 306 files and 3,390 tests passed. |
| Presentation build and browser suite | Build passed; 26 browser tests passed. |
| Production and public builds with isolation check | Passed; production contained 90 files and public build 19 files. |
| Public browser matrix | 201 passed, 0 skipped in 12.8 min. |
| Guide and event-row browser recheck after the final timestamp assertion | 9 passed across desktop Chromium, mobile Chromium and Firefox. |
| Seven-locale keyboard core flow | 7 passed in Chromium desktop. |
| Link and no-mutation navigation suite | 9 passed across desktop Chromium, mobile Chromium and Firefox. |

## 8. Follow-up ledger

| ID | Item | Owner |
|---|---|---|
| L1 | Device realism branch 202b15a6f ("B", "C" not started): reconcile after v2 ships | Simulator owner |
| L2 | 26fe14d59 and 202b15a6f exist only in the transfer bundle. Preserve them in the private remote as archive refs; never on public `origin` (AGENTS.md, branch visibility) | Owner decision |
| L3 | Live deployment of v2, `/osi-system/` link, nav menu item, cache purge, rollback window | Owner; runbook |
| L4 | Privacy-safe usage measurement: needs infrastructure; no analytics in this plan | Owner |
| L5 | Production candidates found while porting (Sdi12 settings drafts, today-liters source names, flow-meter estimated usage, English literals `Weather data`/`Weather conditions`, NetworkPage load race, SenseCAP name wrap, zone settings order). Each needs its own reproduction on main and PR | GUI maintainers |
| L6 | Sample history realism | Simulator owner, after L1 |
| L7 | Production app never sets `html lang` | GUI maintainers |
| L8 | Latest public GitHub release is v0.6.5; v0.8.0 and v0.8.1 are drafts (**source**: `gh release list`). Keep release links off simulator copy until resolved | Release owner |
| L9 | Main's presentation-mode demo username contains a partner-institute name (`demo/model.ts`, `demo/runtime.ts`) | Simulator owner |
| L10 | Human Luganda pass for simulator host copy and the pending families | Owner |
| L11 | Hosted browser CI for the simulator if minutes are budgeted | Owner |
| L12 | Merge coordination: one line to the osi-server steward before each osi-os squash | Merger |

## 9. Stop conditions and open contradictions

Stop and report instead of improvising when:

- a slice needs a change under `conf/`, `database/`, `lib/`, `scripts/` outside the listed files, or to `flows.json`;
- main's legacy trigger behaviour (Slice 4 step 4) cannot be established from code;
- an edge route's response shape cannot be found in an edge test fixture;
- the production build differs from main's for a reason that is not a listed hook, or a simulator marker survives in it after the Slice 2 step 0 define;
- the pre-push guard or `verify-doc-hygiene.js` flags imported files (for example `demo/journal-catalog.json`); do not add allowlist entries without a reviewed reason;
- a public browser test fails twice for the same cause after a fix attempt.

Open contradictions for Sol:

- C1: The audit asks for a complete Luganda path; main's `demo/tests/valve-locale.test.ts`
  keeps conditional-irrigation and CMD-04 text English even in the demo. This
  plan follows main (D7) and needs a ruling on machine-drafted Luganda for new host copy.
- C2: The deployed simulator is built from a commit on no remote. Preserving it
  is an outward action outside this plan (L2).
- C3: The audit's dark-mode contrast finding is real on the live build and
  already fixed on main. Slice 5 measures instead of re-fixing.


## ROUND1 execution disposition

| Finding | Disposition |
|---|---|
| Sol R1-01 native storage before isolation | Fixed with import-free bootstraps for both app entries; startup browser tests compare bytes in captured native local/session storage, including expired and malformed synthetic holds. |
| Sol R1-02 unreachable keyboard stops | Fixed in the shared modal hook. It leaves unknown native in-dialog stops to browser traversal, includes `summary`, ignores hidden details contents, and preserves the modal boundary logic. Normal Tab browser tests cover Chromium and Firefox. |
| Sol R1-03 net-depth defaults and area clamp | Fixed with one null-preserving conversion used by daily and top-level summaries. Tests write null setup, deliver measured litres, verify 0.5 m², and pin measured zero. |
| Sol R1-04 alternate DENDRO controller | Replaced with current-flow fresh-action dispatch and action multipliers. A test executes the canonical flow function in a VM for all supported action factors; the old rank/response-mode golden cases are removed. |
| Sol R1-05 source-build CI | Fixed in the parent change with `.github/workflows/public-simulator.yml`, including demo typecheck, production/public builds, packaging and isolation. |
| Sol R1-06 stale contract documentation | Fixed in the parent docs and this DENDRO reconciliation: pending cancellation vs running refusal, locale-preserving reset, unchanged CSV disposition, and current-flow DENDRO behavior. |
| GLM N3 externally-open valve at daily trigger | Fixed with a narrow daily-trigger guard and regression. Manual command handling and weekly plan semantics remain separately pinned. |

Parent changes also restore strict seven-locale key parity with an English Luganda pending-human entry, correct the cancel reply's `dropped_opens` shape/count, and add the demo-only MeteoSwiss label. Their focused tests passed before this execution.

## Final execution evidence

- Before the fix, the parent-storage probes observed the expired synthetic hold
  key being deleted during startup. After the fix, presentation and public
  startup probes passed with expired and malformed values unchanged in both
  captured native storage objects.
- An initial normal-Tab browser probe reproduced the native focus-stop issue;
  the final Chromium and Firefox paths reached the creation controls and
  compiled-week summary through normal Tab. Screenshot:
  `/tmp/osi-simulator-ux-evidence/keyboard-dialog-compiled-week.png`.
- Model suite: 381 passed, 0 failed, 0 skipped
  (`/tmp/osi-sim-final-demo-model-types.log`). Demo and GUI TypeScript checks
  passed in the same job.
- Shared modal suite: 67 passed. GUI TSX runner: 347 passed. GUI Vitest:
  306 files, 3,391 passed, 0 failed, 0 skipped
  (`/tmp/osi-sim-final-gui-units.log`).
- Presentation browser suite: 28 passed. Public browser suite: 213 passed,
  0 skipped, across desktop Chromium, mobile Chromium and Firefox
  (`/tmp/osi-sim-final-public-browser.log`).
- Production, presentation, public and website builds passed; artifact
  isolation passed (90 production files, 21 public files)
  (`/tmp/osi-sim-final-builds-isolation.log`).
- Hygiene, test-inventory, AGENTS-size, prose and diff checks passed.

All counts above are from completed runs. The browser tests are fresh at this
execution head; the model, shared-hook, unit and typecheck gates were rerun
after the corresponding code changes. Independent Sol review remains pending.
