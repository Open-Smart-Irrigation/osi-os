# uPlot real-history pilot design

Date: 2026-10-07\
Status: ready for adversarial review\
Scope owner: standalone `web/history-zoom-prototypes` package

## Goal

Add an opt-in mobile pilot that renders authenticated history from an OSI edge or OSI Server with the uPlot and D3 interaction stack selected on a real Pixel 8 Pro. The pilot must answer whether that interaction remains useful with actual sensor selection, null gaps, long histories, delayed requests, truncation, and real units.

This is a static test-server pilot. It does not replace an existing history route, alter an API, change a database, or deploy to production. Existing desktop history, existing mobile history, and the three synthetic comparison routes stay usable.

## Evidence behind the design

The standalone package already has a shared viewport store, a D3 touch controller, a renderer adapter boundary, frame coalescing, inspection, explicit null handling, and verified uPlot rendering. Its current public routes are `#/uplot`, `#/echarts`, and `#/chartjs`. The baseline at commit `4482f0f36` passes 78 unit tests, 34 Playwright tests, and the production build.

Both host applications keep the bearer token in same-origin `localStorage` under `auth_token`. Their authenticated history response shapes match closely enough for one normalizer. The path prefixes differ:

| Contract | Edge | Cloud |
|---|---|---|
| Zone list | `/api/irrigation-zones` | `/api/v1/irrigation-zones` |
| Cards | `/api/history/zones/{id}/cards` | `/api/v1/history/zones/{id}/cards` |
| Card data | `/api/history/zones/{id}/cards/{cardId}/data` | `/api/v1/history/zones/{id}/cards/{cardId}/data` |
| Login | `/gui/#/login` | `/login` |
| Point limit | 2,000 per series | 2,000 per series |

The endpoints accept explicit `from` and `to` instants. Edge accepts a `custom` range label, while the cloud validates the label against each card's advertised range. The pilot therefore sends a server-supported label (`24h`, `7d`, or `30d`) with every explicit interval and treats the explicit bounds as authoritative. It never sends `season`, because both implementations give that label configured season semantics.

## Chosen architecture

Extend `web/history-zoom-prototypes` with `#/pilot/edge` and `#/pilot/cloud`. The platform segment fixes API prefixes and the login target for the lifetime of the page. A small API module reads the existing token immediately before each request, sends only same-origin requests, and checks that same token again before accepting a response.

The pilot reuses `ChartHost`, `mountUplot`, the viewport store, D3 gestures, inspection, and the uPlot data join. It adds a production response normalizer and a pilot shell. `ChartHost` gains optional data extent and automatic value-range inputs; its mount effect includes the viewport-store identity. The D3 controller accepts an optional extent instead of always using `FIXTURE_EXTENT`, and uPlot can derive a padded finite y range for a single unit group. Defaults retain the fixture extent and 0–100 value range, so the three comparison routes keep their current synthetic data, controls, lazy renderer loading, and URLs.

An integrated route in each production GUI was rejected for this pilot. It would duplicate the selected chart stack across two applications, require two host release cycles, and put experimental loading behavior beside current history behavior. A separate cross-origin data service was also rejected because it would need a new auth and CORS contract.

## Routes and reachability

The hash parser returns one of these values:

```ts
type AppRoute =
  | { kind: 'candidate'; candidate: 'echarts' | 'uplot' | 'chartjs' }
  | { kind: 'pilot'; platform: 'edge' | 'cloud' };
```

Unknown hashes still replace themselves with `#/uplot`. The pilot routes are reachable only by their URLs; no production navigation or feature flag points to them. The comparison header may link to the two pilot routes, but it must label them as authenticated real-data pilots.

The static bundle must be served from the same origin as the API whose route is open. `#/pilot/cloud` is useful when the bundle is under the cloud host. `#/pilot/edge` is useful when the same build is copied below an edge host's static path. A route never lets the user enter another origin or API base URL.

## Authentication and request safety

The pilot borrows the host application's current session. It does not create, refresh, copy, log, decode, or remove a token. `auth_token` is read from `window.localStorage` at request start and kept only in the request closure.

Every request uses:

```ts
fetch(relativePath, {
  method: 'GET',
  headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
  credentials: 'same-origin',
  cache: 'no-store',
  redirect: 'error',
  signal,
});
```

Before dispatch, the client resolves the relative path against `window.location.origin` and refuses it unless the resulting origin is identical and the pathname starts with the fixed platform API prefix. Before applying the response, it reads `auth_token` again and requires exact equality with the captured token. A request generation check and an `AbortController` provide a second stale-response fence.

The page listens for the `storage` event and rechecks the token on `visibilitychange`. A token change aborts work and clears zones, cards, accepted chart data, inspection, and errors before any new request starts. A `401` or `403` produces a login-required state and clears data. The button links to the fixed same-origin login path. No automatic redirect occurs, so a login response cannot strand the user in a loop or put the pilot hash in a query parameter.

## Supported data

The pilot lists all readable zones, then the zone cards returned by the existing endpoint. It enables only numeric time-series cards whose advertised views contain `line-chart`:

- soil uses `view=line-chart`;
- dendrometer uses `view=line-chart`;
- environment uses `view=line-chart`.

Irrigation and gateway cards remain visible in the selector with an “No numeric line series in this pilot” label and cannot start a data request. The pilot does not invent an event renderer.

The pilot does not send `sourceKey`. The cloud controller has no such request parameter, and the shared public contract does not guarantee server-side source filtering on both platforms. Display-safe source labels may appear as metadata, while the returned series checkboxes provide sensor selection. Per-device card ids retain their existing backend meaning. A device name never becomes a client-generated query key.

The response series become this renderer type:

```ts
interface SensorSeries {
  id: string;
  label: string;
  unit: string;
  points: readonly { t: number; value: number | null }[];
}
```

For each point, a present `value` field is authoritative: finite numbers, including zero, remain numbers; `value: null` remains null; and a non-finite value becomes null. Only a response that omits `value` may fall back to the first finite field among `latest`, `mean`, and `median`. Invalid timestamps are dropped; duplicate timestamps keep the last response value, as the proven uPlot alignment code already does.

Series are grouped by the exact trimmed unit. Missing units use an internal empty-string group and the visible label “Unit not reported”; the client does not infer a unit from a series id. Only one unit group is plotted because the selected uPlot adapter has one value scale. Within that group, checked series are plotted and unchecked series stay available in the sensor control. The default selects the first non-empty group and all of its series.

No-data has three distinct forms:

- no series in the accepted response: an empty-history panel;
- a series with null samples: a visible gap in the line and “Unavailable at this sample” in inspection;
- a viewport outside the accepted response extent while another interval loads: a hatched “Not loaded” overlay, never an empty-history claim.

## Time windows and aggregation

The pilot horizon is the 90 days ending at the most recent `Latest` action. The initial request is the latest 24 hours. Controls offer 24 h, 7 d, 30 d, and 90 d windows, plus Back, Forward, and Latest. Back and Forward move by 80% of the selected span, clamp to the 90-day horizon, and start a new request. Latest resets the horizon end to the current clock and selects the interval ending there.

The request policy is explicit:

| Requested span | `range` label | `aggregation` |
|---|---|---|
| up to 24 h | `24h` | `raw` |
| over 24 h through 7 d | `7d` | `15m` |
| over 7 d through 30 d | `30d` | `hourly` |
| over 30 d through 90 d | `30d` with explicit bounds | `daily` |

This avoids cloud `auto` behavior varying with the nominal label and avoids illegal long-range `raw` or `15m` cloud requests. The response's actual `aggregation.level`, `pointCount`, and accepted `range.from/to` are shown above the chart. A daily response says “Daily”; it is not presented as raw sensor detail.

The 2,000-point server limit remains authoritative. When `limits.truncated` is true, the pilot shows “The server limited this result; the chart may be incomplete” beside a “Show 24 h” action centered on the current interval end. It never describes a truncated response as complete.

## Loading and race semantics

The loading identity is:

```ts
interface PilotRequestKey {
  platform: 'edge' | 'cloud';
  sessionEpoch: number;
  zoneId: number;
  cardId: string;
  from: string;
  to: string;
  aggregation: 'raw' | '15m' | 'hourly' | 'daily';
}
```

The token stays in the request owner's closure. `sessionEpoch` advances when the observed token changes and is safe to use in request keys and diagnostics. Raw tokens must never enter a serialized key, React state, DOM attribute, screenshot, probe, console message, or error.

Changing platform, session epoch, zone, card, or unit clears the chart immediately. Those values can change what the lines mean. Changing only the time window within the same platform/session/zone/card/unit identity keeps the last accepted chart mounted and interactive while the next interval loads.

The viewport store drives background history loading without putting React in the gesture frame loop. A store subscription waits until the viewport has been settled for 150 ms, then floors both endpoints to whole minutes; flooring both preserves the span and avoids turning an exact 24 h viewport into 24 h plus one minute. The client first compares that visible interval and its desired aggregation against accepted coverage and the aggregation requested for the accepted response. If both fit, it does nothing. Otherwise it builds one request with up to 25% padding on each side, capped so the request stays inside the desired aggregation tier: 24 h for raw, 7 d for 15-minute, 30 d for hourly, or 90 d for daily. A viewport already at a tier boundary receives no padding. A successful request becomes the new accepted coverage. Identity changes, unmount, and a newer settled viewport cancel the pending timer and abort its request. The response's actual aggregation remains visible metadata; cache decisions use the requested aggregation so a backend-selected coarser level cannot cause a refetch loop.

The accepted extent is shaded normally. Any requested area outside it receives the “Not loaded” treatment until the matching response arrives. The loading status names the requested interval. If that request fails, the accepted chart remains usable, an inline error names the failed interval, and Retry starts the same key again. The error does not replace accepted data.

Only the latest request generation may apply. Starting a new request aborts the prior request. The acceptance check requires: the component is mounted, the generation is current, the token still matches, and the current selection still matches platform/zone/card. Unit selection is local but is checked before exposing a derived series set.

On successful acceptance, coverage comes from the validated response `range.from/to`, clipped to the requested interval; if the response omits valid bounds, coverage is the requested interval. Sample minimum and maximum timestamps never define coverage because sparse sampling is different from unfetched time. Network acceptance updates data and coverage only. It never changes the chart viewport, including for empty responses or a response that no longer overlaps after the user pans. Gestures and explicit controls are the only viewport writers.

## Mobile interface

The page remains English because it is a standalone test instrument, not a host GUI surface. It uses the existing package colors and typography. Native labelled selects choose zone, card, and unit. Checkbox controls select series. Every interactive target has a minimum 44 px height, a visible focus indicator, and an accessible name.

The chart header always shows platform, card, selected unit, requested interval, actual aggregation, accepted point count, and truncation status. The legend uses series labels and units from the normalized response. The pinned inspector reports the requested timestamp, each enabled series value, each sample timestamp, and missing values without substituting zero.

The D3 surface retains the accepted touch behavior: one-finger horizontal pan, anchored two-finger pinch, vertical page scroll outside the chart, tap inspection, resize refresh, and requestAnimationFrame coalescing. Network completion must not remount the adapter when only its data changes.

## Error and empty states

| Condition | Required behavior |
|---|---|
| No token | Login-required panel; no API request |
| 401 or 403 | Clear all account data; login-required panel |
| Zone list empty | “No zones are available for this account” |
| Cards empty | “No history cards are available for this zone” |
| Unsupported card | Keep selector usable; explain numeric pilot coverage |
| Accepted response empty | Keep controls; show empty-history panel |
| Same-identity refresh fails | Keep accepted chart; inline Retry |
| Selection request fails before acceptance | Clear chart; full error panel with Retry |
| Malformed response | Treat as request failure; never partially render it |
| Truncated response | Keep chart; show incomplete-result banner and 24 h action |

Error text may include HTTP status and a bounded server message. It must not include an authorization header, token, raw response body, or device EUI hidden by the card API.

## Tests and acceptance

Unit tests cover route preservation, API prefixes, login targets, same-origin enforcement, token fences, abort/generation races, the explicit aggregation table, response normalization, zero/null behavior, unit grouping, duplicate timestamps, empty data, and truncation.

Component tests cover the login state, selectors, disabled cards, clearing on semantic selection changes, same-identity background loading, accepted-data error retention, sensor selection, unit isolation, extent labels, and the truncated action.

Playwright intercepts API calls with response shapes copied from the existing edge/cloud contracts. It runs at 390 × 844 and proves:

1. `#/pilot/edge` and `#/pilot/cloud` use their own prefixes and login links.
2. A slow interval request leaves the accepted chart pinchable and inspectable.
3. A later request wins when an older response resolves last.
4. A token change while a response is in flight prevents acceptance and clears the chart.
5. Null outages remain blank, measured zero renders, unit changes never mix scales, and sensors can be hidden and restored.
6. Empty, malformed, rejected, and truncated responses show the required states.
7. The existing `#/uplot`, `#/echarts`, and `#/chartjs` browser checks still pass.

Live test-server acceptance needs an existing test account/session supplied through the host login. The executor may deploy and verify the unauthenticated gate without credentials. Real-data acceptance is reported as blocked if no authorized session is available; credentials and tokens never enter test files, screenshots, console output, or documentation.

## Deployment

Build with `npm ci && npm run build` inside `web/history-zoom-prototypes`. Deploy only `dist/` to the existing test-server `/prototypes/history-zoom/` static location, using the same test-server procedure recorded in `docs/operations/mobile-history-zoom-prototypes-2026-10-07.md`. The build uses relative assets and requires no proxy change when it shares the host origin.

Before replacing the test-server directory, preserve the current bundle using the recorded rollback procedure. Verify all five hash routes after deployment. Do not connect to a production cloud host, change a production Caddy configuration, deploy either production GUI, or modify backend state as part of this work.

## Out of scope

- production rollout or a production feature flag;
- backend, schema, sync, or auth changes;
- event, calendar, irrigation, gateway, export, or workspace UI;
- multi-axis charts, computed units, downsampling in the browser, or infinite pan;
- storing pilot preferences;
- cross-origin API access;
- copying pilot code into `web/react-gui` or `osi-server/frontend`.
