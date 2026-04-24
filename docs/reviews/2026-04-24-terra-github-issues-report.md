# Terra GitHub Issues Report

Date: 2026-04-24

Scope:
- active Terra issues now tracked in `Open-Smart-Irrigation/osi-server`
- closed moved duplicates in `Open-Smart-Irrigation/osi-os`
- Terra-adjacent mobile wrapper issues that explicitly include Terra in scope
- follow-up review findings from split Terra history review passes

Primary issue set:
- `osi-server#8` Terra live view: multiple rendering breaks
- `osi-server#9` Terra: saved zone not loaded on startup
- `osi-server#10` Terra: save-to-zone does not reliably overwrite field geometry
- `osi-server#11` Terra draw field: cannot close polygon by clicking first point
- `osi-server#12` Terra: draw field control and sensor anchors panel overlap
- `osi-server#13` Terra: sensor anchor box cannot be closed when no sensors are installed
- `osi-server#14` Add back-to-dashboard navigation button in Terra and standalone views
- `osi-server#15` Terra: add responsive mobile layout

Terra-adjacent mobile scope:
- `osi-server#16` Android app: wrap OSI OS dashboard and Terra in a native Android app
- `osi-server#17` iPhone app: wrap OSI OS dashboard and Terra in a native iOS app

Moved duplicates:
- `osi-os#35` through `osi-os#40`, `osi-os#43`, `osi-os#44`
- `osi-os#45` and `osi-os#46` for the mobile wrapper follow-up

## Executive Summary

The current Terra issue set is not a collection of unrelated bugs. After the additional slice-by-slice review work, it now collapses into six main bundles:

1. Launch and session-state contract is incomplete.
2. Field geometry editing is implicit and fragile.
3. Overlay layout is built from independent absolute-positioned panels with no shared layout model.
4. Terra has backend service tests, but essentially no frontend interaction coverage, so regressions cluster in the React and CSS layer.
5. Live data orchestration, partial-failure handling, and auth flow behavior are brittle in the standalone frontend.
6. The prediction field-state and recompute backend paths have stale-artifact and concurrency correctness risks that can break Terra live mode without any obvious UI change.

Geometry and sensor-anchor persistence are still broadly stronger than the frontend shell, but the earlier "backend is structurally sound" conclusion was too optimistic for `PredictionFieldStateService` and `PredictionRunService`. The highest-risk defects now span both the standalone Terra frontend under `osi-server/prediction_animation_v2` and the live field-state/recompute backend paths in `osi-server/backend`.

## Issue Inventory And Cause Analysis

### Bundle A: Launch, startup state, and navigation contract

Issues:
- `osi-server#9`
- `osi-server#14`
- contributes to `osi-server#15`
- blocks clean execution of `osi-server#16` and `osi-server#17`

Root cause:
- Terra has a partial live-bootstrap design, but the persistence path is unfinished.
- Live entry mode is decided only from the current URL `zoneId` query parameter.
- A stored live config helper exists, but it is never written anywhere.
- Terra launch links only pass `?zoneId=<id>` and do not pass any return target.
- The standalone app itself contains no dashboard navigation.

Evidence:
- `readEntryMode()` returns `live` only when the current URL contains `zoneId`; otherwise Terra becomes demo mode immediately.
- `readLiveConfig()` can read `terra-live-config` from local storage, but `writeLiveConfig()` has no callers.
- Prediction cards open Terra in a new tab with `/terra-intelligence?zoneId=<id>` and no source-route context.
- The Terra app header exposes refresh only; there is no "back" affordance to dashboard-level routes.

Likely issue mapping:
- `#9`: high-confidence cause. The "saved zone" restoration path is incomplete because persisted live config is dead code and mode detection ignores stored config.
- `#14`: high-confidence cause. Navigation was never modeled in the standalone entry contract.
- `#15`: medium-confidence secondary cause. Mobile navigation feels worse because the app assumes the browser tab itself is the container.
- `#16` and `#17`: these are not native-only tasks yet. They are downstream of the missing mobile and navigation contract in the web app.

Important product note:
- Current repo guidance says direct `/terra-intelligence` should open demo mode and OSI Cloud should open live mode with `?zoneId=<id>`. That means `#9` partially conflicts with the currently documented launch contract. This issue needs a product decision: keep demo-first direct access, or support last-live-zone restoration.

### Bundle B: Field geometry editing and persistence UX

Issues:
- `osi-server#10`
- `osi-server#11`
- contributes to `osi-server#8`

Root cause:
- Geometry editing is tied to a single closure flow inside the map interaction layer.
- Saving is implicit: successful polygon finalization immediately writes to the backend.
- There is no separate dirty state, explicit "Save to zone" action, or success state for geometry edits.
- A geometry save is immediately followed by a full live refresh, so unrelated field-state errors can appear right after a successful save and make the save feel unreliable.

Evidence:
- `finalizePolygon()` is the only live geometry save path. It calls `saveFieldGeometry()` directly, then immediately calls `refreshLiveData()`.
- If refresh finds geometry but not a ready field-state artifact, Terra surfaces a live error even though geometry may already have been saved.
- The draw tool closes by either clicking near the first point, double-clicking, or pressing the draw button. There is no dedicated persist button for geometry.

Likely issue mapping:
- `#10`: high-confidence cause is UX coupling, not backend persistence. The save is implicit, success is not clearly acknowledged, and post-save refresh can show confusing errors.
- `#11`: medium-confidence cause is the fragile close gesture implementation. The close action relies on a hard-coded proximity check against the first point rather than a feature-targeted interaction or explicit completion control. This is easy to regress and hard to validate without UI tests.
- `#8`: the umbrella rendering-break issue includes this class of map interaction regressions.

### Bundle C: Overlay and panel layout architecture

Issues:
- `osi-server#8`
- `osi-server#12`
- `osi-server#13`
- `osi-server#15`

Root cause:
- Terra is composed from many absolute-positioned overlay islands layered over the map:
  - brand HUD
  - selector panel
  - tool stack
  - live status bar
  - field intelligence panel
  - field hints and draw hints
  - forecast rail
- These elements do not participate in a shared responsive layout system.
- Several semantically different surfaces reuse the same `field-hint` overlay style, including the live depth and sensor-anchor editor.
- The sensor-anchor panel is always shown in live mode when the launch config exists; it is not a dismissible panel with open/closed state.

Evidence:
- `App.tsx` renders the live depth and sensor-anchor editor inside a centered `field-hint` block.
- `styles.css` positions the major UI surfaces independently with absolute coordinates and breakpoint-specific overrides.
- On small screens the UI is rearranged, but it is still many competing overlays rather than one mobile-first flow.

Likely issue mapping:
- `#12`: high-confidence cause. The toolbar and sensor-anchor UI are placed independently and do not reserve space for each other.
- `#13`: high-confidence cause. The sensor-anchor box has no collapse state at all; "Cancel placement" only clears the selected probe, not the panel itself.
- `#15`: high-confidence cause. This is broader than "missing media queries"; the root problem is desktop-first overlay architecture.
- `#8`: the generic rendering-break ticket is mostly the umbrella for this whole bundle.

### Bundle D: Delivery and regression-prevention gap

Issues:
- contributes to all of `osi-server#8` through `osi-server#15`

Root cause:
- Terra frontend behavior is concentrated in a very large single component and a very large stylesheet.
- Backend service behavior has direct unit coverage.
- Comparable frontend interaction coverage is effectively absent.

Evidence:
- `prediction_animation_v2/src/App.tsx` is 2259 lines.
- `prediction_animation_v2/src/styles.css` is 1968 lines.
- Backend tests exist for `ZoneFieldGeometryService`, `ZoneSensorAnchorService`, and `PredictionFieldStateService`.
- I did not find Terra frontend interaction tests covering startup mode, draw-close behavior, save flow, overlay layout, or mobile states.

Likely issue mapping:
- This is why regressions show up as clusters in GitHub rather than isolated one-offs. The service layer is tested; the frontend interaction layer is not.

### Bundle E: Live data orchestration, partial-failure handling, and auth drift

Issues:
- contributes to `osi-server#8`
- contributes to `osi-server#9`
- contributes to `osi-server#10`
- likely warrants additional Terra stabilization issues if `#8` should remain UI-only

Root cause:
- `refreshLiveData()` has no request cancellation or sequencing, so older responses can overwrite newer live state after save/apply/manual refresh actions.
- Terra stores bootstrap failures in a single mutable `liveError`, and later successful requests can clear earlier partial-failure signals.
- Terra bypasses the main frontend API/auth-expiry handling and uses raw `fetch` requests plus direct `localStorage` token reads.

Evidence:
- Save/apply/manual refresh flows all call the same async refresh path without request versioning or abort logic.
- A catalog failure sets `liveError`, but a successful field-state response clears it in the same refresh cycle.
- `terraLive.ts` uses raw `fetch`, while the main frontend `api.ts` handles `401` responses by clearing auth state and notifying `AuthContext`.

Likely issue mapping:
- `#8`: high-confidence cause for "live view is broken in inconsistent ways" behavior.
- `#9`: medium-confidence secondary cause because launch/bootstrap confusion is worsened by partial-failure masking.
- `#10`: medium-confidence secondary cause because post-save refresh races can make saved state appear unreliable.
- likely new issue candidates:
  - Terra refresh race can overwrite newer live state
  - Terra hides partial live bootstrap failures
  - Terra live mode does not follow the app-wide auth-expired flow

### Bundle F: Prediction backend fallback and concurrency correctness

Issues:
- contributes to `osi-server#8`
- likely warrants additional backend Terra issues

Root cause:
- `prediction-field-state` fetches the prediction catalog before checking whether a stored Track A artifact can be reused.
- `PredictionFieldStateService` swallows recompute and diagnostic fallback exceptions instead of logging them.
- `PredictionRunService` can mark a long-running run stale, start a replacement, and then still let the original thread complete and mark the old run successful.

Evidence:
- `fetchCatalog()` happens before the stored-artifact reuse check.
- `catch (Exception ignored)` exists in the live Track A path and the diagnostic fallback path.
- `startRun()` fails stale `RUNNING` rows after 15 minutes, but `completeRun()` does not verify that the run is still the active run before marking it `SUCCEEDED`.

Likely issue mapping:
- `#8`: medium-confidence cause when live field state becomes unavailable or flips between modes for backend reasons rather than frontend rendering reasons.
- likely new issue candidates:
  - prediction-field-state cannot serve stale artifacts when catalog lookup fails
  - prediction-field-state suppresses root-cause logs on live fallback failures
  - prediction recompute can duplicate and resurrect stale runs

## Additional Review Findings

### Current-Head Findings

These were found during the split Terra review passes and still appear to apply on current `osi-server` `main`.

- Major: `PredictionFieldStateService` hard-depends on the prediction catalog before it attempts stale stored-artifact reuse. Terra live mode can fail closed during catalog outages even when a renderable Track A artifact already exists.
- Major: `PredictionFieldStateService` suppresses exceptions in both the live Track A and diagnostic fallback paths, which removes the main server-side trail needed to explain Terra live-state failures.
- Major: `PredictionRunService` stale-run takeover can start a replacement run while still allowing the original long-running thread to complete and mark the stale run successful later.
- Major: `refreshLiveData()` has no cancellation or response-ordering guard, so overlapping refreshes can let an older response overwrite newer geometry, field-state, or anchor state after a successful user action.
- Medium: Terra clears `liveError` after a later successful subrequest, which hides partial bootstrap failures such as catalog load failures.
- Medium: Terra live mode bypasses the main app's `401` handling and logout flow by using raw `fetch` in `terraLive.ts` instead of the shared API client.
- Minor: the forecast rail still uses `onWheel` plus `preventDefault()`, which can be passive/ignored in some browsers and may let page scroll compete with Terra's hour scrubber.
- Minor: `.gitignore` still references `prediction_animation/` instead of `prediction_animation_v2/`.

### Historical Slice Findings

These came from the split review process but do not appear to be current production defects on `main`.

- CodeRabbit flagged an overly broad class-level deprecation on `CommandService` during the early Terra slice review. That no longer applies on current `main`; the class is no longer marked `@Deprecated`.
- CodeRabbit also flagged ambiguity in `prediction_animation_v2/implementation_creative_dark.md` around exact click-target semantics and the return path from the soil profile back to the top-down field view. This is still useful design hygiene, but it is not a direct runtime defect.

## Suggested Bundling For Triage

### Bundle 1: Terra shell and launch contract

Include:
- `osi-server#9`
- `osi-server#14`
- `osi-server#15`
- note dependencies for `osi-server#16` and `osi-server#17`

Reason:
- one decision about entry mode, persisted live context, return navigation, and mobile shell behavior should drive all of these together

### Bundle 2: Geometry editing workflow

Include:
- `osi-server#10`
- `osi-server#11`

Reason:
- these are two symptoms of the same map-drawing completion and save UX

### Bundle 3: Live overlay panel cleanup

Include:
- `osi-server#12`
- `osi-server#13`
- optionally fold into `osi-server#8`

Reason:
- both come from the current overlay/panel architecture rather than backend data correctness

### Bundle 4: Umbrella / meta issue

Use:
- `osi-server#8`

Reason:
- keep it as the parent Terra stabilization ticket, but avoid treating it as an extra independent defect on top of the child issues

### Bundle 5: Live refresh and auth behavior

Include:
- current `#8` umbrella, or open focused child issues if you want sharper ownership

Reason:
- these are not just UI polish defects; they are state-management and recovery-path bugs in the standalone Terra live shell

Suggested issue candidates:
- Terra refresh race can overwrite newer live state
- Terra hides partial live bootstrap failures
- Terra live mode bypasses shared auth-expiry handling

### Bundle 6: Backend live-state correctness

Include:
- current `#8` umbrella, or separate backend issues if you want them tracked outside the UI bucket

Reason:
- these are service-layer defects in field-state fallback and recompute coordination rather than frontend rendering problems

Suggested issue candidates:
- prediction-field-state cannot serve stale Track A artifact when catalog lookup fails
- prediction-field-state suppresses root-cause logs on live fallback failure
- prediction recompute can duplicate and resurrect stale runs

### Bundle 7: Low-priority hygiene

Include:
- separate maintenance tickets only if desired

Reason:
- these came up in review but are lower priority than the runtime Terra defects

Suggested issue candidates:
- forecast rail wheel handler should use a non-passive listener
- `.gitignore` should ignore `prediction_animation_v2/`

## Recommended Fix Order

1. Decide the launch contract first:
   - demo-only direct access vs last-live-zone restoration
   - whether Terra should always know a return route
2. Fix live refresh/auth/error-handling behavior next:
   - request sequencing or aborts for live refresh
   - persistent partial-failure reporting
   - shared auth-expiry handling for Terra
3. Fix geometry editing next:
   - explicit save semantics
   - robust polygon close behavior
4. Fix backend live-state correctness:
   - artifact reuse without catalog hard-failure
   - logging for fallback failures
   - stale-run completion safety
5. Refactor live overlay layout:
   - make sensor anchors a true panel with open/closed state
   - stop using free-floating absolute overlays for every control group
6. Only then start `#16` and `#17`:
   - wrapping the current web UX in native shells before steps 1-5 will mostly repackage the same problems

## Verification Performed

- GitHub issue lookup via `gh` against `Open-Smart-Irrigation/osi-server` and `Open-Smart-Irrigation/osi-os`
- confirmed the active Terra tracker is on `osi-server`; `osi-os` tickets are closed moved duplicates
- built `osi-server/prediction_animation_v2` successfully on 2026-04-24
- ran backend tests successfully on 2026-04-24:
  - `org.osi.server.zone.ZoneFieldGeometryServiceTest`
  - `org.osi.server.zone.ZoneSensorAnchorServiceTest`
  - `org.osi.server.prediction.PredictionFieldStateServiceTest`
- split Terra history into smaller review ranges
- CodeRabbit review completed for the early mockup slice and raised:
  - `.gitignore` mismatch for `prediction_animation_v2/`
  - forecast rail wheel handler concern
  - one historical `CommandService` deprecation finding that no longer applies on current `main`
  - one design-doc clarity finding in `implementation_creative_dark.md`
- CodeRabbit review of the next slice was blocked by org rate limiting, so the remaining Terra slices were reviewed manually

Limitations:
- this report is based on issue metadata, code inspection, build/test verification, and architecture review
- I did not run an interactive browser session, so the frontend interaction findings above should be read as high-confidence code-based analysis rather than pixel-level reproduced recordings
- CodeRabbit did not complete all planned Terra slices due rate limiting, so only the first slice findings are tool-generated; the later findings are from manual review
