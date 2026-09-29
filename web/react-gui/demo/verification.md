# Verification record

The simulator was checked in Chromium on the development machine on 2026-09-29.
Screenshots show the rendered application, not mockups.

## Automated coverage

The model/protocol tests cover deterministic seed/history, name validation,
assignment cleanup, duplicate-open rejection, pending/observed/closed transitions,
cancellation, acceleration, pause, reset, unsupported operations, device ID
restrictions and exact message payloads. Fixture recommendations are compared to
the shipped `osi-zone-env.resolveWaterAction` helper.

The browser suite exercises the built artifact:

- Prepared farm, both initial zones and English/French switching.
- Temporary zone creation, device assignment, expansion and deletion; the device
  returns to Unassigned Devices and the initial zones remain.
- Water card, chart and tooltip, depth labels, wet/moist/dry colours and values.
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

The baseline production suite passed 206 Node-runner tests (one additional test
skipped) and 2,135 Vitest tests across 206 files. Production and demo builds passed;
Vite emitted its existing large-chunk and browser-database-age warnings.

An independent verifier reran the final artifact and found no remaining blocker:

| Check | Result |
| --- | --- |
| `npm run demo:test` | 9 passed |
| `npx tsc -p demo/tsconfig.json --noEmit` | Passed |
| `npm run demo:build` | Passed |
| `npm run demo:test:browser` | 9 passed in Chromium |
| `npm run test:unit` | 206 Node tests passed, 1 skipped; 2,135 Vitest tests passed |
| `npm run build` | Passed |

The verifier also checked that the host returns 200, API and path-traversal
requests return 404, and the server sends the restrictive CSP and permissions
headers. Normal production sources have no demo imports or edits; the normal
production build contains no simulator markers.

Screenshots: `overview.png`, `populated-zone.png`, `french.png`, `open-valve.png`,
`layout-1920.png` and `layout-1280.png` under `screenshots/`.

The independent review found two defects that were fixed before final checks:
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
