# AgroLink branch findings ledger — 2026-08-13

Consolidated, adjudicated findings from five reviews of `feat/journal-cloud-primary`:
Codex Tasks 1–4 (edge `71b8103d..efd744de`), edge Tasks 5–16 (`3a416c3e..09bcf11c`),
cloud Tasks 1–15 (`f1b51e25..69fc0667`), the branch-vs-main risk sweep, and the
sync-contract review. Every finding below survived verification (mutation tests, live
probes, or direct code reads); unsubstantiated suspicions were dropped. This ledger is
the input to the fix-wave plan.

Severity: **MG** = merge-gating for the write-only-scoping pair, **BR** = branch blocker
independent of the scoping work, **SF** = should-fix, **FU** = tracked follow-up.

## Edge — write-only scoping execution

| # | Sev | Finding | Fix shape |
|---|---|---|---|
| E1 | MG | Task 13: both add-device modals send `type_id = catalog[0].id`, ignoring the dropdown (`AddDeviceModal.tsx:52-57`, `ZoneDeviceModal.tsx:98-103`); every device registers as the first catalog type, both flag modes | Send `selectedType`; add a two-item-catalog test (the existing single-item mock cannot catch it) |
| E2 | MG | Task 10: `&& !weatherDevice` on the `byZone` branch ejects zone-assigned S2120/LoRain from their zone card into "Unassigned" on flag-off production; zones whose only device is a weather station render the empty state | Drop only the dead scope term; keep card-internal weather sections; unmock `IrrigationZoneCard` far enough to test `devicesByZone` |
| E3 | MG | Lifecycle predicate `d.user_id IS NOT NULL` hides cloud-assigned devices with NULL `user_id`; proven end-to-end via Task 15 (`INSERT OR IGNORE` + `user_id`-preserving UPDATE): ACK says SUCCESS, device invisible in every list. Plan v3 carries the defect too | Predicate → `(d.user_id IS NOT NULL OR d.irrigation_zone_id IS NOT NULL)`; verified: all 91 backend tests stay green |
| E4 | MG | Gateway history card-preference PUT/POST skip the P2 admin gate (`scopeRouteForRequest` keys on `method === 'GET'`); enabled viewers get a gateway-existence oracle plus a write | Drop the GET conjunct |
| E5 | MG | Task 15 has no `OSI_SCOPED_ACCESS` guard: flag-off gateways' REGISTER_DEVICE ACKs gain `zoneAssignedId`/`zoneWarning` and would honor a cloud `zoneUuid` — violates the spec §10 flag-off promise; ACK fields not schema-pinned | Gate zone resolution + new ACK fields on scoped mode, or amend spec §10 with cloud sign-off |
| E6 | SF | `POST /api/devices` on an existing device silently unassigns (absent `zone_id`) or moves (different `zone_id`) it, bypassing the P7/W4 assign precondition | Reject existing-device re-posts with 409, or route them through the assign gate |
| E7 | SF | Devices left pointing at a soft-deleted zone (deleter-owned filter on `delete-zone-unassign`) are now unrepairable: assign 409s, unassign 404s; modal shows `zone ""` for null names | Zone-delete nulls all member devices' zone ids; 409 body/modal handle null names |
| E8 | SF | `showAdmin` migration missed CrossZoneAnalysisPage (still `isAdmin && isScoped`); JournalPage body still gated on `scopeLoading` (hung `/api/me` parks Journal forever) | Finish both; copy the HistoryShell never-resolves test |
| E9 | SF | Test-honesty gaps: header-wiring test cannot catch a `showAdmin` revert; `ZoneDeviceModal` catalog mock single-item; `AddDeviceModal` has no test file | Fix alongside E1/E8 |
| E10 | SF | Four `addModal.appkey*` keys missing from all 7 locales (inline English fallback), incl. lg | Add keys; extend the locale test to referenced-key completeness |
| E11 | FU | Assign lost idempotency (re-assign to same zone 409s); stale migration scripts emit deleted helper calls; tablist a11y; `HistoryDashboard` loadingMessage still includes scopeLoading | Batch into cleanup task |

## Cloud — write-only scoping execution

| # | Sev | Finding | Fix shape |
|---|---|---|---|
| C1 | MG | Granted researcher assigning an unassigned device still 404s: `DeviceMutationService.authorize` zoneless branch requires claimer identity; the 202 test mocks `assign` and proves nothing | Widen the zoneless branch to target-zone write scope; unmocked test |
| C2 | MG | `gatewayMismatch` fails open on null device gateway EUI (every cloud-registered device pre-sync): cross-account `ASSIGN_DEVICE_TO_ZONE` issuable in that window | Fail closed on null; require `isMember(user, device.gatewayDeviceEui)` |
| C3 | MG | Eleven `addModal.*` keys exist in no locale including `en` — the "New device" tab is English everywhere; locale test checks only the 3 keys that exist | Add all keys × 7 locales; referenced-key test |
| C4 | MG | Zone-card add-device gated on `mutationsSupported` (zone desired-state capability): whole fixed-zone flow unreachable on gateways without it; the only test pinning the gate queries a renamed button | Gate on `deviceWritable`; fix the dead tests |
| C5 | SF | `devicesForZone` still filters `device.claimedBy == zone.user`: on multi-user gateways, widened zone reads return zones with missing devices (visible in the §10 walkthrough) | Delete the owner filter per spec |
| C6 | SF | The "advisory" 409 hard-blocks on stale mirror data (cloud refuses a legal assign until edge unassign syncs); every 409 renders as `already in zone ""` (status-only branch) | Distinguish 409 bodies; consider command-through on stale mirror |
| C7 | FU | Dead code (`JournalQueryService.find` main-callers, `findOwnedS2120`); stray `@Transactional(readOnly)` on a write helper; resolve-then-catch pattern one level up from `tryResolve`; ArchUnit omitted-dep counters +4552 re-baselined | Cleanup task |
| C8 | FU | 1,601-test sweep unverifiable from artifacts (preservation rerun clobbered reports) | Re-run full sweep in the fix wave's final gate |

## Branch-wide (pre-existing on the branch, independent of scoping)

| # | Sev | Finding |
|---|---|---|
| X1 | BR | Factory image provenance stale (seed DB grew, bundle not regenerated): fresh images boot with no `/data/db/farming.db`; no CI runs the verifiers. Fix: `generate-factory-image-provenance.js --refresh-bound-hashes --preserve-image-build-id --write` + CI gate |
| X2 | BR | Journal update authorizes the body-supplied plot, never the entry's real plot (`api.js:1279-1285`): revoked grantee overwrites/re-parents entries |
| X3 | BR | Scoped zone-entry path commits an orphan duplicate plot + shipped outbox event, then always fails (`assertZoneWrite` principal not rewritten) |
| X4 | BR | All-zero requested AppKey "registers" with no key written (`storedKeyEqual` canonicalizes both operands); reject at validation |
| X5 | BR | Cloud REGISTER_DEVICE for an already-claimed EUI rewrites live ChirpStack incl. root key while local `INSERT OR IGNORE` no-ops: cross-tenant takeover, ACK SUCCESS |
| X6 | BR | New edge + deployed cloud terminally NACKs all STREGA/valve physical actions (`physicalActionExpiry` treats missing `expires_at` as malformed); fix: missing = legacy issuer, no fence |
| X7 | BR | Seven new sync event ops unstaged (`staged: []`): deployed cloud rejects `unknown_op`, edge stamps `rejected_at`, never resent — permanent mirror divergence. Stage via capability matrix or enforce cloud-first + document outbox replay |
| X8 | SF | Login path: unguarded `verifierSubject` throw + auth-tab catch with no http-response node = hung request (placeholder-EUI + server-auth user) |
| X9 | SF | Duplicated auth-secret generators can race on fresh gateways; password reset leaves 7-day tokens valid (document disable→re-enable or add token epoch); verifyKeys mismatch skips key rollback with no ACK signal; `cs-register-device-fn` double HTTP response on compensation failure |
| X10 | SF | Journal: plotless entries readable but not voidable in scoped mode; catalog GET not owner-rewritten (empty custom vocab for grantees) |
| X11 | SF | CI: main-only triggers mean no branch gate ever ran. Add branch triggers for: provenance verifiers, `verify-sync-op-parity` (pinned pairing), `OSI_EXPECT_FLOW_RED=1` flow tests, the 10 unwired contract/command-path suites, journal-V2 suite. `osi-zone-commands` (802 lines) + `osi-scoped-access-commands` (479) have zero tests |
| X12 | FU | `action:` effect keys inert on un-upgraded gateway ledgers; `effect-keys.md` replay rule understates implemented dedupe; journal-V2 docs claim producer-off while the tick runs (runtime-safe); guarded-SQL string surgery unpinned; derole guard over-strict with a disabled admin |

## Deployment and live-state findings (maintainer sweep, 2026-08-13)

State repairs and deploy-day gates, distinct from code fixes. Sources: live inspection of
agrolink-test-01, kaba100, and the production cloud DB.

| # | Sev | Finding | Fix shape |
|---|---|---|---|
| D1 | BR | Bootstrap whitelist (`8ac15856`, deployed) covers only DEVICE + the zone family: DENDRO, DENDRO_ROW, CHAMELEON, DEVICE_DATA*, and journal types still terminally reject when the cloud does not know the parent resource | Extend the absent-resource bootstrap whitelist to telemetry/journal types whose id carries the gateway EUI, with per-type review |
| D2 | BR | **Deploy-day gate:** `gateway_user_mirrors` has ZERO rows on the live cloud (`last_acknowledged_at` NULL on both linked accounts). The widened read path throws without a mirror row (`GatewayScopeService.java:73`), so post-deploy every read 403s "Gateway membership is required" and the dashboard stays dead. Edge machinery exists (0033 USER triggers + 0034 backfill, gated on `scoped_access_emit.enabled`) but mirrors have never arrived | After lockstep deploy, verify mirrors populate for BOTH gateways; if not, touch edge `users` rows (or re-link) to fire the emit trigger; diagnose why USER events never arrived (check `scoped_access_emit.enabled` + `USER%` rows in each edge outbox) |
| D3 | SF | 14,386 dead outbox rows on agrolink-test-01: terminal rejections never retry; sim devices whose DEVICE-create died pre-bootstrap-fix stay unregistered cloud-side, so their telemetry keeps rejecting and the pile grows while sim tabs run | State repair: re-enqueue/inject recipe (in [[sync-ownership-bootstrap-gap-2026-08-12]] memory) or re-register the sims; consider disabling sim tabs until then |
| D4 | SF | kaba100 stores plaintext passwords for `Farmer` and `admin` (`test` is bcrypt). Flag-off gateway; untouched by the rework | Live repair: bcrypt-hash both rows; check Silvan/Uganda for the same |
| D5 | SF | 0034 backfill promoted `MIN(id)` to admin: on kaba100 that is `Farmer` (id 1), enabled | Live data correction + a backfill guard for future gateways |
| D6 | FU | kaba100: 381 historical rejections (222 stale_sync_version, 48 equal_version_payload_conflict, ~111 journal ownership_denied) — same classes as D1/D3 | Triage with the D3 replay recipe |
| D7 | — | Agroscope banner on the cloud branch is deliberate (`f6bc5491`), non-issue | None |
| D8 | — | agrolink-test-01 went offline mid-session (SSH/:1880 timeout, Tailscale relay "fra"); healthy an hour earlier — looks like site network/power, not the deploys. The emit-gate check (D2's edge half) is still unrun | Confirm the gateway returns before scheduling the lockstep deploy; run the emit-gate check first thing |

## Round 2 — fix-wave execution review findings (2026-08-13, post-wave)

Reviews of the fix-wave commits themselves (edge `8fc83874..2e47ab5b`, cloud
`85d6ccd8..67040c28`). The four security fixes (X2/X3/X4/X6) and the nine original merge
gates verified fixed; the rows below are what the wave itself introduced or left open.
Mutation tally: edge 21 mutants, 17 killed, 4 survivors (each a row below).

| # | Sev | Finding | Fix shape |
|---|---|---|---|
| R1 | MG | Edge `58470b5c` rewrote the AddDeviceModal E1 test to select `catalog[0]` — reverting the E1 fix in that modal kills zero tests | Restore the `8fc83874` STREGA-selecting version (one line; passes against HEAD) |
| R2 | MG | Edge `c0a60430` deleted `typecheck.yml`'s `working-directory: web/react-gui`: `npm ci` ENOENTs, the whole GUI gate stops running | Restore the defaults block |
| R3 | MG | Edge X7 commit reds `test-contract-schemas.js:1103` (`cloudDeferred === []` hard pin) → 3 workflows red | Update the assertion to the staged set |
| R4 | MG | `capture-history-router-vectors.js --verify` reds: the auth-secret refactor put `osiLib.require` in `history-api-router-fn`'s hot path and the harness sandbox provides no `osiLib` (runtime fine — `libs` declared). Same gap keeps `verify-strega-gen1.js` red (pre-existing) | Provide `osiLib` in the harness sandbox; retires both reds |
| R5 | MG | Cloud vendored `sync-contract-golden.json` byte-differs from edge (edge staged 7 ops; cloud still `staged: []`); server vendor gate reds at the lockstep merge; no verifier compares the copies | Copy edge → cloud; add a cross-repo byte-compare to the parity verifier |
| R6 | MG | Cloud ArchUnit red introduced at `85d6ccd8`: NOT a new cycle — identical 1402-cycle set, only violation example text changed (constructor signature churn). `allowStoreUpdate=true` is not a valid refreeze | Reviewed refreeze commit per precedent (`5648f753` et al.); evidence = the 0/0 cycle diff |
| R7 | MG | Cloud C5 regression test is vacuous (claims the device by the zone owner — passes on pre-fix code, empirically proven) | Claim by a non-owner user (one line) |
| R8 | MG* | X5 fence no-ops legitimate re-registration: unclaimed (`user_id IS NULL`) device → ACK `SUCCESS/ALREADY_REGISTERED`, never claimed, zoneUuid ignored, ChirpStack never provisioned, invisible under E3's predicate; same-owner re-key also no-ops (blocks zero-key repair). And the new ACK vocabulary is ungated on flag-off (breaks the §10 promise E5 restored). *Design decision: mirror local `post-devices-insert` semantics (claim unclaimed + revive, 409 only cross-owner), gate ACK vocabulary on scoped mode | Decide, then implement + de-vacuous the W4 pin (`cloudUserId` routing makes the zone-precondition mutant survive) |
| R9 | SF | X7 stages the declaration only: migrations 0036/0038 triggers still emit `ZONE_IRRIGATION_CALIBRATION_UPSERTED`/`WEATHER_STATION_ZONES_REPLACED` unconditionally (only USER_* is runtime-gated via `scoped_access_emit`) — divergence guarded by rollout law alone | Runtime-gate both families like `scoped_access_emit`, or accept + document cloud-first as the sole guard |
| R10 | SF | X2 destination-plot check load-bearing but unpinned (mutant survives; probe proves same-owner scope widening); X10 plotless void gated on role only — any writer can void another user's plotless entries | Pin destination check; add ownership comparison to plotless `assertEntryWrite` |
| R11 | SF | D1 cloud follow-ups: aggregateKey vs `payload.device_eui` never cross-checked (WeatherStationZonesApplier has the fix shape); unseen-EUI first-writer-wins claiming; `writeHistoryMirror` still creates ownerless devices; journal ownership SQL zero runtime coverage | Sync-hardening bundle, cloud side |
| R12 | SF | C2 fallout: devices with `gateway_device_eui IS NULL` unassignable from cloud with a wrong "different gateway" message; E6 returns 2xx while silently ignoring the requested zone (ledger asked 409-or-gate); C6 mismatch modal branch untested | Message + count NULL-EUI rows pre-deploy (deploy-day gate addition); E6 → 409; add the C6 branch test |
| R13 | SF | CI residue: 42 script suites still unwired incl. every named command-path suite; `verify-sync-op-parity` pinned to a branch head not a sha (and cannot catch new-edge-vs-deployed-cloud); bcm2709 copies of new command tests never invoked; provenance workflow's second step deterministically red at test-concurrency ≥ 2; frontend `npm run test:unit` in no cloud workflow; new command-package tests cover 1 of 4 / 1 of 6 types (validateIdentity arms, `enabledAdminCount` at zero) | CI round 2 |
| R14 | FU | Report corrections: cloud sweep is 1,608 passed not 1,609; ArchUnit red introduced by the wave, not pre-existing; anonymous skip = ClamAV EICAR IT; `d2e81bd6` commit message says "fail closed" where code deliberately falls back open (tested, but message misleads); E11 HistoryDashboard half has zero coverage; lg renders "hexadecimal" as base ten (feeds Uganda language gate) | Corrections + coverage |

## Rollout law (from the sync-contract review, extended)

Cloud merges and deploys before any edge flows/firmware rollout — never the reverse. No
firmware images until X1 lands. The §10 two-account walkthrough runs after the MG set is
fixed on both sides. Deploy day itself is gated on D8 (gateway back online), then D2
(mirrors verified populated) before anyone calls the deployment done.
