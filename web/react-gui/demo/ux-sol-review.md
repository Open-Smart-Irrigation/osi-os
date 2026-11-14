# Sol review of the visitor experience

Reviewed head `1657b4383f` on 2026-11-13. Verdict: changes required. Reported
test results are useful, but the core phone interaction below fails in the
built local app. Do not call the release green until these cases pass.

## Required changes

1. The nonmodal guide obscures its target. At 390x844, after advancing to timed
   irrigation, its rectangle is x=20, y=78, width=390, height=414. It extends
   beyond the right edge. The first Open control's outer center is x=100.5,
   y=467; `document.elementFromPoint` there returns the guide's Source code
   link, not the iframe. A normal tap cannot open the valve. The screenshot
   confirms this overlap. Replace the floating overlay with a guide layout
   that reserves its own space (desktop side panel, compact phone step panel),
   keeping the current target and its action operable. Show the long intro
   before the tour and next-step links at the end, rather than repeating both
   on every step. Close or suspend the guide cleanly during app modal actions.
   Do not solve this with force clicks or hiding real app controls.
2. The contextual skip control breaks the phone header. After a one-minute
   open request at 390px, the new skip button is 72px wide and 164px tall,
   starting at y=-56.5. Its long timestamp wraps above the viewport. Move the
   contextual event action to a separate bounded row or compact panel with
   readable date/time details, and retain a usable app viewport. Keep header
   actions inside the screen in every locale. Give Home a normal touch target.
3. Event guidance becomes stale. `showNextEvent` runs after selected mutations,
   but time advancement does not publish a fresh descriptor. Reset does not
   clear `skipEvent`. Language switching does not reformat its existing text.
   Publish/update the descriptor after event processing and relevant setting
   changes, clear it during reset/startup, and update existing text when the
   locale or farm timezone changes. An acknowledgement must not remain labelled
   as the next event after it already happened.
4. Complete the promised acceptance coverage. There is no seven-language
   keyboard core-flow test; the guide spec is desktop-only and checks CSS
   visibility, which misses the observed occlusion. Add normal pointer tests
   at 390x844 and desktop for opening and completing a timed run with the guide
   enabled, inspecting its result and creating a weekly schedule. Run keyboard
   navigation in all seven locales: language switch, guide, Open dialog,
   confirmation, event advance, schedule dialog, Tab/Shift+Tab containment,
   nested delete confirmation, Escape/return focus, reset/language retention.
   Assert actionability and screen bounds, not only element existence. Use
   stable existing test IDs and localized semantic names, never force clicks.
5. Harden guide transitions. The runtime currently guesses readiness using a
   fixed 250ms timer and searches broad selectors. Rapid Next presses or a
   slower route mount can highlight the wrong screen or emit unsupported.
   Use an explicit completion/target-ready response with a finite timeout;
   disable Next only while transitioning and retain an actionable recovery.
   Clear highlighting and restore usable focus when the guide closes. Preserve
   the rule that guide navigation alone never mutates farm state.

## Small correction by Sol

The share image was empty in raw HTML and only set by JavaScript. Link-preview
crawlers commonly need the raw metadata. Sol changed the public build to emit
a stable preview asset and put its absolute production URL in the entry HTML.
The regression test reads the raw HTTP response before any page script runs.

## Verification scope

Sol inspected the desktop landing, expanded desktop, Luganda/dark guided phone
and website CTA captures. Sol reproduced items 1 and 2 with the built public
app in the shared browser and closed the tab and local server afterward. These
are concrete UI failures despite the reported 171 passing browser tests.

Re-run affected model/protocol/type/browser checks after correction, then the
integrated gates. Capture the actual guided action states at phone and desktop
sizes. No live publishing, production safety changes or unrelated redesign.

## Follow-up inspection

Luna addressed the five items in `a95db5199a`. Sol's image inspection then
found that the more-specific desktop guide grid rule left only 250px for the
app at a 390px viewport. Sol added the matching mobile rule and a full-width
iframe assertion. Sol also made opening Guide leave expanded mode, where its
panel was otherwise hidden, and gave Home a 44px minimum touch target.
Demo typecheck and all 12 guide tests across the three browser projects passed.
Sol inspected the refreshed phone capture: the app occupies the full 390px and
the highlighted Open and Schedule controls remain unobstructed.

Final independent code review and the integrated gate remain pending; this
follow-up closes the reproduced layout findings rather than approving the
whole source import.
