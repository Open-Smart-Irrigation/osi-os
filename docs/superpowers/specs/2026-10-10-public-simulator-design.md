# Public OSI OS simulator design

Status: revised October 10 for the smartphone invitation. The user authorized Astra plan review, revisions until green, Luna implementation, and final independent review/verification. Live publication remains a separate release step requiring target access.

## Purpose

Website visitors, potential partners, and farmers should experience OSI OS as a working application using fictional devices and data. The user clarified that features should work through simulation: opening a valve must open it in the interface, with no command sent to a field device.

The release rule is: each normal application action has a complete simulated outcome. Implement the model behind the controls. Do not remove scheduling, triggers, configuration, or other product features merely to avoid modelling them. Normal validation, permission restrictions, and device-specific availability still apply.

## Scope

Reuse the current farmer-facing application, including features reachable through its menus, Settings, and device catalogue. Start signed into a fictional demonstration farm. A user may explore freely without hardware or a real account.

| Surface | Simulated behaviour |
| --- | --- |
| Farm overview | Two fictional zones with wet/moist/dry readings, a valve, rain/flow meters, and example sensor types needed to exercise the available irrigation modes. One zone starts expanded. |
| Zones | Create, rename, configure crop/soil/area/timezone, assign/unassign devices, and delete with confirmation. Deleting either starting zone is allowed. |
| Devices | Add example devices through the real forms/catalogue, rename, configure, calibrate where offered, and remove with confirmation. Added devices acquire coherent synthetic readings for their type. |
| Manual valves | Pending acknowledgement, open/closed state, countdown, early closure, queued-command cancellation, and recent-run records. Settings and service commands produce corresponding local state changes. |
| Irrigation plans | Create/edit/delete/enable weekly and one-time schedules, show next runs, simulate plan delivery/acknowledgement, skip today, pause/resume, resend, and execute when simulated time reaches the run. |
| Automatic irrigation | Save SWT/VWC/dendrometer trigger configurations where the real app offers them. Evaluate synthetic readings, start simulated irrigation when conditions are met, close it at the correct time, and display the resulting record. |
| Sensors and water | Readings, histories, daily totals, flow, valve outcomes, and subsequent soil trends agree with the same simulated timeline. Each displayed chart window works. |
| Preferences | Language, light/dark theme, units, refresh, timezone, and module switches work. Enabling a module opens a usable simulated module. |
| History and analysis | Filter synthetic readings, compare channels, save/remove analysis views, and export files containing the displayed fictional data. |
| Journal | Create/edit/filter fictional entries and plots, attach local demo media where offered, and export the current simulated records. |
| Network and gateway | Show a fictional network/device status; settings, scans, test commands, and restart controls change simulated state and return to a usable interface. |
| Account and support | Logout/login/registration and account linking use local fictional identities and server status. Support submissions enter a local demonstration inbox and confirm local receipt. No email, support ticket, or cloud account is created. |
| Weather/advisory modules | If enabled through the normal UI, show internally consistent synthetic weather and illustrative advisory results. Preserve the app's experimental labels and label simulation outputs. |
| Demo controls | Reset, pause/resume, speed, expanded view, and Advance to next event. These make scheduled and delayed behaviour observable without waiting for real days. |

The action inventory must include every control reachable for the seeded persona, including dialogs, alternate card placements, and settings-enabled modules. Existing role restrictions remain as in the real app. A feature does not become optional because its handler is missing from the current simulator.

Farm edits survive navigation, language changes, and a simulated logout/login within the session. Reload starts a fresh session. Reset restores the exact seed, initial route, English/light preferences, clock, fake session, and valve state.

## Architecture

Keep the real React components and client contracts, including structured errors, multipart inputs and binary exports. Public mode removes the current presentation-only CSS hiding rules and account/trigger interception; presentation mode retains them. Public formatting follows the chosen display timezone while scheduling/rain boundaries follow resource/gateway timezone, as specified in the plan. Expand the in-memory simulator into focused domain modules behind the existing Axios adapter: farm/devices, irrigation plans and commands, synthetic readings, sessions, and the remaining modules. A saved action updates canonical local state; subsequent reads, labels, charts, and summaries reflect it. Generic success responses without those effects do not count as simulation.

Use a separate public entry under `demo/public/`, reusing the runtime and model. The presentation entry keeps its existing defaults and localhost restriction; the archived FAO bundle stays unchanged. A public-model mode enables the complete simulation while the presentation mode can retain its fixed historical scenario.

Limit shared React changes to small presentation options required by the demo, such as initial zone expansion, offline map data, and simulated environment labels. Keep production defaults and authorization unchanged. There is no broad policy that hides product features.

Retain transport and storage isolation before application imports. The adapter has no live fallback, and CSP forbids connections. If an inventoried feature uses fetch or another transport directly, route only its exact registered requests to in-memory handlers; never delegate to a native network implementation. Unknown operations still fail in development/tests. Normal release flows produce none of those failures.

## Simulation clock and effects

Use one monotonic simulation clock for the whole session. Manual actions, schedule delivery, trigger evaluation, sensor samples, countdowns, and recent-run timestamps all use it. Process events chronologically when a user accelerates or jumps time; a complete opening must not lose its acknowledgement merely because one tick crossed both open and close boundaries.

Advance to next event targets the earliest meaningful acknowledgement, run, daily trigger evaluation, delayed soil response, service completion, or closure within 8 days. Routine periodic sample ticks are processed en route but are not user jump targets. It uses the same event-processing path as ordinary ticks. It preserves the pause setting and leaves time paused after a jump when the user had paused it.

Weekly schedules use the valve/zone timezone and the real app's validation rules. One-time runs fire once. Disabled/deleted plans cannot fire; skipped runs stay skipped; resume does not replay past runs. Use source-pinned controller rules and explicit simulator-only exceptions in the addendum. Because the shipped code has no cross-source exclusivity arbiter, the public model gives an active/pending run ownership of its valve. Competing planned/automatic starts record a visible skipped reason; concurrent manual starts return a meaningful busy conflict. Close events precede equal-time starts, permitting adjacent windows. This is a deterministic simulation rule, not a claim about undocumented physical overlap behaviour. The public simulator preserves shipped controller rules except for explicitly documented intended-control behaviour: exposed DENDRO response mode and threshold controls receive deterministic effects even though the shipped controller ignores those fields. This correction is confined to simulation and is labelled in the controller contract addendum. VWC is not offered by the current edge trigger selector and is not invented.

Seed a deterministic 90-day record and append synthetic samples as time advances. Simulated open valves produce fictional flow-meter pulses and cumulative volume. Soil response is delayed and illustrative; a simple deterministic response is sufficient. Cancelling a pending opening prevents it from opening. Cancelling an already observed run only cancels the queued command/expectation as in the shipped product; observed flow continues until the valve self-closes or the existing Settings early-close override acknowledges. Do not pretend queue cancellation physically closes a valve. Day boundaries use the farm timezone, and every history window and daily total derives from the same ledger.

Daily rain implements the current versioned API, including timezone basis, sample counts, period boundaries, and missing-day semantics. Zero rain with samples differs from missing data. Wire the seeded LSN50 rain control to the daily/interval rain viewer in public mode; its existing generic interval chart alone does not demonstrate that API.

Calibrations and configuration changes alter the values/rules they control. Do not claim that this fictional scenario is a validated crop model or that it predicts field water savings. Display one persistent simulation label and short explanatory copy, rather than interrupting each action.

## Edits and destructive controls

Deleting a zone unassigns devices and preserves their historical measurements. An active valve continues to its normal close time unless the user closes it. Its pre-deletion run retains the original historical zone label.

A new run on an unassigned valve uses a nullable zone association and a translated Unassigned label, never a fabricated zone ID. Widen the frontend actuation type and guard context lookups without changing the backend contract.

Removing a valve closes its simulated flow, cancels pending commands and future runs for that device, and retains completed records. Reset can recover a farm after the user deletes everything. Invalid names, conflicting plans, and malformed configuration receive the same useful validation as the real UI.

## External-looking actions

Every apparent external action stays inside the simulation. Account linking changes a fictional linked/unlinked status; a gateway restart shows a local restarting/reconnecting sequence without clearing farm data; a support submission is clearly stored in the demo only. Geolocation controls return the fictional farm coordinates without requesting the visitor's location.

Maps use bundled imagery/geometry and permit the offered pan/zoom/selection actions. File downloads are generated from local state. Allow only registered simulator-owned blob downloads through the runtime's navigation guard, and set allow-downloads on every sandboxed frame in the embedding chain. Also set allow-modals on every frame in that chain so existing native window.confirm actions work. Accepting and dismissing confirmation must retain the application's normal mutation and cancellation behavior. Preserve the ban on arbitrary external navigation and live transports. Media uploads stay local and reset releases their object URLs.

A simulated logout must leave a usable local login screen with an obvious demo entry; visitors cannot become trapped outside the app. Never ask for or use actual cloud credentials to perform a simulation.

## Visitor experience

On visiting opensmartirrigation.org, show a dismissible invitation featuring an OSI OS screen. On desktop it appears inside a smartphone frame. Clicking the screen or its Try OSI OS link navigates in the same tab directly to `/simulator/`. The exit cross is a separate button: it dismisses the invitation, restores focus and scrolling, and leaves the visitor on the normal website. Escape also dismisses it. Show once per browser-tab session, remembering dismissal/navigation in sessionStorage; use an in-memory fallback if storage is unavailable. A persistent website link lets visitors reopen the simulator. This frequency is an implementation default, not an additional user requirement.

The invitation is a static preview, not an embedded live simulator. Do not load the simulator or its large assets until the visitor follows the link. Make the invitation a labelled dialog with focus containment, background inertness while open, visible close control, and reduced-motion support. The close button must never activate the preview link. On mobile, use a compact unframed OSI OS preview that fits the viewport; dismissal still returns to the normal website.

The simulator uses one mounted application across responsive layouts. Desktop presents the live OSI OS interface inside a smartphone frame, with optional guidance and simulation controls beside it. Mobile removes all decorative framing, padding and desktop instructions, and presents the real app edge-to-edge at its natural size with `100dvh` and safe-area support. Avoid nested page scrolling. Keep the native OSI OS navigation and touch behaviour. Place simulation tools in a compact accessible drawer so they do not displace normal app navigation; a small persistent simulation indicator and Reset remain available. Resize/orientation/layout changes must preserve session state, running valves, open dialogs, and clock state. Do not reload or remount the app when a breakpoint changes.

The optional `/try-osi-os/` WordPress page provides explanation and a simulator link. The popup and GitHub primary links go directly to `/simulator/`, avoiding a second launch step. The standalone simulator is the primary mobile experience; any optional WordPress embed also provides that direct link.

Suggested exploration covers a soil reading, a manual valve opening, scheduling a future run, and watching a trigger execute. Guidance is optional and remains usable after users rename/delete the starting records.

Localize host instructions/controls in all seven existing app languages and synchronize with the native selector. Keep new Luganda copy demo-only under the existing translation policy and record review status. Test light/dark themes, touch, keyboard focus, and 200% zoom.

When the app has not sent a valid ready message within 15 seconds, the host shows Retry. A failed initial app chunk is detected by this timeout; app-reported startup errors appear immediately. Retry creates a new app document and a usable seed.

## Hosting and entry points

Proposed URLs are `https://opensmartirrigation.org/try-osi-os/` for the WordPress landing page and `https://opensmartirrigation.org/simulator/` for the static simulator. Build assets for that base path. Publish only the generated artifact and keep simulator CSP scoped to its directory.

Preserve `connect-src 'none'`, blocked geolocation/real media capture, and no API proxy. Same-origin hosting uses `frame-ancestors 'self'`. A static-subdomain fallback uses `frame-ancestors 'self' https://opensmartirrigation.org`, adding only the exact staging parent on staging. The app frame and host remain same-origin with one another. Before enabling an optional cross-origin embed, test native confirmation accept and dismiss through the complete website → simulator host → app chain in Chromium and Firefox with deployment-equivalent headers. Observe an actual confirm dialog; acceptance performs its local mutation and dismissal preserves state. Test native dialogs in the Safari/iPhone and Android release checks for each supported embed configuration. If that origin chain suppresses dialogs, keep the top-level simulator/full-view link working and leave the optional interactive embed disabled until a separately reviewed public confirmation implementation passes equivalent tests. Preserve every application action and its cancellation behavior.

Add Try OSI OS near the GitHub/download links on the OSI System page and near the repository README introduction. Publish entry-point links after the simulator passes public smoke checks.

## Acceptance

- Every action in the inventory has a browser flow checking its local state changes and subsequent reads. Product functionality is not removed to pass this gate.
- A visitor can open a valve, see its state/countdown/flow, close it, and inspect the recorded result.
- Weekly/one-time plans execute under accelerated time; pause/skip/delete/resend and overlap behaviour match the documented controller semantics.
- Trigger edits affect execution; resulting irrigation and readings are visible, with no repeated opening storm.
- Device/zone configuration, catalogue additions/removals, settings-enabled modules, demo account flows, and local exports work.
- Histories, summaries, forecasts labelled as synthetic, and simulated live readings share a consistent timeline. Missing data stays missing.
- Delete-all, active device removal, logout/re-entry, reset during a run, jumps across midnight, and repeated resets remain usable.
- Normal flows have no unsupported notices, uncaught errors, failed resources, or requests to real services.
- Widths 320/360/390/430px, tablet/desktop, all seven languages, both themes, and 200% zoom remain usable.
- The website invitation opens once per tab session, its cross/Escape dismiss without navigation, and its preview/CTA opens the standalone simulator. Keyboard focus and underlying website scrolling recover correctly.
- Desktop shows a smartphone frame; mobile is edge-to-edge with native app navigation and no decorative frame, clipping, or nested page scrolling. Orientation changes preserve the simulation.
- The public hostname/base path, optional WordPress embed, app-ready timeout/retry, and direct simulator link work.
- Chromium and Firefox automation pass; Safari/iPhone and Android touch checks are recorded.
- Production defaults/bundles and the archived FAO presentation remain independent of the public simulation.

## Starting evidence

The October 10 audit rebuilt frontend source corresponding to GitHub main `ea32d23e3a66e5a8a65615547c9f90a5c5c64dcb`. The original demo build and 25 Chromium cases passed. Daily rain returned `501 unsupported`; FAO controls were hidden and the 320px app was clipped. These checks establish the baseline, not completion of the broader simulation.

WordPress admin access, static upload/header permissions, staging, and deployment credentials have not been inspected. Prepare reviewable artifacts and staging content first; publication requires the target access and a go-live instruction.
