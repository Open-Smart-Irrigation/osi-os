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

module.exports = {
  PR_262_URL,
  REJECTED_RETENTION_DAYS,
  KNOWN_TERMINAL_REASON_PREFIXES,
  isKnownTerminalReason,
  hasRejectedOutboxShape,
};
