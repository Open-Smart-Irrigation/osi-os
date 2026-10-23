# uPlot loading optimization execution record

This records the loading optimization release. See the [coverage and recovery record](uplot-history-coverage-recovery-2026-10-07.md) for the subsequent fix, current preview release, and rollback command.

The mobile history pilot now reuses recent whole responses, shares matching in-flight requests, and loads one neighboring interval in the background. It keeps accepted data visible during loading and reserves space for the quiet update message, so the chart does not move beneath a finger.

This changes the standalone pilot's shared edge/cloud client. It does not change server queries or deploy to a live gateway. The updated static bundle is deployed and verified on the test server.

## Loading policy

The cache holds at most eight responses and 20,000 normalized samples. Historical responses expire after five minutes; a response requested within one minute of the horizon end expires after 15 seconds. Latest and Retry bypass cached data but join an eligible request already running. Responses remain whole: samples and aggregation buckets are never merged across responses.

The loader allows one foreground request and one prefetch. A newer visible demand can promote or retain useful work instead of aborting it near completion. The hook invalidates obsolete display consumers on each gesture update, observes session changes before cache access and response acceptance, and cancels speculative work while hidden. Foreground completion never moves the viewport.

Small movements accumulate toward the five-percent threshold for directional prefetch, with a 500 ms start cooldown. Settled foreground loading retains its 150 ms debounce. After acceptance, a 500 ms idle timer can request one neighboring window; prefetch completion does not create another request.

## Controlled loading measurements

The controller used native Playwright touch with contract fixtures and a controlled 600 ms response delay. The baseline probe ran against the previous deployed bundle; the new probe ran against the locally built release. These measurements describe client policy, not authenticated backend latency or physical Pixel 8 Pro performance.

| Scenario | Previous client | Updated client |
| --- | --- | --- |
| Latest refresh | Two identical physical requests; first aborted | One physical request for two clicks while pending |
| Warm Back then Forward | Returning to a prior interval fetched it again | Zero additional physical requests |
| Continuous swipe | First request started 115 ms after release | Neighbor request started 206 ms after touch start, 1,731 ms before release |
| Three successive pans in the probe sequence | Two requests aborted near completion | No requests aborted |
| Cold settled interval, response release after finger lift | 719 ms | 718 ms |

A repeat against the deployed bundle confirmed zero warm-navigation requests, one request for duplicate Latest clicks, and a neighbor request 207 ms after touch start (1,730 ms before release). The rapid-pan sequence again had no aborted requests. Deployed captures at both phone sizes also passed geometry and overflow checks.

The final row matters: this change reduces repeated work and warms nearby intervals, but it does not shorten the server round trip for an uncached interval. In the new cold-pan probe, the ready-state poll completed 731 ms after release; that is separate from response-release timing. Background prefetch can increase total request count, so total traffic reduction is not claimed.

Phone captures at 390×844 and 448×998 showed no horizontal overflow or browser errors. The chart's bounding box was identical before and during refresh at both sizes. The controller inspected the captures after the automated geometry checks.

## Review and verification

The user retained the Sol plan, controller review, Luna implementation, and independent Sol review workflow. Reviews of the loader/range policy, hook, scheduler tests, quiet UI, and browser fixtures finished GREEN after corrections. The controller identified and corrected false-positive request-count tests and a paused-clock race before release.

- Unit suite: 180 passed across 23 files.
- Production build: passed.
- Directional native-touch regression: three consecutive passes after clock control was moved before navigation.
- Full local mobile suite: 54 passed, including all 27 original gesture criteria.
- Full deployed mobile suite: 54 passed, including all 27 original gesture criteria.
- Public edge/cloud auth gates and served-asset SHA-256 checks: passed.
- Main page, health endpoint, and neighboring route baseline checks: passed.

The source plan and controller review are under `docs/superpowers/plans/2026-10-07-uplot-loading-optimization*`. Local review reports, probe observations, screenshots, and run logs are under `.superpowers/sdd/2026-10-07-uplot-loading-optimization/`. The baseline observations remain under the sibling `2026-10-07-uplot-loading-analysis/` directory.

## Deployment

The existing static preview on the test cloud host is at [Real sensor history](https://server.opensmartirrigation.org/prototypes/history-zoom/#/pilot/cloud).

- Source commit: `2535d4a0b983`.
- Release: `20261007T160311Z-2535d4a0b983`.
- Archive SHA-256: `5097d8ae57e56fe7124c16a048bd7efe11aa2fb86906a1cc547fa3cc74b1918d`.
- Static directory inside Caddy: `/data/prototypes/history-zoom/releases/20261007T160311Z-2535d4a0b983`.
- Caddy backup and rollback script: `/home/rocky/caddy/deploy-staging/20261007T160311Z-2535d4a0b983/`.
- Previous retained release: `20261007T142257Z-71a140e0f7e8`.

To restore the previous preview:

```bash
ssh <test-host> bash /home/rocky/caddy/deploy-staging/20261007T160311Z-2535d4a0b983/rollback.sh
```

The deployment changes only the preview directory target in Caddy. The coordinator validates the candidate configuration, checks for concurrent changes, compares served assets with local SHA-256 hashes, and verifies the main page, health endpoint and neighboring route against their baselines. Backend and database containers were not restarted. No rollback was needed. The deployment evidence is in `deployment-20261007T160311Z-2535d4a0b983/` under the local task directory.

Authenticated cloud backend timing remains unverified because no working test account/session was supplied. The API browser tests use intercepted contract fixtures for both edge and cloud. No production host was accessed, and no live edge gateway was deployed.
