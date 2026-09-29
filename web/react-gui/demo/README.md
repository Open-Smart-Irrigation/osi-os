# OSI OS presentation simulator

This runs the real edge React application inside a 390 × 844 iframe, with an
in-memory REST adapter and a fictional MUARIK demonstration farm. It contains no
MUARIK field records. The supplied standalone slide uses English presentation
copy; the phone uses the existing English and French translations.

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
   above the dashboard to select Français, then English. This is the real
   LanguageSwitcher, also available through Settings; the demo strip keeps it
   available without navigating away.
2. **0:35–1:30:** Add → Add Zone → name it “Trial bed”. Use its **+ Device** button
   to assign “Spare demonstration probe”. Expand and collapse the zone, then
   Delete → Yes, Delete. The probe returns to Unassigned Devices. Starting zones
   are protected from deletion so the demonstration can continue.
3. **1:30–2:35:** Expand Tomato plot. Its water card says **Irrigate today**.
   Expand **Devices in this zone** and select **68.0 kPa** to open the real history
   chart. Show 20 cm and 40 cm readings. In Demonstration bed, the 12 kPa wet
   reading is blue and 35 kPa moist reading is green. Tomato readings are red.
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
| LanguageSwitcher and i18next | Only bundled en/fr; no claim about Luganda review status |
| Water card, translated reasons and environment panels | Fixed backend response, including a cached forecast sample |
| Soil cards, thresholds, depths and interactive charts | Deterministic samples, up to seven days; irrigation does not rewrite them |
| Valve dialog, pending/observed states and countdown | Two simulated seconds to acknowledge, local close/expiry |
| SWT trigger editor | Saves/reloads configuration; no scheduler execution |

Tomato's sample balance is −4 mm with 0.5 mm forecast rain; the demonstration bed
has +2 mm. These match the existing `resolveWaterAction` branches in
`osi-zone-env/index.js`. The simulator does not calculate ET0, crop demand or
predictions. The real water card's action is a water-balance verdict; the soil
reading is displayed alongside it, not secretly fed into a new combined model.
No cloud or live weather service is called. Forecast values are fixtures, even
where the existing environment UI names their source format.

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
normal app/browser storage is neither read nor overwritten. Production source,
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
