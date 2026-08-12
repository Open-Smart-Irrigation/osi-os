# Write-only scoping execution report

## Edge Task 5

Task 5 makes scoped sensor export, recent-actuation, and analysis reads account-wide while preserving flag-off behavior and the deliberate readability of historical rows from unclaimed devices.

### Plan deviation

The plan assumed that `osi-history-helper` treats `zoneUuids: null` as a wildcard. The current helper does not: `null` selects its legacy owner-only query path. Treating that sentinel as account-wide would therefore leave scoped analysis reads incorrectly owner-filtered, while changing the helper globally could widen flag-off reads.

The analysis router now keeps `scopeZoneUuids` as `null` only for flag-off legacy behavior. In scoped mode it loads an explicit array of all non-deleted, non-null `irrigation_zones.zone_uuid` values and passes that array to the helper. The call-site comment explicitly records that `null` is the legacy owner-only path, not the scope-helper wildcard.

This is a deliberate plan deviation to preserve the production negative control and avoid a fail-open interpretation of a shared sentinel.

### Pinning tests

- Scoped analysis with the explicit array returns channels from both the owned and foreign zones.
- Flag-off analysis remains owner-only and excludes the foreign zone.
- Per-user saved-view ownership remains intact; account-wide readable selectors are retained rather than dropped.

### Verification

- `node --test scripts/test-scoped-access-reads.js` — 35 tests passed.
- `node scripts/verify-history-api-contract.js` — passed.
- `node --test scripts/verify-history-api-contract.test.js` — 2 tests passed.
- `node scripts/verify-sync-flow.js` — passed.
- `node scripts/verify-flows-fn-parse.js` — passed.
- `node scripts/verify-scoped-access.js` — passed.
- `node scripts/verify-flows-size-ratchet.js` — passed.
- Exact Task 5 flow sizes: `fn_build_sensor_sql_params` 5102, `get-actuations-query` 4163, `analysis-api-router-fn` 9097, total 1280015.

### Cloud follow-up

Before the cloud plan reaches its Task 5-equivalent reads, inspect `GatewayReadAccessService` and its callers for the same sentinel trap. If that service grows any `null`-means-all convention, record the same fail-open argument and require scoped mode to pass an explicit account-wide value.
