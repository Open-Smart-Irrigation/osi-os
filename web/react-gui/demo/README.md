# OSI OS presentation simulator

This runs the real edge React application inside a 390 × 844 iframe, with an
in-memory REST adapter and a fictional MUARIK demonstration farm. It contains no
MUARIK field records. The supplied standalone slide uses English presentation
copy; the phone bundles all seven supported languages: English, Deutsch (de-CH),
Français, Italiano, Español, Português and Luganda. The presenter authorized
machine-translated Luganda valve controls for this simulator. Those unreviewed
strings live only in `demo/locales/lg-valves.json`; production Luganda retains its
human-review policy. Other pending Luganda strings may still fall back to English.

No existing reveal.js deck was found in the available repositories or Downloads.
`reveal.html` is a three-slide integration example, not the full WASAG talk.

## Run locally

From this checkout:

```sh
cd web/react-gui
npm ci
npm run demo:start
```

Open **http://127.0.0.1:4173/**. For the reveal.js example, open
**http://127.0.0.1:4173/demo/reveal.html**. The server binds only to loopback.
Installation needs internet. After installation/build, runtime needs only the
local server; translations, chart code, icons and reveal fonts are local. The
application and standalone host use system fonts.

Build and serve separately:

```sh
npm run demo:build
npm run demo:serve
```

The output is `demo-build/`, separate from the normal `build/`. There is no Vite
API proxy in the demo server. Do not use `npm run dev` for this demonstration.
Keep the source and node_modules on the presenting laptop, or copy `demo-build/`
and `demo/serve.mjs` with their relative directory layout; serving requires Node.
Use Node 22 or newer, as used during verification. Set `DEMO_PORT` if 4173 is busy.

## Four-minute rehearsal

1. **0:00–0:35:** Explain the simulated MUARIK scenario. Use the language control
   below **Add**, beside **Account**, to select Français, then English. This
   is the native LanguageSwitcher in the dashboard header, also available through
   Settings. There is no separate demo strip.
2. **0:35–1:30:** Add → Add Zone → name it “Trial bed”. Use its **+ Device** button
   to assign “Spare demonstration probe”. Expand and collapse the zone, then
   Delete → Yes, Delete. The probe returns to Unassigned Devices. Starting zones
   are protected from deletion so the demonstration can continue.
3. **1:30–2:35:** Expand Tomato plot. Its water card shows **Rain today: 6.0 mm** and
   **Irrigation (measured, flow meter): 120 L**. These are fixed simulated sensor readings. **Soil now** shows the shallow
   reading; **Action** gives explicitly simulated advice for this scenario.
   Expand **Devices in this zone** and select **56.0 kPa** to open the real history
   chart. Select **7 d**, **30 d** or **90 d** to show drying between rain and irrigation events.
   Close the chart and select the 40 cm reading to compare its delayed response.
   In Demonstration bed, the 12 kPa wet
   reading is blue and 35 kPa moist reading is green. Tomato’s 56 kPa shallow reading is red; its 46 kPa deeper reading is green.
   Higher positive tension means drier soil. Collapse the zones when finished.
4. **2:35–4:00:** Scroll to **Valve control**, choose **Open**, enter **1 minute**,
   and confirm. The simulated command waits two simulated seconds before the
   observed open state. Remaining time is shown in minutes, as in the real UI.
   For early closure: More → Valve settings → Close valve now → Yes, close it.
   Close the dialog. Open again, select **10×** outside the phone and watch the
   minute expire in six real seconds. Return speed to **1×** for questions.

Reset demo restores the exact dataset, route, English, light theme, clock and
closed valve, including during an active countdown. Enlarge demo and Return to
slide retain the same iframe and application state. Pause freezes simulated time.
**Slide focus**, or **Shift + Escape** inside the phone, returns keyboard focus to
reveal. Normal arrows, typing, space and scrolling remain inside the phone.

For optional exploration, register a Kiwi with name “Practice probe”, DevEUI
`00000000000000B0`, and an empty AppKey. Only the fictional B0–CF identifier range
is accepted for registration. The spare probe can also be assigned without
registering anything. Expand Trigger-based irrigation to save/reload an SWT
threshold. Its notice states that automatic trigger execution is not simulated.

## Integrate into the real deck

Serve the built assets and deck from the same localhost origin. Preserve the
`/assets/` and `/demo/` paths produced by the build, and the CSP/permissions headers
from `serve.mjs`. Do not embed a gateway URL. Copy the standalone host as one slide:

```html
<section>
  <iframe id="osi-demo" title="Interactive OSI OS slide"
    src="/demo/index.html"
    style="width:1280px;height:720px;max-width:none;max-height:none;border:0;margin:0">
  </iframe>
</section>
```

Include `reveal-bridge.js` in your deck source and call:

```js
import { connectOsiDemo } from './reveal-bridge.js';
const disconnect = connectOsiDemo(deck, document.querySelector('#osi-demo'));
// Call disconnect() only when destroying the deck.
```

Match the outer iframe dimensions to the deck's logical dimensions. The host
scales the phone itself. Keep the iframe mounted (use `src`, not lazy `data-src`).
The bridge sends active state on slide changes and load; hidden slides pause,
returning resumes, and neither action reseeds the farm. The bridge validates the
same origin and exact source window. The host validates each command's shape.
The included example uses reveal.js 6.0.2; rerun the integration checks against
any different version used by the eventual presentation.

## Real functionality and simulated boundaries

| Real application functionality | Simulated input or behavior |
| --- | --- |
| App, HashRouter, dashboard and zone components | Two fictional zones; records only in iframe memory |
| Authentication and scope consumers | Inert demo session string, never a valid gateway token |
| Existing forms, name validation, assignment and confirmation flows | Local CRUD; the two starting zones cannot be deleted |
| LanguageSwitcher and i18next | All seven shipped locales, including existing English fallbacks in Luganda |
| Water card and rain/flow device cards | Fixed local gauge and flow-meter samples; environment panel hidden by default |
| Soil cards, thresholds, depths and interactive charts | Deterministic samples, up to 90 days; presenter valve commands do not rewrite them |
| Valve dialog, pending/observed states and countdown | Two simulated seconds to acknowledge, local close/expiry |
| SWT trigger editor | Saves/reloads configuration; no scheduler execution |

The dashboard title is **OSI OS Dashboard**. Full environment and weather panels
start disabled through the existing display preference. Each zone has a simulated
LSN50 MOD9 node with a rain gauge and flow meter: Tomato has 6 mm and 120 L today;
Demonstration bed has 6 mm and 80 L. Readings and device history share the same
fixed snapshot. Valve demonstrations do not alter these historical measurements.
The water card displays rain, measured irrigation volume, Soil now and Action.
Advice is labelled **Simulated sensor advice**: dry shallow readings suggest
irrigation, wet readings suggest delaying, and moist readings suggest monitoring.
This is a demo fixture using the existing soil-status categories, not a deployed
agronomic recommendation algorithm. The uncalibrated valve estimate stays hidden.
The dashboard header mounts its native language selector. Valve tiles place
last-seen information above the name, and the panel’s compact info tooltip replaces
its subtitle. The tooltip works with hover, focus or tap; Escape dismisses it.

The [agronomy scenario](agronomy.md) records the 90-day event timeline and
review assumptions. Rain and flow histories, local-day totals and current readings
come from one event ledger. Soil channels use separate reviewed curves; they are
not calculated irrigation advice. Temperature, humidity and light histories follow
day/night cycles and shared rain events. The 30-day and seven-day windows are
exact subsets of the same 90-day fictional sensor record.

Long labels wrap inside the phone viewport, including Luganda. Demo styles show
full text instead of single-line truncation; device footer metadata can shrink
and wrap while action buttons retain their size.

No forecast, ET0 or crop-demand calculation is supplied.
Forecast data stays unavailable even if the presenter enables the full environment
panel in Settings. The normal English fallbacks and untranslated text already in
the shipped UI remain; enabling a language does not certify translation coverage.

Settings hides all five controls marked experimental: Prediction advisory, Data
view, Network, Gateway and Field journal. Supported module controls remain visible.
This hiding is scoped to the demo stylesheet; production Settings keeps its controls.

The demo runs a single monotonic clock. Speed multiplies simulated elapsed time,
including acknowledgement and countdown. Pausing consumes no simulated elapsed
time. A reset creates a fresh document and clears React/SWR state; normal route
changes, language changes and enlargement keep the running session. Long
accelerated sessions can make fixed sensor samples stale, which the real UI shows.

Unknown operations return a translated failure and a visible notice. Account
linking, radio/service configuration, weekly valve-plan mutation, device removal,
zone configuration changes, data export, system administration and live location
are outside this simulator. Dismiss an in-phone notice by clicking it; its text
also remains outside the phone. Settings still exposes the real app's controls,
so attempts at unsupported actions are rejected rather than represented as saved.

Transport isolation is installed before App imports its API module. The Axios
adapter has no fallback. Fetch, XHR, WebSocket, EventSource and beacons are blocked;
CSP separately denies connections, workers and external assets. Geolocation is
disabled. Local/session storage are separate in-memory objects in the iframe;
normal app/browser storage is neither read nor overwritten. Production
authentication, API implementation and build entry are unchanged.

## Verify

```sh
npx playwright install chromium
npm run demo:build
npm run demo:test
npm run demo:test:browser
npx tsc -p demo/tsconfig.json --noEmit
npm run test:unit
npm run build
```

Browser tests use the built output. Screenshots are under `demo/screenshots/`.
See `verification.md` for the observed results and limits. A Microsoft Teams
screen-sharing rehearsal on the CachyOS laptop remains a separate manual check.
Rehearse the phone's readability, mouse position and dialog scrolling at the
actual shared-screen size before presenting.
