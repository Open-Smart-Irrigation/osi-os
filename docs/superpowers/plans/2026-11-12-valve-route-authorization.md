# Valve route authorization repair

The valve schedule and settings API must enforce the manual command path's current
effective policy: fresh scoped access followed by device ownership. The owner
decided on 2026-11-12 that a zone grant does not permit operating another user's
valve.
This patch grants nobody new access.

## Scope and implementation

The canonical module directory is
`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/`.
Mirror every changed file to the matching bcm2709 directory.

1. Add request tests to `api.test.js` that run the shipped flow adapter with real
   temporary SQLite databases and synthetic users, zones and grants. Cover every
   valve route, disabled accounts, missing and viewer roles, absent/wrong/revoked
   zone access, valid owner grants, and the present non-owner refusal. Keep the
   flag-off owner path unchanged. Run these tests against the unchanged base first.
2. In `api.js`, obtain the current user by token user ID and username. With scoped
   mode enabled, reuse `osi-scope-helper.assertFreshDeviceAccess` and `canMutate`
   before the existing owner check. Reuse that sequence at existing transaction
   checks. Take the valve writer before the scheduler-status recheck. The list
   route checks the current account and returns only its owned, accessible valves.
   With the flag on, an owner's valve in no zone is omitted from the list and
   answers 404 on the per-valve routes, as at the command boundary.
3. In `live-transport.js`, forward `OSI_SCOPED_ACCESS` into the API environment.
   Resolve scope only when this flag is exactly `1`, preserving the flag-off path.
4. Run the API tests, the valve module suite serially, profile parity, helper
   registration, test inventory, documentation hygiene, and whitespace checks.
5. File an authorization-only PR. Leave it unmerged for independent risk-class
   review and lead sign-off. Do not change command builders or zone routes.

## Evidence and review status

At base `1bdd49d5`, the new 71-case authorization subset had 48 failures and 23
passes. The failures were successful responses where fresh scope should refuse
the request, or inaccessible valves present in the list. With the implementation,
the complete API file passed 97 tests.

The implementation follows the campaign's explicit ruling to retain both existing
authorization stages. Independent review and lead sign-off remain outstanding;
the campaign prohibits implementation writers from starting subagents or merging.
