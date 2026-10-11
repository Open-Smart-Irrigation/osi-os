# Public OSI OS simulator implementation plan

> For agentic workers: use `superpowers:executing-plans` after design/plan review. The user selected Astra expert plan review until green, Luna implementation, and final independent expert review/verification. Steps use checkboxes for tracking.

**Goal:** Make OSI OS feel functional through complete local simulation, then integrate it into the website and link it from GitHub.

**Architecture:** Mount the real React application over stateful in-memory domain handlers. One event clock drives synthetic readings, valve commands, schedules, triggers, and simulated service activity. A separate public entry supplies visitor controls and a static deployment under `/simulator/`.

**Tech stack:** Existing React/TypeScript, Vite, SWR, i18next, Node model tests, Vitest, and Playwright; WordPress/Elementor and Apache static hosting.

**Contract addendum:** [Reviewed action and controller contracts](2026-10-10-public-simulator-contracts.md). Task 1 verifies this source-pinned design before coding; it must not invent missing model policy.

**Spec:** [Public simulator design](../specs/2026-10-10-public-simulator-design.md). Revised after the user clarified that product features should be simulated rather than removed.

## Global constraints

- Each normal application action has a complete simulated outcome. Do not remove scheduling, triggers, configuration, or other product features merely to avoid modelling them.
- The real GUI and its API response contracts remain the reference. A generic successful response without updated local state is insufficient.
- No command, identity, location request, support message, or file upload reaches field hardware or a real cloud service.
- Preserve production defaults/authorization, presentation-entry defaults, and the archived FAO bundle.
- One simulation clock drives commands, scheduled events, trigger evaluation, readings, and displayed timestamps.
- Zero rain with samples differs from missing data.
- Reload starts a fresh session; Reset restores the exact seed, initial route, English/light preferences, clock, fake session, and valve state.
- A dismissible website invitation links directly to /simulator/. Desktop invitation and simulator use a smartphone frame. Mobile uses an unframed preview and an edge-to-edge simulator with native app navigation; breakpoint changes never remount the app.
- Public host instructions/controls support all seven existing app languages.
- Unknown requests fail in development/tests; no normal release flow reaches an unsupported request.
- Work on an isolated branch at execution time. Do not reset the original checkout or access a live farm or `osicloud.ch`.

## Review focus

| Condition | Expected behaviour | Owning tasks |
| --- | --- | --- |
| A normal Settings switch or new device reveals more controls | The newly reachable module and every nested action have model handlers and subsequent readable state. | 1, 3, 6, 10 |
| One accelerated tick crosses several command/run boundaries | Events execute once in chronological order; readings, acknowledgement, closure, and history agree. | 2, 4, 5, 10 |
| A rule conflicts with a manual/weekly run or sees stale data | Use documented current controller semantics; no duplicate opens, replayed runs, or invented missing measurements. | 1, 4, 5 |
| Users delete every zone/device or log out | Reset and local demo re-entry remain usable; historic records retain honest associations. | 3, 6, 10 |
| A public embed, translated phone UI, or initial asset fails | Isolation survives, controls/focus remain reachable, and app-ready timeout offers working Retry. | 7, 8, 9, 10 |

## Execution setup

- [ ] Record the user-authorized sequence: revise invitation/layout plan, Astra review and fix until green, Luna implementation, final independent review and verification. Prepare and test deployable website integration; live publication still needs hosting access and a go-live instruction.
- [ ] Treat full simulated product behaviour as the agreed intent. The prior proposal to remove weekly schedules, triggers, and configuration is superseded.
- [ ] Use the worktree skill and branch from freshly verified remote main. Read AGENTS.md, the engineering playbook, architect.yaml/RULES.yaml, and the relevant GUI/sensor/controller skills.
- [ ] Re-run `npm run demo:build`, `npm run demo:test`, and `npm run demo:test:browser` from `web/react-gui`; record actual baseline results.
- [ ] Review this revised plan independently before execution. The earlier review of a reduced demo does not validate the expanded scope.

## Task 1: Map the complete application to simulation contracts

Files to create: `web/react-gui/demo/action-inventory.md`, `demo/controller-semantics.md`, `demo/tests/public/actions.spec.ts`, and `demo/tests/contracts.test.ts`. Later paths in this plan are relative to `web/react-gui/` unless prefixed otherwise.

Consumes: the source-pinned reviewed contract addendum and current components/client/controller implementations. Produces: demo/action-inventory.md and demo/controller-semantics.md copied from the reviewed addendum, updated only for verified source drift, plus executable contract cases. This is verification of the agreed design, not discovery left to Luna. Report and resolve a genuine source/plan mismatch before forcing code.

- [ ] Verify the addendum inventory against controls for DashboardHeader, FarmingDashboard, every device card/catalogue type, IrrigationZoneCard/ZoneConfigModal, ScheduleSection/AdvancedScheduleDrawer, ValveTile/ValveScheduleDialog/ValveSettingsDialog/ValveServiceDialog/ValveScheduleOverview, SettingsPage, history/analysis, JournalPage, NetworkPage/SystemPanel, and account/support screens. Include enabled module switches and alternate/unassigned card placements.
- [ ] Verify each reviewed action row has the exact client method, method/path, request and response types, state mutation, dependent read keys, validation cases, and browser test. Read `src/services/api.ts`, `src/services/journalApi.ts`, `src/analysis/edgeAnalysisApi.ts`, and direct requests in pages/hooks; do not infer the surface only from the current demo adapter.
- [ ] Verify the addendum controller rules against the shipped scheduler/trigger bodies and existing tests, including repository `scripts/test-scheduler-clock-jump.js` and the valve-control helper tests. Verify the addendum distinction between shipped decisions and simulator-only intended DENDRO control behaviour; VWC is not exposed by the current edge selector. Record current timezone, overlapping-run, manual-vs-automatic, pause/skip/resume, retry, fresh-data, cooldown, VWC/SWT/DENDRO, and proportional/fixed response semantics with source locations. Resolve a discovered mismatch in the written rules before implementing the simulator.
- [ ] Run early model/client tests through npm run demo:test before the public host exists. Browser cases are written once their public host/fixture is available in Tasks 7-9 and run in Task 10; do not claim early browser passes.
- [ ] Establish executable representative contracts across the core and the initial tested HTTP domains now (trigger TRxx first RED belongs to Task 5; environment ENxx first RED belongs to Task 6), with valid inputs and changed dependent reads. Every inventory row receives an explicit owning task and pending executable/browser trace. Tasks 2-6 add each remaining model/client contract RED immediately before implementing its handler; native-only actions receive their browser RED in Tasks 7-9. Task 10 enforces complete 139-ID coverage and rejects pending/skip markers. This stages test authoring with its domain while preserving the entire reviewed scope; the initial representative suite alone is not the final complete gate.
- [ ] Add a static presentation option only for public-demo labels, initial zone expansion, rain-view mode, and offline maps. Do not introduce the previous feature-hiding policy. Commit the inventory, rules, and failing coverage as `test(demo): define complete simulation contracts`.

## Task 2: Add the public state model and event clock

Files: modify `demo/model.ts`, `demo/runtime.ts`, `demo/revalidation.ts`; create `demo/env.d.ts` for the compile-time public flag declaration now (Task 8 sets the flag in Vite); create `demo/model/state.ts`, `demo/model/clock.ts`, `demo/model/readings.ts`, `demo/tests/clock.test.ts`, and `demo/tests/live-readings.test.ts`.

Interfaces: `new Simulator({mode: 'public'})` enables the complete model; default `new Simulator()` preserves the presentation scenario. Keep `request(method, path, body)` and `advance(realMilliseconds): boolean`. Add `jumpToNextEvent(): boolean`. Clock exports `advanceTo(targetMs: number): void` and `nextEventAt(): number | null`; all domains schedule events through this clock.

- [ ] Add failing tests for speed/pause, multi-boundary jumps, equal-time event ordering, no backward jumps, idempotent repeated ticks, reset, and a jump while paused. A paused jump advances through one meaningful next-event time and remains paused afterward. Routine samples are processed en route but excluded as user targets; search is bounded to 8 days. Seed public time at 05:59:50 Africa/Kampala so the 06:00 daily trigger is reachable immediately.
- [ ] Extract public domain state with stable synthetic IDs, per-device active commands, schedules, rules, settings, sessions, and a retained historical ledger. Preserve the original fixed presentation defaults through the constructor mode.
- [ ] Implement chronological event processing with deterministic ordering for acknowledgements, closures, plan runs, trigger checks, sensor samples, restart/sync status, and delayed soil response. Bound a jump to a finite horizon and report an explicit no-event state rather than looping forever.
- [ ] Append deterministic synthetic readings to the seeded 90-day record. Integrate simulated flow only while a valve is observed open; update zone/day volumes from those same samples. Model a delayed illustrative soil response and ordinary drying/rain. Current readings, summaries, chart windows, and trigger input all read this ledger.
- [ ] Test midnight and timezone changes, cancelled/removed devices, missing readings, and maximum supported acceleration. Ensure SWR revalidation uses scoped cache keys for every changed domain. Commit as `feat(demo): add shared simulation clock and live readings`.

## Task 3: Complete farm, device, and history operations

Files: modify `demo/fixtures.ts`, `demo/history.ts`; create `demo/model/farm.ts`, `demo/model/devices.ts`, `demo/model/histories.ts`, `demo/tests/farm.test.ts`, `demo/tests/devices.test.ts`, and `demo/tests/rain-history.test.ts`. Modify `src/components/farming/DraginoTempCard.tsx`, `IrrigationOutcomesPanel.tsx`, `src/services/api.ts`, and null-zone consumers when required.

Consumes: canonical public state/clock. Produces: complete handlers for device catalogue/register/edit/calibrate/delete, zone config/CRUD/assignment, histories, and all derived summaries.

- [ ] Add failing cases for creating/renaming/configuring/deleting either starting zone; area/crop/soil/timezone edits; assignment/unassignment; every offered catalogue type; invalid names/duplicate IDs (duplicate display names remain allowed as in the real validator); calibration save/re-read; and deleting all devices.
- [ ] Implement handlers from the action inventory using existing validation and normalization. Example device form values are fictional and prefilled where helpful; no real identifiers, credentials, or radio registration are required. New device types get suitable deterministic channels and histories.
- [ ] Implement device removal semantics: stop simulated flow, cancel that device's pending/future actions, unassign it, and retain completed records. Zone deletion preserves device histories and existing run labels. Newly unassigned runs use `zoneId: null`; widen frontend actuation typing and guard map lookups accordingly.
- [ ] Implement daily rain through the current versioned contract. In public mode wire the LSN50 rain button to RainMonitor, covering 12/24h and 7/30/90d through an actual device-card browser flow. Preserve the presentation interval viewer. Test all other displayed chart windows/series selectors for seeded and newly added devices.
- [ ] Verify that changing area/efficiency/calibration affects the relevant fictional summaries instead of hardcoded seed values. Test delete-all/recreate/reset and active-valve unassignment. Commit as `feat(demo): simulate farm configuration and devices`.

- [ ] Include the catalogued MILESIGHT_UC512 in public mode using a minimal inspect/config/remove card based on existing fields/forms; current production dashboard does not render it. Do not invent unavailable physical valve actions. Keep this rendering addition public-only.

## Task 4: Simulate valve commands and irrigation plans

Files to create: `demo/model/irrigation.ts`, `demo/model/plans.ts`, `demo/tests/irrigation.test.ts`, `demo/tests/plans.test.ts`, and `demo/tests/public/plans.spec.ts`. Modify public fixture/state/response wiring and only shared GUI code needed to display honest demo state.

Consumes: clock, devices, ledger, and Task 1 controller semantics. Produces: manual/service command state plus stored plans, delivery status, next runs, and recent outcomes. Preserve `valvesAPI` and `devicesAPI` wire formats.

- [ ] Add RED coverage for manual open, acknowledgement, queued cancel, early close, timed close, settings/calibration, and each offered service command. Add create/edit/delete/enable tests for WEEKLY and ONCE plans; check the re-read schedule/summary changes.
- [ ] Implement `POST /api/valve/:eui`, `POST /api/valve/:eui/cancel`, settings/service handlers, and schedule CRUD under `/api/valves/:eui/schedules`. Implement `/plan/resend` and `/scheduler-status` with visible simulated delivery/acknowledgement and changed next-run state.
- [ ] Execute plans using the shared event clock and reviewed timezone/conflict rules. Delivered WEEKLY windows open/close at compiled boundary instants (zero command-open delay); the +2s plan-delivery ACK is separate. A window that starts before its generation is delivered records plan_not_delivered and is never replayed. Manual/ONCE/trigger opens retain the +2s observation delay. This distinction preserves adjacent weekly windows and their volumes. Skip today, pause/resume, disabling/deleting a plan, and one-time completion must affect future execution. A single large time jump must record both acknowledgement and closure.
- [ ] Add this concrete ONCE regression using the current API body and seeded valve:

```ts
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Simulator, VALVE_EUI} from '../model';

test('one-time plan produces a complete simulated run across one large tick', () => {
  const sim = new Simulator({mode: 'public'});
  sim.request('POST', `/api/valves/${VALVE_EUI}/schedules`, {
    kind: 'ONCE',
    fire_at: new Date(sim.now + 60000).toISOString(),
    duration_minutes: 1,
    enabled: true,
  });
  sim.advance(123000);
  const response = sim.request('GET', '/api/irrigation/recent-actuations') as {
    actuations: Array<{status: string; observedOpenAt: string | null; observedCloseAt: string | null}>;
  };
  assert.equal(response.actuations.length, 1);
  assert.equal(response.actuations[0].status, 'COMPLETED');
  assert.ok(response.actuations[0].observedOpenAt);
  assert.ok(response.actuations[0].observedCloseAt);
});
```

- [ ] Exercise those behaviours through the real plan dialog, overview, overflow menu, and alternate valve card. Confirm flow/history effects and unassigned-valve use. Commit as `feat(demo): execute simulated valve plans`.

- [ ] Match queued-cancel versus early-close semantics in the addendum: pending cancel prevents opening; cancelling an observed run does not physically close it. The existing Settings override schedules its own close acknowledgement; ordinary runs self-close. Test continuing flow after cancel of an observed run and stopped flow after Settings-close acknowledgement.

## Task 5: Execute automatic irrigation rules

Files to create: `demo/model/triggers.ts`, `demo/tests/triggers.test.ts`, and `demo/tests/public/triggers.spec.ts`. Modify seed sensor fixtures and summary handlers to supply the channels and outputs used by the real forms.

Consumes: Task 1 controller semantics, live readings, configuration, and the same irrigation command path as manual/planned runs. Produces: actual simulated rule execution and controller feedback.

- [ ] Add failing cases for save/re-read/disable, threshold met/not met, SWT channel and mean selection, VWC and DENDRO modes where offered, missing/stale readings, cooldown, and a valve already opened by another source.
- [ ] Implement the exact `/api/irrigation-zones/:id/schedule` request fields accepted by the current GUI, including duration and response mode. Use the reviewed addendum rules: shipped SWT/daily 06:00 cadence and debounce, with explicitly simulator-only meaningful DENDRO response-mode/threshold behaviour matching exposed UI intent. Changing an offered setting alters subsequent evaluation; do not claim ignored shipped fields already work in production.
- [ ] Evaluate rules on the event clock, queue a simulated valve opening through the shared command path, record its automatic trigger source, and apply the resulting ledger effects. Prevent duplicate starts and feedback loops according to Task 1 semantics.
- [ ] Add deterministic browser scenarios: dry soil activates a rule, wet soil does not, disabling prevents execution, a duration/threshold edit changes the next run, and overlapping manual/weekly/trigger actions resolve correctly. Advance to next event makes each case observable quickly.
- [ ] Compare the simulator's decisions against pinned examples from the shipped controller tests. Label illustrative agronomy without claiming field validation. Commit as `feat(demo): execute simulated automatic irrigation`.

## Task 6: Simulate the remaining application modules

Files to modify also include `demo/app.css`, `demo/datetime.ts`, and `vite.demo.config.ts` for public-only compatibility. Files to create: `demo/model/preferences.ts`, `sessions.ts`, `system.ts`, `journal.ts`, `analysis.ts`, `environment.ts`, `demo/transports.ts`, and corresponding `demo/tests/*.test.ts`. Extend `demo/runtime.ts` and add `demo/public/offline-map.ts` plus local map/media assets. Consume the exact client contracts inventoried in Task 1.

This task can be split into separate implementation commits for preferences/system, session flows, journal, and analysis/environment. Each part must complete its own RED/GREEN cycle; none of these visible modules is deferred from the public release.

- [ ] Add public-mode regressions for current restrictions. Scope demo/app.css selectors [data-experimental-module="true"] and the hidden flow-meter paragraph to a presentation-only root attribute; public mode must display the genuine controls. Branch runtime capture-phase logout/osi-server interception and the saved-trigger unsupported notice to presentation mode only. Public account menu actions must reach local session handlers, and saved triggers execute. Keep original presentation tests.
- [ ] Implement the reviewed transport contract in demo/adapter.ts: export a testable createDemoAdapter(sim) installed before app imports. Retain request(method,path,body):unknown for existing callers; extend DemoError with optional full wire data and headers while preserving its (status,code) constructor. Add requestResponse(...) returning {status,headers,data}; JSON defaults to status 200 and domain-specific creation/deletion/empty status comes from inventory. Adapter constructs AxiosError with the unmodified structured error body and status. Its body decoder preserves FormData/Blob/ArrayBuffer and parses JSON only for JSON input, never by unconditional stringify. Its response encoder honors responseType blob/arraybuffer/text with serialized content and content-type/content-disposition; downloaded JSON/CSV/packages must have actual bytes. Use the addendum to determine formats, not a generic success body.
- [ ] Test through real api.ts/journalApi.ts client functions and the installed adapter for plan_conflict details and ValvePlanConflictError, auth failure, version conflicts, binary/package downloads and multipart/media where offered. In public runtime wrap URL.createObjectURL/revokeObjectURL so client-generated Blob URLs are registered/released automatically; only registered local blobs pass navigation/download guards. Tests must prove no fallback to native transports.
- [ ] Make public datetime policy explicit: explicit per-call timezone wins; otherwise use Settings defaultTimezone when set, then gatewayTimezone, seeded Africa/Kampala. Valve/zone scheduling and rain day boundaries use each resource timezone, falling back to gateway timezone; they are not changed retroactively by a display preference. Gateway timezone changes update fallback resources, not explicitly zoned resources. DefaultTimezone also supplies new-zone defaults as in current GUI. Do not change production datetime. Add demo/public/datetime.ts as a public-only Vite alias with useDisplayPreferences and a demo timezone-store subscription to invalidate useDateFormat on preference/gateway changes. Preserve demo/datetime.ts for presentation. Test browser America/New_York against seed Kampala, explicit Europe/Zurich settings/zone edits, outcomes/history/rain boundaries around midnight, and the controller addendum DST vectors.
- [ ] Add RED tests for every normal Settings switch and the module it enables. Implement local preferences/timezone settings, data/history/analysis reads and saved views, journal plots/entries/corrections/exports, and synthetic weather/advisory inputs from the same timeline.
- [ ] Implement fictional network/gateway status and stateful scan/service/restart sequences. A simulated restart returns after a clock event and preserves farm configuration. Offline maps use bundled geometry/imagery; simulated location selection returns the fictional farm coordinates without browser permission prompts.
- [ ] Implement local logout/login/registration and fictional account-link/sync state using non-production session identifiers. Preserve farm state through local re-entry. Provide an obvious demo-login path, never a dead-end login form or a request for real cloud credentials. For exact inventoried fetch/direct-transport calls, return typed in-memory responses from demo/transports.ts without retaining or calling native transports; unknown URLs/operations still fail. Test a cloud-looking link action against that local registry and prove it emits no network request.
- [ ] Store support submissions in a local demo inbox and show local receipt. Generate downloadable CSV/JSON/packages from current state using the existing client response types. Support local journal media without external uploads. Register simulator-owned blob URLs and permit only those downloads through navigation guards. Normalize the existing src/analysis/download.ts canvas PNG data-URL export to a registered Blob in the public-only download boundary; accept only valid locally generated image/png bytes, never general data navigation. Source inventory found no actual GUI media upload or multipart wire API at the execution base, so do not invent one; release blob resources on reset. Add allow-downloads to both the public app iframe and the outer WordPress iframe, then exercise actual downloads through both frames and assert file content. Add allow-modals to both frames because native Settings, mode-change, calibration-delete and saved-view actions call window.confirm. Exercise real confirmation accept and dismiss through the nested frames; dismiss must preserve state. Keep the existing transport, navigation and permissions boundaries. Do not rely on merely observing a blob creation.
- [ ] Run the contract suite and browser flows through each enabled module, including validation, edit/delete, filtering, and subsequent reads. Assert zero real HTTP connections/messages and no generic empty-success handlers. Commit each completed module group with its tests.

## Task 7: Build the visitor interface

Files to create: `demo/public/index.html`, `demo/public/app.html`, `demo/public/host.ts`, `demo/public/host.css`, `demo/public/locales/{en,de-CH,fr,it,es,pt,lg}.json`, and `demo/tests/public/layout.spec.ts`. Modify `demo/protocol.ts`, `demo/runtime.ts`, `demo/mount.tsx`, and the zone-card/dashboard initial-expansion plumbing when required. Use existing `demo/app.css` only for shared app presentation.

Interface: public host retains `#app` and uses the existing validated speed/active/notice message contract. The public app HTML imports `../runtime.ts`; it does not copy the runtime. Add `initiallyExpanded?: boolean` to IrrigationZoneCard, default false. FarmingDashboard passes true only for public mode's seeded zone 1; React state initializes from that prop without reopening a zone on every refresh. Reset reloads the document and reinitializes it.

Create `demo/public/messages.ts` to import all seven public JSON files and export `DemoLanguage`, `normalizeDemoLanguage(value: string): DemoLanguage`, and `getDemoMessages(language: DemoLanguage)`. Host controls and public app notices consume that shared copy; the existing `demo/i18n.ts` app-locale loader continues reading the normal app translations. Extend the app-to-host union with `{channel: CHANNEL, type: 'language', value: DemoLanguage}` and `{channel: CHANNEL, type: 'startup-error', message: string}`. Public runtime sends language on startup and every i18next `languageChanged` event; host validates origin, exact app window, key count, and locale membership. Reset always selects English/light and sends English with readiness. No host-to-app language command is needed because the native selector owns language changes.

- [ ] Add failing layout cases at 320x720, 360x800, 390x844, 430x932, 768x1024, 1280x720, and 1440x900. Check app/document scroll width, text bounds, at least 44px primary touch targets, visible reset, and dialogs that can be closed. Verify desktop frame presence, mobile frame absence, no double vertical scrollbars, safe-area padding, and narrow landscape/soft-keyboard layout. Verify any compact tools drawer restores focus to its trigger. Include 200% zoom, all locales, and both themes.
- [ ] Create the public host using the real app at natural phone width. Place the app in a smartphone frame with guidance beside it on desktop. On mobile remove the frame, decorative padding and guidance; use 100dvh, safe areas and native OSI OS navigation. Put time/speed/pause/next-event tools in an accessible compact drawer and keep a small simulation indicator plus Reset accessible. The app iframe remains mounted across breakpoints, orientation, and expanded view; no redirect or reload is allowed for a layout change. Test a running valve and open modal through desktop/mobile transitions and check state and focus preservation. Remove slide-focus/return-to-slide wording from this entry. Show a persistent simulated-data label, session-reset note, Reset, speed, pause/resume, Advance to next event, and an expanded view with state preserved. Extend the validated host command union with an exact two-key next-event command and call Simulator.jumpToNextEvent through the existing app-message boundary; reject malformed or wrong-source messages.
- [ ] Add short optional instructions, an initial expanded zone, loading status, and Retry. Start a 15-second host readiness timer whenever the app document is created; clear it only for a valid app-ready message. Initial app-chunk failures cannot report through the app and must reach this timeout. App-reported startup errors fail immediately. Retry uses a fresh session URL, restarts the timer, and restores a usable seed. Test by blocking an initial app asset, then unblocking it and clicking Retry; also test that iframe load alone cannot mark the app ready. Each side sends messages to `location.origin`.
- [ ] Localize host text and sync it with the native app language. Keep the Luganda review status explicit and the existing demo-only translation policy. Guidance must still make sense when seed zones are renamed/deleted. Reset must clear pending notices, timing, route, form state, preferences, and translations. Test reset during pending/open valve states and while a modal is open.
- [ ] Run layout, focus, message-validation, and reset tests; inspect actual captures at 320px, 390px, desktop, and 200% zoom. Commit as `feat(demo): add responsive visitor interface`.

## Task 8: Package a public static build

Files: modify `vite.demo.config.ts`, `package.json`, `demo/runtime.ts`, `demo/playwright.config.ts`, and `demo/tsconfig.json`; create `demo/env.d.ts`, `demo/check-build-isolation.mjs`, `demo/tests/build-isolation.test.ts`, `demo/public/serve.mjs`, `demo/public/apache.conf`, `demo/public/apache-subdomain.conf`, `demo/playwright.public.config.ts`, and `demo/tests/public/hosting.spec.ts`. Add demo/website/package.mjs for dependency-free invitation asset packaging. Add a CI workflow under `.github/workflows/public-simulator.yml` once the source checks work locally.

Interface: `npm run demo:build:public` emits `web/react-gui/public-demo-build/` containing root `index.html`, `app.html`, and local assets. `npm run demo:serve:public` serves it on loopback port 4174 under `/simulator/` with deployment-equivalent headers. `npm run demo:test:public` runs the public browser suite. The original presentation commands retain their paths and localhost guard.

- [ ] Add failing hosting cases for `/simulator/`, reset's app URL, every asset URL, a non-localhost hostname, path traversal, missing resources, and forbidden APIs. Configure Chromium test hostname `demo.osi.test` to resolve to loopback using `--host-resolver-rules=MAP demo.osi.test 127.0.0.1`. Firefox uses localhost with an equivalent public-mode test and requires a separate non-localhost smoke check if host mapping is unavailable.
- [ ] Add explicit public build mode in Vite. Set public `root` to `resolve('demo/public')`, public `base` to `/simulator/`, absolute output to `resolve('public-demo-build')`, and inputs to the public index/app HTML. Exclude reveal/presentation entries. Define a compile-time public flag with a declaration in `demo/env.d.ts`; default it false. Only that flag bypasses the localhost hostname guard; URL query strings, storage, and auth tokens cannot change it. Include public source recursively in `demo/tsconfig.json`, excluding all demo tests and both Playwright configs. Public Playwright uses `testDir: './tests/public'`; presentation Playwright ignores `**/public/**` so the suites cannot discover each other's cases.
- [ ] Implement the small static test server and per-directory Apache configuration. Preserve `connect-src 'none'`, same-origin internal frames, blocked workers/form navigation/geolocation, and no proxy. Same-origin Apache uses `frame-ancestors 'self'`; the optional subdomain template uses `frame-ancestors 'self' https://opensmartirrigation.org` plus only the exact staging parent in staging. Test both templates with allowed and rejected ancestor origins, including the nested app frame. For optional subdomain embedding, also test actual native confirm accept and dismiss through website → cross-origin host → same-origin app in Chromium and Firefox with deployment-equivalent headers. Assert native dialog type and subsequent mutation/preserved state; frame loading and ancestor checks alone are insufficient. Do not override window.confirm. If the origin chain suppresses dialogs, keep top-level/full-view access and withhold the optional interactive embed until a separate reviewed public confirmation implementation passes equivalent tests; retain every action and cancellation path. Adapt paths beneath the base and use no-store for HTML, cacheable fingerprinted assets, correct MIME types, and 404 for absent resources. Test the same policy on the public app HTML as on the host.
- [ ] Confirm registered simulated transports never delegate to fetch/XHR/WebSocket/EventSource/beacon or Axios's native adapter, and unregistered requests stay blocked on the public hostname. Run `npm run build` and `node demo/check-build-isolation.mjs --production build --public public-demo-build --source src`. The checker rejects `inert-demo-session-not-a-jwt` and simulator module references in normal production `build/`; its source-import check excludes test files and rejects production imports from demo/. Add known-bad temporary fixtures for both checks and confirm they fail. Separately check public-demo-build contains only index/app HTML and their local assets, excluding reveal/presentation entries. Verify the public Vite/test-server configuration has no API proxy. The public artifact is expected to contain the simulator marker/runtime and ordinary API route strings from reused clients; those are allowed there. The marker/import prohibition applies only to normal production build/ and production source imports. Actual network fallback is checked by the transport tests, not by banning route strings. Exercise normal refresh and reset at the deployed base rather than only `/`.
- [ ] Package website assets separately: npm run demo:build:website runs node demo/website/package.mjs and emits website-demo-build/{invitation.js,invitation.css,osi-os-preview.png,invitation.html,preview.html,embed.html}. The packager is created in Task 8 but first invoked in Task 9 after the screenshot/invitation assets exist; it fails on missing inputs rather than emitting placeholders. Copy source assets without Vite module dependencies; fixture HTML references /website-demo/ assets and its simulator link/iframe references /simulator/. npm run demo:serve:public serves both directories on port 4174: /simulator/** gets simulator CSP, /website-demo/** gets website-compatible fixture headers (no simulator connect-src policy); no API proxy on either. Reject traversal/missing files on both roots. During Task 8, public Playwright webServer builds only the public simulator then starts this server; website routes return 404 until Task 9 supplies the invitation/assets. Task 9 changes webServer to run both build commands then this server, baseURL http://127.0.0.1:4174; invitation tests use /website-demo/preview.html and outer-frame tests /website-demo/embed.html. Include mobile user-agent Chromium (isMobile/hasTouch) plus desktop Chromium/Firefox projects, not only narrow viewports. Tests verify request sets before activation exclude simulator app chunks.
- [ ] Run the public build/suite and original presentation build/suite. Add CI jobs using the repository's current Node/dependency conventions, separate browser artifacts, and no deployment secrets. Commit as `build(demo): package isolated public simulator`.

## Task 7b: Complete device demonstrations after Task 8

The user extended the scope on 2026-10-11 to require realistic simulated data and supported behavior for all nine native Add device families, with connected Chameleon on LSN50 and Tensiomark on SDI-12. Nine device-specific Astra consultations and a scoped plan review are complete.

Execute [the accepted device extension](2026-10-11-public-simulator-device-extension.md) after Task 8 acceptance and before Task 9 captures the preview. Its slices are shared forcing (7b-A), native data/configuration integration (7b-B), and complete native device browser acceptance with specialist rechecks (7b-C). Each slice uses Luna implementation and scoped Astra review. The extension's eight accepted rulings govern source nulls, calibration exceptions, registration defaults, depth metadata, water provenance and device-specific rain accounting. Task 10 and the final independent review/verification remain required.

Review: [Astra GREEN](../../reviews/2026-10-11-public-simulator-device-plan-astra.md). The nine specialist reports are under `docs/reviews/2026-10-11-public-simulator-devices/`.

## Task 9: Prepare website and GitHub integration

Files to create: `docs/website/osi-os-demo-page.md`, `docs/website/osi-os-demo-embed.html`, `web/react-gui/demo/website/invitation.{js,css,html}`, `web/react-gui/demo/website/preview.html`, `web/react-gui/demo/tests/public/invitation.spec.ts`, and `docs/operations/public-simulator-release.md`. Modify `README.md` only at the integration stage. Capture and visually review a stable screenshot after Task 7 layout passes and Task 8 serves the public artifact, before Task 9 packages the invitation. Store it under docs/images/osi-os-simulator.png and demo/website/osi-os-preview.png. Task 10 performs final visual verification; there is no Task 9 dependency on a future Task 10 artifact.

Consumes: the versioned artifact from Task 8 and its `/simulator/` base. Produces: tested website-wide invitation JS/CSS and a local WordPress-like preview fixture, exact WordPress installation instructions/page copy, an optional Elementor embed, release/rollback instructions, and the README entry. These files prepare external changes; they do not publish them.

- [ ] Implement and test local integration first. Document uninspected hosting/staging access as a release prerequisite, not a blocker to Tasks 1-10. At release setup, check target hosting access and staging with the maintainer. Verify Apache directory headers and static upload support using a harmless staging file. If those are unavailable, amend the hosting section to a static subdomain and explicit frame-parent origins before deployment. Never apply simulator CSP to WordPress pages.
- [ ] Capture/review the screenshot from the already served public simulator, then implement the invitation assets and run demo:build:website. Extend public Playwright webServer to build both artifacts before serving the fixture; Task 8 public-host tests work before these website inputs exist.
- [ ] Add RED browser tests on the local website fixture: first visit opens a labelled dialog; desktop phone-screen click/CTA navigates same-tab to /simulator/; close-cross and Escape leave the URL unchanged and restore focus/scrolling; Tab stays within the dialog; returning after dismissal/navigation does not auto-open again in that tab; a new session opens it; unavailable sessionStorage does not crash; repeated script installation cannot duplicate it. Include mobile unframed preview, 320px/landscape/200% zoom, reduced motion, and a normal website link that always works.
- [ ] Implement a dependency-free invitation script and scoped CSS using the approved OSI OS screenshot. Use a real anchor for the preview/CTA and a separate 44px close button. Set dialog semantics and preserve/restore previous focus, scroll and background inert attributes without disturbing WordPress handlers. Remember display/dismissal/navigation with a namespaced session key and in-memory fallback. Avoid loading live simulator scripts or assets before navigation. Keep the screenshot and invitation assets local. Configure the direct simulator URL in one place for preview/staging/production. Use scoped selectors and idempotent installation. The mobile preview has no decorative frame. Provide exact WordPress asset uploads to /wp-content/uploads/osi-os-demo/ and footer enqueue/snippet instructions: load invitation.css and deferred invitation.js once on public pages, pointing to /simulator/. Include the screenshot at the same asset directory. Turning off the enqueue disables the invitation immediately without removing the simulator. Provide WordPress footer enqueue/snippet instructions without applying simulator CSP to website pages.
- [ ] Prepare the optional landing page at `/try-osi-os/` with title Try OSI OS, the fictional-data explanation, session-reset behaviour, optional instructions, embedded simulator, and a working full-view link. Use this iframe structure, adapting only the reviewed origin if hosting changes:

```html
<iframe
  src="https://opensmartirrigation.org/simulator/"
  title="Try OSI OS with a fictional farm"
  loading="lazy"
  sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-modals"
  allow="geolocation 'none'; camera 'none'; microphone 'none'"
  style="display:block;width:100%;height:900px;border:0"
></iframe>
<p><a href="https://opensmartirrigation.org/simulator/">Open the full simulator</a></p>
```

- [ ] Document responsive iframe heights and the mobile full-view option; nested scrolling must be tested in the actual Elementor template. Install the invitation site-wide after the simulator is live. Add a persistent Try OSI OS link near View on GitHub and Releases & Downloads on the existing OSI System page; all primary invitation/system/GitHub links target /simulator/ directly. The explanatory landing page is optional. Document how to disable the invitation independently during rollback.
- [ ] Prepare the README link/screenshot beside the introduction. Link directly to https://opensmartirrigation.org/simulator/ and state that users can try fictional sensors, valve operation, schedules, and automatic irrigation without hardware or signup. Keep this change unpublished until the public destination is working. Record the exact artifact commit, deployment path, headers, cache handling, and rollback to the previous artifact in the runbook.
- [ ] Verify the invitation end-to-end on the local website fixture and then staging when access exists: dismiss and continue browsing, click the preview, inspect desktop frame/mobile edge-to-edge UI, direct navigation, translations, reset, and scoped headers. The local fixture validates the artifact without claiming a live WordPress install. Inspect the optional embed/full-view link separately. Verify the README URL equals the agreed production destination and the same path returns 200 on the local fixture or available staging. The production URL 200 gate belongs to Task 11 after upload. Commit the reviewed content/runbook as `docs: prepare public simulator entry points`.

Task 9 also creates `demo/website/embed.html`, the actual outer-frame local fixture copied by the Task 8 website packager. This is separate from the deployment snippet `docs/website/osi-os-demo-embed.html`. Both reference the reviewed simulator and preserve modal/download permissions and full-view fallback.

## Task 10: Verify the entire reachable interface

Files: extend `demo/tests/public/actions.spec.ts`, `layout.spec.ts`, `hosting.spec.ts`, and `demo/action-inventory.md`; update `demo/README.md`, `demo/verification.md`, and `demo/agronomy.md` with observed results and simulation limits. Capture screenshots under `demo/screenshots/public/`.

- [ ] Create browser flows for every action-inventory row. Include every action from Tasks 1-6, all chart windows through seeded and newly added device cards, schedules and trigger execution, configuration and enabled modules, local account recovery, exports/media, delete-all, empty assignment choices, and reset from every major screen. Watch the demo notice channel and fail normal flows on unexpected notices or unsupported requests. Form validation is tested separately and may show its expected message. Change the native app language and assert the host instructions, controls, and public error messages change too; Reset returns both documents to English.
- [ ] Collect uncaught page errors, failing resource requests, and requests leaving the simulator origin. Assert the collection is empty for successful flows. Seed a deliberately unsupported request in a negative test and confirm that this monitor fails, so an incomplete monitor cannot produce a false pass.
- [ ] Run the following from `web/react-gui`, recording actual totals rather than copying historical counts:

```sh
npm run demo:test
npx tsc -p demo/tsconfig.json --noEmit
npm run demo:build
npm run demo:test:browser
npm run demo:build:public
npm run demo:test:public
npm run typecheck
npm run test:unit
npm run build
node demo/check-build-isolation.mjs --production build --public public-demo-build --source src
```

- [ ] Run Chromium and Firefox public projects, then record Safari/iPhone and Android touch checks. Exercise all six native confirmation actions in valid conditional states: scheduler disable, apply timezone to all zones, incompatible LSN50 mode change, WATERMARK calibration deletion, legacy dendrometer baseline reset, and saved analysis view deletion. Observe native confirm dialogs for both accept and dismiss, with mutation/readback and cancellation preservation, through the same-origin embed and every supported cross-origin fallback. Include native accept/dismiss in Safari/iPhone and Android release checks; record any unavailable device/origin checks honestly. Inspect 200% zoom, language-menu keyboard interaction, modal focus return, dark theme, all seven locales, and the WordPress embed. Request farmer-language review of new instructions and relevant valve text; record any unreviewed Luganda copy using the existing demo-only policy.
- [ ] Request an independent whole-surface review against the action inventory, not only the code diff. Record defects and rerun affected checks after fixes. A verifier who did not author the code runs the final gates before a PR. Commit evidence and approved screenshots as `test(demo): verify public visitor flows`.

## Task 11: Release the reviewed artifact

Consumes: accepted design/plan, completed Tasks 1-10, reviewed artifact, staging URL, hosting permissions, and an explicit go-live instruction. Produces: a working public simulator, website links, and README link, with a recorded rollback target.

- [ ] Present the working staging simulator and final page/README changes for review. Do not request publication approval against an unbuilt design.
- [ ] Once publication is authorized, upload only the reviewed static artifact and scoped headers. Retain the previous artifact and config for rollback.
- [ ] Smoke-check the public URL on phone/desktop: first load, asset MIME types, rain/soil histories, valve open/close, reset, transport isolation, and the WordPress embed/full-view link. Before enabling any optional embed, confirm native accept/dismiss on its actual origin chain in supported desktop/mobile browsers; otherwise publish only the working top-level/full-view entry until the separately reviewed confirmation solution is verified.
- [ ] Enable the WordPress invitation and persistent system link, publish any optional landing page, and merge the direct README link only after those checks pass. Verify close-cross dismissal leaves the website usable and invitation activation opens the simulator with desktop frame/mobile full-screen layout. Verify the production README link target returns 200 and the entire flow starting from both the website and GitHub.
- [ ] Record public URLs, deployed source commit, verification evidence, and rollback location in the release runbook. If a gate fails, restore the previous artifact and withhold entry-point publication until the failure is resolved.

## Plan review checklist

- [ ] Scheduling, triggers, device/zone configuration, and ordinary application modules remain present and work through simulation.
- [ ] Every inventoried action has state-changing or read-only behaviour as appropriate, a client contract, and a browser test.
- [ ] Time jumps execute ordered events once, including complete command cycles and midnight boundaries.
- [ ] No real hardware/cloud command, support submission, geolocation request, or upload leaves the demo.
- [ ] Public hostname/base-path tests exercise the generated artifact and the WordPress embed.
- [ ] Production defaults, presentation defaults, and the archived FAO bundle remain usable.
- [ ] Hosting conditions and translation review status are accurately recorded before release.

## Planning validation

This revision supersedes the reviewed manual-watering-only proposal. Execution base 2e8beead65292bcdcbceba2b239f5ec2e70f2877 was freshly fetched: 18 model tests, 25 Chromium presentation browser tests, presentation build and GUI typecheck passed. These are baseline checks, not public-simulator acceptance. Its review findings about rain visibility, host language messages, nested framing policies, ready-timeout recovery, and production build isolation remain incorporated. Full simulated behaviour adds controller execution and stateful domain work. Independent review of this revision found no remaining reduced-scope contradiction; its download finding is addressed by allow-downloads on both sandboxed frames and embedded file-content tests. The production-marker rule now names its separate production/public scopes.

The smartphone invitation/layout revision and contract addendum received independent Astra GREEN for implementation; see docs/reviews/2026-10-10-public-simulator-plan-green-astra.md. Luna execution is authorized and starting. Publication has not started.
