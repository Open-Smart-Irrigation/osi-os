'use strict';
// The edge's own HTTP client timeout for its outbound cloud REST calls, and
// the pending-commands poll's cadence -- both read directly from the edge
// source, so R1's bounded waits are sized from what the product actually
// does, never a guess (F125/F146).
//
// Citations (verified 2026-09-17, both firmware profiles identical):
//   conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/
//     osi-cloud-http/index.js:6
//       const DEFAULT_TIMEOUT_MS = 30000;
//     -- requestJsonIpv4() sets this as BOTH the http(s).request `timeout`
//     option and an explicit `req.setTimeout(...)` that destroys the socket
//     and rejects on expiry, so it bounds a hung connection attempt (e.g. one
//     that started against a target that only later got blackholed) as well
//     as a hung response.
//   conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
//     node id "sync-pending-http" (fn 'GET Pending Commands IPv4'), ~line 6570:
//       timeoutMs: Number(env.get('OSI_CLOUD_REST_TIMEOUT_MS') || 30000) || 30000
//     -- the pending-commands poll's own outbound request uses this timeout.
//   conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
//     node id "sync-pending-inject" (inject 'Poll Pending Cloud Commands'),
//     ~line 6520, "repeat": "30" (line 6528) -- the poll fires every 30s.
// The bcm2709 profile ships byte-identical osi-cloud-http/index.js and the
// same flows.json cadence; the selftest checks both, not just this profile.

const CLOUD_REST_TIMEOUT_MS = 30000;
const PENDING_POLL_INTERVAL_MS = 30000;

// Worst-case time from "the blackhole route is removed" to "the pending-
// commands poll is observed to have resumed succeeding":
//   - a request already in flight when the route was added is holding its
//     own connection open on ITS OWN timer, not the network's -- it can take
//     up to CLOUD_REST_TIMEOUT_MS after the route is gone to notice nothing
//     is coming back and give up, regardless of when connectivity actually
//     returned;
//   - the next attempt is on a flat 30s cadence (no backoff in this flow), so
//     it can be up to a further PENDING_POLL_INTERVAL_MS away;
//   - that attempt itself gets the same CLOUD_REST_TIMEOUT_MS budget, in case
//     it also catches an unlucky moment (e.g. racing the route removal).
// Two full (timeout + interval) cycles, not one, is the bound this documents.
function resumeBudgetMs() {
  return (CLOUD_REST_TIMEOUT_MS + PENDING_POLL_INTERVAL_MS) * 2;
}

module.exports = { CLOUD_REST_TIMEOUT_MS, PENDING_POLL_INTERVAL_MS, resumeBudgetMs };
