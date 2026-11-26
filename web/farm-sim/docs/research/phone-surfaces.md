# Farm-sim phone surfaces: spec for M1

Basis: branch `t3/farming-sim-osi-education` before the hook commit (HEAD `e3fc909bdc`, on PR #658 head `4682fb17b1`). Dated snapshot (2026-11-23), written for plan revision 3; section numbers like "plan 4.3" refer to revision 2. Every `file:line` is relative to `web/react-gui/` unless it starts with `web/farm-sim/`. Read-only research: nothing in the repository was changed. Every claim is from code reading unless marked otherwise; the section 6 probe did not run because the workstation heavy-job lock was blocked.

Path legend: component names without a directory (`IrrigationZoneCard.tsx`, `valves/ValveControlPanel.tsx`, `environment/WaterTab.tsx`, `shared/RainTodayTile.tsx`) live under `src/components/farming/`; `api.ts` is `src/services/api.ts`; `model.ts` and `model/*.ts` are under `demo/`; pages are under `src/pages/`; `history/...` component paths are under `src/components/history/`.

Device names below: `B1` = KIWI soil probe `00000000000000B1`, `B2` = LSN50 MOD9 `00000000000000B2`, `B3` = STREGA valve `00000000000000B3`, zone `1` = "Tomato bed" (plan 4.3, 4.7).

## 0. Findings that change the plan

1. **The verdict label is not "Simulated sensor advice" once public copy runs.** `demo/i18n.ts:34` sets `zone.water.drivenByBalance` to `WATER_COPY.advice`, but `applyPublicCopy` overwrites it with `sensorAdvice` ("Sensor advice", `demo/public-copy.ts:6,20`), and plan 4.6 step 2 applies public copy. Plan 5.3 is therefore wrong as written. The phone must re-apply its overrides after `applyPublicCopy` (section 2).
2. **The "illustrative" label is not shown either.** `applyPublicCopy` maps `environment.source.illustrative` to "Weather data" (`demo/public-copy.ts:23`); the shipped locales have no `illustrative` key. Plan 4.5 ("the app labels the block `illustrative`") does not hold in public mode.
3. **A GET can fire a pending event.** `requestResponse` runs `this.clock.advanceTo(this.now)` before dispatch (`demo/model.ts:619`). A ONCE plan whose `fire_at` is at most 10 minutes in the past is scheduled at exactly `now` (`demo/model/plans.ts:213-221`), after that same flush, so it fires on the **next** request, which may be a phone GET. The game must flush after every write (section 6).
4. **GETs retain environment records and stamp them with the read time** (`demo/model/environment.ts:82,87-90`); see section 6 (code-read).
5. **SWR keeps polling inside a hidden iframe.** SWR 2.3.7 refreshes when `document.visibilityState !== 'hidden'` (`node_modules/swr/dist/_internal/config-context-12s-Dh3trQsc.mjs:81-83`, `node_modules/swr/dist/index/index.mjs:571`). CSS `visibility: hidden` or `inert` on the iframe element does not change the frame document's visibility state, so polling continues while the phone is closed (section 4).
6. **History sends the browser's time zone to the simulator** (`src/history/useTimeViewport.ts:49-50,202`, `src/components/history/desktop/HistoryDesktopDetail.tsx:124`). That changes daily aggregation, not only labels (section 3).
7. **Unknown error codes become "Check the entered values."** The public notice mapper falls back to `noticeInvalid` for any code it does not know (`demo/runtime.ts:69`, `113-117`). Game refusals need their own codes and texts (section 1.4).
8. **The Valve settings dialog cannot be allowed as a whole.** Its Save always sends `strega_generation` (`src/components/farming/valves/ValveSettingsDialog.tsx:84-91`). Only its separate manual CLOSE button (`:111`) is allowed.
9. **The conditional-irrigation editor is reachable at every tier** from the trigger section (`src/components/farming/ScheduleSection.tsx:380-387`). Its first GET uses the zone UUID, which the simulator's `\d+` zone matcher (`demo/model.ts:1049`) does not accept, so it answers 501 `unsupported` today.

## 1. Write allow-list

### 1.1 Matching rules (bridge, phone-originated requests only)

- The list governs requests that arrive through the phone bridge. The farm builder and the dry-run cutoff call `sim.requestResponse` directly and are not filtered (the builder needs `flow_rate_lpm`, zone config, location and device registration, plan 4.4 and 4.7).
- Deny by default. Normalise exactly as the simulator does: reject a path that does not start with `/`, starts with `//` or contains `\` (`demo/model.ts:616`), resolve with `new URL(path, 'http://demo.invalid')` and match on `url.pathname` (`demo/model.ts:617-618`). Upper-case the method.
- Pin identifiers: the EUI segment must be one of the devices the current tier registered (exact upper-case match), and the zone id must be `1`. A request for any other EUI or zone is refused, never forwarded.
- Body: must be a plain object (or empty for routes listed "no body"). Reject unknown keys instead of stripping them; the app sends no extra keys on the allowed routes because axios's JSON serialisation drops `undefined` values before `demo/adapter.ts:30-35` decodes the body.
- Tier: a route allowed at a higher tier is refused with the **tier** text (1.4), a route never allowed with the **refused** text.
- Phone closed: every non-GET is refused with code `phone_asleep` and no notice (section 4).

### 1.2 Allowed routes and payload fields

Tier column: lowest tier at which the route is allowed. T1 = soil probe only; T2 adds LSN50 and the weather service; T3 adds the valve; T4 adds the 06:00 trigger.

| Tier | Method and path | Allowed body | Caller (src) | Simulator handler |
|---|---|---|---|---|
| T1 | `PUT /api/irrigation-zones/1/name` | `{name: string}` | `IrrigationZoneCard.tsx:242` via `api.ts:822-829` | `model.ts:1099-1102` → `model/farm.ts:20-25` |
| T1 | `PUT /api/devices/{registered EUI}/name` | `{name: string}` | `KiwiSensorCard.tsx:326`, `DraginoTempCard.tsx:95`, `StregaValveCard.tsx:767`, `valves/ValveControlPanel.tsx:104` via `api.ts:660-667` | `model.ts:1230-1237` (EUI match is case-sensitive, `:1232`) |
| T1 | `POST /auth/login` | `{username: string, password: string}`; log `{username}` only | `api.ts:301-304` (Login page after a logout) | `model.ts:929` → `model/sessions.ts:54-68` |
| T3 | `POST /api/valve/B3` | `{action: 'OPEN_FOR_DURATION', duration_seconds: integer 60..15300}` or `{action: 'CLOSE'}` (no other key) | open: `valves/ValveControlPanel.tsx:126`, `StregaValveCard.tsx:851`; close: `valves/ValveSettingsDialog.tsx:111`; all via `api.ts:639-645` | `model/irrigation.ts:301-302` → `commandValve` `:103-124` |
| T3 | `POST /api/valve/B3/cancel` | `{reason?: 'operator_cancel'}` | `ValveCancelButton.tsx:29`, `valves/ValveControlPanel.tsx:156` via `api.ts:648-651` | `model/irrigation.ts:299-300` → `cancelValveCommand` `:126-148` |
| T3 | `PUT /api/valves/B3/settings` | `{default_open_minutes: integer 1..255}` only; refuse if `strega_generation`, `flow_rate_lpm` or `flow_rate_source` is present | `valves/ValveControlPanel.tsx:141` (sent after a successful open) via `api.ts:2101-2110` | `model/irrigation.ts:297-298` → `updateValveSettings` `:83-101` |
| T3 | `POST /api/valves/B3/schedules` | WEEKLY: `{kind: 'WEEKLY', weekdays_mask: integer 1..127, start_time: 'HH:MM', duration_minutes: integer 1..1439, label?: string ≤80, enabled?: boolean}`; ONCE: `{kind: 'ONCE', fire_at: ISO instant, duration_minutes: integer 1..255, label?, enabled?}` | `valves/ValveScheduleDialog.tsx:351,396` via `api.ts:2039-2048` (`toScheduleBody` `:1990-2000`) | `model/plans.ts:552-557` → `createValvePlan` `:479-497`, validation `:32-53` |
| T3 | `PUT /api/valves/B3/schedules/{uuid}` | any subset of `kind` (ignored, the stored kind wins, `plans.ts:503`), `weekdays_mask`, `start_time`, `fire_at`, `duration_minutes`, `label`, `enabled`; same ranges | `valves/ValveScheduleDialog.tsx:343,386-387,462,464` via `api.ts:2053-2065` | `plans.ts:559-563` → `updateValvePlan` `:499-523` |
| T3 | `DELETE /api/valves/B3/schedules/{uuid}` | no body | `valves/ValveScheduleDialog.tsx:480` via `api.ts:2066-2073` | `plans.ts:563` → `deleteValvePlan` `:525-533` |
| T3 | `POST /api/valves/B3/plan/resend` | `{}` | `valves/ValveControlPanel.tsx:277` via `api.ts:2074-2081` | `plans.ts:565-566` → `resendValvePlan` `:535-538` |
| T3 | `POST /api/valves/B3/scheduler-status` | `{status: 'ACTIVE' \| 'SKIP_TODAY' \| 'DEACTIVATED'}` | `valves/ValveControlPanel.tsx:274-276` via `api.ts:2082-2100` | `plans.ts:567-568` → `setValveSchedulerStatus` `:540-550` |
| T4 | `PUT /api/irrigation-zones/1/schedule` | `{trigger_metric: 'SWT_1' \| 'SWT_2' \| 'SWT_AVG', threshold_kpa: number, 0 < x ≤ 300, enabled: boolean, duration_minutes?: number, 0 < x ≤ 240}`; refuse `response_mode` (the SWT form omits it, `ScheduleSection.tsx:328-334`), `DENDRO` and `SWT_3` (the KIWI probe has two depths) | `ScheduleSection.tsx:338` via `api.ts:840-849` | `model.ts:1169-1203` |
| T4 | `POST /api/irrigation-zones/schedules/disable-all` | no body | `SettingsPage.tsx:338-342` (behind `window.confirm`) via `api.ts:889-892` | `model.ts:1001-1013` |

Where the player finds an early close: the only CLOSE control is the two-step "Close valve" in Valve settings (`valves/ValveSettingsDialog.tsx:101-121`; the code comment explains that routine STREGA runs close on their own timer). Cancel deletes a queued open but does not close an open valve; once the valve is open it answers `409 actuation_handed_off` (`model/irrigation.ts:141-144`). A tutorial beat that teaches "stop the run early" must therefore point at Valve settings, whose Save button next to it is refused.

T2 adds no write route: the LSN50 only adds a rename target. The T4 trigger form also offers Sensor 3 and Dendro (`ScheduleSection.tsx:32-37,46`); those bodies get the **refused** text at T4 (and the tier text below T4, where the whole route is a tier refusal).

Named exceptions and judgement calls:

- `disable-all` is not literally "the zone trigger schedule", but it only sets `enabled: false` on trigger schedules (`model.ts:1005-1011`). Allowed at T4; refused with the tier text below T4.
- `/auth/login` is the only session call the app needs: after "Log out", `setSessionUser(null)` makes `GET /api/me` answer 401 (`model/sessions.ts:43,86-90`) and the app shows the Login page. Never log the password. `POST /auth/register` is refused (it creates accounts, `model/sessions.ts:70-84`).
- Display preferences are not requests: they live in `localStorage` (`src/utils/displayPreferences.ts:5-17`). The phone's memory storage allows them, with two rules: pin `osi.defaults.timezone` to the farm zone (setItem coerces it) because `demo/public/datetime.ts:13-15` prefers it over the gateway zone, and do **not** copy the display time zone into `sim.state.settings.defaultTimezone` as `demo/runtime.ts:36-38` does (only zone creation reads it, `demo/model/farm.ts:15`, and zone creation is refused).
- The valve-cancel route is `/api/valve/:eui/cancel` in both app and simulator (`api.ts:649`, `demo/route-dispositions.ts:13`).

Reads (GET) are allowed at every tier except the refused GETs in 1.3. `POST /api/analysis/series` is a read (`demo/revalidation.ts:15-20`) but only the analysis page and the internal mobile history use it, and both are unreachable in the public build (`src/App.tsx:22-24,87-94`), so it is refused.

### 1.3 Refused routes

Every other method and path is refused. Grouped, with whether a player reaches the control in normal use (dashboard, Settings, account menu at a phone-width viewport). The History tab is hidden because the simulator reports `dataModuleEnabled: false` (`demo/model/preferences.ts:4-9`, read by `src/hooks/useGatewayModules.ts:60-67`, gating `src/components/AppHeader.tsx:71-73` and the zone-card Data link `IrrigationZoneCard.tsx:331,501-508`). The hook shows **every** module only when `GET /api/system/settings` has failed with no earlier data (`useGatewayModules.ts:24-39`), so the bridge must never answer that GET with an error, including from the closed-phone cache (4.3): the app reads it at mount while the phone is open, so pin that cache entry (never evicted) and serve it while closed, never `phone_asleep`. If it did fail, the Data and Journal tabs would appear, the History rows in 3.2 would count as reached, and the auto-fired `POST .../opened` would raise a refusal notice on every card open.

| Group | Routes (method path) | Callers | Reached in normal use? | Simulator handler |
|---|---|---|---|---|
| Device add/remove/assign | `POST /api/devices`; `DELETE /api/devices/:eui`; `PUT/DELETE /api/irrigation-zones/:id/devices/:eui` | `AddDeviceModal.tsx:81`, `ZoneDeviceModal.tsx:90,142`; `StregaValveCard.tsx:881`, `useDeviceRemoval.ts:62`, `valves/ValveControlPanel.tsx:278`; `IrrigationZoneCard.tsx:262` | **Yes**: dashboard add menu, valve card and valve panel "Remove", zone card "remove from zone" | `model.ts:1205-1223`; `:1224-1229` → `removeDevice` `:287-309`; `:1161-1168` |
| Device config | `PUT /api/devices/:eui/{dendro,temp,rain-gauge,flow-meter,chameleon,lsn50/mode,lsn50/interval,lsn50/interrupt-mode,lsn50/5v-warmup,dendro-config,chameleon/depth,watermark/calibration,kiwi/interval,soil-moisture-depths,reference-tree,zone-assignments,sdi12/config}`; `POST .../{dendro-baseline/reset,chameleon/refresh-calibration,kiwi/temperature-humidity/enable,sdi12/identify,sdi12/recipe/apply,sdi12/recipe/rollback}`; `DELETE .../watermark/calibration`; `PUT .../{installation-location,radio-configuration}` | `api.ts:1339-1430,1575,2421,693-725` | **Yes** at T1 (KIWI card interval, temperature/humidity, depths) and T2 (LSN50 settings: mode, interval, rain/flow toggles, `DraginoSettingsModal.tsx`) | `model.ts:1230-1246` → `deviceRoute` `:675-910`; location/radio `model.ts:633-634` → `model/network.ts` |
| STREGA service | `PUT /api/devices/:eui/strega/{interval,model,timed-action,magnet,partial-opening,flushing}` | `StregaValveCard.tsx:352-476` via `api.ts:1437-1474`; `valves/ValveServiceDialog.tsx` | **Yes** at T3 (service controls on the valve card) | `model/irrigation.ts:303-304` → `executeStregaServiceCommand` `:150-284` |
| Valve settings other than `default_open_minutes` | `PUT /api/valves/:eui/settings` with `strega_generation`, `flow_rate_lpm` or `flow_rate_source` | `valves/ValveSettingsDialog.tsx:84-91` | **Yes** at T3 (Valve settings, Save) | `model/irrigation.ts:83-101` |
| Zone create/delete/config | `POST /api/irrigation-zones`; `DELETE /api/irrigation-zones/:id`; `PUT .../config`; `POST .../calibration`; `PUT .../location`; `PUT .../rain-source` | `CreateZoneModal.tsx:42`; `IrrigationZoneCard.tsx:250`; `ZoneConfigModal.tsx:419,434,449`, `AdvancedScheduleDrawer.tsx:99,265`; `ZoneRainGaugeField` | **Yes**: add menu, zone delete, zone settings Save | `model.ts:1031-1038`, `:1086-1098`, `:1103-1111`, `:1112-1119`, `:1120-1124`; rain-source PUT has no handler → 501 at `model.ts:1254` |
| Conditional irrigation | `PUT /api/irrigation-zones/:ref/irrigation-policy`; `POST .../irrigation-policy/{pause,retry-valve}` | `IrrigationPolicyEditor.tsx:439,464,491` | **Yes**: "Configure conditional irrigation" in the trigger section, every tier (`ScheduleSection.tsx:380-387`) | `model.ts:1053-1067` (enabled conditional PUT → 503 `qualification_unavailable`, else 501); a UUID-addressed path misses the `\d+` matcher → 501 at `model.ts:1254` |
| Trigger below T4 | `PUT /api/irrigation-zones/1/schedule`, `POST .../schedules/disable-all` | as in 1.2 | **Yes** at T1-T3 (trigger section is shown whenever `schedulerUi` is on, `IrrigationZoneCard.tsx:780-787`); tier text | `model.ts:1169-1203`, `:1001-1013` |
| Valve routes below T3 | all `/api/valve/...` and `/api/valves/...` writes | — | No (no valve registered, the panel hides, `FarmingDashboard.tsx:316`) | as in 1.2 (404 `missing` without a valve) |
| System | `PUT /api/system/settings` (time zone and modules); `POST /api/system/fan`; `POST /api/system/reboot` | `SettingsPage.tsx` via `api.ts:1695-1698`; `SystemPanel.tsx:83,96` | **Yes**: Settings page | `model.ts:1000` → `saveSystemSettings` `:267-283`; fan `:1022-1029`; reboot `:1030` |
| Account link and sync | `POST/DELETE /api/account-link`; `POST /api/sync/force` | `AccountLink.tsx:61,93,108,127` | **Yes**: account menu "OSI Server" (`AppHeader.tsx:133`). Refuse **before** logging: the body carries credentials (`api.ts:1715-1720`) | `model.ts:992-998` → `model/sessions.ts:99-123`; `:999` |
| Register | `POST /auth/register` | `api.ts:306-309` | Only from the Login page | `model.ts:930` → `model/sessions.ts:70-84` |
| Users and grants | `/api/users...`, `/api/grants...` writes | `api.ts:348-387` | No (`role: 'researcher'`, `model/sessions.ts:47`; admin pages are `AdminOnly`) | `model.ts:923-928` → `permissionDenied` |
| Support | `POST /api/improvement-requests` | `api.ts:2412` | **Yes**: support page from the account menu | `model.ts:1014-1021` |
| History writes | `PUT .../cards/:card/preferences`; `POST .../cards/:card/opened`; `POST/PUT/DELETE /api/history/workspaces...` | `HistoryDashboard.tsx:212,243,304-326`, `HistoryCardDetailPage.tsx:727` | No (History tab hidden). If a tutorial ever links `#/history`, allow `opened` (it fires on every card open and its error is swallowed, `HistoryCardDetailPage.tsx:727`) or the player sees a refusal on each card | `model.ts:627-632` → `model/history.ts:388-400,454-472` |
| Analysis, journal, network | `POST/DELETE /api/analysis/...`; all `/api/journal/...`; `/api/network/...` | `api.ts:2121-2139`, `journalApi.ts`, `api.ts:687-695` | No (routes redirect in the public build, `App.tsx:87-94,108,140-147`) | `model.ts:913-918` (analysis), `:919-922` (journal), `:633-634` (network) |
| **Refused GETs** (data export) | `GET /api/history/export.csv`, `GET /api/history/zones/:id/export.csv`, `GET /api/journal/export.*` | `DataExportSection.tsx:49` via `api.ts:2320,2347`; `journalApi.ts:203` | **Yes**: zone settings, "Download" (`ZoneConfigModal.tsx:571`) | `model.ts:627-632` → `model/history.ts:475` onward; journal export via `:919-922` |
| Refused GETs (unreachable modules) | `GET /api/network/*`, `GET /api/journal/*`, `GET /api/history/gateways/*` | — | No; refuse anyway (network observation ids are assigned on read, `demo/model/network.ts:115`) | `model.ts:633-634`, `:919-922`, `model/history.ts:407-450` |

### 1.4 Refusal answer and notice texts

The bridge answers a refusal without calling the simulator:

```ts
{status: 403, headers: {'content-type': 'application/json'},
 data: {error: 'game_refused' | 'game_tier', message: <localised text below>}}
```

The phone passes its own `onError` to `createDemoAdapter` (do not reuse `demo/runtime.ts:113-117`). It maps `game_refused` and `game_tier` to the texts below, maps the simulator's own `unsupported` (501) to the refused text, and shows nothing for `phone_asleep`. The axios error message is the `message` field (`demo/adapter.ts:78-81`), so components that print `err.response.data.message` (for example `StregaValveCard.tsx:863`, `ScheduleSection.tsx:342`) show the same sentence.

| Locale | `game_refused` | `game_tier` |
|---|---|---|
| en | Not part of this game. Nothing was changed. | Your farm needs a higher OSI level for this. Nothing was changed. |
| de-CH | Im Spiel nicht enthalten. Es wurde nichts geändert. | Dafür braucht dein Hof eine höhere OSI-Stufe. Es wurde nichts geändert. |
| fr | Cette action ne fait pas partie du jeu. Rien n’a été modifié. | Votre ferme a besoin d’un niveau OSI supérieur pour cela. Rien n’a été modifié. |
| it | Questa azione non fa parte del gioco. Non è stato modificato nulla. | Per questo la tua azienda ha bisogno di un livello OSI superiore. Non è stato modificato nulla. |
| es | Esta acción no forma parte del juego. No se ha cambiado nada. | Tu finca necesita un nivel de OSI superior para esto. No se ha cambiado nada. |
| pt | Esta ação não faz parte do jogo. Nada foi alterado. | A sua quinta precisa de um nível OSI superior para isto. Nada foi alterado. |
| lg | Ekikolwa kino tekisoboka. (existing `noticeUnsupported`, `demo/public/locales/lg.json`) | same existing sentence; a dedicated Luganda tier sentence needs a reviewer |

The de-CH informal "du" matches `demo/public/locales/de-CH.json` ("Prüfe die eingegebenen Werte."). The refusal wording matters most for the "Yes" rows in 1.3: Remove device, Add device, Create zone, zone settings Save and Download, LSN50 and KIWI settings, valve service controls, Valve settings Save, conditional irrigation, trigger Save below T4, Settings time zone and modules, fan, reboot, OSI Server link, support request.

### 1.5 Simulator answers the app handles itself (no notice)

Pass these through unchanged and suppress the phone notice; the component already renders its own outcome:

- `409 actuation_handed_off`, `503 transport_uncertain`, `404 no_active_actuation` from cancel (`model/irrigation.ts:128,142-147`; read by `valveCancelResultFromError`, `valves/ValveControlPanel.tsx:161-165`).
- `422 plan_conflict` from schedule create/update (`api.ts:2014-2027`; the dialog lists the clashing windows).
- `401 unauthenticated` from `GET /api/me` after logout and `401 invalid_credentials` from login (the Login page reports it).
- `name_*` rename reasons keep the existing mapping to `rename.reason.*` (`demo/runtime.ts:115-116`).
- `409 busy` keeps the existing "cancel the active opening first" notice.

Every other simulator error on an allowed route (`invalid`, `invalid_threshold`, `invalid_duration`, `invalid_trigger_metric`, `invalid_fire_at`, `invalid_weekdays`, `invalid_start_time`, `invalid_status`, `missing`, `not_found`, ...) keeps the existing public mapping, which ends in `noticeInvalid` ("Check the entered values.", `demo/runtime.ts:69`). That text is right for these validation answers; the bridge's own body validation (1.1) should answer `422 {error: 'invalid'}` so it gets the same text.

### 1.6 Logging

- Allowed non-GET: log `{method, path, body, simNow}` as replay input (plan 4.8), password removed for `/auth/login`.
- Refused request: log `{method, path, code, simNow}` without the body (account link and login bodies carry credentials). Refusals do not reach the simulator and are not replay input.
- GET: `api_read` with the path only, and only while the phone is open (section 4).

## 2. Labels

### 2.1 Where the water verdict renders

| Place | Component | Text keys |
|---|---|---|
| Zone card, "Action" tile, verb | `IrrigationZoneCard.tsx:700-710`, `formatWaterAction` `:117-122` | `zone.water.actionTitle`; `zone.water.action.<code>` (`delay_irrigation`, `irrigate_today`, `monitor_today`) |
| Zone card, line under the verb | `IrrigationZoneCard.tsx:706-709`, `drivenByBalanceText` `:321-325` | `zone.water.drivenByBalance` (the simulator never sets `water.rainSource`, `demo/fixtures.ts:57-64`, so `drivenByWaterBalanceFromStation` and `drivenByWaterBalanceFromWeather` are not reached; `drivenByDendro` needs a dendrometer, absent in M1) |
| Zone card, insufficient-data state | `IrrigationZoneCard.tsx:712-719` | `zone.water.insufficientData`, `zone.water.reason.<reasonCode>` |
| Zone card, subtitle under "Water balance" | `IrrigationZoneCard.tsx:603-609`, `formatWaterSubtitle` `:148-160` | `zone.water.reason.<reasonCode>` (the reason, not the verb) |
| Detailed Water tab, Balance tile | `environment/WaterTab.tsx:517-526`, `actionLabel` `:354-359` | label `environment.water.balance`, detail `zone.water.action.<code>`; **no source line** |
| Water tab, "Last 7 days" help | `environment/WaterTab.tsx:373-385`, `:546-548` | `zone.water.reason.<reasonCode>` |

The simulator's verdict comes from `demo/model/water-action.ts:10-26` via `demo/model.ts:559-566`. Only the Balance tile carries a verb without any "simulated" wording.

### 2.2 What `applyPublicCopy` changes and what the phone restores

`applyPublicCopy` (`demo/public-copy.ts:15-36`, called at `demo/runtime.ts:18`) adds bundles with overwrite. For `devices` it sets `irrigationOutcomes.empty`, `zone.water.drivenByBalance` = `sensorAdvice`, `environment.water.trendNoteMeasured` (lg only), `environment.source.{meteoswiss: 'MeteoSwiss', illustrative, weatherData, weatherConditions, cropCoefficient}`, `environment.description.weatherConditions`, `zoneConfig.{locationAvailable, locationUnavailable}`; plus `settings.requestSaved`, `auth.login.demoHelp`, `accountLink.form.demoNotice`, `accountLink.errors.*`, `history.history.source.weatherData`, `common.analysis.tray.weatherData`.

The phone keeps `applyPublicCopy` and then applies `applyPhoneCopy(i18n)` (all seven locales, `addResourceBundle(lang, 'devices', …, true, true)`), which must restore or replace:

- `zone.water.drivenByBalance` → `WATER_COPY[lang].advice` (`demo/water-copy.ts:3-9`), undoing `public-copy.ts:20`.
- `environment.source.meteoswiss` → the game provider label (undoing `public-copy.ts:23`).
- `environment.source.illustrative` → the illustrative label (undoing "Weather data" from `public-copy.ts:23`).
- `auth.login.demoHelp` keeps "Demo farmer / demo" (still correct for the phone).

### 2.3 Phone overrides: verdict

| Key | Value per locale |
|---|---|
| `devices:zone.water.drivenByBalance` | `WATER_COPY[lang].advice`: en "Simulated sensor advice"; de-CH "Simulierte Sensor-Empfehlung"; fr "Conseil simulé à partir des capteurs"; it "Consiglio simulato dai sensori"; es "Recomendación simulada de los sensores"; pt "Recomendação simulada dos sensores"; lg "Amagezi agateeberezeddwa okuva ku bipima" |
| `devices:zone.water.drivenByWaterBalanceFromWeather`, `devices:zone.water.drivenByWaterBalanceFromStation` (defensive, not reached in M1) | same `WATER_COPY[lang].advice` |
| `devices:environment.water.balance` | composed at runtime: `${shipped environment.water.balance} · ${WATER_COPY[lang].advice}`. en "Balance · Simulated sensor advice"; de-CH "Bilanz · Simulierte Sensor-Empfehlung"; fr "Bilan · Conseil simulé à partir des capteurs"; it "Bilancio · Consiglio simulato dai sensori"; es "Balance · Recomendación simulada de los sensores"; pt "Balanço · Recomendação simulada dos sensores"; lg "Balance · Amagezi agateeberezeddwa okuva ku bipima" |

This labels the tile that carries the verb in the Water tab, reuses only existing translated strings (lg included) and touches no `src/` file. `zone.water.action.*` stays unchanged so the verb is not doubled on the zone card.

### 2.4 Provider and country names in `public/locales/*/`

Scan of all 7 locales × 12 namespaces (regex over Open-Meteo, MeteoSwiss and its localised forms, and the country name in seven languages): 16 keys, each present in all seven locales. Render sites from `grep` over `src/`:

| Key (namespace `devices` unless noted) | en value (shortened) | Rendered at | Reached in M1? | Policy |
|---|---|---|---|---|
| `environment.water.attribution.open_meteo` | "Weather data by Open-Meteo.com, CC BY 4.0" | `environment/WeatherTab.tsx:172-176` (when `forecast.source` contains `open_meteo`), `environment/WaterTab.tsx:281-283` | **Yes** from T2: the forecast source is the provider id (`demo/model/environment.ts:230`) | Override: "Weather data from the game's weather service (simulated)" |
| `environment.water.et0Tier.provider_open_meteo` | "Open-Meteo model" | `WaterTab.tsx:223-224` | No after the hook (`et0Source: 'fao56_daily_game_weather'`); yes without it (`environment.ts:81`) | Override: GAME label |
| `environment.water.et0Tier.provider_meteoswiss` | "MeteoSwiss {{station}}" | `WaterTab.tsx:221-222` | No | Override: GAME label |
| `environment.water.et0Tier.open_meteo_daily` | "Open-Meteo weather model, daily FAO-56" | `WaterTab.tsx:218-220` | No (cloud-linked only) | Override: "GAME label, daily FAO-56" |
| `environment.water.stationCredit` | "Source: MeteoSwiss" | `WaterTab.tsx:284-286` | No | Override: "Source: GAME label" |
| `environment.water.computedBy.cloud` | "ET0 from the Open-Meteo weather model …" | `WaterTab.tsx:327` | No (cloud-linked only) | Override: "ET0 from the game's weather service (simulated)" |
| `environment.water.demandMixedStation`, `environment.water.demandUnknownStation` | "… MeteoSwiss stations …" | `WaterTab.tsx:187-189` | No | Override: generic "hours from two weather stations" / "Weather station unknown for these hours" |
| `zone.water.rainFromStation`, `zone.water.drivenByWaterBalanceFromStation` | "Measured at MeteoSwiss {{station}} …" | `WaterTab.tsx:412`, `IrrigationZoneCard.tsx:301,322` | No | Override (2.3 for the second; generic "Measured at weather station {{station}} ({{distance}} km away)" for the first) |
| `zoneConfig.weatherProviderOption.open_meteo` | "Open-Meteo" | `ZoneConfigModal.tsx:511,923` | **Yes**: zone settings select (Save is refused, but the dialog opens) | Override: GAME label |
| `zoneConfig.weatherProviderOption.meteoswiss` | "MeteoSwiss" | same select | **Yes** | Override: "Not available in this game" |
| `zoneConfig.weatherProviderOption.auto` | "Gateway default ({{provider}})" | `ZoneConfigModal.tsx:512-517` | **Yes** (interpolates the open_meteo label) | Override: "Gateway default: {{provider}}" (avoids nested brackets) |
| `zoneConfig.weatherProviderHelp` | "… MeteoSwiss covers [the country] …" | `ZoneConfigModal.tsx:910-914` | **Yes** (help tip) | Override with game text (2.5) |
| `environment.source.open_meteo` | "Open-Meteo" | only `OnlineTab.tsx:40`, which no component imports | No | Override anyway (cheap) |
| `environment.water.meteoswissCloudNote` | "… uses MeteoSwiss …" | no reader in `src/` | No | None |
| `common:analysis.aggregation.help` | "… Open-Meteo hourly temperature …" | `CrossZoneAnalysisPage.tsx:253-254` | No (`/analysis` redirects in the public build) | None |

Not in the JSON but rendered with a provider name: `environment.source.meteoswiss` (added by `public-copy.ts:23`, so it renders "MeteoSwiss" in every locale) and the `WEATHER_SOURCE_FALLBACK` defaults (`ZoneConfigModal.tsx:107-111`, used only if a key is missing; all seven locales have the keys).

Replacement policy: one GAME label per locale, used for every provider id the game resolves to (`open_meteo` via `auto`), "Not available in this game" for the provider the game never uses, generic station wording for station-only keys, and no key left that names a real provider or country. Overrides go after `applyPublicCopy`.

### 2.5 Override strings (seven locales)

lg keeps English for new sentences: the shipped lg values of these keys are English already (`public/locales/lg/devices.json`), and no new Luganda is composed here.

| Text | en | de-CH | fr | it | es | pt | lg |
|---|---|---|---|---|---|---|---|
| GAME label | Weather service (game) | Wetterdienst (Spiel) | Service météo (jeu) | Servizio meteo (gioco) | Servicio meteorológico (juego) | Serviço meteorológico (jogo) | Weather service (game) |
| attribution | Weather data from the game's weather service (simulated) | Wetterdaten vom Wetterdienst des Spiels (simuliert) | Données météo du service météo du jeu (simulées) | Dati meteo dal servizio meteo del gioco (simulati) | Datos meteorológicos del servicio meteorológico del juego (simulados) | Dados meteorológicos do serviço meteorológico do jogo (simulados) | (en) |
| daily FAO-56 | Weather service (game), daily FAO-56 | Wetterdienst (Spiel), tägliche FAO-56 | Service météo (jeu), FAO-56 quotidienne | Servizio meteo (gioco), FAO-56 giornaliera | Servicio meteorológico (juego), FAO-56 diaria | Serviço meteorológico (jogo), FAO-56 diária | (en) |
| station credit | Source: weather service (game) | Quelle: Wetterdienst (Spiel) | Source : service météo (jeu) | Fonte: servizio meteo (gioco) | Fuente: servicio meteorológico (juego) | Fonte: serviço meteorológico (jogo) | (en) |
| computedBy.cloud | ET0 from the game's weather service (simulated) | ET0 vom Wetterdienst des Spiels (simuliert) | ET0 du service météo du jeu (simulée) | ET0 dal servizio meteo del gioco (simulata) | ET0 del servicio meteorológico del juego (simulada) | ET0 do serviço meteorológico do jogo (simulada) | (en) |
| not in game | Not available in this game | Im Spiel nicht verfügbar | Non disponible dans ce jeu | Non disponibile in questo gioco | No disponible en este juego | Indisponível neste jogo | (en) |
| auto | Gateway default: {{provider}} | Gateway-Standard: {{provider}} | Par défaut de la passerelle : {{provider}} | Predefinito del gateway: {{provider}} | Predeterminado del gateway: {{provider}} | Predefinição do gateway: {{provider}} | Gateway default: {{provider}} |
| provider help | In this game the weather service is part of the game. It supplies the forecast and the daily weather that OSI uses to compute ET0. With Local weather station only, the zone gets no ET0. | In diesem Spiel gehört der Wetterdienst zum Spiel. Er liefert die Vorhersage und das Tageswetter, aus dem OSI die ET0 berechnet. Mit «Nur lokale Wetterstation» erhält die Zone keine ET0. | Dans ce jeu, le service météo fait partie du jeu. Il fournit la prévision et la météo du jour dont OSI se sert pour calculer l’ET0. Avec « Station météo locale uniquement », la zone n’a pas d’ET0. | In questo gioco il servizio meteo fa parte del gioco. Fornisce la previsione e il meteo giornaliero con cui OSI calcola l’ET0. Con «Solo stazione meteo locale» la zona non ha ET0. | En este juego, el servicio meteorológico forma parte del juego. Proporciona el pronóstico y el tiempo diario con el que OSI calcula la ET0. Con «Solo estación meteorológica local», la zona no tiene ET0. | Neste jogo, o serviço meteorológico faz parte do jogo. Fornece a previsão e o tempo diário que o OSI usa para calcular a ET0. Com «Apenas estação meteorológica local», a zona não tem ET0. | (en) |
| illustrative | Illustrative values (game) | Beispielwerte (Spiel) | Valeurs indicatives (jeu) | Valori illustrativi (gioco) | Valores ilustrativos (juego) | Valores ilustrativos (jogo) | Illustrative values (game) |
| station rain | Measured at weather station {{station}} ({{distance}} km away) | Gemessen an der Wetterstation {{station}} ({{distance}} km entfernt) | Mesurée à la station météo {{station}} (à {{distance}} km) | Misurata alla stazione meteo {{station}} (a {{distance}} km) | Medida en la estación meteorológica {{station}} (a {{distance}} km) | Medida na estação meteorológica {{station}} (a {{distance}} km) | (en) |
| two stations | hours from two weather stations | Stunden von zwei Wetterstationen | heures de deux stations météo | ore da due stazioni meteo | horas de dos estaciones meteorológicas | horas de duas estações meteorológicas | (en) |
| station unknown | Weather station unknown for these hours | Wetterstation für diese Stunden unbekannt | Station météo inconnue pour ces heures | Stazione meteo sconosciuta per queste ore | Estación meteorológica desconocida para estas horas | Estação meteorológica desconhecida para estas horas | (en) |

The non-English sentences above need a native-speaker pass before release; they follow the wording of the shipped keys they replace.

### 2.6 `preferredSource`

`buildEnvironmentSummary` sets `agronomic.preferredSource` to `Illustrative ${provider}` (`demo/model/environment.ts:226`). No component in `src/` reads it (only the type, `src/types/farming.ts:943`), so it never renders. The hook does not change it. No override needed; mention it in the honesty ledger only if the game shows raw API data.

### 2.7 Smoke assertion

Assert on the Weather, Water and zone-settings screens, in all seven locales, that the document text and every `title`/`aria-label` match none of `/Open-?Meteo|MeteoSwiss|MeteoSchweiz|MétéoSuisse|MeteoSvizzera|open_meteo|meteoswiss/i`, and that the Balance tile and the Action tile contain the `WATER_COPY[lang].advice` string.

## 3. Browser time zone

### 3.1 What is already fixed

- The Vite pre-plugin replaces every `utils/datetime` import with `demo/public/datetime.ts` in public mode (`vite.demo.config.ts:6-8,21-24`). Its `formatTime`, `formatDate`, `formatDateTime` and `formatWeekday` default `timeZone` to the display-preference zone, else the gateway zone (`demo/public/datetime.ts:13-24`), and `useDateFormat` re-renders on a zone change (`:34-47`). `relativeToNow` needs no zone. Every component that formats through `useDateFormat()` is correct for **formatting an instant**.
- `ValveScheduleDialog` converts wall-clock input with the valve zone explicitly (`valves/ValveScheduleDialog.tsx:64-118`), so weekly and one-time plans use the farm zone.
- `RainTodayTile` formats the rain day in UTC from a date string and schedules its rollover from the farm zone (`shared/RainTodayTile.tsx:35,43`).
- The timezone store defaults to the demo's seed zone (`demo/timezone-store.ts:2`); the phone must call `setGatewayTimezone('Etc/GMT-3')` at boot (plan 4.6 step 4). `demo/datetime.ts:5` (presentation build) hard-codes the seed zone and must not be the alias target.

### 3.2 Residual mismatches on screens the phone reaches

Effect sizes assume farm UTC+3 (`Etc/GMT-3`) and a browser at offset `B` hours.

| Screen | Code | What uses the browser zone | Effect | Fixed by |
|---|---|---|---|---|
| Zone card → Weather tab, day strip | `environment/WeatherTab.tsx:274,315` | `new Date().toDateString()` vs `new Date(day.date + 'T12:00:00').toDateString()` | The "today" highlight is on the wrong card or missing for \|B−3\| hours of each farm day | Level B |
| Weather tab, day labels | `WeatherTab.tsx:26-36` (`isSameCalendarDay` uses `setDate/getDate/toDateString`; `fmtDay` parses local noon) | browser calendar | "Today"/"Tomorrow" shifted for \|B−3\| hours per farm day; weekday label off by one for B ≤ −9 | Level B |
| Weather tab, next-rain ETA | `WeatherTab.tsx:43-50` | `isSameCalendarDay` | "today"/"tomorrow" word wrong in the same windows (the clock time is right) | Level B |
| Water tab, chart day labels | `environment/WaterTab.tsx:437-439` via `parseCalendarDay` (`src/utils/datetime.ts:69-75`) | local noon, then formatted in the farm zone | One day late for B ≤ −9 (12 − B + 3 ≥ 24); the "Today" label and reference line use the server's `todayDate` and are right | Level B |
| Trigger section → advanced drawer | `AdvancedScheduleDrawer.tsx:193,353` | `toLocaleString()` (browser zone and browser locale) | last-triggered and computed-at times in browser time | Level A |
| Rain gauge monitor (LSN50, T2+) | `RainMonitor.tsx:49` | `toLocaleString(undefined, {hour, minute})` | hourly axis in browser time and browser locale | Level A |
| Settings → system panel | `SystemPanel.tsx:117` | `toLocaleTimeString()` | "updated" time in browser time | Level A |
| Zone settings, stage start prefill | `ZoneConfigModal.tsx:34-37` (`localTodayIso`) | `getFullYear/getMonth/getDate` | prefill is the browser's date (config Save is refused anyway) | Level B |
| History (reachable by URL only; not in nav) | `components/history/visualizations/chartAxis.ts:48-60,80-110`, `*ChartView.tsx` formatters, `TimelineBrush.tsx:26-27`, `mobile/HistoryInspectorSheet.tsx:55` | `Intl.DateTimeFormat(undefined, …)`, `toLocaleString()`, `getDate` | axis labels in browser time | Level A (+B for `sameCalendarDay`) |
| History data | `src/history/useTimeViewport.ts:49-50,202`, `desktop/HistoryDesktopDetail.tsx:124` | `Intl.DateTimeFormat().resolvedOptions().timeZone` sent as the `timezone` query parameter | daily buckets computed in the browser zone by the simulator (`demo/model/history.ts:110` reads `timezone` for zone cards) | Level A |
| Display-preference default zone | `src/utils/displayPreferences.ts:183-195` | `resolvedOptions().timeZone` when no zone is stored | shown in Settings; seeding `osi.defaults.timezone` covers it | seeded key |

`WindMonitor.tsx`, both `DendrometerMonitor.tsx` and `ForecastTab.tsx` also use browser time, but M1 has no wind sensor or dendrometer and `ForecastTab` is not imported anywhere.

### 3.3 Fix without `src/` changes

Install in the phone realm, before any app import (in `phone/bootstrap.ts`, after the storage shim). It changes only the iframe's own `Date` and `Intl`; the game realm is separate. `FARM_ZONE` is `'Etc/GMT-3'` (fixed offset, no daylight saving, plan D6). <!-- slop-allow: "realm" is the ECMAScript term for a JS global environment -->

**Level A: Intl and toLocale defaults (about 25 lines).**

```ts
const FARM_ZONE = 'Etc/GMT-3';
const NativeDTF = Intl.DateTimeFormat;
const withZone = (o?: Intl.DateTimeFormatOptions) => (o && o.timeZone ? o : {...o, timeZone: FARM_ZONE});
const DTF = new Proxy(NativeDTF, {
  construct: (t, [locales, options]) => Reflect.construct(t, [locales, withZone(options)]),
  apply: (t, self, [locales, options]) => Reflect.apply(t, self, [locales, withZone(options)]),
});
Object.defineProperty(Intl, 'DateTimeFormat', {value: DTF, writable: true, configurable: true});
for (const name of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'] as const) {
  const native = Date.prototype[name];
  Object.defineProperty(Date.prototype, name, {configurable: true, writable: true,
    value(this: Date, locales?: string | string[], options?: Intl.DateTimeFormatOptions) {
      return native.call(this, locales, withZone(options)); }});
}
```

`Intl.DateTimeFormat().resolvedOptions().timeZone` then reports the farm zone, which fixes the history query parameter. `instanceof Intl.DateTimeFormat`, `supportedLocalesOf` and `formatToParts` keep working through the proxy (`get` falls through). This also covers every `src/` caller that passes `undefined` as locale and no zone.

**Level B: local-calendar Date methods (about 60 lines).** For a fixed-offset zone the local view is exact: `local(t) = t + 3 h` read with UTC methods.

- Replace `getFullYear/getMonth/getDate/getDay/getHours/getMinutes/getSeconds/getMilliseconds` with the `getUTC*` method on `new NativeDate(t + OFFSET)`; `getTimezoneOffset` returns `-180`.
- Replace `setFullYear/setMonth/setDate/setHours/setMinutes/setSeconds/setMilliseconds`: shift by `+OFFSET`, call the `setUTC*` equivalent, shift back.
- `toString/toDateString/toTimeString`: format from the shifted value with a `GMT+0300` suffix.
- Constructor (extend the existing `Date` proxy, plan 4.6 step 5): with ≥ 2 numeric arguments return `Date.UTC(...args) - OFFSET`; with one string argument that is an ISO date-time without `Z` or offset (`/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d+)?)?$/`), parse it as UTC and subtract `OFFSET`; date-only strings stay UTC per spec. `Date.parse` gets the same rule. Calling `Date()` without `new` returns the patched `toString` of `sim.now`.
- `Date.UTC`, `getUTC*`, `toISOString`, `getTime` stay native.

Risks:

- Libraries in the phone (Recharts, its d3 scales) then also see farm-local time. That is the intent, and they stay self-consistent because getters, setters and the constructor agree.
- Non-ISO date strings (implementation-defined parsing) are not covered by Level B; `src/` uses ISO strings and `YYYY-MM-DD` only (grep of the residual list above).
- A zone with daylight saving would need per-instant offsets via `NativeDTF`; M1 uses a fixed offset, so keep a guard that throws at boot if `FARM_ZONE` is not a fixed-offset `Etc/GMT±N` zone.
- Level A alone leaves the WeatherTab today marker and day words, the Water chart labels for B ≤ −9 and the stage prefill wrong. Level B is the smallest fix that removes every row in 3.2.
- Patching `Date.prototype` costs a few hundred nanoseconds per call; the phone formats a few hundred dates per render.

Proof (Playwright, phone build): run the phone smoke with `timezoneId` set to `Pacific/Honolulu` (B = −10), `America/Los_Angeles`, `UTC` and `Asia/Tokyo`, at a farm time chosen so that the browser date differs from the farm date. Assert: the WeatherTab card highlighted as today has `day.date === water.todayDate`; the first strip card reads "Today"; the Water chart's first tick matches the farm date six days back; the history request carries `timezone=Etc%2FGMT-3`; AdvancedScheduleDrawer times equal the farm clock. None of this is verified here (no browser run in this task).

## 4. Polling while the phone is mounted

### 4.1 Pollers

| Poller | Interval | Calls | Source |
|---|---|---|---|
| Dashboard devices (SWR) | 10 s, plus on focus | `GET /api/devices` | `FarmingDashboard.tsx:57-64` |
| Dashboard zones (SWR) | 10 s, plus on focus | `GET /api/irrigation-zones` | `FarmingDashboard.tsx:67-74` |
| Dashboard valves (SWR, only with a STREGA, T3+) | 10 s | `GET /api/valves` (lazily creates valve runtime, section 6) | `FarmingDashboard.tsx:94-101`; shared key with `valves/ValveControlPanel.tsx:58-60` |
| Recent actuations (SWR) | 60 s | `GET /api/irrigation/recent-actuations` | `FarmingDashboard.tsx:107-115` (the outcomes panel is fed from it, `:490-491`) |
| Restart banner (always mounted) | 30 s | `GET /api/system/stats` | `src/App.tsx:31`, `GatewayRestartBanner.tsx:20`, `hooks/useSystemStatus.ts:4,28` |
| Settings system panel | 30 s | `GET /api/system/stats` | `SystemPanel.tsx:74` |
| Zone card water summary | 5 min **and every `*` revalidation** | `GET /api/irrigation-zones/1/environment-summary` (+ recommendations only with dendrometers) | `IrrigationZoneCard.tsx:404-431` |
| Environment card | 5 min **and every `*` revalidation** | `GET /api/irrigation-zones/1/environment-summary` | `environment/EnvironmentCard.tsx:111-140` |
| Valve panel clock | 1 s | none (re-render only) | `valves/ValveControlPanel.tsx:81` |
| Valve schedule overview (SWR) | none (on mount, on revalidation) | `GET /api/valves/B3/schedules` | `valves/ValveScheduleOverview.tsx:31-34` |
| Gateway settings, features (SWR) | none | `GET /api/system/settings`, `/api/system/features` | `hooks/useGatewayModules.ts:42-45`, `history/useFeatureFlags.ts:13-20` |
| Restart countdown | 1 s | none | `GatewayRestartBanner.tsx:40` |

The two imperative summary loaders subscribe to `osi-demo:revalidate` (`src/utils/publicSimulatorInvalidation.ts:5-13`), so each `requestDemoRevalidation(['*'])` costs two environment summaries for the expanded zone plus one call per mounted SWR key (`demo/revalidation.ts:22-39`).

### 4.2 Cost

Research measured `environment-summary` at 70-115 ms with the hook's memo and up to 190 ms without (`web/farm-sim/docs/research/sim-integration.md:289-291,369`). Composition (unpatched): `publicWaterDays` calls `localCalendarDayStart` 14 times (`demo/model.ts:443-460`), each stepping minute by minute with `formatToParts` from local date − 18 h (`:70-78`), about 900 steps for UTC+3, so about 12,600 `formatToParts` calls; `syntheticDays` and `buildForecast` construct a new `Intl.DateTimeFormat` per `localDateKey` call (`demo/model/aggregation.ts:10-11`), several hundred per summary (`environment.ts:70-72,241-256`); `localEnvironment` filters each device's whole ledger (`environment.ts:174-196`); `publicWaterAction` runs a 14-day recommendation scan (`model.ts:545-566`). With the hook, `weatherSource` is called for 7 + 72 + 3 dates per summary (`environment.ts` hook lines `weather(date, provider, zone)`), so the game's source must memoise per `(issue date, target date)`. No HEAD measurement was taken by this task (6.4).

A full `*` revalidation at T3 is therefore about 2 × summary + 6 cheap reads. Derived from the research figures above (not measured here): roughly 150-400 ms on the main thread, so the plan's "once per real second" throttle would spend 15-40 % of the main thread while the phone is open.

### 4.3 Freezing the phone while closed (no unmount)

Three layers, in the phone runtime and the bridge:

1. **Bridge read cache (the guarantee).** While open, every successful GET response is stored by `method + pathname + search` (bounded LRU, 256 entries, deep-cloned). While closed, a GET is answered from the cache with `structuredClone(entry)` and **no** simulator call; a miss answers `503 {error: 'phone_asleep'}` with no notice; every non-GET answers `403 phone_asleep`. Cached answers are not logged as `api_read`. SWR compares the identical data and does not re-render.
2. **Frozen phone clock.** The phone's `Date` proxy reads `bridge.phoneNow()`, which returns `sim.now` while open and the instant of closing while closed. Relative texts ("3 min ago", valve countdowns) then stay consistent with the cached data.
3. **Optional, fewer timer fetches.** The phone does its own mount (a copy of `demo/mount.tsx` is 48 lines) with `SWRConfig value={{use: [demoRevalidation], isVisible: () => bridge.isOpen()}}`; SWR then skips refresh ticks while closed (`swr/dist/index/index.mjs:571`). This does not stop the `setInterval` pollers (zone card, environment card, system stats), so layer 1 stays required. Writing a custom mount also removes `mount.tsx:22`, which posts a `time` message with the seed zone.

On open: unfreeze the clock, keep the cache as fallback, call `requestDemoRevalidation(['*'])` once, then resume the normal throttle.

Revalidation while open: notify on meaningful events only (`sim.clock.revision` changed by an event the game stops at: sample, ACK, close, plan start, trigger; plan 4.2) and at most once every 2 real seconds, plus once after a sleep jump. Add a **same-instant memo** in the bridge: a GET with the same key, `sim.now`, `sim.clock.revision` and bridge write counter as the previous call returns the previous answer. That halves the summary cost, because both loaders ask for the same summary in the same burst. It is safe because a summary at the same instant and state is the same value (its only side effect, record retention, is idempotent at the same instant; section 6).

### 4.4 Smoke test: no simulator calls while closed

In a test build (`import.meta.env.MODE === 'test'`), the adapter exposes `window.__farmSim = {simCalls, cacheHits, cacheMisses, log}`, incremented in `bridge.request`. Playwright:

1. Boot, open the phone, wait for "Tomato bed" and network idle.
2. Close the phone. Record `simCalls` as `c0`.
3. Advance **phone timer time** by at least 6 minutes with `page.clock` (installed before boot; whether it reaches the timers of a lazily created same-origin iframe is unverified, so assert `cacheHits` grows and fall back to a test-only timer-speed hook in the phone runtime if it does not) and advance game time by several game hours, including at least one valve run.
4. Assert `simCalls === c0`, `cacheHits > 0` (the 10 s, 30 s and 5 min pollers fired and were answered), and no `api_read` entries in the log after step 2.
5. Open the phone. Assert `simCalls > c0` within 2 s and that the phone shows the newer reading or run.

## 5. soilType

The simulator accepts any value: `configureZone` copies `soilType` to `soil_type` without validation (`demo/model/farm.ts:26-45`) and nothing in `demo/` reads `soil_type`. The zone settings select offers exactly these ids (`ZoneConfigModal.tsx:77-86`):

`''` (select), `sandy`, **`sandy_loam`**, `loam`, `clay_loam`, `clay`, `silt_loam`, `other`.

`sandy_loam` exists and is the right id. `src/agronomy/crop-kc.json` has no soil list (it holds crops, stages and groups). The zone fixture stores `soil_type: 'Loam'` and `irrigation_method: 'Drip'` (`demo/fixtures.ts:13`), which match no option, so the builder should send `soilType: 'sandy_loam'` and `irrigationMethod: 'drip'` (`ZoneConfigModal.tsx:88-96`) so the settings dialog shows the world's bed.

## 6. `requestResponse` side effects

### 6.1 What a request does besides dispatch (`demo/model.ts:615-657`)

1. `this.clock.advanceTo(this.now)` (`:619`): runs every event with `atMs <= now` that has not run. It does not move time and does not call `refreshCompletedEnvironmentRecords` (only `Simulator.advanceTo`, `:330-333`, does). If an event runs, `clock.revision` increments (`model/clock.ts:60`).
2. Public-mode write tracking (`:621-623,637`): a canonical mutation bumps `sessions.pendingOutboxCount` (shown in the sync summary only).
3. The response is `structuredClone`d (`:636`).

### 6.2 State that a GET can create or change

| Effect | Code | When |
|---|---|---|
| A due event fires (valve opens, plan starts) | `model.ts:619` | Only if a previous write scheduled an event at exactly `now`. Allowed routes that do so: ONCE plan create/update with `fire_at` in `[now − 10 min, now]` (`plans.ts:213-221`). With 1 real second = 5 game minutes (plan 4.2) that 10-minute window is about 2 real seconds, so a player who sets a one-time open "now" hits it routinely. All other allowed writes schedule at `now + 2000` or later (`irrigation.ts:108,122`, `plans.ts:438,459`), and the trigger at the next 06:00 (`model.ts:240-249`) |
| Lazy valve runtime | `planRuntime` `model.ts:470-479`, called by `GET /api/valves` (`:961-977`) and `GET /api/valves/:eui/schedules` (`plans.ts:556`) | First read of a valve. The value is fixed (`state.defaultOpenMinutes` is always 1, `model/state.ts:56`; no route writes it), so a read-created runtime equals a write-created one |
| Retained past-day environment record | `environment.ts:88-90` via `recordFor`, from `environment-summary` (`syntheticDays`, `buildForecast`) and history card data (`syntheticEnvironmentTimeline`, `:106-130`) | A past date with no retained record, or a retained record with null ET0 while the zone now has a provider. The record stores `source_captured_at: iso(now)` and `provenance.capturedAt` (`:82,87`) and the zone's crop, stage, area and efficiency at that moment |
| Network observation ids | `model/network.ts:113-115` | Network page only (refused) |

### 6.3 What the game must do

1. **Flush after every write.** After each allowed phone write, each builder write and each cutoff CLOSE, call `sim.advanceTo(sim.now)` (the `Simulator` method, not `sim.clock.advanceTo`), through the game's own stepping path (plan 4.2 `advanceOsi`) so the water tap's `afterStep` drain and `bridge.notify()` see any event the flush fires. It runs any event due at `now` at the write's own instant and refreshes completed environment records when the key changed (`model.ts:256-266`). After that, no event is due at `now`, so a later GET's `clock.advanceTo(now)` is a no-op and `clock.revision` cannot change on a read.
2. **Step with `sim.advanceTo` only** (plan 4.2 already says so): it refreshes completed records after each step, so every past date in the 7-day window and the 92-day seed is retained before any read, with stamps from the step, not from a read.
3. **After the farm build, clear and reseed records once.** The builder's `PUT /api/system/settings` refreshes records (`model.ts:269`) while zone 1 still has the seed provider and coordinates, and `recordFor` then keeps any record with numeric ET0 for good (`environment.ts:61`). Order: build (plan 4.7 steps 1-7), then `sim.state.environmentRecords.clear()`, then `sim.advanceTo(sim.now)`. Without this, T1 can show past-day ET0 and demand (code-read, unconfirmed: probe 6.4 (c)/(c3)). On unpatched HEAD the values would come from the fixture series; with the hook, `recordFor` calls the game's `weatherSource` during that refresh, so they would be game weather leaking into a tier that has no weather service.
4. **Weather source must return `null`, not throw, outside its range.** History card data accepts `range=custom` with any `from`/`to` (`demo/model/history.ts:99-111`), so it can ask for dates beyond the 92 seeded days; the source must be total. A `null` input gives a record with null ET0 (`environment.ts:65,78-84`).
5. **Do not log GETs as replay input.** With 1-3 in place, reads cannot change replay state: no event fires on a read, valve runtime creation is value-neutral, and past-day records already exist with step-time stamps. Remaining read-dependence: a history read for a date older than the seeded window retains a record stamped with the read time; it is phone-visible only and not in the replay hash (plan 4.8 hashes zones, devices, outcomes and trigger evaluations).

### 6.4 Probe results (unpatched HEAD)

Not run. The script waited about 40 minutes behind the workstation heavy-job lock, which `osi-heavy status` reports as `blocked-ambiguous` (holder label `review753`, wrapper dead, flock still held by a descendant; an owner recovery decision is required, and other queued heavy jobs are blocked too). Until it runs, every statement in 6.1-6.3 is from code reading. What the probe checks, so a later run can confirm or refute:

- (a) after `advanceTo`, one round of the 16 dashboard GETs changes only `valveSettings` (lazy runtime) on the first round and nothing on the second;
- (b) a ONCE plan with `fire_at = now − 60 s` leaves the valve idle after the POST and opens it on the next GET (`clock.revision` increments on the GET);
- (c) builder order at T1 (`weatherSource: 'local'`) without the clear: zone-1 past-day records keep numeric ET0 from the settings-PUT refresh, and the summary's past days show `et0Mm`/`demandMm`;
- (c2) builder order at T2 with a GET before any `advanceTo`: whether the GET adds records, and their capture stamps;
- (c3) T1 with `environmentRecords.clear()` + `advanceTo(now)` after the build: past-day ET0 is null;
- (d) environment-summary time on unpatched HEAD (public seed farm with fictional history, `Etc/GMT-3`): min/median/max of 15 calls, and one full dashboard GET round.

## 7. CSP and sandbox

### 7.1 What the public simulator serves

- Header CSP for everything under `/simulator/` (`demo/public/serve.mjs:19,128`; identical in `demo/public/apache.conf:3`):
  `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; frame-src 'self' blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; worker-src 'none'`
- Other headers: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: geolocation=(), camera=(), microphone=()`, `Cache-Control: no-store` for HTML and non-fingerprinted files, immutable for fingerprinted assets (`serve.mjs:121-127`, `apache.conf:4-8`).
- The app iframe: `sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals"` (`demo/public/index.html:70`); `src` set by `host.ts:169`. Neither HTML file has a meta CSP (`demo/public/app.html:1-15`).

### 7.2 Phone page (`phone.html`)

Meta tag, first element in `<head>`, before any script:

```html
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; worker-src 'none'; manifest-src 'none'">
```

- `connect-src 'none'`: the phone never fetches; the runtime also replaces `fetch`, XHR, WebSocket, EventSource and `sendBeacon` (`demo/runtime.ts:79-83`).
- `frame-src 'none'` and no `allow-downloads`: exports are refused (1.3), so no blob frames or downloads are needed. If a later milestone allows a download, use `frame-src blob:` and add `allow-downloads`.
- `style-src 'unsafe-inline'` is needed for React `style` attributes and Recharts.
- The iframe document does not inherit the game page's policy; it needs its own.

### 7.3 Game page (`index.html`)

```html
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; manifest-src 'self'">
```

Conditions to confirm in the M1 build (the renderer packages are not installed here, so these are not verified):

- `connect-src 'self'`: needed only if the game fetches its own assets (Pixi `Assets` loads through `fetch`). M1 art is authored in code, so `'none'` may suffice; keep `'self'` (same origin, no third party) unless the build proves otherwise.
- `worker-src 'self'`: the autosave compression worker (`research/tech.md:163`). If Pixi's texture loader creates blob-URL workers, either add `blob:` or turn worker loading off in Pixi's texture loader config.
- No `'unsafe-eval'`: Pixi 8 generates some shader/uniform code with `new Function`; import its CSP-safe build path (`pixi.js/unsafe-eval` module) instead of loosening `script-src`.
- `frame-src 'self'` for the phone iframe.

Assert all of this in the smoke test: register `securitypolicyviolation` listeners in both documents (game and phone) and fail on any event.

### 7.4 Limits of a meta CSP, and what to add

- A meta CSP cannot carry `frame-ancestors`, `sandbox` or `report-uri`/`report-to`, and there is no meta form of `Permissions-Policy`, `X-Content-Type-Options` or `Referrer-Policy` (only `<meta name="referrer" content="strict-origin-when-cross-origin">`).
- Replacement for `frame-ancestors 'self'` on the phone: the phone bootstrap refuses to run unless `window.parent !== window` and reading `parent.location.origin` succeeds and equals `location.origin` (a cross-origin parent throws). It also needs the bridge object on `parent`, so a foreign embedder gets nothing.
- Game page on a static host: framing by another site cannot be blocked without headers; accept, or show a "open this game directly" screen when `window.top !== window`.

### 7.5 Vite preview and static hosting

- `vite preview`: set `preview.headers` in both farm-sim configs to the header form of 7.2/7.3 plus `frame-ancestors 'self'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: geolocation=(), camera=(), microphone=()`. The built HTML still carries the meta tags; both policies apply and the stricter wins.
- `vite dev`: `@vitejs/plugin-react` injects an inline refresh preamble and HMR needs a WebSocket, so the meta CSP must not be present in dev. Inject it with a `transformIndexHtml` plugin that has `apply: 'build'`.
- Static host without header control: the meta tags are the whole policy; add the frame checks of 7.4.

### 7.6 Phone iframe attributes

```html
<iframe id="phone" title="OSI OS phone" src="./phone.html#/dashboard"
  sandbox="allow-scripts allow-same-origin allow-forms allow-modals"
  referrerpolicy="no-referrer" loading="lazy"></iframe>
```

- `allow-scripts allow-same-origin`: the phone calls the parent bridge synchronously (plan 4.6 step 8). With both flags on a same-origin frame the sandbox is not a security boundary (the frame could remove it); it only blocks popups, top navigation and downloads.
- `allow-forms`: per the HTML form-submission algorithm, a document without it returns before the `submit` event fires, so React `onSubmit` handlers (login, rename forms) would stop working (from the spec, not verified in a browser here); the public simulator keeps the flag for the same reason (`demo/public/index.html:70`), and the runtime already calls `preventDefault` on every submit (`demo/runtime.ts:112`).
- `allow-modals`: `window.confirm` gates disable-all (`SettingsPage.tsx:338`) and other confirmations.
- Drop `allow-downloads` (exports are refused).
- Closed state: `inert` plus `visibility: hidden` on the iframe; freezing is done by the bridge (section 4), not by these attributes.

## Round-3 addendum (2026-11-23)

Written for plan revision 4; where it and sections 1.2, 1.5 or 2.4 above disagree, this addendum and the plan win.


Addendum to `web/farm-sim/docs/research/phone-surfaces.md` sections 2.3-2.5 and plan sections 4.5-4.6. Basis: branch `t3/farming-sim-osi-education`, HEAD `8fdd6b434f`. Read-only research; nothing in the repository was changed. Paths are relative to `web/react-gui/` unless they start with `web/farm-sim/`. Locale line numbers are from `public/locales/<locale>/<namespace>.json`, found with a JSON path walker (en `devices.json` is three lines shorter than the other six above line 455). No browser run took place in this task: every DOM, CSP and event-order statement below comes from reading code and specifications.

Every replacement string is collected in one table set (below). A script checked all 7 keys × 7 locales: none matches `/Open-?Meteo|Meteo-?Swiss|MeteoSchweiz|MétéoSuisse|MeteoSvizzera|open_meteo|meteoswiss|Schweiz|Suisse|Svizzera|Suiza|Suíça|Switzerland|Uganda|Kampala|Africa\/|Europe\/|Rom[ea]|Zürich|Genève|Geneva/i`, and none of the item 2 strings contains a word that `WeatherIcon` maps to an icon (section 2). The lg column follows section 2.5: lg keeps English where the shipped lg value is English, and no new Luganda is written here. The non-English sentences need a native-speaker pass before release, as in section 2.5.

#### Summary of corrections to the plan

1. **The Weather tab description is not an i18n key.** `WeatherTab.tsx:68-69` renders `{c.description}`, the raw `online.current.description` from the simulator (`demo/model/environment.ts:236`, the English literal `'Weather conditions'`). `devices:environment.description.weatherConditions`, set by `demo/public-copy.ts:24`, has no reader in `src/`; it is only asserted in `demo/tests/public-i18n.test.ts:74`. Plan 4.5 ("key `environment.description.weatherConditions`") is wrong as written, and the public simulator shows the English "Weather Conditions" in every locale today. The phone has to rewrite the payload field (section 2).
2. **The system panel is not on the Settings page, and M1 does not show it.** `SystemPanel` renders only on the dashboard (`src/pages/FarmingDashboard.tsx:501-505`) and only when `useGatewayModules().gatewayHub` is true. The simulator reports `gatewayHubModuleEnabled: false` (`demo/model/preferences.ts:7`), and the module switch (`PUT /api/system/settings`) is refused for the phone (phone-surfaces 1.3). It appears only if `GET /api/system/settings` fails before any success (`src/hooks/useGatewayModules.ts:79-86`, `VISIBLE_ON_FAILURE`), which the introduction to phone-surfaces 1.3 already forbids. The heading override is therefore defensive. If the game wants the panel shown, the farm builder must send `gatewayHubModuleEnabled: true` in its own `PUT /api/system/settings` (plan 4.7 step 5).
3. **Two more JSON keys name a real place:** `devices:advancedSchedule.timezoneExample` and `settings:timeZoneInvalid` both contain `Europe/Rome`. The section 2.4 scan matched only providers and the country, so it missed them, and the section 2.7 smoke regex would miss them too. Count: the scan finds 18 JSON keys that name a provider, country or place (the 16 of section 2.4 plus these 2). Section 2.4 also overrides two keys outside that scan: `zoneConfig.weatherProviderOption.auto` (it names nothing itself but interpolates the provider label) and the public-copy `environment.source.meteoswiss` (not in the JSON). The plan's "eighteen" equals 16 + those 2; with the 2 time-zone keys, the provider, country and place overrides number 20. Add `Europe\/|Africa\/|Kampala|\bRome\b` to the 2.7 regex and to the all-strings unit test.
4. **Phone-surfaces 1.2 row T1 (`POST /auth/login` allowed) and 1.5 (401 pass-through) contradict plan 4.6 step 10.** With logout intercepted, the phone never reaches `/auth/login`; refuse T1 in the bridge as well (section 5).

#### 1. Provider names in keys that do not render in M1

| Key | Shipped location (all seven locales name a provider) | Reader |
|---|---|---|
| `devices:environment.water.meteoswissCloudNote` | en `devices.json:455`; de-CH, fr, it, es, pt, lg `devices.json:458` | none in `src/` (grep) |
| `common:analysis.aggregation.help` | `common.json:44` in all seven | `src/pages/CrossZoneAnalysisPage.tsx:253-254` (HelpTip); `/analysis` redirects to `/dashboard` in the public build (`src/App.tsx:89`) |

The cloud note keeps its meaning (the gateway and OSI Cloud history use different services for a while) without naming either service. In the aggregation help only the sentence that named the provider changes; the rest is the shipped text, carried over by script from each locale file. "Weather model" matches the shipped wording of the replaced provider elsewhere (`environment.water.et0Tier.open_meteo_daily`, "… weather model, daily FAO-56").

| Key | Locale | String |
|---|---|---|
| `devices:environment.water.meteoswissCloudNote` | en | This zone uses one weather service on the gateway; OSI Cloud's own history uses another until the history of the gateway's service is available in the cloud. |
| `devices:environment.water.meteoswissCloudNote` | de-CH | Diese Zone nutzt auf dem Gateway einen Wetterdienst; die eigene Historie von OSI Cloud nutzt einen anderen, bis die Historie des Gateway-Dienstes in der Cloud verfügbar ist. |
| `devices:environment.water.meteoswissCloudNote` | fr | Cette zone utilise un service météo sur la passerelle ; l’historique propre d’OSI Cloud en utilise un autre jusqu’à ce que l’historique du service de la passerelle soit disponible dans le cloud. |
| `devices:environment.water.meteoswissCloudNote` | it | Questa zona usa un servizio meteo sul gateway; lo storico di OSI Cloud ne usa un altro finché lo storico del servizio del gateway non è disponibile nel cloud. |
| `devices:environment.water.meteoswissCloudNote` | es | Esta zona usa un servicio meteorológico en el gateway; el historial propio de OSI Cloud usa otro hasta que el historial del servicio del gateway esté disponible en la nube. |
| `devices:environment.water.meteoswissCloudNote` | pt | Esta zona usa um serviço meteorológico no gateway; o histórico próprio do OSI Cloud usa outro até o histórico do serviço do gateway estar disponível na nuvem. |
| `devices:environment.water.meteoswissCloudNote` | lg | This zone uses one weather service on the gateway; OSI Cloud's own history uses another until the history of the gateway's service is available in the cloud. |

| Key | Locale | String |
|---|---|---|
| `common:analysis.aggregation.help` | en | Raw points sit at the reading's time; at 15-minute, hourly, daily and weekly aggregation each point sits at the start of its period, and for weather sources a day is the zone's local day. Rain, ET0 and ETc from a weather provider, a station's hourly record or daily agronomy are totals for that period, and other values are means. Hourly temperature, humidity and wind from the weather model are values at the time shown. Weather sources show no finer detail than one hour, or one day for daily agronomy. |
| `common:analysis.aggregation.help` | de-CH | Ohne Aggregation (Rohdaten) liegt jeder Punkt beim Zeitpunkt der Messung; bei 15-Minuten-Aggregation, stündlicher Aggregation, täglicher Aggregation und wöchentlicher Aggregation liegt er am Anfang seines Zeitraums, und bei Wetterquellen ist ein Tag der lokale Tag der Zone. Regen, ET0 und ETc von einem Wetteranbieter, aus den Stundenwerten einer Station oder aus «daily agronomy» sind Summen für diesen Zeitraum, alle anderen Werte sind Mittelwerte. Stündliche Temperatur, Luftfeuchtigkeit und Wind aus dem Wettermodell sind Werte zum angezeigten Zeitpunkt. Wetterquellen sind höchstens stündlich aufgelöst, «daily agronomy» täglich. |
| `common:analysis.aggregation.help` | fr | En agrégation brute, chaque point est à l'heure de la mesure ; en agrégation de 15 minutes, horaire, quotidienne ou hebdomadaire, il est au début de sa période, et pour les sources météo un jour est le jour local de la zone. La pluie, l'ET0 et l'ETc d'un fournisseur météo, des valeurs horaires d'une station ou de « daily agronomy » sont des totaux pour cette période ; les autres valeurs sont des moyennes. La température, l'humidité et le vent horaires du modèle météo sont des valeurs à l'heure affichée. Les sources météo ont une résolution d'une heure au mieux, d'un jour pour « daily agronomy ». |
| `common:analysis.aggregation.help` | it | Nell'aggregazione grezza ogni punto sta al momento della misura; nell'aggregazione di 15 minuti, oraria, giornaliera o settimanale sta all'inizio del suo periodo, e per le fonti meteo un giorno è il giorno locale della zona. Pioggia, ET0 ed ETc di un fornitore meteo, dei valori orari di una stazione o di «daily agronomy» sono totali del periodo; gli altri valori sono medie. Temperatura, umidità e vento orari del modello meteo sono valori all'ora indicata. Le fonti meteo hanno al massimo una risoluzione oraria, «daily agronomy» giornaliera. |
| `common:analysis.aggregation.help` | es | Sin agregación, cada punto está en el momento de la medición; con agregación de 15 minutos, por hora, diaria o semanal, está al inicio de su periodo, y para las fuentes meteorológicas un día es el día local de la zona. La lluvia, la ET0 y la ETc de un proveedor meteorológico, de los valores horarios de una estación o de «daily agronomy» son totales del periodo; los demás valores son medias. La temperatura, la humedad y el viento horarios del modelo meteorológico son valores a la hora indicada. Las fuentes meteorológicas tienen como máximo una resolución horaria, y «daily agronomy» diaria. |
| `common:analysis.aggregation.help` | pt | Sem agregação, cada ponto fica à hora da medição; com agregação de 15 minutos, horária, diária ou semanal, fica no início do seu período, e para as fontes meteorológicas um dia é o dia local da zona. A chuva, a ET0 e a ETc de um fornecedor meteorológico, dos valores horários de uma estação ou de «daily agronomy» são totais do período; os restantes valores são médias. A temperatura, a humidade e o vento horários do modelo meteorológico são valores à hora indicada. As fontes meteorológicas têm no máximo uma resolução horária, e «daily agronomy» diária. |
| `common:analysis.aggregation.help` | lg | Raw points sit at the reading's time; at 15-minute, hourly, daily and weekly aggregation each point sits at the start of its period, and for weather sources a day is the zone's local day. Rain, ET0 and ETc from a weather provider, a station's hourly record or daily agronomy are totals for that period, and other values are means. Hourly temperature, humidity and wind from the weather model are values at the time shown. Weather sources show no finer detail than one hour, or one day for daily agronomy. |

#### 2. Weather tab current-conditions bar

**Where it renders.** `EnvironmentCard.tsx:241` passes `data.online` unchanged to `WeatherTab`; `CurrentConditions` (`WeatherTab.tsx:60-92`) renders when `online.available && online.current` (`:61`). The simulator fills `online.current` only when the zone has a weather source (`demo/model/environment.ts:215-236`), so the phone shows the bar from T2 (`weatherSource: 'auto'`, plan 4.7 step 4), not below: `selectedWeatherProvider` returns `null` for `'local'` (`demo/model/environment.ts:25-27`), which makes `hasIllustrativeWeatherSource` false (`:34-36`).

**Every text in the bar:**

| Line | Text | Source | i18n? |
|---|---|---|---|
| `WeatherTab.tsx:66` | weather icon (SVG, no `<title>`, no `aria-*`; `WeatherIcon.tsx:322-343`) | `resolveIconType(null, description)`: no WMO code, so the description string picks the icon; "Weather conditions" matches no keyword and gives `cloudy` (`WeatherIcon.tsx:46-63`) | no |
| `:68-69` | description, CSS `capitalize` and `truncate`; renders "Weather Conditions" | `online.current.description` = `'Weather conditions'` (`demo/model/environment.ts:236`) | **no** (raw payload) |
| `:72-75` | `{t.toFixed(1)} °C`, e.g. "31.0 °C" | `airTemperatureC` = the day's forecast maximum (`environment.ts:236`) | no; the unit is a literal |
| `:77-80` | `{rh}% RH` | `relativeHumidityPct` = `meanRhPct ?? 62` (`environment.ts:237`) | no; "RH" is a hard-coded English literal |
| `:82-86` | `{v} m/s` plus an optional compass point (`src/utils/wind.ts:1`, English letters) | `windSpeedMps ?? 1.1`; `windDirectionDeg: null` (`environment.ts:237`), so no compass point | no |

None of these names a provider or place. The cache badge (`environment.cache.live`, `EnvironmentCard.tsx:57-62`) sits in the card header, outside the bar.

**Replacement seam.** Because the line is payload, an i18n override alone changes nothing. Recommended:

1. `applyPhoneCopy` sets the phone-owned key `devices:environment.description.weatherConditions` to the strings below (the key already exists through public copy, so the all-strings scan covers it).
2. The phone's `requestResponse` wrapper (plan 4.6 step 7), **after** `structuredClone(bridge.request(...))`, so cached answers from the closed-phone cache (phone-surfaces 4.3) are rewritten too: for a 2xx `GET /api/irrigation-zones/:id/environment-summary` whose `online.current.description === 'Weather conditions'`, set it to `i18n.t('environment.description.weatherConditions', {ns: 'devices'})`. Leave `forecast.rainFocus.daily[].description` (`environment.ts:284`) alone: it feeds only the day-card icon (`WeatherTab.tsx:146`) and never renders as text.
3. On `i18n.on('languageChanged')`, call `requestDemoRevalidation(['*'])`. `EnvironmentCard` reloads on that event (`EnvironmentCard.tsx:133`, `src/utils/publicSimulatorInvalidation.ts:5-12`, active only when the phone build defines `VITE_PUBLIC_SIMULATOR=true`); otherwise it reloads only every 5 minutes (`:134`). While the phone is closed the reload is served from the bridge cache and rewritten in the new language by step 2.

A DOM shim is the fallback: a `MutationObserver` that rewrites a text node equal to `Weather conditions` inside `p.capitalize.truncate`. It depends on Tailwind class names, so prefer the payload rewrite. An alternative that touches no phone code is a `currentDescription` option on the simulator hook, but that would be English-only again unless the game passes the localized string per request.

**Fit (risk, not verified).** The description `<p>` also has `truncate` (`WeatherTab.tsx:69`), and these strings run 36-42 characters against 18 for today's "Weather conditions". At phone width the ellipsis may cut the trailing "(game)" marker, the one word that carries the label. Smoke assertion: on that element, `scrollWidth <= clientWidth` in all seven locales at the phone viewport. If it fails, lead with the marker (for example en "Game: illustrative current conditions") and rerun the icon-keyword check.

`capitalize` turns every word's first letter to upper case, so en, fr, it, es, pt and lg render in title case ("Illustrative Current Conditions (Game)"); the de-CH string is unaffected because every word in it already starts with a capital. The icon check passed for all seven strings: none contains `thunder`, `storm`, `rain`, `shower`, `drizzle`, `snow`, `sleet`, `fog`, `mist`, `haze`, `overcast`, `partly`, `partial`, `cloud`, `clear`, `sunny` or `fair`, so the icon stays `cloudy`. The wording reuses the section 2.5 "illustrative" stems.

| Key | Locale | String |
|---|---|---|
| `devices:environment.description.weatherConditions` | en | Illustrative current conditions (game) |
| `devices:environment.description.weatherConditions` | de-CH | Aktuelle Wetterlage: Beispielwerte (Spiel) |
| `devices:environment.description.weatherConditions` | fr | Conditions actuelles indicatives (jeu) |
| `devices:environment.description.weatherConditions` | it | Condizioni attuali illustrative (gioco) |
| `devices:environment.description.weatherConditions` | es | Condiciones actuales ilustrativas (juego) |
| `devices:environment.description.weatherConditions` | pt | Condições atuais ilustrativas (jogo) |
| `devices:environment.description.weatherConditions` | lg | Illustrative current conditions (game) |

#### 3. System panel

`src/components/farming/SystemPanel.tsx`, namespace `devices` (`:28`), plus `common` for `adminOnly`/`cancel` (`:29`). No other component reads `systemPanel.title` or `systemPanel.subtitle` (grep).

| Line | Element | Key | en value | en / other locales line |
|---|---|---|---|---|
| `:111` | `<h2>` heading | `systemPanel.title` | Gateway | 821 / 824 |
| `:112` | `<p>` under the heading | `systemPanel.subtitle` | System status | 822 / 825 |
| `:117` | "updated" time (`toLocaleTimeString()`, needs the Level A time-zone shim) | `systemPanel.updated` | Updated {{time}} | 823 / 826 |
| `:125` | refresh button (`↻ ` prefix literal) | `systemPanel.refresh` | Refresh | 824 / 827 |
| `:147` | tile label | `systemPanel.cpuTemperature` | CPU temperature | 826 / 829 |
| `:149` | value `{n.toFixed(1)}°C` | literal unit | — | — |
| `:160` | scale note | `systemPanel.maxTemperature` (`max: 85`) | max {{max}}°C | 827 / 830 |
| `:165` | tile label | `systemPanel.memory` | Memory | 828 / 831 |
| `:166`, `:174` | `{mem_percent}%`; used/total | `systemPanel.memoryUsed` | {{used}} / {{total}} MB used | 829 / 832 |
| `:181` | tile label (no plural forms in any locale) | `systemPanel.cpuLoad` (`count`) | CPU load ({{count}} cores) | 830 / 833 |
| `:190-192` | load prefixes | `systemPanel.load1m`, `load5m`, `load15m` | 1m: / 5m: / 15m: | 831-833 / 834-836 |
| `:198` | tile label | `systemPanel.fanControl` | Fan control | 834 / 837 |
| `:202` | current fan value | `systemPanel.fanCurrent`, `fanOff`, `fanMax` | Current: | 835 / 838 |
| `:220` | presets | `systemPanel.fanOff/fanLow/fanMedium/fanHigh/fanMax` (`:7-11`) | — | — |
| `:234` | no-fan text (not reached: the simulator reports `fan_available: true`, `demo/model/system.ts:35`) | `systemPanel.noFanDetected` | No fan detected | 842 / 845 |
| `:275` | reboot button | `systemPanel.rebootButton` | Reboot gateway | 843 / 846 |

The values come from `publicSystemStats` (`demo/model/system.ts:23-36`).

**Override.** Put the replacement heading on `systemPanel.title` (the `<h2>`). With that heading, the shipped subtitle ("System status") repeats it, so replacing `systemPanel.subtitle` as well is recommended; keeping it is harmless.

| Key | Locale | String |
|---|---|---|
| `devices:systemPanel.title` | en | Gateway status (simulated values) |
| `devices:systemPanel.title` | de-CH | Gateway-Status (simulierte Werte) |
| `devices:systemPanel.title` | fr | État de la passerelle (valeurs simulées) |
| `devices:systemPanel.title` | it | Stato del gateway (valori simulati) |
| `devices:systemPanel.title` | es | Estado del gateway (valores simulados) |
| `devices:systemPanel.title` | pt | Estado do gateway (valores simulados) |
| `devices:systemPanel.title` | lg | Gateway status (simulated values) |

| Key | Locale | String |
|---|---|---|
| `devices:systemPanel.subtitle` | en | Values come from the game, not from a gateway |
| `devices:systemPanel.subtitle` | de-CH | Die Werte stammen aus dem Spiel, nicht von einem Gateway |
| `devices:systemPanel.subtitle` | fr | Les valeurs viennent du jeu, pas d’une passerelle |
| `devices:systemPanel.subtitle` | it | I valori provengono dal gioco, non da un gateway |
| `devices:systemPanel.subtitle` | es | Los valores proceden del juego, no de un gateway |
| `devices:systemPanel.subtitle` | pt | Os valores vêm do jogo, não de um gateway |
| `devices:systemPanel.subtitle` | lg | Values come from the game, not from a gateway |

**Raw refusal code on this panel.** If the panel is ever shown, a refused fan or reboot write prints the code: `setFanError(e.response?.data?.error || …)` (`:86`) and `setRebootMsg(e.response?.data?.error || …)` (`:100`) read `data.error` before the translated fallback, and the refusal body of phone-surfaces 1.4 carries `error: 'game_refused'`. The demo adapter takes the error code from `data.error` (`demo/adapter.ts:37-41`). Either keep the panel hidden (the M1 default), or have the bridge put the localized sentence in `error` and the code in a second field (`code`) that the phone's `onError` reads first (`(wire.data as {code?: string}).code ?? code`).

#### 4. Hard-coded place and provider strings that i18n cannot reach

Scans: `src/**/*.{ts,tsx}` without tests, the seven `public/locales` folders, `demo/public/locales/*.json`, `demo/locales/lg-valves.json`, `demo/public/messages.ts`, `demo/model.ts`, `demo/model/*.ts`, `demo/fixtures.ts`, `demo/history.ts`, `demo/public-copy.ts` and `demo/water-copy.ts`, for provider, country, city and IANA-region names.

#### 4.1 Needs a DOM shim

| String | Where | Renders on | Shim selector and attribute | Replacement |
|---|---|---|---|---|
| `placeholder="e.g. Europe/Rome"` (hard-coded English default prop, the same in all locales) | `src/components/farming/TimezoneInput.tsx:17`, applied at `:31`. Call sites pass no `placeholder`: `src/pages/SettingsPage.tsx:578-584` (`id="gateway-timezone"`) and `src/components/farming/ZoneConfigModal.tsx:796-801` (`id={id('timezone')}` = `zone-config-timezone-<useId>`, `:129-130`) | Settings, time-zone section; zone settings dialog. Visible only when the field is empty (both are prefilled with `Etc/GMT-3` by the farm builder), but the attribute scan sees it always | `input[placeholder="e.g. Europe/Rome"]`, attribute `placeholder`. Narrower alternatives: `#gateway-timezone`, `input[id^="zone-config-timezone-"]` | `i18n.t('advancedSchedule.timezoneExample', {ns: 'devices'})` after the phone override below, i.e. "e.g. Etc/GMT-3" in en, localized in the other six |

Shim notes: a `MutationObserver` on `document.body` (`childList`, `subtree`) handles both call sites, including the modal on each open. React 18.3.1 updates an attribute only when the prop changes between renders, and the prop here is constant, so React does not write the old value back. Mark rewritten inputs (`data-phone-placeholder`) and rewrite those again on `languageChanged`, because after the first rewrite the value selector no longer matches. Not verified in a browser.

#### 4.2 Fixed through i18n (new keys for the override list)

| Key | Shipped location | Rendered at | Reached |
|---|---|---|---|
| `devices:advancedSchedule.timezoneExample` | en `devices.json:944`; other six `:947` | `src/components/farming/AdvancedScheduleDrawer.tsx:287` (`placeholder` of the drawer's time-zone input) | Yes: trigger section → advanced drawer (phone-surfaces 3.2) |
| `settings:timeZoneInvalid` | `settings.json:22` in all seven (it, es, pt and lg ship the English text) | `src/pages/SettingsPage.tsx:611-614`, an alert shown when the typed gateway zone is not valid | Yes: the Settings time-zone field is editable; Save is refused, but the alert appears while typing |

The replacements swap only `Europe/Rome` for `Etc/GMT-3` in each shipped string, so no new translation is introduced. `Etc/GMT-3` is a valid IANA zone, so the example passes the page's own validation.

| Key | Locale | String |
|---|---|---|
| `devices:advancedSchedule.timezoneExample` | en | e.g. Etc/GMT-3 |
| `devices:advancedSchedule.timezoneExample` | de-CH | z. B. Etc/GMT-3 |
| `devices:advancedSchedule.timezoneExample` | fr | ex. : Etc/GMT-3 |
| `devices:advancedSchedule.timezoneExample` | it | es. Etc/GMT-3 |
| `devices:advancedSchedule.timezoneExample` | es | p. ej., Etc/GMT-3 |
| `devices:advancedSchedule.timezoneExample` | pt | por ex., Etc/GMT-3 |
| `devices:advancedSchedule.timezoneExample` | lg | e.g. Etc/GMT-3 |

| Key | Locale | String |
|---|---|---|
| `settings:timeZoneInvalid` | en | Enter a valid IANA time zone (e.g. Etc/GMT-3) |
| `settings:timeZoneInvalid` | de-CH | Bitte eine gültige IANA-Zeitzone eingeben (z. B. Etc/GMT-3) |
| `settings:timeZoneInvalid` | fr | Indiquez un fuseau horaire IANA valable (par ex. Etc/GMT-3) |
| `settings:timeZoneInvalid` | it | Enter a valid IANA time zone (e.g. Etc/GMT-3) |
| `settings:timeZoneInvalid` | es | Enter a valid IANA time zone (e.g. Etc/GMT-3) |
| `settings:timeZoneInvalid` | pt | Enter a valid IANA time zone (e.g. Etc/GMT-3) |
| `settings:timeZoneInvalid` | lg | Enter a valid IANA time zone (e.g. Etc/GMT-3) |

#### 4.3 Checked and not a problem

- **`defaultValue` fallbacks.** Every `t()` call in `src/` whose `defaultValue` names a provider (`WeatherTab.tsx:174`; `WaterTab.tsx:187,189,220,222,224,282,285,327,412`; `IrrigationZoneCard.tsx:304,322`; `ZoneConfigModal.tsx:912`) uses a key that exists in all seven locales (checked per key and locale), and `demo/i18n.ts:48` sets `fallbackLng: 'en'`, so a `defaultValue` would render only if a key were missing in both the locale and en. The `WEATHER_SOURCE_FALLBACK` map (`ZoneConfigModal.tsx:107-111`, used at `:511`) is likewise unreachable: `zoneConfig.weatherProviderOption.{open_meteo,meteoswiss,local,auto}` exist in all seven. The phone overrides add these keys again in every locale.
- **Simulator payload values with a real place**, all overwritten by the farm builder (plan 4.7) before the phone mounts: zone `timezone: 'Africa/Kampala'` (`demo/fixtures.ts:12`; step 4 sets zone 1 to `Etc/GMT-3`, step 6 deletes zone 2), gateway time zone (`demo/model/preferences.ts:20`; step 5), `settings.defaultTimezone` (`demo/model/state.ts:46`; step 3), public-seed coordinates (`demo/model/state.ts:73`; step 4), fixture device names (step 2 deletes them). `osi.defaults.timezone` (`demo/runtime.ts:35`) is pinned by plan 4.6 step 2. The environment fixture's `location.timezone` (`demo/fixtures.ts:55`) is replaced on every summary (`demo/model/environment.ts:226`). The `/api/me` and valve-schedule literals at `demo/model.ts:990,1036` are presentation-mode only.
- **Demo locale files**: the only matches are the word "Luganda" (`demo/public/locales/*.json:22`, `demo/water-copy.ts:1`).
- **Out of reach in M1**: `NetworkPage.tsx:316` (map attribution, map centre); `/network` redirects in the public build (`src/App.tsx:108`). `IrrigationPolicyEditor.tsx:698` uses the neutral placeholder "Area/Location".

#### 5. Logout path

**How the app logs out.** Logout is client-only; no API call is made.

1. The control: the "Account" `HeaderMenu` item `{key: 'logout', onSelect: onLogout}` in `src/components/DashboardHeader.tsx:124` (dashboard) and `src/components/AppHeader.tsx:134` (other pages). `HeaderMenu` renders it as `<button data-action="logout" role="menuitem">` whose `onClick` calls `close(); item.onSelect?.()` (`src/components/HeaderMenu.tsx:125-138`). The History headers have their own buttons without `data-action` (`src/components/history/mobile/HistoryMobileHeader.tsx:59-65`, `src/pages/HistoryDashboard.tsx:436-442`); History is hidden in M1.
2. `onLogout` is `useAuth().logout` (`src/pages/FarmingDashboard.tsx:41,227`), which calls `endAuthSession()` (`src/contexts/AuthContext.tsx:57-59`).
3. `endAuthSession` (`src/services/authSession.ts:165-168`) removes `auth_token` and `username` from storage (`:73-79`) and publishes a new anonymous snapshot (`:121-134`): it aborts the epoch's in-flight requests and notifies every `subscribeAuthSession` listener.
4. `AuthProvider` re-renders through `useSyncExternalStore(subscribeAuthSession, getAuthSession)` (`AuthContext.tsx:54`); `isAuthenticated` turns false and `PrivateRoute` redirects to `/login` (`src/components/PrivateRoute.tsx:22-23`).
5. In the public simulator only, `demo/runtime.ts:266` subscribes `sim.setSessionUser(getAuthSession().username)`, which clears the simulator's active user (`demo/model/sessions.ts:86-90`), so `GET /api/me` answers 401 (`sessions.ts:43`).

Other ways the app ends a session: any 401 for a request of the current session (`src/services/api.ts:290-291` → `expireAuthSession`, `authSession.ts:196-201`, then `AUTH_EXPIRED_EVENT`, `AuthContext.tsx:67-77`); a `storage` event for `auth_token` (`AuthContext.tsx:79-94`); and `MobileTensionHistoryRoute.tsx:100,134` on a history 401 (History hidden).

**What the phone runtime must do:**

1. Do not install the `demo/runtime.ts:266` subscription. The simulator's session stays on its seed user (`demo/model/sessions.ts:23`), and `GET /api/me` keeps answering 200.
2. Intercept the control before React sees it: a capture-phase listener on `document` for `click`, matching `target.closest('[role="menuitem"][data-action="logout"]')`, calling `preventDefault()` and `stopImmediatePropagation()`, then showing the `game_refused` notice. React 18 attaches its listeners to the root container, a descendant of `document`, so a document capture listener runs first and stopping propagation keeps React's `onClick` from running. Keyboard activation (Enter or Space on the focused button) also produces a `click`. The menu stays open because `close()` did not run; dispatch `keydown` `Escape` on the `[role="menu"]` element (`HeaderMenu.tsx:62-65`) to close it. Not verified in a browser; the smoke test should click the item and assert that `auth_token` is still set and the hash is unchanged.
3. Keep every route free of 401: `phone_asleep` answers 503 or 403 (phone-surfaces 4.3), and refusals answer 403 (1.4). The phone uses memory storage, so no cross-tab `storage` event arrives.
4. As a backstop, add a phone-owned `subscribeAuthSession` listener that, when `getAuthSession().token === null`, records an integrity failure (failing the smoke test) and restores the session with `beginAuthSession('public-demo-session', <seed user>)`. That listener never calls the simulator. Restoring opens a new app epoch (`AuthSessionDataBoundary` remounts), which is acceptable only as a fallback.

**Is `/auth/login` then unreachable?** Yes, in normal use. `/login` itself has no auth guard (`src/App.tsx:34`, `src/pages/Login.tsx`), but nothing in the authenticated app links to it: `PrivateRoute` is the only redirect (`PrivateRoute.tsx:23`), and the only links are Login ↔ Register (`src/pages/Register.tsx:38,137`, `src/pages/Login.tsx:92`). The parent owns the iframe URL (`phone.html#/dashboard`), and the phone has no address bar. The bridge should still refuse `POST /auth/login` and `POST /auth/register` with `game_refused` as defense in depth, which means removing row T1 from phone-surfaces 1.2 and the two 401 items from 1.5.

#### 6. Pixi 8.23.0 and CSP

**Verified from package source**, not in a browser: `npm pack pixi.js@8.23.0`, extracted into the scratchpad; the tarball's SHA-512 in base64 (`RkWSwo+mAR0d7MKnJ20IjKkWGPdFh1C0adBRYYLa+SGdxTfbrr6RnQyZZRwjBaG/bDAIQqgBcTBbiNsN6iKFVQ==`) matches the registry's `dist.integrity`. The game package is not installed in the repository.

- **Yes, texture loading creates `blob:` workers by default.** `lib/assets/loader/parsers/textures/loadTextures.mjs:36-49`: `config.preferWorkers` defaults to `true`; when `createImageBitmap` exists and `preferCreateImageBitmap` is true, `load()` first calls `WorkerManager.isImageBitmapSupported()` and then `WorkerManager.loadImageBitmap()`. Both create workers from `URL.createObjectURL(new Blob([WORKER_CODE]))` (`lib/_virtual/checkImageBitmap.worker.mjs:9`, `lib/_virtual/loadImageBitmap.worker.mjs:9`; pool in `lib/assets/loader/workers/WorkerManager.mjs:24-35,65-80`). Under `worker-src 'self'` those workers are blocked. `isImageBitmapSupported()` registers only a `message` listener (`WorkerManager.mjs:26-33`), so a blocked worker may leave the first texture load waiting forever; the exact browser behaviour is unverified.
- **Documented switch:** `preferWorkers: false`, documented in `lib/assets/loader/parsers/textures/loadTextures.d.ts:13-20` and in `Assets.setPreferences` (`lib/assets/Assets.d.ts:842`, `:846`; implementation `lib/assets/Assets.mjs:668-694`). Either `await Assets.init({preferences: {preferWorkers: false}})` (`Assets.d.ts:222`, applied at `Assets.mjs:127-128`) or `Assets.setPreferences({preferWorkers: false})`, before the first `Assets.load`. Setting `preferCreateImageBitmap: false` also turns the workers off, since workers require `createImageBitmap` (`loadTextures.d.ts:52-58`).
- **What then needs CSP:** with workers off and `preferCreateImageBitmap` on, the main-thread `loadImageBitmap` calls `DOMAdapter.get().fetch(url)` (`loadTextures.mjs:19-25`), which `connect-src` governs, so the game page needs `connect-src 'self'` (plan 4.6). `'self'` does not match `data:` URLs: an atlas that Vite inlines as base64 (default `build.assetsInlineLimit` 4096 bytes) would be blocked. Set `assetsInlineLimit: 0` for loaded images, or use `preferCreateImageBitmap: false`, which loads through an `<img>` under `img-src 'self' data: blob:`. If the M1 art is generated in code and never passes through `Assets.load`, no loader path runs.
- **Other workers in the package:** `lib/_virtual/ktx.worker.mjs` and `basis.worker.mjs` (also `blob:`) are used only by the KTX2 and Basis loaders, which are registered only by the opt-in `pixi.js/ktx2` and `pixi.js/basis` entries (package `exports`); the default entry does not register them.
- **`unsafe-eval`:** the default renderer checks for `new Function` at construction (`lib/rendering/renderers/shared/system/AbstractRenderer.mjs:50,284-287`) and throws without it. `import 'pixi.js/unsafe-eval'` (`lib/unsafe-eval/init.mjs`) replaces that check and the UBO check with no-ops and installs polyfills for the four other `new Function` sites in `lib/` (shader sync, uniform sync, UBO buffer sync, particle update; `grep -rl 'new Function' lib`), so the probe in `lib/utils/browser/unsafeEvalSupported.mjs` (which calls `new Function` inside `try`, and would raise a `securitypolicyviolation` event even though it is caught) never runs. Import it before the first renderer is created.

#### Native-review list

All de-CH, fr, it, es and pt strings in sections 1-3 are new sentences or fragments (sections 4.2 only swaps the example zone). They follow the wording of the shipped keys they replace, and they need a native-speaker pass before release, as section 2.5 says. lg stays English in every new row.

## Round-4 addendum (2026-11-23)

Basis 4682fb17b1. Superseded where the round-5 addendum below differs (Dendrometer-tab selector, attribution rendering, line numbers on main 1ca703ae2f).

Written for plan revision 5; where it and section 2.5 above disagree (the attribution row), this addendum and the plan win. Basis: branch `t3/farming-sim-osi-education` at `f1700c91ea`. Read-only research; nothing in `web/react-gui` was changed. Everything below is a phone-runtime override (`src/phone/copy.ts`, the phone stylesheet or the phone DOM shim); nothing changes `web/react-gui/src`, `demo/water-copy.ts` or the locale JSON. Component and service paths are relative to `web/react-gui/src`; paths starting with `demo/` or `public/`, and `tsconfig.json`, are relative to `web/react-gui`.

**lg policy.** lg is English in every new row, as `research/phone-surfaces.md` 2.5 already does. Exception to note: `zone.water.measured` is Luganda today in the demo (`demo/water-copy.ts:9`, applied at `demo/i18n.ts:33`), so the phone override replaces a Luganda string with English. If that is not wanted, the candidate `Okufukirira (ekipima amazzi ekiteeberezeddwa)` reuses only words already in `WATER_COPY.lg` and `demo/i18n.ts:25`, but its noun-class agreement is unchecked and it needs a native speaker.

All de-CH, fr, it, es and pt strings are new and need the same native-speaker pass as the round-3 rows.


#### Corrections to the task's premises

1. The "Advanced settings →" link exists only inside `DendroForm` (`components/farming/ScheduleSection.tsx:217-225`), and `components/farming/IrrigationZoneCard.tsx:784` is the only place that sets `showAdvancedDrawer` to true. A player reaches the drawer only by clicking the Dendrometer tab first. That click is local state (`handleTypeChange`, `ScheduleSection.tsx:316-320`) and sends nothing.
2. The drawer reads the saved `zone.schedule`, not the form's unsaved choice (`AdvancedScheduleDrawer.tsx:81-82`). With a saved SWT trigger at T4, `isDendro` is false and the drawer shows `advancedSchedule.weatherControlled` ("Controlled by weather integration") at `AdvancedScheduleDrawer.tsx:216`, because that line tests only `zone.schedule` truthiness.
3. The SWT trigger in the simulator has no rain or recovery logic: `demo/model/triggers.ts:188-193` compares the last-hour SWT mean with the threshold and nothing else. The drawer text is wrong for the game, not merely irrelevant.
4. The zone-card key is at `IrrigationZoneCard.tsx:666` (tile `:663-678`, `data-testid="water-flow-meter-tile"`), not `:663`.
5. `WaterTab.tsx:281-283` does not render the attribution once the hook is in place: the game's rows carry `et0Source: 'fao56_daily_game_weather'` and `et0Tier: 'fao56_daily'` (plan 4.5), today's row has `et0Source: null` (`demo/model/environment.ts:180`), and the condition at `:281` needs `open_meteo_hourly_sum` or `open_meteo_daily`. Only `WeatherTab.tsx:172-176` renders it. Neither site has a `truncate` class.
6. `demo/mount.tsx` imports only three bare specifiers itself: `react`, `react-dom/client` and `swr`. `i18next` and `react-i18next` are imports of `demo/i18n.ts` (section 4).

#### 1. Dendrometer content behind the trigger section

#### 1.1 What a T4 player with an SWT trigger can reach

Sequence: open the trigger section (`ScheduleSection`, shown whenever `modules.schedulerUi` is on, `IrrigationZoneCard.tsx:780-787`), click "Dendrometer" (`ScheduleSection.tsx:426-428`), click "Advanced settings →" (`:217-225`).

- Clicking the tab renders `DendroForm` with no request.
- Opening the drawer sends one read, `GET /api/irrigation-zones/1/recommendations?days=7` (`AdvancedScheduleDrawer.tsx:386-393`, `services/api.ts:1564-1568`). The simulator answers `[]` because the zone has no dendrometer (`demo/model.ts:1238-1243`, `demo/model/histories.ts:92-93`), so the Analysis tab shows `noRecommendations`.
- All drawer text below renders **before any write**. The misleading Scheduling-tab text needs no write at all; `weatherControlled` needs only the T4 preset or an earlier SWT save.
- Saving the form on the Dendrometer tab sends `PUT /api/irrigation-zones/1/schedule` with `trigger_metric: 'DENDRO'`, `threshold_kpa: 2` and `response_mode` (`ScheduleSection.tsx:323-338`). The bridge refuses it (`game_refused`; DENDRO is outside the T4 enum and `response_mode` is an unknown key, plan 4.6 write allow-list). The form shows the refusal `message` in its error box (`:342`) and stays on the Dendrometer tab until reload.
- Writes the drawer can attempt: the stage and calibration selects call `PUT .../config` (`AdvancedScheduleDrawer.tsx:96-106`), refused as zone configuration. The select keeps the new value on screen because the drawer sets local state first (`:133`, `:147`) and swallows the error (`:101-103`); it resets only when the `zone` prop changes (`:91-94`). The time-zone Save (`:261-273`) is refused and shows `advancedSchedule.timezoneSaveFailed`. "Configure conditional irrigation" (`:205-210`) opens the policy editor, which plan decision D4 refuses at the bridge.
- Below T4 the same path works; `zone.schedule` is null (`demo/model/state.ts:81`), so the status line shows `noSchedule` and every description still renders.

#### 1.2 Recommendation: two layers

**Layer 1 (required, primary): i18n overrides** in `src/phone/copy.ts`, table 1.3.
**Layer 2 (recommended): CSS hide** of the Dendrometer tab and of the drawer link, section 1.4.

The i18n layer has fewer ways to fail. It does not depend on DOM shape, it applies on every render and language change through i18next, and its one failure mode (a key renamed in `src`, which would bring back the shipped `defaultValue`) is caught by a static unit test before the phone builds: assert every overridden key exists in `public/locales/en/devices.json` and resolves to the spec string in all seven locales. It does not reach hard-coded strings or keys added to the drawer later.

The CSS layer is more complete: hiding one button removes the whole surface, including future drawer strings, the recommendations read and the refused DENDRO save. It fails on a DOM reorder in `ScheduleSection`, which no `src` test pins, and on browsers without `:has()` (Firefox before 121). Its smoke assertion (1.4) fails closed, and the i18n layer still covers the drawer if the selector stops matching in a player's browser.

A MutationObserver that matches the button text was considered and rejected: it depends on the translated label, has to rerun on every language change and remount, and adds nothing the `:has()` rule does not.

#### 1.3 Layer 1: override strings

Shared phrases:

| Id | en | de-CH | fr | it | es | pt |
|---|---|---|---|---|---|---|
| N | Not used in this game | In diesem Spiel nicht verwendet | Non utilisé dans ce jeu | Non usato in questo gioco | No se usa en este juego | Não usado neste jogo |
| D | Only for the dendrometer method, which is not part of this game. | Nur für die Dendrometer-Methode, die nicht Teil dieses Spiels ist. | Uniquement pour la méthode du dendromètre, qui ne fait pas partie de ce jeu. | Solo per il metodo del dendrometro, che non fa parte di questo gioco. | Solo para el método del dendrómetro, que no forma parte de este juego. | Apenas para o método do dendrómetro, que não faz parte deste jogo. |

lg takes the en string in every row of this section (the shipped lg values of all these keys are English).

| Key | Render site | Reachable | Replacement |
|---|---|---|---|
| `devices:advancedSchedule.weatherControlled` | `AdvancedScheduleDrawer.tsx:216` (Rain suppression, Status value) | Yes, whenever `zone.schedule` exists (T4 preset or saved SWT trigger) | N |
| `devices:advancedSchedule.rainSuppressionDescription` | `:218` | Yes | R (below) |
| `devices:advancedSchedule.recoveryDescription` | `:225` | Yes | D |
| `devices:advancedSchedule.aggregationDescription` | `:232` | Yes | D |
| `devices:advancedSchedule.phenologyDescription` | `:154` | Yes | P (below) |
| `devices:zoneConfig.dendroCalibration` | `:143`; also `ZoneConfigModal.tsx:725` (zone settings dialog) | Yes, both | C (below) |
| `devices:schedule.responseMode` | `:180` (disabled select, shows `proportional` for an SWT schedule, `:182`); also `ScheduleSection.tsx:203` | Yes | M (below) |
| `devices:schedule.methodDendro` | `ScheduleSection.tsx:427` (trigger-method tab) | Yes, T1-T4 | T (below) |
| `devices:advancedSchedule.localWindow` | `:302-303` (d_max and d_min window values; drop the interpolation) | Yes | N |
| `devices:advancedSchedule.stepwiseEnvelope` | `:308` | Yes | N |
| `devices:advancedSchedule.twdDescription` | `:310` | Yes | D |
| `devices:advancedSchedule.diagnosticsUnavailable` | `:318`, `:322`, `:328`, `:334` (four SD-VPD values when diagnostics are absent) | Yes | N |
| `devices:advancedSchedule.sdVpdDescription` | `:337` | Yes | D |
| `devices:advancedSchedule.noRecommendations` | `:368` (says "Run dendro compute or wait for the daily 08:00 UTC job") | Yes | X (below) |

Key-specific strings:

| Id | en | de-CH | fr | it | es | pt |
|---|---|---|---|---|---|---|
| R | The soil-moisture trigger does not pause for rain. Rain suppression belongs to the dendrometer method, which is not part of this game. | Die Auslösung nach Bodenfeuchte pausiert bei Regen nicht. Die Regenunterdrückung gehört zur Dendrometer-Methode, die nicht Teil dieses Spiels ist. | Le déclenchement selon l’humidité du sol ne s’interrompt pas en cas de pluie. La suppression en cas de pluie relève de la méthode du dendromètre, qui ne fait pas partie de ce jeu. | L’attivazione in base all’umidità del suolo non si sospende con la pioggia. La soppressione per pioggia appartiene al metodo del dendrometro, che non fa parte di questo gioco. | La activación por humedad del suelo no se detiene con la lluvia. La supresión por lluvia pertenece al método del dendrómetro, que no forma parte de este juego. | A ativação pela humidade do solo não para com a chuva. A supressão por chuva pertence ao método do dendrómetro, que não faz parte deste jogo. |
| P | The growth stage sets the crop coefficient (Kc) for crop water demand. The calibration key is only for dendrometers, which are not part of this game. | Das Wachstumsstadium bestimmt den Kulturkoeffizienten (Kc) für den Wasserbedarf der Kultur. Der Kalibrierungsschlüssel gilt nur für Dendrometer, die nicht Teil dieses Spiels sind. | Le stade de croissance fixe le coefficient cultural (Kc) pour les besoins en eau de la culture. La clé d’étalonnage ne sert qu’aux dendromètres, qui ne font pas partie de ce jeu. | La fase di crescita determina il coefficiente colturale (Kc) per il fabbisogno idrico della coltura. La chiave di calibrazione serve solo ai dendrometri, che non fanno parte di questo gioco. | La fase de crecimiento fija el coeficiente de cultivo (Kc) para la demanda de agua del cultivo. La clave de calibración solo sirve para dendrómetros, que no forman parte de este juego. | O estádio de crescimento define o coeficiente cultural (Kc) para as necessidades de água da cultura. A chave de calibração serve apenas para dendrómetros, que não fazem parte deste jogo. |
| C | Dendrometer calibration (not in this game) | Dendrometer-Kalibrierung (nicht im Spiel) | Calibrage dendromètre (pas dans ce jeu) | Calibrazione dendrometro (non in questo gioco) | Calibración del dendrómetro (no en este juego) | Calibração do dendrómetro (não neste jogo) |
| M | Response mode (dendrometer only) | Reaktionsmodus (nur Dendrometer) | Mode de réponse (dendromètre uniquement) | Modalità di risposta (solo dendrometro) | Modo de respuesta (solo dendrómetro) | Modo de resposta (apenas dendrómetro) |
| T | Dendrometer (not in this game) | Dendrometer (nicht im Spiel) | Dendromètre (pas dans ce jeu) | Dendrometro (non in questo gioco) | Dendrómetro (no en este juego) | Dendrómetro (não neste jogo) |
| X | No tree recommendations: dendrometers are not part of this game. | Keine Baumempfehlungen: Dendrometer sind nicht Teil dieses Spiels. | Aucune recommandation par arbre : les dendromètres ne font pas partie de ce jeu. | Nessuna raccomandazione sugli alberi: i dendrometri non fanno parte di questo gioco. | No hay recomendaciones por árbol: los dendrómetros no forman parte de este juego. | Sem recomendações por árvore: os dendrómetros não fazem parte deste jogo. |

P is true for the game: the simulator derives Kc from the stage (`demo/model/environment.ts:19-22`). The Kc terms follow `demo/public-copy.ts` (`cropCoefficient`). Tab T is `whitespace-nowrap` inside a `flex-wrap` row (`ScheduleSection.tsx:78-92`, `:422-429`); at about 35 characters in de-CH it moves to its own line rather than truncating.

Reachable keys kept as shipped (neutral, or explained by a row above): section titles (`sectionPhenology`, `sectionScheduleParameters`, `sectionRainSuppression`, `sectionRecoveryVerification`, `sectionZoneAggregation`, `sectionExtractionWindows`, `sectionTwdMethod`, `sectionSdVpdCorrelation`), `tabScheduling`, `tabAnalysis`, `baseDuration`, `lastTriggered`, `never`, `status`, `noSchedule`, `timezoneSaveFailed`, `dmaxWindow`, `dminWindow`, `method`, `baselineR2`, `rolling14DayR2`, `sdVpdStatusLabel`, `vpdOverrides`, `loadingRecommendations`, `responseModeOption.*` (now under label M), `zoneConfig.calibration.*` (under label C), `zoneConfig.phenologicalStage`, `zoneConfig.stageHelp*`, `valves:irrigationPreference.advanced`, `valves:irrigationPreference.editSchedule`, `valves:irrigationPolicy.openEditor`; `timezoneExample` is already overridden in round 3. The `DendroForm` keys (`schedule.triggerSensitivity`, `schedule.stress.*`, `schedule.baseDurationMin`, `schedule.mode.*`, `schedule.advancedSettings`) describe the method the player opened under tab T and stay.

Not reachable in M1 (no override needed): `stressTriggerLevel`, `stressLevel.*`, `stressLevelOther` (need a saved DENDRO schedule, `:110-112`, `:161`; the bridge refuses one); `sectionLatestReasoningTrace`, `computedAt`, `usableTrees`, `lowConfidenceTrees`, `outlierFiltered`, `zoneConfidence` (need a recommendation, `:348-364`); `sdVpdStatus.*`, `vpdOverrideCounts`, `insufficientData` (need diagnostics; the simulator sends `diagnostics: null`, `demo/model/histories.ts:103`).

The shipped values of these keys are in `public/locales/<locale>/devices.json`.

#### 1.4 Layer 2: CSS hide

Phone stylesheet (CSP `style-src 'self' 'unsafe-inline'` allows it):

```css
/* Dendrometer trigger-method tab. The tab group is the element directly before the SWT form,
   whose sensor select has the stable id swt-sensor-<zoneId> (ScheduleSection.tsx:109,117). */
div:has(+ div select[id^="swt-sensor-"]) > p + div > button:nth-child(2) { display: none !important; }
/* The drawer's only opener, inside DendroForm (ScheduleSection.tsx:166,217-225). */
div:has(> div > div > select[id^="dendro-sensitivity-"]) > div:last-child > button { display: none !important; }
```

Why it holds: inside the loaded branch the order is the optional `!canSave` alert (`:416`), the trigger-method `div` (`:418-431`: a `p`, then the tab group with SWT first and Dendrometer second), then `SwtForm`'s root `div` (`:433-443`). The alert precedes the trigger `div`, so adjacency is unaffected. The tab group and the form mount in the same render, so the tab never flashes. Both id prefixes occur once in `src` (`ScheduleSection.tsx:109`, `:166`). React leaves the rule alone because it is a stylesheet rule, not a class or inline style it manages.

Smoke assertion (fails closed): at T4, with the trigger section open, `[id^="swt-sensor-"]` is visible, the trigger-method group has exactly one visible button and its text is `t('schedule.methodSwt')`, and no element with the text of `t('advancedSchedule.tabAnalysis')` exists anywhere in the phone document during the run.

#### 2. Flow meter labels

From T2 the builder registers the LSN50 MOD9 with the flow counter (plan 4.3 readings table, fictional EUI `00000000000000B2`), so `zoneHasFlowMeter` is true and `sensorHealth.flowMeterPresent` is true (`demo/fixtures.ts:63`). The valve arrives at T3.

Meter term per locale, kept from the shipped strings: de-CH Durchflussmesser, fr débitmètre, it flussometro, es and pt caudalímetro.

| Key or literal | Render site | Renders in M1 | en | de-CH | fr | it | es | pt | lg |
|---|---|---|---|---|---|---|---|---|---|
| `devices:zone.water.measured` (demo value `WATER_COPY.measured`, `demo/i18n.ts:33`) | `IrrigationZoneCard.tsx:666` | T2-T4 | Irrigation (simulated flow meter) | Bewässerung (simulierter Durchflussmesser) | Irrigation (débitmètre simulé) | Irrigazione (flussometro simulato) | Riego (caudalímetro simulado) | Rega (caudalímetro simulado) | en (see lg policy) |
| `devices:environment.water.measuredIrrigationToday` | `environment/WaterTab.tsx:485` (tile), `:303` (day tooltip) | T2-T4 | Irrigation (simulated flow meter) | Bewässerung (simulierter Durchflussmesser) | Irrigation (débitmètre simulé) | Irrigazione (flussometro simulato) | Riego (caudalímetro simulado) | Rega (caudalímetro simulado) | en |
| `devices:environment.water.tooltipMeasuredEffective` | `WaterTab.tsx:442` (legend), `:611` (bar name), `:313` (tooltip) | T2-T4 | Effective (simulated flow meter) | Effektiv (simulierter Durchflussmesser) | Efficace (débitmètre simulé) | Efficace (flussometro simulato) | Efectivo (caudalímetro simulado) | Efetivo (caudalímetro simulado) | en |
| `devices:environment.water.flowMeterReporting` | `WaterTab.tsx:641` (status chip) | T2-T4 | Simulated flow meter reporting | Simulierter Durchflussmesser meldet | Débitmètre simulé actif | Contatore di portata simulato attivo | Caudalímetro simulado activo | Medidor de caudal simulado ativo | en |
| `devices:stregaValve.measured` | `StregaValveCard.tsx:1052` (badge after "Today: N L"; source `measured_flow_meter` from `demo/model.ts:1073` whenever the zone has a flow source) | T3-T4 | Simulated meter | Simulierter Zähler | Compteur simulé | Contatore simulato | Contador simulado | Contador simulado | en |
| hard-coded `Flow Meter` | `DraginoTempCard.tsx:350` (LSN50 card in the zone's device list, `IrrigationZoneCard.tsx:874-890`) | T2-T4 | Simulated flow meter | Simulierter Durchflussmesser | Débitmètre simulé | Flussometro simulato | Caudalímetro simulado | Caudalímetro simulado | en |

Implementation notes:

- Keep `demo/water-copy.ts` unchanged; the public simulator in PR #658 uses it. The phone copy sets `zone.water.measured` itself and recomposes `zone.water.subtitle` as `${rainToday} · ${measured}`, matching `demo/i18n.ts:35`. The subtitle does not render in M1: without a dendrometer recommendation `resolveWaterAction` always returns a `reasonCode` (`demo/model/water-action.ts:15-27`), and `formatWaterSubtitle` prefers it (`IrrigationZoneCard.tsx:148-151`).
- The `DraginoTempCard` heading is a literal, so i18n cannot reach it. Rewrite it in the phone DOM shim that already handles the time-zone placeholder (plan 4.5): a MutationObserver on the phone root replaces the text of any `p` whose `textContent` is exactly `Flow Meter` with `i18n.t('farmSim.flowMeterHeading')` (a phone-owned key holding the row above), and reruns on `languageChanged`. CSS `uppercase` on the element renders it in capitals. Restricting the match to `p` skips the `Flow Meter` toggle label in `DraginoSettingsModal.tsx:23`, a configuration label whose writes the bridge refuses. Smoke assertion: no `p` in the phone document has the text `Flow Meter` at T2.
- The badge string is shorter than the other rows because it sits inline after "Today: N L" in `text-xs uppercase tracking-wide`.

Adjacent lines that render but are not meter labels (no override proposed; listed so the reviewer can decide):

- `devices:zone.water.estimated` (`IrrigationZoneCard.tsx:672-675`) renders under the meter tile from T2 as "Estimated (valve time × calibration): —". The public summary never fills `irrigationTodayEstimatedLiters` (`demo/fixtures.ts:59`; not set at `demo/model.ts:1220-1233`), so it shows a dash, at T2 before any valve exists.
- `devices:environment.water.estimatedIrrigationToday` (`WaterTab.tsx:492-499`) adds a tile at T3-T4 (`hasValve`) with the same dash.
- The LSN50 card's other literals (`Today:`, `tap to view history`, the history monitor title `Flow` and series `This interval` / `Per 10 min (rate)`, `DraginoTempCard.tsx:352-378`) carry no measured claim.

#### 3. Weather tab attribution

Key `devices:environment.water.attribution.open_meteo`. It renders at `environment/WeatherTab.tsx:172-176`, inside a HelpTip in `HourlyChart` (mounted at `:322`), when `forecast.source` contains `open_meteo`; the simulator sets the source to the provider id (`demo/model/environment.ts:253`), so it shows from T2. `WaterTab.tsx:281-283` does not render it with the hook (premise correction 5). The same key covers both sites.

What the Weather tab shows, and where each value comes from with the hook:

| Value on screen | Source |
|---|---|
| Hourly rain bars | Game (`hourlyRainMm`, `environment.ts:284-286`) |
| Hourly rain probability | Illustrative, 45 % or 8 % (`:287`) |
| Day card rain | Sum of the game's hourly rain over the card's hours (`:297`) |
| Day card high | Maximum of the hourly shape, which equals the game's `maxTemp` at the 14:00 UTC row (`:288`, `:300`) |
| Day card low | Illustrative: the shape falls 0.35 °C per hour from 14:00 UTC (`:288`, `:301`) |
| Day card rain chance | Illustrative, 45 % or 8 % (`:302`) |

The hourly temperature shape itself is not drawn on the Weather tab; it shows only through the day card's low.

| Locale | String |
|---|---|
| en | Rain amounts and daily highs come from the game's weather service. Rain chances and daily lows are illustrative. |
| de-CH | Regenmengen und Tageshöchstwerte stammen vom Wetterdienst des Spiels. Regenwahrscheinlichkeiten und Tagestiefstwerte sind Beispielwerte. |
| fr | Les quantités de pluie et les maximales du jour viennent du service météo du jeu. Les probabilités de pluie et les minimales sont indicatives. |
| it | Quantità di pioggia e massime giornaliere vengono dal servizio meteo del gioco. Probabilità di pioggia e minime giornaliere sono illustrative. |
| es | Las cantidades de lluvia y las máximas diarias proceden del servicio meteorológico del juego. La probabilidad de lluvia y las mínimas diarias son ilustrativas. |
| pt | As quantidades de chuva e as máximas diárias vêm do serviço meteorológico do jogo. A probabilidade de chuva e as mínimas diárias são ilustrativas. |
| lg | Rain amounts and daily highs come from the game's weather service. Rain chances and daily lows are illustrative. |

This replaces the round-3 attribution row ("Weather data from the game's weather service (simulated)", `research/phone-surfaces.md` 2.5). The stems follow 2.5 ("Beispielwerte", "indicatives", "illustrativi"/"ilustrativos"). The strings run 105 to 160 characters. Truncation is not possible at either site: the HelpTip panel is a wrapping `p` with `w-full basis-full` (`components/farming/shared/HelpTip.tsx`), inside a `flex-wrap` row (`WeatherTab.tsx:194`), and the WaterTab credit is a plain wrapping `p` in a `max-w-xs` box (`WaterTab.tsx:345-347`). The smoke test should still screenshot the open HelpTip at the phone viewport in de-CH and es, the two longest.

The wording deliberately does not say the cards show full-day values. Today's card covers only the hours after now (the hourly series starts at the next full hour, `environment.ts:263`), so after 14:00 UTC (17:00 farm time) today's high is below the game's daily maximum and today's rain is the remainder of the day. Record this in the honesty ledger; it does not block.

`environment.water.attributionHelpLabel` ("About the weather data", the HelpTip's `aria-label`) names no provider and stays.

#### 4. Bare imports of the phone's copy of `demo/mount.tsx`

`demo/mount.tsx` imports exactly these bare specifiers:

| Specifier | Line | Used for |
|---|---|---|
| `react` | 1 | `React`, `Component`, `Suspense`, `useEffect` |
| `react-dom/client` | 2 | `ReactDOM.createRoot` |
| `swr` | 3 | `SWRConfig` |

One more is implicit: the root `tsconfig.json:15` sets `"jsx": "react-jsx"` and `@vitejs/plugin-react` uses the automatic runtime, so the compiled file also imports `react/jsx-runtime` (`react/jsx-dev-runtime` in dev).

Everything else in the file is relative: `../src/App`, `../src/index.css`, `./app.css`, `../src/utils/displayPreferences`, `./revalidation`, `./protocol`, `./i18n`, `./public/messages`. The bare imports one level down belong to those modules: `demo/i18n.ts:1,4` imports `i18next` and `react-i18next`; `demo/revalidation.ts:1-2` imports `react` and a type-only `swr`; `src/index.css:1` has `@import "tailwindcss"`. Files that live inside `web/react-gui` resolve their bare imports from `web/react-gui/node_modules` without help.

So plan revision 4's step 8 wording ("its bare imports, such as `swr`, `react-dom/client`, `i18next` and `react-i18next`") overstated the file's own list; revision 5 corrects it. If the phone copy keeps `PublicMountReady` (`mount.tsx:15-27`), it reaches i18next only through the `i18n` default export of `demo/i18n.ts`, not by a bare import; it gains a direct `i18next` import only if `src/phone/mount.tsx` imports it for types or listeners.

The risk is the copy's location. `web/farm-sim` has no `node_modules` (it holds only `docs/` today), so `react`, `react/jsx-runtime`, `react-dom/client` and `swr` imported from `web/farm-sim/src/phone/mount.tsx` either fail to resolve or, if farm-sim installs its own packages, resolve to a second copy. A second `swr` is the silent case: `SWRConfig` from one copy does not configure hooks from the other, so `isVisible: () => bridge.isOpen()` and the `demoRevalidation` middleware would be dropped without an error. Vite's `resolve.dedupe` does not help when the root has no `node_modules`. The phone config needs an explicit alias (or a `resolveId` hook using `createRequire('../react-gui/package.json')`) for at least `react`, `react/jsx-runtime`, `react/jsx-dev-runtime`, `react-dom`, `react-dom/client` and `swr`, and for `i18next`/`react-i18next` if any `src/phone` file imports them. A build check can grep the phone bundle for a single SWR context, or a unit test can assert that the `SWRConfig` imported by the phone mount is the same object as the one `src` hooks import.

## Round-5 addendum (2026-11-23)

Written for plan revision 6. Basis: `main` at `1ca703ae2f` (PR #658 merged) for `src`, `demo` outside `demo/model*`, `public/locales` and `tsconfig.json`; `demo/model.ts` and `demo/model/*.ts` at the hook commit rebased onto it. Where this addendum disagrees with sections 1.2, 1.3, 1.5, 2.4, 2.5 or 3.2 or with the round-3 and round-4 addenda, this addendum and the plan win. Paths follow the round-4 conventions. Every statement comes from reading code on `main`; no browser run took place.

A script checked every new string below (38, lg rows included) against `/Open-?Meteo|Meteo-?Swiss|MeteoSchweiz|MétéoSuisse|MeteoSvizzera|open_meteo|meteoswiss|OpenAgri|Schweiz|Suisse|Svizzera|Suiza|Suíça|Switzerland|Uganda|Kampala|Africa\/|Europe\/|\bRom[ea]\b|Zürich|Genève|Geneva/i`: no match. lg takes the en string in every new row. The de-CH, fr, it, es and pt strings need the native-speaker pass of section 2.5.

#### Line citations on `main`

Files unchanged since `4682fb17b1`, so their citations above still hold: `ScheduleSection.tsx`, `AdvancedScheduleDrawer.tsx`, `environment/WaterTab.tsx`, `StregaValveCard.tsx`, `DraginoTempCard.tsx`, `DraginoSettingsModal.tsx`, `ZoneConfigModal.tsx`, `shared/HelpTip.tsx`, `TimezoneInput.tsx`, `demo/adapter.ts`, `meteoswissCloudNote` (en `devices.json:455`, others `:458`), `common.json:44` and `settings.json:22`. The citations that moved:

| Where above | Was | On `main` |
|---|---|---|
| 2.4; round-3 4.3; round-4 premise 5 and section 3 | attribution `environment/WeatherTab.tsx:172-176` (`defaultValue` `:174`); `HourlyChart` mounted at `:322` | `:167-171` (`defaultValue` `:169`); `:332` |
| Round-3 section 2 | `CurrentConditions` `WeatherTab.tsx:60-92`, guard `:61`, icon `:66`, description `:68-69`, temperature `:72-75`, RH `:77-80`, wind `:82-86` | `:54-90`, `:56`, `:61`, `:63-65`, `:67-71`, `:72-79`, `:80-85` |
| Round-3 section 1 | `CrossZoneAnalysisPage.tsx:253-254`; `src/App.tsx:89` | `:268-269`; `:89-91` (public-build `Navigate` at `:91`) |
| Round-3 summary item 2 | `FarmingDashboard.tsx:501-505` | `:504-508` |
| Round-3 section 3 | `systemPanel` locale lines from en `:821`, others `:824` | 38 lines later (title en `:859`, others `:862`) |
| Round-3 4.2 | `advancedSchedule.timezoneExample` en `devices.json:944`, others `:947` | en `:982`, others `:985` |
| 2.6 | `src/types/farming.ts:943` | `:954` |
| Round-3 section 5 item 1 | `HeaderMenu.tsx:125-138` | `:128-141` (`data-action` at `:130`); see section 6 below |
| Round-4 premise 1; 1.1 | `IrrigationZoneCard.tsx:784`; `:780-787` | `:785`; `:781-788` |
| Round-4 premise 4; section 2 | `IrrigationZoneCard.tsx:666`, tile `:663-678` | `:667`, tile `:664-679` |
| Round-4 section 2 | LSN50 list `IrrigationZoneCard.tsx:874-890`; `zone.water.estimated` `:672-675` | `:875-891`; `:673-676` |
| Round-4 1.1 | `services/api.ts:1564-1568` | `:1570-1574` |
| 3.2 | `environment/WeatherTab.tsx:274,315`; `:26-36` | `:284`, `:325`; `:26-37` (`fmtDay` ends at `:37`). The today card is now marked by `border-[var(--primary)]` (`:136-139`) or its non-animated icon (`:141`) |

#### 1. Weather tab on `main`

**Current-conditions bar** (round-3 section 2). RH now renders through `environment.forecast.relativeHumidityValue` (`WeatherTab.tsx:74-77`) and the compass point through `environment.compass.*` (`:83`); the numbers are locale-formatted (`:69`, `:82`). Neither key names a provider. The description is still the raw payload in a `p` with `capitalize` and `truncate` (`:63-65`), so the payload rewrite and the truncation check of round-3 section 2 stand. With the hook the temperature is the day's forecast maximum (`demo/model/environment.ts:246`), RH and wind are the day's values shown as current (`:247`), and the payload's current rain and 40 % or 10 % probability (`:248`) are rendered by no mounted component: `CurrentConditions` reads neither, and `OnlineTab`, which does, is imported nowhere outside tests.

**Attribution** (replaces the render-site, truncation and string parts of round-4 section 3). The credit is an always-visible `p` with `text-[10px]` (`WeatherTab.tsx:167-171`), rendered under the hourly chart (`:258`) inside the chart's `flex flex-col` column (`:188`), or alone in a `flex justify-end` row (`creditOnly`, `:172`) when no hourly row is visible. It has no HelpTip and no `truncate` class, so it wraps; at 10 px the strings below take two or three lines. `environment.water.attributionHelpLabel` no longer renders. The HelpTip beside the hourly title carries `environment.forecast.hourlyHelpLabel` and `environment.forecast.hourlyHelp` (`:193-195`); neither names a provider, and the attribution's "rain chances … are illustrative" covers the probability line they describe.

Today's card covers only the hours still ahead (round-4 section 3), so its high is the maximum of the remaining hours of the illustrative temperature shape, not the game's daily maximum. Revision 6 therefore calls every temperature illustrative and states the today's-card rule:

| Locale | `devices:environment.water.attribution.open_meteo` |
|---|---|
| en | Rain amounts come from the game's weather service; today's card counts only the hours still ahead. Rain chances and temperatures are illustrative. |
| de-CH | Regenmengen stammen vom Wetterdienst des Spiels; die Karte für heute zählt nur die verbleibenden Stunden. Regenwahrscheinlichkeiten und Temperaturen sind Beispielwerte. |
| fr | Les quantités de pluie viennent du service météo du jeu ; la carte du jour ne compte que les heures restantes. Les probabilités de pluie et les températures sont indicatives. |
| it | Le quantità di pioggia provengono dal servizio meteo del gioco; la scheda di oggi conta solo le ore rimanenti. Probabilità di pioggia e temperature sono illustrative. |
| es | Las cantidades de lluvia proceden del servicio meteorológico del juego; la tarjeta de hoy solo cuenta las horas que quedan. La probabilidad de lluvia y las temperaturas son ilustrativas. |
| pt | As quantidades de chuva vêm do serviço meteorológico do jogo; o cartão de hoje conta apenas as horas que faltam. A probabilidade de chuva e as temperaturas são ilustrativas. |
| lg | Rain amounts come from the game's weather service; today's card counts only the hours still ahead. Rain chances and temperatures are illustrative. |

Smoke: a screenshot of that line under the hourly chart in de-CH and es, the two longest strings, at phone width, with no horizontal overflow.

**Day-card icon.** Every simulator daily row carries `weatherCode: null` and the description "Weather conditions" (`demo/model/environment.ts:299`). `resolveIconType` finds no keyword in it and falls back to `cloudy` (`WeatherIcon.tsx:46-64`), so each day card draws the same cloud (`WeatherTab.tsx:141`), on clear days and storm days alike. The phone's `requestResponse` wrapper, which already rewrites the current description, sets each `forecast.rainFocus.daily[].description`, when `rainFocus` is present (it is null without a provider, `demo/model/environment.ts:262`), to `rain` when the row's `rainMm` is at least 0.05 and to `clear` otherwise, which resolve to the rainy and sunny icons. The card prints the amount with one decimal (`WeatherTab.tsx:147`, `utils/forecastFormat.ts:15-17`), so 0.01-0.04 mm reads "0.0 mm" and 0.05 mm reads "0.1 mm"; a threshold of 0 would draw the rainy icon over "0.0 mm". The simulator counts an hour as a rain hour above 0.05 mm (`demo/model/environment.ts:316,321`); the wrapper takes the same 0.05 mm inclusive, so the icon agrees with the printed figure. No mounted component prints the daily description, so it needs no locale strings, and the attribution need not mention the icon.

#### 2. Agronomic tab and cache badge

The Agronomic tab's current block labels temperature, humidity and VPD with the source label `environment.source.illustrative` (`AgronomicTab.tsx:189-193`, `:210`, `:217`), which the phone sets to "Illustrative values (game)" (section 2.5). Dew point, heat index and THI carry no source label (`:220`, `:226`, `:248`), and their values are fixed or copied from the forecast maximum (`demo/model/environment.ts:251-252`). The Environment card header shows a cache badge whose key is built as `environment.cache.${cacheStatus}` (`EnvironmentCard.tsx:49-63`); every game summary reports `live` (`demo/model/environment.ts:244`), so it reads "Live". Overrides:

| Key | en | de-CH | fr | it | es | pt | lg |
|---|---|---|---|---|---|---|---|
| `devices:environment.agronomic.dewPoint` | Dew point (illustrative) | Taupunkt (Beispielwert) | Point de rosée (indicatif) | Punto di rugiada (illustrativo) | Punto de rocío (ilustrativo) | Ponto de orvalho (ilustrativo) | Dew point (illustrative) |
| `devices:environment.agronomic.heatIndex` | Heat index (illustrative) | Hitzeindex (Beispielwert) | Indice de chaleur (indicatif) | Indice di calore (illustrativo) | Índice de calor (ilustrativo) | Índice de calor (ilustrativo) | Heat index (illustrative) |
| `devices:environment.agronomic.thi` | THI (illustrative) | THI (Beispielwert) | THI (indicatif) | THI (illustrativo) | THI (ilustrativo) | THI (ilustrativo) | THI (illustrative) |
| `devices:environment.cache.live` | Game weather | Spielwetter | Météo du jeu | Meteo del gioco | Tiempo del juego | Tempo do jogo | Game weather |

The T2 smoke asserts these four labels in all seven locales and that the header badge reads the game string.

#### 3. Provider and place keys

- `devices:environment.source.openagri` ("OpenAgri", en `devices.json:477`, other six `:480`) names a real weather provider. Its only reader is the dynamic `environment.source.${source}` in `AgronomicTab.tsx:35-39`, and the simulator never emits that source, so it does not render in M1. The phone sets it to the GAME label of section 2.5, as for `environment.source.open_meteo`, so the all-strings scan passes. With it the provider, country and place overrides number twenty-one.
- The unit test and the smoke scan add `OpenAgri` to the pattern and use `\bRom[ea]\b`. The bare `Rom[ea]` of round 3 matches "Dendrometer" and "dendrometro" in more than twenty shipped keys, es "Promedio", and the phone's own dendrometer overrides.
- `settings:timeZoneInvalid` is translated on `main` in it, es and pt, and the shipped strings name `Europe/Rome`, `Europe/Madrid` and `Europe/Lisbon`. The replacement swaps the shipped `Europe/<city>` for `Etc/GMT-3`. These rows replace the it, es and pt rows of round-3 4.2; en, de-CH, fr and lg stay as there (lg still ships English).

| Locale | `settings:timeZoneInvalid` |
|---|---|
| it | Inserisci un fuso orario IANA valido (ad es. Etc/GMT-3) |
| es | Introduce una zona horaria IANA válida (p. ej., Etc/GMT-3) |
| pt | Introduza um fuso horário IANA válido (por exemplo, Etc/GMT-3) |

- The unit test that requires every overridden key to exist in react-gui's English locale files excludes the public-copy keys `environment.source.{illustrative,meteoswiss}` and `environment.description.weatherConditions` (they exist only through `demo/public-copy.ts:23-24`) and the phone-owned `farmSim.*` keys.

#### 4. Dendrometer tab selector

The first rule of round-4 1.4 becomes:

```css
div:has(+ div > div > select[id^="swt-sensor-"]) > p + div > button:nth-child(2) { display: none !important; }
```

The child combinators pin the adjacency to `SwtForm`'s root `div.grid` (`ScheduleSection.tsx:111`) > `div` (`:112`) > `select` (`:116-117`). The round-4 descendant form (`+ div select`) also matched the zone card's delete-confirm panel (`IrrigationZoneCard.tsx:558-588`: `p`, `p`, then a `div` holding Yes-delete and Cancel) whenever the panel's next sibling is the `ScheduleSection` root (`ScheduleSection.tsx:364`), which happens when the water card (`IrrigationZoneCard.tsx:597`) is absent. It hid Cancel, and `handleDeleteZone` keeps the panel open after a refused delete (`:246-256`). Added smoke assertion: with the trigger section open, "Delete zone" shows both buttons. The drawer-link rule already uses child combinators and stays.

#### 5. LSN50 settings dialog

From T2 a writer opens it with the gear on the LSN50 card (`DraginoTempCard.tsx:186-198`, rendered when not `readOnly`; `readOnly={!canWrite}` at `IrrigationZoneCard.tsx:886`), which mounts `DraginoSettingsModal` (`DraginoTempCard.tsx:199`). The dialog is device configuration with English literals: sensor toggles including `Dendrometer` (`DraginoSettingsModal.tsx:21`) and `Flow Meter` (`:23`), mode and uplink interval, advanced settings, the Chameleon section and an always-mounted "Dendrometer calibration" section (`:645-655`). Every save in the mounted sections calls a `PUT` or `POST` route under `/api/devices/{eui}/` (`lsn50API`, `services/api.ts:1343-1395`), which the bridge refuses as device configuration without calling the simulator; the WATERMARK sections mount only for a device with a watermark reading (`DraginoSettingsModal.tsx:630`), which no game device has.

**Decision: the gear stays visible.** A refused toggle reverts and shows the refusal. The checkbox is controlled by the device prop (`enabled = device[option.key] === 1`, `checked={enabled}`, `:425`, `:439`); `toggle` sets no local state before the request, calls `onUpdate` only on success (`:286`) and on failure sets the dialog's error line `Failed to update <label>` (`:288`, rendered at `:657`). The demo adapter calls the phone's `onError` for every non-2xx answer (`demo/adapter.ts:76`), so the game notice appears as well. After a refused Apply the Mode select keeps the player's pick while the line above it shows the device's real mode (`:466`) and the error line reads "Failed to change LSN50 mode"; that is an unsaved form value, not a refused value shown as applied. The dendrometer toggle and calibration section stay visible as the real app shows them; neither shows a reading, and nothing in them can be saved.

Smoke assertion at T2: toggle Dendrometer or Flow Meter (Chameleon SWT returns before any request on a MOD9 device, `:278-281`), then assert the game notice, the checkbox back at its previous state and an unchanged simulator digest.

#### 6. Logout path

This replaces the selector and the close of round-3 section 5 item 2. Below `sm` (640 px) Add, Settings and Account sit in a panel opened by the header's Menu button (`AppHeader.tsx:169-191`, label `dashboard:header.menu`); the 390 px phone frame is below `sm`, so logout is Menu, then Account, then Log out. The item is `{key: 'logout', onSelect: onLogout}` in the Account menu (`AppHeader.tsx:182-189`), rendered as `button[data-action="logout"][role="menuitem"]` whose `onClick` runs `close()` and then `onSelect` (`HeaderMenu.tsx:128-141`). `HistoryMobileHeader` now composes `AppHeader` (`HistoryMobileHeader.tsx:16`), so the phone-width History header carries the same item.

The interceptor is a capture-phase `click` listener on `document` matching `event.target.closest('[data-action="logout"]')`. It calls `preventDefault()` and `stopPropagation()`, shows the refusal notice and dispatches a bubbling `mousedown` on `document.body`, which closes the Account menu (`HeaderMenu.tsx:34-43`) and the Menu panel (`AppHeader.tsx:147-155`). An Escape keydown would close only the Account menu: `HeaderMenu.tsx:63-66` calls `preventDefault`, and `AppHeader.tsx:159-164` ignores a prevented Escape. Smoke: the notice, an unchanged session token, and `aria-expanded="false"` on the Account trigger (`HeaderMenu.tsx:97`) and on the Menu button (`AppHeader.tsx:170`). The farm-sim e2e reaches these controls with `clickHeaderControl` and `openSettingsFromHeader`, copied from `web/react-gui/demo/tests/header.ts` (19 lines) into `web/farm-sim/tests/e2e/header.ts`. Importing the file instead would load react-gui's `@playwright/test` next to farm-sim's own copy, and Playwright refuses a second copy.

#### 7. Valve cancel body

This replaces the cancel row of section 1.2. `cancelIrrigation` always sends `reason`, default `'operator_cancel'` (`services/api.ts:650-657`). Both cancel controls go through `cancelIrrigationWithAmbiguityRetry` (`services/valveCancelRetry.ts:30-39`), which re-sends with `expectation_id` only after a `409 ambiguous_actuation`. The simulator keeps one active command per valve and never answers that code (`demo/model/irrigation.ts:126-148`). The allowed body is therefore `{reason: 'operator_cancel'}`, and `expectation_id` stays an unknown key. The simulator's cancel answers pass through without a notice: `404 no_active_actuation`, `409 actuation_handed_off` and `503 transport_uncertain` (`:128`, `:142`, `:146`).

#### 8. Flow Meter heading shim

This refines the second implementation note of round-4 section 2. On first match the shim sets `data-farm-sim-literal="flowMeterHeading"` on the `p` and replaces its text with `farmSim.flowMeterHeading`; on every `languageChanged` it rewrites every marked element and any new exact match. Without the marker the exact-text predicate stops matching after the first rewrite, and the heading would keep its first language. Smoke: at T2, switch the phone language twice without remount (en, then de-CH, then es) and assert the heading text each time; no `p` reads `Flow Meter`. The settings toggle label `Flow Meter` is a `span` (`DraginoSettingsModal.tsx:444`), so the `p`-only match skips it.

#### 9. Bare imports of the phone

This replaces the alias proposal of round-4 section 4. `createRequire('../react-gui/package.json').resolve('swr')` follows the `require` condition and returns `swr`'s `dist/index/index.js`, while the app's ES import follows `import` and gets `dist/index/index.mjs` (`swr` 2.3.7 `package.json` `exports`). Those are two module instances, so an alias built that way would still split `SWRConfig` from the app's hooks. The phone config instead re-resolves each bare import from a `src/phone` file with `this.resolve(source, <absolute path of web/react-gui/src/main.jsx>, {skipSelf: true})` in a `resolveId` plugin, so Vite applies the app's conditions and picks the app's file (`src/main.jsx` is the app entry, `index.html:11`). The build guard also fails on two modules of one package whose paths differ only by extension (`.js`, `.mjs`, `.cjs`). Smoke: with the phone open, the bridge calls `requestDemoRevalidation(['/api/devices'])` and sees `GET /api/devices` within 1 s; only the SWR middleware answers that key (plan revision 7, 11.2).

#### 10. Device location

This corrects round-3 4.3, which names the seed coordinates as the only real place in simulator values and has the builder overwrite them. A second source reaches the phone: the public build aliases `services/deviceLocation` to `demo/public/device-location.ts` (`vite.demo.config.ts:29-30`). That module reports GPS as available with permission granted and the English message "Location is available." (`:7-8`), and its `requestDeviceLocation` returns fixed real-world coordinates (`:6`, `:12`), the values `research/sim-integration.md` flags in the seed (`demo/model/state.ts:73-74`). A writer reaches it from T1 with the zone-card gear (`IrrigationZoneCard.tsx:478`, `:1032`; the simulator's `researcher` role can write, `contexts/ScopeContext.tsx:112`). Before any click the dialog's Device GPS block shows the available label, the permission state and the message (`ZoneConfigModal.tsx:852-862`). "Use device location" (`:840`) fills the latitude and longitude inputs (`:489-491`) and prints the pair with accuracy and source (`:866-884`); the refused Save leaves them in the inputs. The provider and place scan has no numeric pattern and reads no input values, and a bundle grep cannot tell the module from the seed.

Plan 10.2 therefore aliases `services/deviceLocation` to the phone's own `src/phone/device-location.ts`, with the same four functions and four types: support resolves unavailable (`reason: 'unsupported'`, `permissionState: 'unknown'`) with the `game_refused` text as its message, the request rejects, the error message is the same text, and `openNativeLocationSettings()` returns false. T1 smoke: in zone settings "Use device location" is disabled, the status reads `zoneConfig.gps.unavailable`, and the latitude and longitude inputs read `-2` and `0` (`ZoneConfigModal.tsx:149-150` keeps longitude 0 as `"0"`).

#### 11. Plan label

This corrects the `label?: string ≤80` bound of section 1.2. `label` is a string or null: the schedule dialog sends `null` for an unnamed weekly or one-time plan, on create and on edit (`valves/ValveScheduleDialog.tsx:359,400`), and `toScheduleBody` forwards it (`services/api.ts:2003`). The simulator accepts null and keeps the first 80 characters of a longer string instead of refusing it (`demo/model/plans.ts:35-36`); the dialog's label inputs set no `maxLength` (`ValveScheduleDialog.tsx:788-794`, `:868-874`). The bridge therefore takes the plan's reference to `plans.ts:32-53` and refuses neither `null` nor a label over 80 characters. A bridge built from 1.2 would refuse every unnamed plan with `game_refused`; the plan's allow-list test creates and edits an unnamed weekly plan and an unnamed one-time plan.

#### 12. `disable-all` from T1

This replaces the T4 row and the named exception for `disable-all` in section 1.2 and its entry in the 1.3 "Trigger below T4" row. The Settings "Irrigation schedule" switch is a per-browser display preference, but turning it off first asks for confirmation and calls `POST /api/irrigation-zones/schedules/disable-all`, and it stores the preference only after that call succeeds (`pages/SettingsPage.tsx:336-353`, row at `:651-660`). With the tier text below T4, a player who hides the trigger section is told the farm needs a higher OSI level, and the switch stays on. Below T4 no zone has a trigger schedule: the public seed clears them (`demo/model/state.ts:81`) and the builder sets none. The handler then answers `{disabledSchedules: 0}` without a state change (`demo/model.ts:1085-1097`), and the pending-outbox count moves only when the canonical snapshot changes (`:721`). The bridge allows the route with no body from T1; the allow-list test asserts the zero answer and an unchanged digest below T4.
