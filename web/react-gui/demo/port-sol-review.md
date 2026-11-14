# Sol review of the stage 1 port

Reviewed commit `5266d809b9` against base `103e4c547` on 2026-11-12.
The port may proceed to UX implementation with the required corrections below.
This is not final approval or a claim that all integration gates are green.

## Independent evidence

Sol ran the following serially through `osi-heavy`:

- Full demo model suite: 374 passed, zero failed or skipped.
- GUI typecheck: passed. Demo typecheck initially failed on the rain-source
  `flatMap` result inference. Sol added its explicit candidate type; the demo
  typecheck then passed. No request behavior changed in this correction.
- Schedule-dialog and shared-modal-hook Vitest files: 30 tests passed.
- Production build: passed. Build isolation: passed, 90 production files and
  17 public files.
- Firefox desktop native History CSV download: one test passed against a fresh
  public server. No CSV timing change is required solely by the historical
  review concern; retain this browser proof in the final gate.
- Documentation hygiene and whitespace: passed after replacing raw node IDs in
  Sol's plan review with their names. No allowlist exception was added.

An initial focused-Vitest invocation used the plan's obsolete `--minWorkers`
option and stopped before tests. Vitest 4 rejects that option. The corrected
command uses `--maxWorkers=2`; the plan commands are corrected accordingly.

Sol built a clean archive of base `103e4c547` with `npm ci --ignore-scripts` and
the same Node/toolchain. Both artifacts contain 90 files. Of these, 82 have
identical path and content. The seven changed hashed JavaScript filenames and
the entry HTML account for the rest. After normalizing only Vite filename
references, the main JavaScript entry is the sole differing artifact. CSS,
locale resources and other chunk bodies remain identical. This matches the
listed shared focus/order and null-zone display changes; it is not byte-for-byte
production equivalence. The existing CSS-minifier warning occurs on base too.

## Required corrections during stage 2

1. `cancelValveCommand` returns an empty object after cancellation. Main's
   `devicesAPI.cancelIrrigation` parses `status` or `outcome`; the empty object
   loses the outcome. Mirror the current `cancelHttpResponse` contract in the
   simulator, including cancellation distinctions that the public UI can reach.
   Add a test through the real API parser and a native queued-cancel browser
   test. Cancelling a record must not invent physical closure of a running valve.
2. The source carries 151 empty skipped browser placeholders in `actions`,
   `plans` and `triggers` specs, producing 453 project skips. Preserve their
   trace IDs in a coverage mapping. Retire only empty duplicate scaffolding
   where substantive model/browser tests supersede it. Implement required
   public workflows that remain uncovered, or explicitly restrict an
   unsupported action and test that boundary. Do not remove real assertions,
   disable a browser project or claim unexercised inventory rows are covered.
   Final public tests must have zero skipped cases.
3. UC512 registration currently succeeds without rendering a card; its test
   asserts that the new card is absent. That is an unusable successful action.
   Either provide an inspectable demo-scoped surface or refuse unsupported
   registration with clear feedback and no created invisible record. Keep
   production locale restrictions and capabilities wording accurate.
4. Reconcile stale imported documentation instead of appending contradictory
   amendments. `PRODUCTION-HOOKS.md` currently gives opposite dispositions for
   `IrrigationOutcomesPanel`; `controller-semantics.md` still claims ordinary
   busy requests return 409 after its superseding section says otherwise.
   Fix broken links to historical documents that were intentionally not imported.
   Keep historical provenance distinct from current behavior and remove unused
   public-advisory locale machinery if no rendered surface consumes it.
5. Finish the schedule-save feedback and nested-focus acceptance cases from
   the reviewed plan. Current tests cover opening and an initial reverse Tab;
   final keyboard tests must prove both ends, outside-focus containment, the
   nested confirmation and return focus. Preserve actuator request payloads.

## Next execution

Luna implements these corrections and Slices 5-12 of the reviewed plan, then
runs the integrated gate. Production command handlers, edge runtime and live
deployment remain out of scope. Sol will independently inspect screenshots,
run final gates and obtain the required non-author reviews before any handoff.
