# X2 valve ingress extraction

X2 prepares thirteen valve/router/log entry points without taking the flows reservation. The original function bodies are frozen in `scripts/fixtures/valve-ingress-x2/baseline.json` from main at ec822b556. A comment naming a customer is normalized to a generic label in the new fixture and copies; original-body SHA-256 pins still check the actual shipped source. X1 must settle its interface and merge before the dispatcher grants X2 its adapter window.

The extraction preserves dispatch decisions, auth checks, exact SQL and ACK text, port positions and deferred HTTP replies. K3 PR #697 supplies case names; its proposed behavior is outside this patch. Existing transport, reservation, expiry and cancellation modules remain the implementation of physical dispatch.

## Execution

1. Freeze node bodies and metadata. Run `scripts/test-valve-ingress-x2-parity.js --record-baseline` before creating entry points, then run `--baseline-only` against those frozen hashes. Capture the entire message, every output, thrown errors, dependency calls in order and cloned HTTP identities under a fixed clock.
2. Copy each body into an ordinary exported function in `osi-valve-control`, retaining its internal control flow. Split the router's sensor/system/registration branches into `command-routing.js`; leave its valve branches in `command-ingress.js`. Inject the former Node-RED globals explicitly. Keep auth implementations separate so this patch does not consolidate or revise them.
3. Export the new functions from the existing package. Mirror every module byte-for-byte to the second profile. Add the eleven new files to the existing `deploy.sh` staging list so script upgrades can load the package. Keep its pins and activation logic unchanged. Do not change transport files, command registry, migrations, GUI or either flows file.
4. Build a guarded adapter manifest and an exact apply script. Tests apply it in memory. The apply script checks every original node body and metadata before preparing both profile results, and requires the dispatcher's explicit reservation flag before writing either file. Existing external-module bindings remain; nodes without an `osiLib` binding need that one addition. This is necessary for the required guarded loader and is the only intended `libs` delta.
5. Compare each case against its frozen output hash, the original node and the proposed adapter. Run the same cases with real Function nodes on Node 20.18.3 with Node-RED 3.1.15 and 4.0.9, the image feed and release-smoke pins. Compare both profile payloads. Use the existing Node-RED clone emulator and actual runtime fanout to preserve top-level `req`/`res` references.
6. Run the valve module tests and X2 parity/HTTP characterization locally. The CTO's 20 November gate rule makes GitHub CI on the exact head the gate for full sync, migrations, smoke and shell fixtures. The existing command-safety/equivalence regressions and staged-payload/fetch-list checks run in CI. Local focused harness/suite runs still use `osi-heavy`. Save commands and outcomes in the evidence. Do not queue CI's full suites locally.
7. Commit the module/tests/adapter handoff and open a draft PR. The lead supplies the required independent Sol review of dispatch order, queue state and refusal paths. Do not request review, mark ready or merge as this implementation sub-agent.

## Reservation handoff

Before applying adapters, update from the merged X1 base and rerun characterization. A changed original node causes the apply script to refuse; reconcile and review that change before refreshing a source pin. After the dispatcher grants the window, apply both adapters and rerun differential parity plus every flow-editing gate. Static source-location guards may need to follow the extracted functions at that point; keep their behavioral assertions intact.

The module copies preserve existing silent fan-probe and cancel-close catches because the extraction brief requires identical diagnostics and error paths. A later behavioral change can revise those diagnostics. No shared flow or context receives request data. Cancel constructs one client per request, lazily caches it for that request's callbacks, and retains the existing lack of disposal in that handler; the separate cached router transport stays untouched.

## Measurement

Record actual wall time in four categories: characterization, module, adapter patch, and reservation window. Queue/install time is reported separately. The reservation window remains zero until granted. This draft cannot pass the final merge gate until the actual adapters and their independent review are complete.
