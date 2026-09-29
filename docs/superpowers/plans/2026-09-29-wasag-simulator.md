# WASAG local simulator

Build the actual edge React App from main in a separate Vite entry, embedded in a
390 × 844 iframe on a standalone presentation host. No deck source was found.
Production entry, auth provider, API services and deployment remain unchanged.

## Implementation

1. Add `web/react-gui/demo/model.ts` and deterministic fixture factories. Test
   zone creation/name validation, assignment/deletion, valve pending/observed/
   cancelled/completed transitions, pause/speed/reset and unsupported requests.
   Reuse frontend name rules and sensor units. Serve backend water summaries as
   explicitly simulated outputs; do not claim a new calculation.
2. Add `demo/runtime.ts` before dynamically importing `demo/mount.tsx`, which mounts the real App.
   Install an Axios default adapter (inherited by the existing API instance),
   block fetch/XHR/WebSocket/EventSource/beacon,
   and use in-memory Storage objects for the independent entry. Seed an inert
   demo-only session, English, light theme and fictional MUARIK farm.
   A single clock controls Date.now and valve transitions. SWR refreshes visible
   state after transitions. No live fallback. Unsupported actions return a
   translated error and a visible demo notice.
3. Add `demo/index.html` (host), `demo/app.html` (real GUI entry), host CSS and
   script. Scale an unchanged mobile viewport, preserve the iframe on enlarge,
   and provide reset, speed, focus-return and pause controls. Validate origin,
   source and message payloads. A reveal integration helper sends active state
   on slide changes; iframe isolation keeps app keyboard/scroll events local.
4. Add a separate Vite config, build output and loopback-only static server with
   restrictive CSP, no proxy, and no backend routes. Copy only local app assets.
   Keep all demo imports out of the production entry/build.
5. Exercise the built host with browser tests at 1080p and 720p: overview,
   all seven shipped languages, temporary zone and assignment cleanup, water/soil charts,
   valve command/cancel/expiry, reset, pause/resume, enlargement, transport
   isolation and unknown actions. Capture four screenshots. Run the existing
   frontend suite and production build. Document any pre-existing failures.
6. Write demo README with exact commands, reveal embedding, four-minute script,
   simulated output boundaries and Teams rehearsal remaining manual.

## Review focus

- Fail closed before importing any application module, including eager imports.
- Reset clears SWR/component state and storage without touching ordinary app data.
- Pause/speed control the UI countdown and simulator through the same clock.
- Synthetic identifiers only; never read live data or use a production token.
- Real language selector uses all seven bundled translations, preserving existing
  English fallbacks where human Luganda translation is pending.
- Existing UI has expandable zones, not a separate zone route. Preserve that.

## Independent review amendments

The reviewer required a complete iframe Date replacement (both constructor and
`now`, retaining parse/UTC/prototype), elapsed time from performance.now, and a
single state transition tick. Reset reloads the app iframe; enlargement never
replaces it. Override Storage only in the iframe window. Install the Axios adapter
before importing App and return AxiosError responses. Enumerate dashboard reads
in the model and prove the inherited adapter through the real rendered UI.
Replace i18n configuration only in the demo build with all seven eagerly bundled locale resources, removing HttpBackend/detection. CSP blocks every network
connection. Both messaging directions validate origin, source and exact payload.

The demo mount reuses App directly. At the presenter’s request the production
DashboardHeader now mounts the real LanguageSwitcher below Add and beside Account
in the mobile layout. The former demo-only language strip is removed.
The independent code review found and closed a geolocation gap and corrected the
environment sensor count to exclude valves. Reset uses a changing session query
to force a new document even when the current hash route is already the dashboard.


## Offline sensor revision

The presenter requested OSI OS branding, all currently supported languages, and
an offline sensor scenario. Hide the full environment module by default with its
existing preference. Seed one MOD9 rain/flow node per zone, keep measurements
fixed and consistent across history and daily summaries, and remove forecast,
demand and computed advice. Show measured rain and irrigation litres, Soil now and explicitly simulated
sensor advice in the existing water card. Bundle all seven existing
locales, preserving their fallback policy. Test every language offline and refresh
the screenshots and rehearsal notes.

Independent plan review required matching device/summary values, an explicit
false environment preference, removal of demand-oriented copy, and browser checks
for the hidden advice, estimate and soil-summary tiles. The implementation adopts
these requirements. Soil cards and history remain available through device cards.


## Natural histories and native header revision

A separate agent acting as agronomy reviewer proposed a coherent fictional week:
shared rain, separate measured irrigation events, shallow wetting followed by a
delayed deeper response, and slower drying overnight. `demo/history.ts` holds the
event ledger and per-depth anchors. Interval rain/flow readings sum to local-day
totals; rates derive from the interval amounts. Latest values and chart windows
share the same fixed snapshot. There are seven days of samples; longer chart
windows return that available record. Presenter valve actions never rewrite it.

The independent plan reviewer required those consistency checks and header size/
alignment tests, and verified the demo retains the local i18n alias after moving
the native selector into DashboardHeader. Header geometry is checked inside the
390px iframe; production headers with additional modules retain their wrapping
layout. The agronomy reviewer also inspects the implemented event sequence.


## Valve localization and compact layout revision

Complete the valve namespace’s English placeholders in Italian, Spanish and
Portuguese and the dispatch-state gaps in German and French. Replace the panel
subtitle with localized compact help, available on hover, focus or tap and
dismissible by Escape or another tap. Keep weekly/on-valve wording distinct from
one-time/gateway execution. Move last-seen into a full-width row above valve names.

The user permits machine Luganda for this simulation only. Keep those overrides
separate from production locale resources, preserve placeholders and test the
rendered panel/dialog in all seven languages. Document the unreviewed status.

Restore Soil now and Action in the water card. Label the action as simulated
sensor advice, use the existing soil-status categories, and keep forecasts and
crop-demand calculations absent. Rename the volume to Irrigation (measured, flow
meter). Hide the five Settings module controls explicitly marked experimental
using a demo-only rule; do not hide supported controls or change production defaults.
