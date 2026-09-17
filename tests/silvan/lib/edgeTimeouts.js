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

// --- outbox flush mechanics (C1 #5/#7 settle budget, F146) ------------------
//
// Citations (verified 2026-09-17):
//   conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
//     node id "sync-outbox-flush-coalesce" (fn 'Coalesce Outbox Flush'):
//       const DEBOUNCE_MS = 200;
//       const MIN_GAP_MS = 750;
//     -- a local zone/device mutation pings this gate, which collapses a
//     burst into one POST after DEBOUNCE_MS, never more than once per
//     MIN_GAP_MS. This is the normal, sub-second path (F128: 374-719ms
//     measured end to end) that made C1's OLD 20000ms settle budget usually
//     enough.
//   conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json
//     node id "sync-outbox-build" (fn 'Build Edge Event Batch'):
//       const FLUSH_LEASE_MS = 120000;
//     -- ONE flush lease is shared by BOTH the event-driven gate above and
//     the 30s periodic "Flush Sync Outbox" safety-net inject (same node id
//     "sync-outbox-inject", "repeat": "30"), so at most one flush attempt is
//     ever in flight. If a flush is already holding the lease when a new
//     mutation's debounce timer fires, the new attempt is recorded as a
//     follow-up and skipped -- it does NOT get to run until the CURRENT
//     lease clears, which normally happens as soon as that flush's own POST
//     settles, but can legitimately take up to the full FLUSH_LEASE_MS if
//     that POST itself is slow (bounded by CLOUD_REST_TIMEOUT_MS's cousin on
//     that path) or genuinely stuck.
// Run 6 (F146) observed exactly this: API vs SQLite disagreed, then agreed
// "within two minutes" -- consistent with one flush cycle waiting out a
// contended FLUSH_LEASE_MS before the recorded follow-up actually ran.
const OUTBOX_FLUSH_DEBOUNCE_MS = 200;
const OUTBOX_FLUSH_MIN_GAP_MS = 750;
const OUTBOX_FLUSH_LEASE_MS = 120000;

// Worst case before the API's live COUNT(*) (flows.json "sync-state-build")
// and the SQLite ground truth agree: the current lease holder can occupy the
// full OUTBOX_FLUSH_LEASE_MS before the follow-up flush this case's own
// writes recorded gets to run, plus that follow-up's own debounce/min-gap
// margin, plus one PENDING_POLL_INTERVAL_MS/2 of read-timing margin so the
// settle-poll's own interval does not itself shave the window too thin.
// Comfortably covers the "within two minutes" observed on run 6, and a
// persistent (not just momentarily unlucky) API/SQLite disagreement still
// exhausts this budget and fails the check -- this is a bound on how long a
// legitimate settle may take, not a blanket exemption.
function outboxSettleBudgetMs() {
  return OUTBOX_FLUSH_LEASE_MS + OUTBOX_FLUSH_MIN_GAP_MS + Math.round(PENDING_POLL_INTERVAL_MS / 2);
}

// Runs a bounded wait (e.g. ctx.until(...)) and turns a timeout into an
// EXPLICIT, named decision instead of a bare note the caller could silently
// downgrade into "proceed anyway" (R1, F125/F146 orchestrator follow-up):
// arming a blackhole -- or taking any other measurement -- on top of a
// baseline that was never confirmed healthy makes the result uninterpretable,
// so the caller must be told to stop, with a message that names what did not
// happen, not discover it later on a less specific assertion.
async function firstSuccessOrFail(waitFn, whatFailedMessage) {
  const result = await waitFn().catch(() => null);
  if (result) return { ok: true, result };
  return { ok: false, message: whatFailedMessage };
}

module.exports = {
  CLOUD_REST_TIMEOUT_MS, PENDING_POLL_INTERVAL_MS, resumeBudgetMs,
  OUTBOX_FLUSH_DEBOUNCE_MS, OUTBOX_FLUSH_MIN_GAP_MS, OUTBOX_FLUSH_LEASE_MS, outboxSettleBudgetMs,
  firstSuccessOrFail,
};
