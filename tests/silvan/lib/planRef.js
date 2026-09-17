'use strict';
// Reference wrapper around the REAL on-valve plan compiler
// (conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/plan.js),
// required directly rather than re-implemented, so S2's timezone/day-boundary
// assertions are checked against the exact same math the gateway runs, not a
// hand-copied formula that could silently drift from it (D1's kpaToHz already
// warns about that risk for a piecewise table; nextRun's DST handling is not
// something to risk re-deriving by hand).
//
// plan.js is safe to require() standalone: its only dependency is
// node:crypto, and every function used here (localParts, weekdayLocal,
// offsetMinutes, isDstTransitionWithin, nextLocalOccurrence, nextRun) is a
// pure computation over Date/Intl.DateTimeFormat -- no osiDb, no Node-RED
// globals, no filesystem access. Verified 2026-09-17 against this repo's own
// checkout of the file; if a future edit adds a require of a gateway-only
// module, requiring this file will throw immediately and loudly rather than
// silently drifting.
//
// The path below is relative to THIS repo's own working copy of the flows
// payload -- exactly what a deployed gateway is supposed to be running. Per
// the harness README's "Known limitations", a gateway running an older
// payload than origin/main can disagree with this reference; that is a
// finding (recorded via ev.note in the case), not a harness bug.

const path = require('node:path');

const PLAN_JS_PATH = path.join(
  __dirname, '..', '..', '..',
  'conf', 'full_raspberrypi_bcm27xx_bcm2712', 'files', 'usr', 'share',
  'node-red', 'osi-valve-control', 'plan.js'
);

const plan = require(PLAN_JS_PATH);

module.exports = {
  PLAN_JS_PATH,
  localParts: plan.localParts,
  weekdayLocal: plan.weekdayLocal,
  offsetMinutes: plan.offsetMinutes,
  isDstTransitionWithin: plan.isDstTransitionWithin,
  nextLocalOccurrence: plan.nextLocalOccurrence,
  nextRun: plan.nextRun,
};
