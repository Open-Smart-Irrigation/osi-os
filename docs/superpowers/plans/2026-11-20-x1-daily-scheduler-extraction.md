# X1 daily scheduler extraction

Prepare six legacy scheduler and schedule-save nodes for extraction without changing either shipped flows file. The dispatcher owns the reservation, after EB19. This draft must not merge until adapter integration and a Sol review of dispatch order, queue state and error paths.

The implementation brief and extraction proposal in the release planning directory govern this package. Startup readiness is READY at `ec822b556`; intended base `origin/main`, behind/ahead 0/0, AGENTS revision `c63103827`.

## Implementation

1. Pin the six current node bodies in `scripts/fixtures/daily-scheduler/legacy-nodes.json`. Drive them through `scripts/lib/daily-scheduler-harness.js` with a fixed clock and record output ports, message mutations, SQL, diagnostics, dependency calls and thrown errors in `expected.json`. Run `node scripts/test-daily-scheduler-parity.js --record` before moving logic.
2. Copy the bodies into `osi-daily-scheduler/queries.js`, `decision.js` and `schedule-save.js` in both runtime profiles. Export the existing UTC `sameLogicalWindow` function from the decision file. Inject the Date constructor and Node-RED dependencies. Keep SWT SQL in `osi-scheduler-mean-query` and keep persistence separate from evaluation.
3. Register `daily-scheduler` in both loaders and loader tests, runtime manifests and seed-copy lists. Add the module files to deploy staging without changing any digest pins.
4. Prepare exact thin adapters in `scripts/fixtures/daily-scheduler/adapters.json` and a guarded scratch-copy preparation script. Preserve IDs, output counts, existing libs and wires; add only the osi-lib binding to nodes that lack it. Keep request state on `msg.osi.request`.
5. Run the same cases against the pinned bodies, current shipped bodies, direct module calls and staged adapters for both profiles. Run them inside real Node-RED 3.1.15 and 4.0.9 Function nodes using Node 20.18.3, the release smoke pins. Change the clock-jump test to call the exported helper and exercise the staged adapter.
6. Run X1 characterization/parity, clock and module tests locally. GitHub CI on the exact PR head gates the full suites, including sync, migration, smoke and shell fixtures, under the CTO gate rule of 20 November. Register the new tests in CI. Record command exits and measured wall time by work category. Open a draft PR with the exact flows handoff. Independent review and the reservation window remain with the dispatcher.

## Preserved behavior

The UTC-day suppression, local/server-preferred recommendation choice, conditional-policy exclusion, early IRRIGATE event/update before dispatch acceptance, and first-save event defect remain. No schedule or actuator behavior changes are authorized by X1. Characterization fixtures use synthetic identities and local dependencies only.
