'use strict';
// Pure re-implementation of the ONE-TIME-OPEN grace window that decides
// whether a due ONCE valve_schedules row FIRES or is SKIPPED, factored out so
// P1 and C1 can both assert against it offline (fixtures) and reuse the exact
// same predicate live, instead of each guessing the 10-minute number.
//
// Source of truth (verified 2026-09-17, this repo):
//   conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/
//   osi-valve-control/workers.js
//     const ONCE_GRACE_MS = 10 * 60 * 1000;
//     ...
//     if (nowMs - fireMs > ONCE_GRACE_MS) { ... once_state: 'SKIPPED' ... }
//     else { ... once_state: 'FIRED' ... }
//
// workers.js itself is NOT required here: it pulls in ./store, ./push,
// ./ack, ./runtime, which touch osiDb/Node-RED globals at call time and are
// not safe to load standalone from a workstation. The constant is copied
// with an explicit citation instead (same pattern lib/rejections.js uses for
// REJECTED_RETENTION_DAYS) so a change on the gateway side shows up as a
// live-run mismatch (a finding), not a silent divergence no one notices.
const ONCE_GRACE_MS = 10 * 60 * 1000;

// Mirrors workers.js's own comparison exactly: `nowMs - fireMs > ONCE_GRACE_MS`.
// Returns 'FIRE' when the tick would fire the row, 'SKIP' when it would mark
// it SKIPPED (one_time_missed), given the row is otherwise due
// (kind=ONCE, once_state=PENDING, enabled, not deleted, fire_at <= now).
function classifyOnceOutcome(fireAtIso, nowMs) {
  const fireMs = Date.parse(fireAtIso);
  if (!Number.isFinite(fireMs)) throw new Error('classifyOnceOutcome: fireAtIso is not parseable: ' + fireAtIso);
  return (nowMs - fireMs > ONCE_GRACE_MS) ? 'SKIP' : 'FIRE';
}

module.exports = { ONCE_GRACE_MS, classifyOnceOutcome };
