# X2 preparation evidence

X2 adds thirteen entry points to `osi-valve-control`. Neither maintained `flows.json` is edited. The exact adapter replacements are in `scripts/fixtures/valve-ingress-x2/adapters.json`; `scripts/apply-valve-ingress-x2-adapters.js` checks the original source hashes and node contracts and defaults to a dry run.

The source fixture is pinned to ec822b556. The branch was later fast-forwarded to 1a984f31f, whose only change is the restore runbook. No executable source or test changed in that base update. Startup was READY at ec822b556, behind 0/ahead 0 against `origin/main`, with AGENTS.md revision c63103827.

## Behavior comparison

The frozen corpus has 554 cases per profile. Every case compares the original node, the currently shipped node, and the proposed adapter plus module. It records all returned ports, the mutated message, exact SQL and JSON payload strings, dependency calls in order, thrown error name/message/status, diagnostics and cloned request/response identities. The clock is fixed. A comment naming a customer is normalized in the new copies; original-body SHA-256 pins still detect any change to the shipped source.

The router's 22 top-level branches are copied whole. Its non-valve branches live in `command-routing.js`. The remaining copied bodies are checked verbatim, including their original directive mode. Existing silent fan-probe and cancel-close catches remain because changing their diagnostics would break this extraction's parity rule. K3 PR #697 supplies case names only.

| Observed case | Before | After |
| --- | --- | --- |
| Cloud open, 61 seconds with competing minute fields | Port 0, `OPEN_FOR_DURATION`, 2 minutes | Identical |
| Cloud timed CLOSE | Port 2 ACK, `REJECTED_PERMANENT`, `valve_action_not_allowed` | Identical |
| UC512 open | Port 2 ACK, `no_dispatcher_on_gateway` | Identical |
| SDI-12 identify | Ports 1 and 6 | Identical |
| Valve schedule bridge | Port 5 | Identical |
| Manual builder | Command on port 0; other ports null; 202 reply deferred; top-level HTTP handles retained | Identical |
| Cancel after possible handoff | 409, `actuation_handed_off`, outcome `handed_off`, collateral retained | Identical |
| Cancel with uncertain transport | 503, `transport_uncertain`, uncertainty retained | Identical |
| Reboot process failure after return | Success ACK already built; queued callback error remains separate | Identical |
| Run-log SQL, including percentage and return position | Exact SQL text and escaping retained | Identical |

The HTTP characterization also follows the shipped downstream graph through Node-RED-style cloning. Its 204 cases pass with the original functions and again with the proposed adapters. They distinguish 202 acceptance, 422 definite enqueue rejection, 503 local-preflight or unknown outcomes, missing queue IDs and failures after a transport attempt. Refusals do not write success logs or target state. An earlier ordinary open still permits another ordinary open without a gateway-added expiry; an unresolved conditional occurrence still refuses it as busy. Cancellation adds no physical CLOSE command; existing collateral requeue behavior remains.

The new outer loader guard has separate failure tests. HTTP adapters return one refusal on their existing response port. Its diagnostic omits the message argument so it does not also enter the HTTP catch lane. Existing internal loader failures retain their original results. Cancel keeps one lazily created client per request, reused by its callbacks, with the handler's existing lack of disposal. The separate cached valve-router client and its disposal code are untouched.

## Runs

| Check | Result |
| --- | --- |
| Frozen baseline, before module creation | 554 cases x 2 profiles, identical; Node 22.23.1 |
| Original versus module and proposed adapter | 554 cases x 2 profiles, identical; Node 22.23.1 |
| Comparator negative control | Expected exit 1 when a routed duration is changed to 999 |
| Entry-point API before extraction | Expected failure: `routeCommand` absent |
| New entry-point tests after extraction | 16 passed across both profiles |
| Real Function nodes, Node 20.18.3 / Node-RED 3.1.15 | 554 cases x 2 profiles x before/after, identical; emitted ports and HTTP identities checked with two receivers per port |
| Real Function nodes, Node 20.18.3 / Node-RED 4.0.9 | Same corpus and result |
| Valve module tests, including both new profile tests | 935 passed, 0 failed |
| HTTP characterization with shipped functions | 204 passed, 0 failed |
| HTTP characterization with proposed adapters in memory | 204 passed, 0 failed |
| Profile parity | Passed |
| Helper registration | Passed |
| Adapter dry run | Both profiles: 1,919,901 to 1,828,280 bytes; no file written |
| `bash -n deploy.sh` | Passed |
| Documentation hygiene | Passed with built-in patterns; private name list not supplied |

The image Node-RED version comes from its feed Makefile. Both profiles enable Node and Node-RED. The packages-feed commit in `feeds.conf.default` specifies Node 20.18.3. Release Runtime Smoke pins that same Node version, Node-RED 3.1.15 for images and 4.0.9 for the stock deploy path. These were local software-runtime tests, with fake filesystem/process/radio adapters and no live commands.

Full sync, migrations, smoke and shell-fixture results come from GitHub CI on the exact PR head, per the CTO's updated gate rule. The queued local wrapper containing those suites was cancelled before running. Existing command-safety/equivalence checks run with the proposed adapters in the new CI workflow; existing deployment tests check the eleven added fetch entries. The staging list changes no deployment pins or activation logic.

Full side-by-side JSON traces and command logs are retained locally under `/home/phil/builds/osi-v082-fix-20261112/plan-0.9/evidence-X2/`. `before.json`, `differential.json`, `runtime-image.json` and `runtime-stock.json` carry the comparison outputs. `regression-results.json` lists the exact focused commands and exit codes. CI uploads its own comparison JSON as artifacts. Two harness issues were corrected before acceptance: duplicate case names overwrote a hash, and Node-RED `setFlows` returns before asynchronous startup, so the real-runtime harness now waits for `flows:started`.

## Time record

These are measured elapsed windows from timestamped work and gate artifacts. Preparation was interleaved, and admission waits are included, so the rows overlap and must not be added as focused engineering hours. A separate active-hour split was not captured.

| Part | UTC window | Elapsed hours |
| --- | --- | ---: |
| Characterization and runtime parity | 19 Nov 23:44 to 20 Nov 01:03:18 | 1.32 |
| Module preparation through its test result | 19 Nov 23:52:21 to 20 Nov 01:04:18 | 1.20 |
| Adapter preparation through HTTP parity | 19 Nov 23:53:08 to 20 Nov 01:04:51 | 1.20 |
| Flows reservation | Not granted or used | 0.00 |

The total preparation/validation window was 1.35 hours. Module files were generated at 00:58:02 after the corrected pre-extraction baseline passed; the first new-entry gates completed at 00:58:03. This preparation does not measure exclusive flows occupancy or validate the proposed reservation-duration estimate.

## Dispatcher handoff

X1 must merge and the dispatcher must grant X2 the reservation before applying adapters. Five nodes need an added `osiLib` binding; all existing bindings remain. The manifest lists every node ID and exact replacement body and `libs` value. IDs, output counts and wires are preserved. Reconcile this necessary binding addition with the extraction brief's stable-libs wording during the adapter review.

After updating to the X1 base, rerun the source-pinned dry run. It refuses changed bodies, tabs, node types, ports, wiring or bindings. During the granted window, apply both profiles and rerun the parity and flow-editing gates. No migration, schema change, K3 behavior change or registry/fallback consolidation is included. Independent Sol review of dispatch order, queue state and refusal paths remains pending; this implementation sub-agent does not request it or mark the draft ready.
