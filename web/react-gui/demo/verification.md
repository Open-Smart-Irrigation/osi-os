# Verification record

The simulator was checked in Chromium on the development machine on 2026-09-29.
Screenshots show the rendered application, not mockups.

## Automated coverage

The model/protocol tests cover deterministic seed/history, name validation,
assignment cleanup, duplicate-open rejection, pending/observed/closed transitions,
cancellation, acceleration, pause, reset, unsupported operations, device ID
restrictions and exact message payloads. Offline fixtures check agreement between
rain/flow device readings, histories and daily totals, removal of sensor sources,
and fixed readings during valve use. History tests cover drying/wetting, delayed
depth response, day/night cycles, shared rainfall, local-day sums and identical
overlapping chart windows.
The 30-day and 90-day records contain 2,881 and 8,641 readings per channel;
their trailing samples exactly match the shorter views. Earlier rain and flow
totals agree with the wetting events and delayed deep-soil responses.

The browser suite exercises the built artifact:

- Prepared farm, both initial zones and all seven shipped languages offline.
- Native header language button below Add and beside Account with matching size.
- All valve locales, tooltip interaction, unclipped names/last-seen and experimental
  Settings controls hidden while supported controls remain reachable.
- Full-text wrapping and horizontal bounds in all seven languages across cards
  and valve dialogs, plus Luganda menus and Settings.
- Temporary zone creation, device assignment, expansion and deletion; the device
  returns to Unassigned Devices and the initial zones remain.
- Water card with rain, measured litres, Soil now and simulated Action, hidden
  environment panel and no forecast; charts/tooltips, depths and wet/moist/dry colours.
- Complete 30-day and 90-day charts at both 20 cm and 40 cm depths.
- Valve acknowledgement, early close, timed close and reset during an opening.
- 1920 × 1080 and 1280 × 720 layouts, exact 390 × 844 application viewport,
  enlargement/restoration and inner scrolling without moving the outer page.
- Offline language change and water-card rendering after the app has loaded.
- Memory-storage isolation, blocked fetch/XHR/WebSocket/EventSource/beacon and
  unavailable geolocation, plus rejection of a message from the wrong window.
- Actual reveal.js navigation, in-form space/arrows, focus return, departure pause
  and retained valve state on return, with a single elapsed-time rate.
- Existing device registration and SWT trigger save/reload, including retaining an
  unsaved threshold while changing languages.

Every browser case checks for uncaught page errors and requests outside localhost.
The localhost server has no API backend/proxy and serves restrictive CSP and
permissions policies. No running gateway or cloud service was accessed.

## Evidence and limits

The production suite passed 213 Node-runner tests and 2,136 Vitest tests across
206 files. Production and demo builds passed;
Vite emitted its existing large-chunk and browser-database-age warnings.

The current revision adds wrapping for long translations and extends sensor
histories to 90 days. Simulator and production checks passed for this revision.

A separate verifier reran all 17 simulator tests, the demo typecheck and build,
all 15 browser cases and 48 focused UI tests. Code review found no blocking issue.
The Luganda wrapping and longer soil-chart screenshots were also inspected visually.

| Check | Result |
| --- | --- |
| `npm run demo:test` | 17 passed |
| `npx tsc -p demo/tsconfig.json --noEmit` | Passed |
| `npm run demo:build` | Passed |
| `npm run demo:test:browser` | 15 passed in Chromium |
| `npm run test:unit` | 213 Node tests passed; 2,136 Vitest tests passed |
| `npm run typecheck` | Passed |
| `npm run build` | Passed |

The verifier also checked that the host returns 200, API and path-traversal
requests return 404, and the server sends the restrictive CSP and permissions
headers. Normal production sources have no demo imports. DashboardHeader mounts the native
language selector, ValveControlPanel uses compact help, ValveTile moves last-seen
above the name, and Settings marks experimental module rows; the normal production build contains no simulator markers.

Screenshots: `overview.png`, `populated-zone.png`, `french.png`, `open-valve.png`,
`layout-1920.png`, `layout-1280.png`, `soil-history-7-days.png`, `settings.png`,
`luganda-wrapping.png`, and 30-/90-day charts at both depths under `screenshots/`.

A separate agronomy agent extended the event sequence, depth delays,
climate cycles and meter totals. The reviewer found no substantive inconsistency;
the scenario remains fictional, as documented in `agronomy.md`.

The initial independent review found two defects that were fixed before final checks:
real geolocation remained reachable through Zone Configure, and the environment
fixture counted a valve as a sensor. Browser failures also caught iframe form
permissions, a missing liters endpoint, reset navigation that did not create a
fresh document, and reveal focus handling. Their regression checks remain in the
suite.

This is a standalone presentation slide and a reveal integration example. The
original deck was unavailable, so its fonts/layout and plugins were not tested.
Firefox, CachyOS-specific rendering, Microsoft Teams sharing and the actual
presentation laptop have not been tested. In particular, automated viewport
checks do not establish that small text survives Teams compression; perform the
manual rehearsal described in README.md.
