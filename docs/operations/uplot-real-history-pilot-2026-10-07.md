# uPlot real-history pilot execution record

This records the initial pilot release. See the [coverage and recovery record](uplot-history-coverage-recovery-2026-10-07.md) for the current preview release and rollback command.

The opt-in uPlot pilot is deployed on the test server at [Real sensor history](https://server.opensmartirrigation.org/prototypes/history-zoom/#/pilot/cloud). Sign in to the test host in the same browser, then return to that URL. The three comparison routes remain available.

The pilot reads existing same-origin edge or cloud APIs. It supports zone/card selection, separate unit groups, sensor toggles, a 90-day horizon, pinch/pan, inspection, range presets and Back/Forward/Latest controls. Requests start after a 150 ms pause in viewport changes. Accepted data stays interactive during background loading; a response does not move the viewport. Missing readings, unfetched intervals and server truncation are represented separately.

Host applications, backend services, database schemas and production deployments were not changed. The edge route is implemented and tested with intercepted API responses, but no live gateway was deployed. Its bundle must be served on an edge origin, for example `/gui/prototypes/history-zoom/#/pilot/edge`.

## Authorization and review

The user selected uPlot after testing the comparison on a Pixel 8 Pro and requested the same workflow: Sol plans, the controller reviews and revises, Luna implements, and Sol reviews the work. The previous test-server deployment authorization covers this continuation.

The design, implementation plan and controller review are under `docs/superpowers/` with the `2026-10-07-uplot-real-history-pilot` prefix. Independent Sol reviews of the data foundation, chart primitives, pilot UI and browser tests all finished GREEN after corrections. The controller reproduced and verified fixes for the initial chart mount crash and route transition failure. The final source release is `71a140e0f7e8` on `plan/mobile-history-zoom-prototypes`.

## Verification

| Check | Result |
| --- | --- |
| Unit suite | 129 passed, 21 files |
| Production build | PASS |
| Focused pilot Playwright suite | 13 passed |
| Full local Playwright suite | 47 passed |
| Full deployed Playwright suite | 47 passed on the final release |
| Original comparison gesture criteria | All 27 passed locally and deployed |
| Phone visual captures | 390×844 and 448×998, no horizontal overflow or browser errors |
| Public pilot login gates | Both routes show the correct login link, no API request without a token, no chart or browser error |
| Public artifact verification | Every served asset matched its local SHA-256; no-store headers verified |
| Existing server routes | Main page, health endpoint and neighboring path retained their baseline responses |

Browser verification used installed Playwright Chromium because the in-app browser plugin could not initialize its native bridge. The pilot tests use contract fixtures for both API families; they do not prove that an authenticated live account has usable sensor history. The suite covers native pinch and pan during delayed requests, rotation, stale response rejection, token revocation, unit isolation, null versus zero, truncation, empty results and error recovery with the same request interval.

Visual review shortened the pilot header and moved the not-loaded label below the chart readout. The last change was CSS-only; the production build and phone captures were repeated, followed by the complete deployed suite. The chart starts around 645 CSS pixels down at 390×844, so a swipe brings the complete plot into view. This remains a comparison pilot, with a later product-layout pass still appropriate after live sensor testing.

These are emulated browser results. Physical Pixel 8 Pro acceptance of this real-history pilot remains pending; the user's earlier physical ranking applies to the synthetic comparison demos.

## Deployment and rollback

- Test host: the test cloud host, hostname verified before deployment.
- Original pilot release: `20261007T142257Z-71a140e0f7e8`.
- Archive SHA-256: `42fd6c38e5dc95f3cc9ddc31ab6ae3a65ea8f3f04bdda583903ba52816171785`.
- Static directory inside Caddy: `/data/prototypes/history-zoom/releases/20261007T142257Z-71a140e0f7e8`.
- Configuration backup and rollback script: `/home/rocky/caddy/deploy-staging/20261007T142257Z-71a140e0f7e8/`.
- Previous retained release: `20261007T111149Z-2a80b3b2fd35`.

Only the existing preview directory target in Caddy was changed. The candidate configuration was validated before an in-place reload; backend and database containers were not restarted. The deployment coordinator checked concurrent configuration changes and was prepared to restore the prior preview on verification failure. No rollback was needed.

To restore the previous preview:

```bash
ssh <test-host> bash /home/rocky/caddy/deploy-staging/20261007T142257Z-71a140e0f7e8/rollback.sh
```

Local evidence is under `.superpowers/sdd/2026-10-07-uplot-real-history-pilot/`. The `deployment-20261007T142257Z-71a140e0f7e8/` directory contains the asset manifest, archive, Caddy diff and validation log, baseline/public HTTP checks, deployed browser log, gesture diagnostics, auth-gate captures and fixture-backed phone captures. Detailed review reports and the root's local visual captures are in the same task directory.

## Authenticated live-data status

BLOCKED: no existing test account/session was supplied. The test server's configured bootstrap login returned 401; the controller requested an existing account/session. No account was created, database changed or authentication bypass added. No production host was accessed.

The cloud pilot is ready for a signed-in user to test, but authenticated live sensor-history acceptance is not claimed. Edge live-data acceptance also remains pending a chosen test gateway.
