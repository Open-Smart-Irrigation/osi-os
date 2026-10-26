# uPlot history coverage and empty-interval recovery

The field report exposed two frontend defects: the pilot restricted navigation to the latest 90 days, and an empty response removed the chart that handled touch gestures. The correction separates the navigation extent from the maximum visible span and preserves the interactive chart through empty results.

## Observed data coverage

Read-only checks on 7 October 2026 found different history on the field gateway and the test cloud. The cloud observations refer to `server.opensmartirrigation.org`; no production cloud access was used.

| Source | Observation |
| --- | --- |
| Field gateway `device_data` | 83,279 records at the observation time, from 11 April to 7 October; 37,135 were older than 90 days. This includes valve records. |
| Field gateway Kiwi devices | Each of the three devices had about 13,700–13,900 records, beginning on 11 April. |
| Test-cloud Kiwi raw history | Each stream began on 10 September, with 2,167–2,282 records. |
| Test-cloud current combined soil source | Daily aggregates began on 7 July; hourly aggregates began on 27 September. |
| Other test-cloud sources | Daily aggregates began in June for the inspected environment and per-device soil sources. No weekly aggregates were returned for the two field zones. |

The gateway-wide count establishes that the previous frontend cutoff excluded retained data. It does not establish that every card has readings throughout that period. Zone membership, source identity, channel, and resolution all affect the result.

The cloud API uses raw readings for short requests and typed aggregates for longer requests. A shorter viewport can therefore return no readings at a date where daily aggregates exist. The prototype must describe the result at the requested resolution; changing the chart library cannot restore absent cloud records.

## Scope of the correction

Navigation can move before the previous 90-day cutoff. Each visible interval and request remains limited to 90 days, with the existing aggregation tiers. The finite lower navigation bound is the Unix epoch; it is a technical limit, not a claim that records exist from that date.

An accepted empty interval keeps its timeline and touch surface. Previously selected units and sensor choices survive a transient empty result, while the chart receives no stale samples. Empty-state text explains that the user can pinch or drag to another interval.

The query policy, history retention, synchronization, and backend services are outside this correction. No automatic daily fallback or cloud backfill is included. A later coverage-aware design should expose which detail levels are available for a selected card and interval.

## Verification status

The controller reproduced the failure before changing product code: native Playwright pinch-out tests failed on both edge and cloud because the chart wrapper disappeared after the empty response. Traces and screenshots are under `.superpowers/sdd/2026-10-07-uplot-history-coverage-recovery/red-empty-recovery/`.

Sol's independent source and test review passed after correcting the remembered metadata key to include the selected zone and card. The complete browser run also caught D3's default double-tap zoom conflicting with reading inspection after a unit change. The final controller disables that handler while keeping pinch and pan; its two-touch-tap regression passed, followed by the previously failing inspection test.

| Local check | Result |
| --- | --- |
| Complete unit suite | 187 passed, 23 files |
| TypeScript and production build | PASS |
| Complete mobile Playwright suite | 60 passed |
| New edge/cloud recovery and older-navigation cases | All six passed |
| Original comparison gesture criteria | All 27 passed |
| Visual checks at 390×844 and 448×998 | No overflow or browser errors; populated-to-empty chart bounds unchanged |

Database observations are live evidence; API fixture tests are evidence of client behavior. An authenticated live browser session was not available during the investigation.

## Verified test-server release

Refresh [the cloud pilot](https://server.opensmartirrigation.org/prototypes/history-zoom/#/pilot/cloud) to load release `20261007T184445Z-d54a0bb1f97b`, built from source commit `d54a0bb1f97b`. Its archive SHA-256 is `87552774dc04e69a4286a4c416696364f75f8c71f9c4e31379a22e9346f5f25f`.

All 60 mobile Playwright tests passed against the deployed bundle, including the six new recovery/navigation tests and all 27 original gesture criteria. The served assets matched their local hashes and carried `no-store` headers. Public login gates passed for both pilot routes, and the main application, health endpoint, and neighboring path retained their baseline responses.

Deployed fixture captures at both phone sizes also passed: no browser errors or horizontal overflow, identical populated-to-empty chart bounds, and a visible time axis around the non-blocking empty-state message.

The deployment changed the existing static preview target in Caddy. Its configuration was backed up, validated, and reloaded in place. Backend services and databases were not restarted or changed. No bundle was deployed to the field gateway.

Rollback to the preceding preview:

```bash
ssh <test-host> bash /home/rocky/caddy/deploy-staging/20261007T184445Z-d54a0bb1f97b/rollback.sh
```

Evidence is under `.superpowers/sdd/2026-10-07-uplot-history-coverage-recovery/`. The release directory contains the archive and manifest, configuration diff and validation output, public HTTP checks, deployed browser log, original prototype screenshots, and public auth-gate captures. Physical Pixel 8 Pro acceptance remains the user's live test.
