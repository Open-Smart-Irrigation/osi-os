'use strict';
// Shared logic for the sync_outbox "terminally rejected" surface (F30 /
// osi-os#262), factored out of case C1 so the offline selftest can exercise it
// against fixture JSON without a gateway, and so the live check and the
// selftest assert on literally the same code.
//
// osi-os#262 (open as of 2026-09-17, https://github.com/Open-Smart-Irrigation/
// osi-os/pull/262) adds three fields to GET /api/sync/state:
//   rejectedOutboxCount: number   -- total rows with rejected_at IS NOT NULL
//   rejectedLast24h:     number   -- of those, rejected in the last 24h
//   lastRejection:       null | { at, op, reason }
// and a fixed (non-env-configurable) REJECTED_RETENTION_DAYS = 14 window in
// prune-sync-outbox that deletes rejected rows once they are older than that.

const PR_262_URL = 'https://github.com/Open-Smart-Irrigation/osi-os/pull/262';
const REJECTED_RETENTION_DAYS = 14;

// Reasons this harness currently knows how to explain. bovey.cloud's interim
// test tenant denies every resource it has never seen before (a simulated
// device/zone this harness cannot pre-register on the cloud side), which is
// the documented never-seen-resource rule, not a defect -- see README
// "Cleanup, and what it cannot clean". Anything outside this list on a rerun
// is a genuine unexplained rejection and should fail, not be waved through.
const KNOWN_TERMINAL_REASON_PREFIXES = ['ownership_denied'];

function isKnownTerminalReason(reason) {
  return typeof reason === 'string' && reason.length > 0 &&
    KNOWN_TERMINAL_REASON_PREFIXES.some((prefix) => reason.startsWith(prefix));
}

// Orchestrator follow-up 2 (PR #301 review, 2026-09-17): `ownership_denied`
// is only a documented, expected outcome for a DEVICE/DEVICE_DATA aggregate
// -- a simulated device this harness registers under a DevEUI the interim
// cloud has never seen. It is NOT expected for a ZONE: this harness creates
// zones through its own authenticated tenant session, and osi-os F21 (fixed,
// osi-server #118/#115) is precisely the fix that makes a first-seen
// resource bind to the AUTHENTICATED gateway and its linked user -- a zone
// created that way is accepted (measured under one second), never
// ownership_denied. Allowing ownership_denied on a ZONE here would let
// exactly F21's defect class come back silently: the check would pass while
// the product rejected a zone it should have accepted.
const OWNERSHIP_ALLOWED_AGGREGATE_TYPES = ['DEVICE', 'DEVICE_DATA'];

function isOwnershipAllowedForAggregate(aggregateType) {
  return OWNERSHIP_ALLOWED_AGGREGATE_TYPES.includes(String(aggregateType || '').toUpperCase());
}

// True when a terminal rejection is fully explained for the aggregate it
// landed on: a known reason (ownership_denied) AND an aggregate type that
// reason is actually documented for. Kind-blind callers (checking the
// reason alone) would wave through an ownership_denied on a ZONE, which is
// exactly the gap orchestrator follow-up 2 closes.
function isExplainedRejection(reason, aggregateType) {
  return isKnownTerminalReason(reason) && isOwnershipAllowedForAggregate(aggregateType);
}

// True only when `state` (a GET /api/sync/state body) carries the exact
// #262 shape: rejectedOutboxCount/rejectedLast24h as numbers, and lastRejection
// present as either null or an { at, op, reason } object. A response missing
// the keys entirely (pre-#262) or exposing an unrelated same-ish-named field
// (e.g. rejectedMigrationCandidates) both return false -- this is a structural
// check, never a name-regex over Object.keys().
function hasRejectedOutboxShape(state) {
  const s = state && typeof state === 'object' ? state : {};
  if (typeof s.rejectedOutboxCount !== 'number') return false;
  if (typeof s.rejectedLast24h !== 'number') return false;
  if (!Object.prototype.hasOwnProperty.call(s, 'lastRejection')) return false;
  const lr = s.lastRejection;
  if (lr === null) return true;
  return !!lr && typeof lr === 'object' &&
    Object.prototype.hasOwnProperty.call(lr, 'at') &&
    Object.prototype.hasOwnProperty.call(lr, 'op') &&
    Object.prototype.hasOwnProperty.call(lr, 'reason');
}

// Orchestrator follow-up (PR #301 review, 2026-09-17): C1's old final
// assertion (`outboxAfter >= 0 && !!zoneEvent && !!deviceEvent`) is a
// tautology plus two stale snapshots captured right after creation -- a write
// that was queued and later silently removed from sync_outbox (never
// delivered, never rejected) passed it. This classifies a FRESH re-query of
// one specific event, by its own event_uuid (sync_outbox's primary key,
// database/seed-blank.sql:1000), so the case can tell a survived write from a
// dropped one at the end of the run, not just right after it was created.
//
//   row === null            -- missing: SILENTLY DROPPED (never happens under
//                               correct behaviour; sync_outbox rows are only
//                               ever updated in place, never deleted, except
//                               #262's 14-day retention prune of REJECTED rows
//                               far older than a single test run)
//   delivered_at set        -- delivered: survived
//   both timestamps null    -- still queued: survived (not yet the cloud's
//                               turn; asserting it must have already resolved
//                               would reintroduce F122's premise)
//   rejected_at set:
//     explained (isExplainedRejection: known reason AND an aggregate type
//                               that reason is documented for, e.g.
//                               ownership_denied on DEVICE/DEVICE_DATA) --
//                               survived, not dropped
//     anything else         -- including ownership_denied on a ZONE, or any
//                               reason outside KNOWN_TERMINAL_REASON_PREFIXES
//                               on any aggregate -- an unexplained rejection
//                               of THIS case's own event: SILENTLY DROPPED in
//                               the sense that matters here (the write never
//                               actually landed and nothing explains why)
//
// `row.aggregate_type` (the same column every SELECT in this file's caller
// already reads, sync_outbox's own schema column -- database/seed-blank.sql,
// `CREATE TABLE sync_outbox`) drives the aggregate-type check; the caller
// must include it in its re-query rather than this function guessing it.
function classifyOutboxEventOutcome(row) {
  if (!row) return { survived: false, state: 'missing' };
  if (row.delivered_at) return { survived: true, state: 'delivered' };
  if (!row.rejected_at) return { survived: true, state: 'pending' };
  if (isExplainedRejection(row.rejection_reason, row.aggregate_type)) {
    return { survived: true, state: 'rejected_expected' };
  }
  return { survived: false, state: 'rejected_unexplained' };
}

module.exports = {
  PR_262_URL,
  REJECTED_RETENTION_DAYS,
  KNOWN_TERMINAL_REASON_PREFIXES,
  OWNERSHIP_ALLOWED_AGGREGATE_TYPES,
  isKnownTerminalReason,
  isOwnershipAllowedForAggregate,
  isExplainedRejection,
  hasRejectedOutboxShape,
  classifyOutboxEventOutcome,
};
