# Tensiomark Data and depth settings execution report

Both configured Tensiomark probes are available in Data, including when their installation depths are unknown. The card, Data charts, history monitor and cloud device history use the existing soil-tension unit preference. Storage and API values remain canonical kPa; selected-series CSV exports use the displayed unit.

The cloud card also has a depth settings button. Each configured probe has one optional depth in centimetres. Saving queues the existing protected depth command; confirmed labels change only after the edge applies the update and mirrors it back. An empty field leaves that probe's depth unknown. The operator supplied the zone assignment during implementation; no installation depths were invented.

## Implementation and review

The edge catalog now validates explicit Tensiomark layouts and discovers both tension/temperature pairs even when the latest observation is absent or rejected. This does not add Tensiomark to root-zone irrigation inputs.

Presentation converts canonical SWT series through the existing conversion function. Channel identifiers, request units and stored workspaces are unchanged. Missing readings remain gaps, and mixed-chart tooltips retain the precision of each unit. Reviews caught canonical-history metadata and tooltip escaping defects; the fixes have regression coverage.

Depth requests contain only paired depth keys. The backend and edge reject malformed, extra, unequal or partially supplied pairs before any normalization can turn them into an unintended clear operation. The edge derives the layout from its current configuration and updates the depth map and layout in one versioned transaction. Sensor identities, addresses, acquisition settings and calibration qualification are preserved. Existing event decoration and mirror convergence carry both fields without a schema or transport change.

Independent Sol and Astra reviews covered the plan, runtime changes, backend, presentation and depth editor. The editor's regression tests include background refreshes, queued/confirmed state, consecutive saves and a later edit from another session. Equivalent refreshes preserve a draft; a stale terminal result cannot hide a newer pending edit.

## Verification

| Check | Result |
|---|---|
| Edge protected depth command tests | 31 passed |
| Edge route harness | 28 passed |
| Edge profile parity and full sync verifier | Passed |
| Private edge frontend | 236 Node tests and 2,750 Vitest tests passed; typecheck and build passed |
| Cloud backend depth, authorization, controller and convergence tests | 193 passed in independent review |
| Cloud depth/card/history/registry/API focused tests | 49 passed |
| Public cloud frontend at `dd11bd2c` | 169 Node tests and 2,592 Vitest tests passed, with two existing skips; build passed |
| Private cloud frontend | 220 Node tests and 2,625 Vitest tests passed, with two existing skips; build passed |

The supporting edge was deployed before the cloud editor. Independent read-only checks matched all 96 GUI files and the runtime helpers to the private build. The live database passed integrity and foreign-key checks; its 74 migration rows and 284 schema fingerprints matched the backup. All 10,525 previous device-history rows and 11 raw Tensiomark observations were retained without changes. The deployed catalog helper returned both configured pairs with null depths. A subsequent field cycle passed independent raw-frame, configuration-hash and conversion checks, and all four canonical readings matched the cloud.

The cloud release also passed independent verification. Its running image, source revision and served index, JavaScript, CSS and depth translations matched the release artifact. Health was UP. The activation check preserved all 11 other container IDs; the independent check also compared the four customer peer services with their baseline. The 125-row Flyway ledger had no failures. All 11 target history rows captured before deployment retained their digest, and the device configuration, zone, null depths and depth-command capability matched the baseline. The latest edge/cloud reading comparison also passed after activation.

The deployed JavaScript contains the depth settings control and protected endpoint, and all nine depth strings were served in English and five translated locales. An unauthenticated empty-object request to the depth route returned 403; the subsequent database read confirmed no configuration change. The analysis endpoint also remained protected. Authenticated catalog output was covered by service tests and source-field checks, not a live user-token request. Release identifiers, backup locations and operational device identifiers are retained in private deployment evidence.

## Verification limits

The supported in-app browser bridge was unavailable. Rendered component tests cover interaction and preference changes, but no signed-in live browser session was exercised. No test depth was written to the live device configuration. The first real installation depths remain an operator action through the new editor.
