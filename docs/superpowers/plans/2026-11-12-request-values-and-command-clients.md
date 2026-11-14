# Request values and command client ownership

Implement the lead architect's NEW-6/NEW-7 ruling: request values travel with the request, lookup results bind to those values, and each cloud adapter owns and closes its ChirpStack client. Add the sandbox collision and `with` guards requested by the same council.

Base: `main` at `88f6e84bb251a03034dc4a6e8fa8e3a10992a2e4`, after #631 and #632 merged. The branch was rebased from #631 at `4bd88bbc3c2cb0efcad362b8270e4fae7cb65476`. The test uses its own small HTTP/function/SQLite wiring walker and deterministic delivery latch. All data and transports are synthetic.

Risk classes: authorization, actuation, flows and sync-contract. The lead ruling authorizes implementation. The campaign prohibits implementation subagents; independent review, council approval and lead sign-off remain required before merge and are not claimed by this record.

## Reproductions

`node --test scripts/test-request-message-isolation.js` initially failed eight of ten delete/assignment interleavings. In both maintained profiles the first request is held at the SQLite lookup while the second runs through the shipped route. Cases include different actors, two requests by one actor, and each assignment lookup boundary.

The audit expanded the same class to device registration, zone creation and account linking. Before their edits, creation tests failed four of four cases; account-link construction selected the second request's server for the first request in both profiles. Logs are retained in the campaign's W1 scratch directory.

The resource fixtures in `scripts/test-conditional-irrigation-adapters.js` initially failed ten of ten cases with one client created and zero closed, including a database-constructor exception. The sandbox collision fixture initially accepted a `util` library variable.

## Changes

For both bcm2712 and bcm2709 payloads:

- `delete-device-auth` keeps normalized `msg.deleteDeviceEui` beside its existing authenticated message fields. `routes.deviceUnclaim` reads only those fields, checks the user lookup against the authenticated actor and retains transaction ownership checks. The obsolete response formatter also reads the message.
- Assignment auth keeps its existing authenticated message fields. `legacyAssignVerifyZone` captures normalized zone/device values from that message's HTTP request into `msg.osi.request` and checks the actor lookup. `legacyAssignVerifyDevice` binds the returned zone ID and owner to that envelope and attaches its fetched identity. `deviceAssign` binds the returned device row and uses only this envelope for the mutation. The old response formatter reads the same envelope. Thin adapters call the existing registered policy helper so these nodes shrink.
- Device onboarding carries normalized registration inputs, actor ID, claim response and provisioning result in `msg.device`. The user lookup must match the captured actor. Zone creation similarly carries name, timezone, actor and created UUID in `msg.zone`; the final zone lookup includes that actor. Preserve registration fences, generation handling and local transaction ownership checks.
- Account linking carries transient local/cloud identities, selected server, attempt data and returned credentials in `msg.link`. Clear only this message's transient state. Keep durable attempt/nonce checks, identity preflight, rollback, and shared runtime link-status flags. Remove the unused status-username and actor-user-UUID context writes.
- Extract only stages that otherwise grow into existing `osi-irrigation-policy/routes.js` or `osi-installation-helper/index.js`; no new runtime module or deployment file. Extracted URL guards retain the Node-RED 3.1.15 fallback through a local undefined URL binding. Convert every touched empty catch to a warning and ratchet the count down. Refresh the account-link validation pin with a measured explanation; preserve all other protected identity code.
- General cloud lifecycle and policy adapters use the existing lazy transport factory. An outer finally owns transport closure even if database construction fails; the original inner finally still closes SQLite after awaited mutation and post-commit work. No shared external client is closed.

The checker rejects library aliases colliding with sandbox globals, intrinsic globals, wrapper names or a previous alias in that node. Enable ESLint `no-with`, with regression fixtures. Remove the two URL exceptions when those functions move into helpers; leave other exceptions intact.

## Audit and verification

Audit all context writes and reads, including computed keys, in both maintained flows and the helpers that consume their values. List every request-value family with writers, readers, asynchronous boundary and disposition in the report. Shared service coordination, counters and persisted worker status remain shared state. The separate older bcm2708 profile is inspected and reported separately from the two maintained images.

Run one suite at a time. Required evidence:

- `node --test scripts/test-request-message-isolation.js`
- `node --test scripts/test-conditional-irrigation-adapters.js`
- `node --test scripts/verify-flows-sandbox.test.js` and `node scripts/verify-flows-sandbox.js`
- Existing device delete/assignment, lifecycle route, scoped-write, account-link, gateway attribution, registration and entity-name fixtures, with direct component inputs changed to explicit message state.
- Profile parity, wiring, parse, size, silent-catch, stray-DDL, helper/deployment coverage, documentation hygiene, test-inventory and full sync-flow gates.

Expect green interleavings with responses and writes bound to each request, created/closed client counts equal after completion and failures, and no new flow-growth exception. Retain before/after logs. Open a separate follow-up PR, describe how request values remain with their request, state authorization/actuation risk, and leave merging to the steward.
