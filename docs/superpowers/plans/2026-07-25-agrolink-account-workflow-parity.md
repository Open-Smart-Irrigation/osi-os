# AgroLink account workflow parity plan

**Date:** 2026-07-25
**Status:** Approved
**Repositories:** `osi-os` and `osi-server`

## Rebaseline

Current route and service inspection leaves one portable account workflow open:
support-request submission and status history.

The other account surfaces are already complete or deliberately split:

- login and registration remain separate on edge and cloud;
- edge user, role, password-reset, and grant administration converges through
  the scoped-access work from Tasks 6 and 7;
- cloud self-service password changes already issue the linked-auth command;
- edge account linking remains an installation-local operation;
- edge diagnostics require local gateway state and are not available to the
  cloud browser;
- work-request triage, quarantine, and GitHub publishing remain cloud operator
  workflows.

The canonical farmer workflow is the edge
`/api/improvement-requests` route and `/support-requests` page. An edge request
is durable locally before its `WORK_REQUEST_SUBMITTED` outbox event reaches the
server.

## Product decisions

1. Add authenticated cloud routes under
   `/api/v1/support/work-requests` for list and submit.
2. Require submission against a currently linked, enabled gateway. Any
   per-gateway role may submit support because this does not read farm data or
   cause a physical effect.
3. Derive the cloud submitter identity from the authenticated user. Ignore
   caller-supplied gateway, provenance, request ID, and user identity.
4. Store direct cloud submissions with `CLOUD_ACCOUNT` provenance and the
   stable private reference `cloud_user_id:<id>`. Edge-delivered submissions
   retain `LINKED_SYNC`; the two account histories do not merge because
   separate accounts remain the default.
5. List only direct requests owned by the authenticated cloud account. A
   user keeps access to requests they submitted even if the gateway link is
   removed later.
6. Reuse the existing intake validation, redaction, rate limits,
   classification, status transitions, and operator queue. Do not create a
   second work-request store.
7. Do not emit an edge sync event or pending command for a direct cloud
   submission. Support requests are account workflow records, not canonical
   farm state.
8. Do not collect or imitate Pi diagnostics from the cloud. The cloud page
   states that gateway diagnostics are available only when submitting from
   OSI OS.
9. Add a cloud `/support-requests` page, an account-menu entry, and a settings
   entry point. Preserve the edge request types, areas, severities, public
   sharing consent, validation bounds, and status vocabulary.
10. Keep cloud operator triage and publication routes unchanged.

## Implementation order

### Slice A: server account-scoped intake

1. Add failing service tests for server-owned identity, linked-gateway
   enforcement, disabled membership, provenance, and account-owned listing.
2. Add failing controller tests for authentication, accepted submission,
   validation failure, rate limiting, and cross-account isolation.
3. Add the narrow account support service and controller around the existing
   intake service.
4. Extend the repository with the owner-scoped query and allow the
   `CLOUD_ACCOUNT` provenance.
5. Run the focused work-request and architecture suites.

### Slice B: cloud farmer UI

1. Add failing API, route, form, gateway-selection, consent, status-list, and
   hardware-diagnostics classification tests.
2. Add the support types, service client, page, route, account-menu entry, and
   settings link.
3. Add all seven locale files and a key-parity test.
4. Run focused frontend tests, the complete frontend unit suite, and the
   production build.

### Slice C: parity evidence

1. Re-run the canonical edge work-request schema, flow, scoped-read, UI, and
   sync gates.
2. Run the complete server backend and frontend suites within the program's
   memory limits.
3. Review both implementations for caller-controlled identity, cross-account
   reads, accidental farm sync, secret exposure, and invented diagnostics.
4. Update the parity matrix and execution report with exact pushed SHAs and
   verification results.

## Acceptance criteria

- A linked cloud user can submit the same portable request fields as an edge
  user and immediately see the created request.
- Submission fails for an unlinked or disabled gateway.
- The server, not the request body, chooses request ID, provenance, gateway,
  submitter identity, and submission timestamp.
- A cloud account cannot list another account's direct requests.
- Edge requests keep their durable outbox path unchanged.
- Direct cloud requests enter the existing operator queue without an edge
  command or sync event.
- Cloud UI does not claim to collect gateway diagnostics.
- All seven supported locales have the same support key set.
- Focused and complete verification is green before row 5 is marked
  `parity`.
