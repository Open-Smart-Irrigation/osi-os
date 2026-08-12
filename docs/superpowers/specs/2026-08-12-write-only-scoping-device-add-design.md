# Write-only scoping and two-option device add — design

**Date:** 2026-08-12
**Status:** Approved direction, pending implementation plan
**Supersedes (partially):** [2026-07-19-agrolink-scoped-multiuser-design.md](2026-07-19-agrolink-scoped-multiuser-design.md) — the role model, grant tables, sync contract, and write gates survive; every zone/plot read filter is removed.
**Trigger:** A freshly registered LSN50 (`A840412D385E7D00`) vanished from every device list on agrolink-test-01 because the scoped `GET /api/devices` filter grants visibility only through zone membership, and a new device has no zone. The maintainer judged the read-scoping model overcomplicated and chose write-only scoping.

## 1. Goal

Any enabled account on a gateway (and its paired cloud membership) reads everything in the account; zone scope and role gate only mutations. The zone card's add-device affordance offers two paths: assign an existing unassigned device, or register a new device directly into the zone in one step.

Non-goals: the sync ownership-bootstrap gap (edge-introduced DEVICE/ZONE events terminally rejected by the cloud) stays a separate work item; `EdgeOwnershipService` and the scoped-access sync mirrors are untouched; flag-off gateways keep their current behavior.

## 2. Locked decisions

| # | Decision | Consequence |
|---|---|---|
| W1 | Scoping is write-only: reads are account-wide for every enabled account, including viewers | All zone/plot read filters and 404-hiding on reads are deleted, both repos |
| W2 | The journal follows the same rule — no read-privacy exception | Every enabled account reads all journal entries, notes, photos, and exports on the hub. Chosen deliberately over per-researcher privacy |
| W3 | Researchers may register devices without a target zone | The old R2 rule (researcher provisioning must terminate in scope) is dropped; unassigned devices land in the bucket everyone can see |
| W4 | Assignment operates only on unassigned devices; moving a device is an explicit unassign, then assign | Assign returns 409 naming the current zone when the device is already assigned. No one silently pulls hardware out of a colleague's zone |
| W5 | `POST /api/devices` takes an explicit optional `zone_id`, write-scope-checked | Replaces the implicit `_scopedTargetZoneId` auto-assign |
| W6 | History workspaces stay owner-only | Saved dashboards are personal artifacts, not zone data |
| W7 | Admin-only infra surfaces keep their role gates, reads included | Downloads, sync state, system stats, gateway history, user and grant management |
| W8 | Edge and cloud land together | The `/api/me` contract and read semantics change on both sides at once |

## 3. Access model

Three gates remain, applied uniformly on both repos:

1. **Authentication and enabled account** on every route. The disabled-account check survives read-filter removal on every read path; the code comment in `get-devices-query` documents why (a disabled account with an unexpired token would otherwise still read data).
2. **Role.** `viewer` reads only; `researcher` and `admin` mutate (`canMutate` unchanged). Admin-only role gates on infra surfaces are untouched (W7 list).
3. **Zone write scope on mutations.** Owned ∪ granted zones gate writes exactly as today: `assertFresh*` guards on write routes, the `write-strega-expectation` dual-gate chokepoint, the `_systemActuation` scheduler exemption, and the `scope_actor_required` cloud-relay rejection all survive unchanged.

Everything else is deleted: the zone-UUID predicates on list reads, `assertZoneAccess`/`assertDeviceAccess` calls on read routes, the plot filter on journal reads, and the weather-device carve-outs (three backend sites, one frontend branch) that existed only to punch holes in read filtering.

## 4. What this fixes beyond the trigger bug

The cloud's read paths are an inconsistent patchwork that already breaks granted members: all 13 Terra/prediction endpoints, device reads and histories, S2120 zone-assignment reads, and zone environment-summary are owner-only with no grant awareness (blanket 403 for granted researchers today); the cloud device list is claimed-by-owner-only, so a granted member sees no devices at all. Write-only scoping repairs all of these in one contract. The edge's CrossZoneAnalysis page, which never filtered reads, becomes consistent instead of anomalous.

## 5. Must-preserve ledger

Each row looks like a read filter but is a different boundary. The implementation plan must carry these as explicit checks with negative tests.

| # | Boundary | Rule |
|---|---|---|
| P1 | Disabled accounts | `assertEnabledAccount` (edge) and the membership-enabled check (cloud) run on every read |
| P2 | Admin-only reads | Gateway history, `/api/sync/state`, `/api/system/stats`, `/download/database`, `/download-fieldtest`, gateway location, improvement-request listing, `/api/users`, account-link status |
| P3 | Workspaces | `/api/history/workspaces*` keep unconditional `user_id = ?` on read and write |
| P4 | Actuation dual-gate | Both scope checks on the downlink path stay; no consolidation |
| P5 | Unassigned-device reads | Dropping the `!device.zone_uuid → 404` branch must cover every device-detail read (sensor-history, dendro-daily, rain-history, today-liters, zone-assignments), or list-visible devices 404 on click |
| P6 | Shared guard hubs | Write gates live in two hub nodes (23 device-config routes, 4 zone-config routes); edits target the hubs, and the sibling read nodes in the same tabs stay separate |
| P7 | Assign precondition | `UPDATE devices SET irrigation_zone_id = ? … WHERE irrigation_zone_id IS NULL`; a lost race or an already-assigned device returns 409 with the current zone name |
| P8 | Honest conflicts | With enumeration hiding gone, foreign-resource conflicts return 409/403 with real reasons, not 404 |
| P9 | Cloud registration gate | Role/mutation-gated, not gateway `claimedBy`; `REGISTER_DEVICE` carries `zone_id` |
| P10 | One cloud scope resolver | `GatewayScopeService` and `JdbcZoneGatewayAccess` collapse into one before read semantics change, so the rework edits one implementation |
| P11 | Sync triggers | Assignment and registration keep flowing through row-wise `UPDATE devices` so `trg_sync_devices_outbox_au` fires; no bulk path that skips the `sync_version` bump |

## 6. Edge backend changes

Read routes losing their scope predicate (keeping P1): `GET /api/devices`, `GET /api/irrigation-zones`, zone environment-summary and recommendations, the five device-detail histories (P5), all `/api/history/zones/*` reads, `visibleZoneIdsForExport` in the account-wide CSV export, `/download-sensordata`, analysis channels/series, recent actuations, and every journal read and export (`buildEntryWhere` drops the owner-OR-granted-plot filter per W2).

Write routes changing: `POST /api/devices` accepts `zone_id` (write scope on that zone; absent → unassigned, any write role per W3). `PUT /api/irrigation-zones/:id/devices/:deveui` gains the P7 precondition and drops `assertFreshDeviceAccess` (the device no longer needs to be in the caller's read scope — it needs to be unassigned). `DELETE …/devices/:deveui` (unassign) keeps its zone write-scope gate. Every other write guard is untouched.

`/api/me` keeps its shape; `zone_uuids`/`plot_uuids` are documented as write scope. `features.scoped_access` stays.

## 7. Edge frontend changes

- Delete `visibleZones`/`visiblePlots`/`availableZones` filtering on FarmingDashboard, JournalPage, HistoryDashboard; delete the weather-device shunting branch (the multi-zone weather-card presentation — weather stations rendering in their own section even when zone-assigned — is the multi-zone table design and stays).
- `scopeLoading` gates only write affordances. Lists render when their data fetch resolves; a failed `/api/me` degrades to read-only, not to a blank page.
- `CanWrite` drops its `isZoneVisible` read-visibility branch and gates on the write-zone set. `showAdmin` becomes `isAdmin && !scopeLoading` — the `&& isScoped` conjunct would hide the admin menu once scoped semantics change.
- The zone card's two buttons open one two-tab modal, built on ui-core with CreateZoneModal as the exemplar. Tab "Assign existing": today's picker plus 409 handling ("now in zone X" refreshes the list). Tab "New device": the registration form with the zone fixed, submitting `zone_id`; ChirpStack bounded errors surface in the modal. AddDeviceModal (header flow) is migrated to ui-core in the same pass and keeps registering unassigned.

## 8. Cloud changes

Reads widen to gateway membership + enabled account: zone list (`readableZones`), zone history, environment-summary, device list and all device reads/histories, S2120 zone-assignment reads, all 13 prediction/Terra endpoints, journal `scopedQuery`. Gateway-wide history stays admin/owner (P2 parity). Writes: registration re-gated per P9; zone↔device assignment moves from `ownedZone` to zone write scope plus the P7 precondition; all other mutation gates (`requireZone`, `requireMutation`) are already write-only-shaped and stay. The scope resolvers consolidate per P10. The three mirrored farming components port back from the edge versions; `gatewayCapabilities.ts` already gates only mutations and needs review, not rework.

## 9. Testing

- Edge `scripts/test-scoped-access-reads.js` is rewritten to assert the inverse: account-wide reads for admin, researcher, viewer; 401/403 for disabled accounts and missing auth on the same routes; P2 admin-only reads still reject non-admins. Negative controls that must fail before the fix: a viewer reading a foreign zone's history (404 today, 200 after), an unassigned device's sensor-history (404 today, 200 after).
- `scripts/test-scoped-access-writes.js` runs unchanged as the write-gate regression net; new cases cover `zone_id` registration (in-scope, out-of-scope 403, viewer 403) and the P7 assign conflict.
- `scripts/verify-scoped-access.js` structural checks update to the new guard wiring.
- Frontend: rewrite the read-filter tests in FarmingDashboardHeaderWiring, JournalPage, HistoryShell, CanWrite, ScopeContext; add modal tests for both tabs including the 409 path.
- Cloud: invert the enumerated read-scope tests (`GatewayScopeServiceTest`, `JdbcZoneGatewayAccessTest`, `HistoryServiceTest`, `JournalQueryServiceTest`, `IrrigationZoneControllerSyncTest`); mutation tests stay.
- Journal reads had zero scope-test coverage; the rewritten suite adds account-wide-read assertions for journal entries and exports so W2 is pinned rather than incidental.

## 10. Rollout

Both repos merge and deploy together (W8). The cloud-side vendored-contract CI has never run for AgroLink branches, so the paired rollout is verified manually: a granted researcher account and a viewer account exercised against both GUIs after deploy — device list, unassigned bucket, both modal tabs, a foreign zone's history, a journal entry from another account, one denied write per role. Flag-off gateways (Silvan, kaba100, Uganda) see no behavior change; agrolink-test-01 is the only scoped-mode gateway live today.
