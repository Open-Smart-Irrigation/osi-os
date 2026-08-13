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

## Rollout law (from the sync-contract review)

Cloud merges and deploys before any edge flows/firmware rollout — never the reverse. No
firmware images until X1 lands. The §10 two-account walkthrough runs after the MG set is
fixed on both sides.
