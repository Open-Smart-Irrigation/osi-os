# AgroLink history, analysis, export, and settings parity plan

**Date:** 2026-07-25
**Status:** Complete
**Repositories:** `osi-os` and `osi-server`

## Current behavior

The canonical edge exposes zone and gateway history cards, card data,
advanced fields, per-card preferences, opened-card tracking, saved history
workspaces, zone CSV export, analysis channels and series, and saved analysis
views. The cloud exposes the same portable reads and writes, plus two portable
operations that the edge does not yet expose:

- account-wide history CSV export;
- deletion of a saved analysis view.

The cloud export currently resolves requested dates at UTC midnight. The edge
resolves each zone's dates in that zone's configured timezone. The edge rule
is canonical because those boundaries also define local history days and
rollups.

The edge `/settings` page mixes three kinds of behavior:

- browser-local presentation preferences;
- bulk schedule deactivation, already governed by the Task 8b schedule
  contract;
- support-request submission, handled as a separate account workflow.

Only the browser-local presentation preferences belong in this slice.
Settings remain browser-local and do not create sync events, desired state, or
pending commands.

## Product decisions

1. Add `GET /api/history/export.csv?scope=allZones` on the edge. It exports
   only zones visible to the authenticated edge account, uses the existing
   tidy CSV schema, preserves source identity and SWT-derived pF rows, and
   resolves each zone's date range in that zone's timezone.
2. Add `DELETE /api/analysis/views/:id` on the edge. Deletion is scoped by
   authenticated user ID and returns not found when the user does not own the
   view.
3. Change cloud history export date handling to match the edge: each catalog
   entry uses the timezone of its mirrored zone for both raw bounds and
   aggregation.
4. Add a cloud `/settings` route for portable browser-local preferences:
   language, light/dark/system theme, SWT display unit, dashboard
   auto-refresh, and display-only module visibility. These preferences use
   the same `osi.*` browser keys as the edge so behavior is stable when the
   same browser opens either deployment.
5. Apply portable settings to real cloud consumers. Theme initializes before
   render, dashboard polling honors auto-refresh, SWT readings use the shared
   formatter, and module preferences control the matching dashboard sections.
6. Do not copy edge-only behavior into cloud settings. Hiding the schedule
   module must not silently deactivate schedules; schedule mutations continue
   through the Task 8b desired-state workflow. Journal capture detail stays
   with the edge capture templates until the cloud uses that capture flow.
   Support-request submission is handled in Task 8 row 5.
7. Saved history workspaces, card preferences, and analysis views are
   presentation state local to each deployment. They do not enter the farm
   sync contract.

## Implementation order

### Slice A: edge export and analysis-view lifecycle

1. Add failing helper tests for account-wide export ordering, zone selection,
   per-zone timezone boundaries, and owner-scoped analysis-view deletion.
2. Add helper functions for all-zone export and analysis-view deletion.
3. Add failing route-contract tests for the new GET and DELETE routes.
4. Update both maintained flow profiles through a deterministic flow-editing
   script, then update the edge analysis API hook and UI tests.
5. Run focused helper, router-contract, profile-parity, sync-flow, frontend
   unit, and frontend build gates.

### Slice B: cloud export semantics

1. Add failing service tests proving Europe/Zurich local-day bounds and
   timezone-aware aggregation.
2. Resolve each mirrored zone's timezone and apply it to raw and aggregate
   export requests.
3. Add controller evidence that the account-wide route remains authenticated,
   scope-limited, and emits the same tidy CSV columns as zone export.
4. Run focused backend tests and the architecture gate.

### Slice C: cloud portable settings

1. Add failing preference, settings-page, dashboard-refresh, module-visibility,
   theme-bootstrap, and SWT-rendering tests.
2. Add the shared display-preference module and settings page.
3. Register `/settings`, add the dashboard entry point, initialize theme, and
   wire the tested consumers.
4. Run focused frontend tests, the complete frontend unit suite, and the
   production build.

### Slice D: parity evidence

1. Re-run the edge history contract/helper/scoped-read suites.
2. Run the complete server backend and frontend suites within the program's
   memory limits.
3. Review both full diffs against the edge-authoritative and scope rules.
4. Update the parity matrix and execution report with route evidence,
   classifications, tests, and exact pushed SHAs.

## Acceptance criteria

- Both deployments support zone and account-wide tidy CSV export.
- Date-only export bounds represent each zone's local calendar days.
- Both deployments support list, save, update, and delete for saved analysis
  views with user ownership enforced.
- History and analysis reads remain limited to the authenticated user's
  visible zones.
- Missing measurements stay absent or null; no display or export path invents
  numeric zero.
- Cloud settings alter only the documented browser-local presentation
  behavior.
- No new sync event or pending command is introduced for presentation state.
- Edge maintained profiles remain byte-identical.
- Focused and complete verification is green before the matrix row is marked
  `parity`.
