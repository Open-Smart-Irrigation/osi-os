# Valve save outcomes and HTTP error handling

A committed schedule change must remain visible as saved when delivery fails. Keep
the stored plan authoritative and report unconfirmed delivery separately. Existing
queueing and retry behavior stays unchanged.

## Implementation sequence

1. Extend the valve API tests with failed transport on weekly create, update and
   delete, plus settings generation and scheduler-status writes. Assert the real
   stored state and the returned outcome. Observe these fail on `1bdd49d5`.
2. Track completed schedule/settings commits in `osi-valve-control/api.js`. After
   such a commit, preserve a successful saved response with `saved: true` and
   `delivery_status: unconfirmed` when the later delivery step fails. Preserve
   ordinary errors before commit. Keep plan resend failures as failures: resend
   does not save a new schedule. Do not claim radio delivery on a successful queue.
3. Normalize the saved outcome in `web/react-gui/src/services/api.ts`. Show a
   persistent saved-but-delivery-unconfirmed notice in the schedule dialog, reload
   the authoritative list and clear completed edit/create forms. Distinguish a
   post-save refresh failure from a failed save. Apply the same notice to valve
   settings and scheduler-status controls.
4. Add scoped catch wiring for the valve HTTP router with standard catch, switch
   and change nodes. Return a generic JSON HTTP 500 without exposing exception
   text. Ignore messages without a response handle and avoid double responses
   when the helper already handles an error. Test injected exceptions through
   the shipped routing graph. Use standard nodes so embedded JavaScript does not
   grow and no growth exception is needed. Classify the standard change node as
   an internal message transform in the scoped-access graph verifier.
5. Mirror payload changes to bcm2709. Run the valve module suite, GUI tests,
   typecheck/build and the required flow gates serially. Stack this PR on the
   authorization PR: both change the scheduler-status call in the API router.

## Review boundary

This is risk-class actuator and flow work. Independent review and lead sign-off
remain pending. The implementation writer may not start subagents or merge. No
live gateway or deployment is part of this verification.
