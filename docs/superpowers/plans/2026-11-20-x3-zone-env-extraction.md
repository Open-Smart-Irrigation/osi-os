# X3 environment and run projection extraction

X3 moves four existing function bodies into the `osi-zone-env` package without
changing their API output. The approved extraction proposal, section 3, defines
the scope. The extraction brief requires characterization before code movement
and reserves the flow files for EB2 → EB12 → EB19 → X1 → X2 → X3.

## Base and instructions

Work begins at `ec822b556` on `refactor/x3-zone-env`, with startup readiness READY,
0 behind and 0 ahead of `origin/main`. AGENTS.md is at revision `c63103827`.
The original T3 checkout was stale; the common brief required a new branch from
`origin/main`. No work was implemented on the stale base.

## Implementation boundary

| Node | Facade entry point | File |
|---|---|---|
| `zone-env-fn` | `environmentSummary(msg, dependencies)` | `http-facade.js` |
| `strega-today-liters-fn` | `todayLiters(msg, dependencies)` | `run-projection.js` |
| `get-actuations-query` | `queryActuations(msg, dependencies)` | `run-projection.js` |
| `get-actuations-response` | `formatActuations(msg, dependencies)` | `run-projection.js` |

Both files live under each profile's `files/usr/share/node-red/osi-zone-env/`.
`index.js` exports the entry points; the existing `zone-env` loader registration
stays in place. `deploy.sh` must fetch the two new files into `$MODULE_STAGE`
before activation. No SHA pin changes are needed.

Copy the bodies from the frozen `scripts/fixtures/x3-zone-env/legacy-nodes.json`.
Replace only the summary's DB creation and assembly-module load with injected
`db` and `ZE`; its adapter retains the original open/load/failure order. Move
`loadEstimatedIrrigationByLocalDate` to the run file and inject its original
closure dependencies. The remaining code is retained verbatim, including auth,
compatibility DDL and caught failures. The injected Date constructor supplies the
clock without changing any date calculation.

## Verification sequence

1. Capture current-node outputs for both profiles with
   `TZ=UTC node scripts/test-x3-zone-env-parity.js --capture`.
2. Run the prepared adapters before exporting the facade. Confirm failure from
   the absent facade entry point. This is a wiring control, not a behavior fix.
3. Add the module files and deploy fetches. Run the same test with `--verify`.
   Run `--legacy` to prove the committed oracle still matches its frozen source.
4. Repeat on Node 20.18.3, and run
   `scripts/test-x3-zone-env-runtime.js` with Node-RED 3.1.15 and 4.0.9. These
   versions come from the feed Makefile and Release Runtime Smoke workflow.
   Both image profiles enable the node and node-red packages. The local image
   package manifest also reports Node 20.18.3-r1 and Node-RED 3.1.15-r1.
5. Compare old and new under `TZ=Europe/Zurich` as well as UTC. Today-liters uses
   process-local midnight; the environment date uses the zone timezone.
6. In GitHub CI, render the handoff to an external scratch tree. Run the flow parse, wiring,
   size, silent-catch, bare-require and full sync-flow gates on that staged result.
   The two repository flow files remain untouched until the dispatcher grants
   the reservation. Repeat those gates after applying the final adapter patch.

The CTO gate rule of 20 Nov moves full suites to GitHub CI on the exact head
SHA. Only characterization, parity and module tests run locally through
`osi-heavy`; `verify-x3-zone-env-handoff.js` runs the staged full gates in CI.
A verifier other than the implementer
must rerun the merge gate after reservation integration. The implementation PR
stays draft for the dispatcher and reviewer.

## Flows handoff

`scripts/x3-zone-env-adapters.js /absolute/scratch/directory` emits the exact
unified patch for both profiles, after checking a byte-identical JSON roundtrip
and exact source-body equality. If an earlier reservation changes an X3 node,
stop and re-characterize that new source before generating another patch.

All node IDs, output arities and wires are retained. Existing libs entries stay
in their original order. The only addition is
`{"var":"osiLib","module":"osi-lib"}` on `get-actuations-response`, which currently
has no bindings. The other three nodes already declare that binding. Phil
explicitly authorized this exception to the brief's libs-stability rule.

Missing measurements and measured zero remain distinguishable. Known defects,
including different volume event sources and ignored soil-depth selection on
this environment route, belong to EB9, EB11b and EB15. This extraction adds no
schema behavior and changes no authorization policy.

## Read and response contracts retained

| Handler | Reads and writes | Retained result rules |
|---|---|---|
| Environment | Auth storage or configured secret; optional scope user lookup; compatibility DDL; zone with gateway location; direct and shared weather stations; current and forecast cache; daily environment, recommendation and agronomy rows; valve expectations; linked-server user row; shared bundle | Full summary sections, CORS headers and existing error objects remain unchanged. Local observations remain alongside shared sections. |
| Today-liters | Bearer verification; optional scope lookup; expectation rows since process-local midnight | Exclude cancelled/stale and report-only rows. Sum by volume source, then return only the largest source total. No upper time bound is added. No usable estimate returns `liters: null, source: 'none'`; a usable zero remains zero. |
| Recent actuations query | Existing user payload; compatibility table creation; optional scope lookup; expectations joined to devices, zones and command results | Keep account-wide reads in scoped mode. Filter report-only rows before the 50-row limit. Keep cancelled, stale and refused command outcomes in history. Success uses output 1; failures use output 2. |
| Recent actuations response | Query rows and the injected clock | Keep every response field and null conversion. Cancellation precedes command failure, then observation state. Timeout requires strictly later than expected close plus 1800 seconds. |

Current weather uses `online_current_v2`; forecast uses `forecast_v2`. A live
entry avoids transport. Expired entries are refreshed, then served stale if
providers fail. Current TTL defaults to 30 minutes with a 5-minute minimum;
forecast defaults to 120 with a 10-minute minimum. Cache SQL, payload JSON,
observed/fetched/expiry timestamps and upsert order are part of the oracle.
The legacy cache keys are not revived. The existing conversion of absent flow
totals to zero is retained too; this extraction does not repair that policy.

OpenAgri acquires its token separately for current and forecast unless a static
token is configured. Current falls back to Open-Meteo. Forecast requests both
providers and retains the existing merge, including its missing-rain outcome.
A malformed, empty, non-success or timed-out provider response follows the same
caught-error paths as before. The shared bundle is read after local calculation:
5 minutes is fresh, and a failed fetch may use a cached bundle through 180
minutes. Cache age alone does not fix a bundle describing yesterday.

Measured flow and duration-derived volume remain separate in the current fields and
history. A missing irrigation-efficiency calibration produces the existing null
millimeter values. The environment route does not implement requested soil-depth
selection; the fixture supplies alternative readings and a missing requested
depth to freeze that behavior for EB11b.

Ordinary DB-owning response paths attempt one close. There are two legacy error
exceptions: a constructor failure acquires no handle, and an environment close
that throws is attempted again by the outer catch. The latter is deliberately
characterized as two attempts. It cannot be changed while claiming behavior
parity. Provider and compatibility-DDL catches retain their current diagnostics,
including silence where the old handler is silent.

## Squash and package-load follow-up

The lead's additional gate requires the oracle and handoff to survive removal of
all PR-only history. Keep fixtures in the tree, use exclusive evidence creation,
and defer extraction-module loading until a new entry point is requested. Test
loader failures through the real osi-lib package in both profiles and retain the
approved 503 adapter fallback. Register these tests and run parity and the
staged affected handoff from an independent clone of a local squash-equivalent
commit, whose only parent is in main ancestry and whose object store contains no
PR-only commits.

## Round 2: verify both handoff states

Detect the complete legacy or integrated adapter state, including full node
metadata and matching silent-catch/DDL recounts. Reject mixed nodes or stale
baselines. Compare the patch and renderer only in the legacy state; in the
integrated state verify committed files directly and run the same gates. Keep
baseline provenance idempotent. A disposable committed checkout applies the
actual patch, rejects partial/stale mutations and runs the post-swap normal,
native and squash checks. The reservation worktree remains unchanged.

Provider diagnostics retain the fixed provider/operation prefix and report only
an HTTP status and bounded reason. Preserve the original errors internally so
fallbacks, SQL/cache order and replies remain identical. Direct and native loader
checks must pin the query failure to error port 2 with its exact 503 payload;
wrong-port mutations must fail those checks.
