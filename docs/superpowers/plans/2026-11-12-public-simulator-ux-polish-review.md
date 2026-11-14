# Sol review of the public simulator v2 plan

Reviewed against main `103e4c547` on 2026-11-12. Verdict: approve with the
amendments below. Opus authored the plan; Sol checked source and owns these
corrections. Luna executes product changes. No product code was changed during
this review.

## Required amendments

1. D5 and Slice 4 conflate the unqualified conditional-policy API with the
   legacy daily scheduler. Main still has the daily 06:00 path: flow nodes
   "Schedule time", "Build zones query (enabled schedules)" and
   "Decide + build actuator cmd + build DB logs" in the canonical flows file.
   The zone query excludes zones with a nondeleted irrigation policy; it does
   not remove legacy scheduling. Preserve supported legacy simulation at its
   daily opportunity, with current source-linked eligibility and debounce.
   Keep conditional-policy qualification false and reject unqualified
   activation as main does. No threshold-crossing immediate dispatch. Replace
   the blanket claim that no simulated automatic dispatch exists. Demonstrate
   legacy automation only where parity has been established, explaining its
   daily cadence and the distinct conditional-policy limitation.
2. Slice 4 step 5 must distinguish an externally opened valve from a timed
   run. A second timed-open command must not invent a timer for an externally
   opened valve. An existing timed run must still close at its original end;
   a second ignored open must not extend it or remove its timer. Derive these
   cases from `scripts/test-valve-v081-equivalence.js` and its oracle. Preserve
   ordinary command acceptance and queue cancellation from current main.
   Replace the old simulator's manual-busy refusal where it contradicts main.
   Never expose bare CLOSE as the normal timed-close path.
3. Reuse `src/hooks/useModalFocus.ts` for the outer schedule modal rather than
   creating another trap. Preserve the nested delete confirmation's ownership,
   Escape behavior and return focus. Test the nested surface with real user
   events. If the shared hook and the existing confirmation trap interfere,
   make the smallest integration change and prove both surfaces. Do not alter
   valve command handlers or payloads for a focus/layout change.
4. Use this existing T3 worktree and branch. Do not run Slice 0's branch-switch
   command or create shell worktrees. Import source objects under the local
   namespace only. Do not publish the original branch or its private review
   history. The existing transfer bundle provides preservation for this task;
   creating an external archive ref is unnecessary and remains out of scope.
5. Deliver one implementation PR with ordered commits, not four simultaneously
   stacked PRs. Run the port gate before starting UX work, and review the final
   integrated result. This avoids a four-layer stack and uncertain dependencies
   between the port, shared GUI fixes and visitor experience.
6. The recovered sandbox and simulated command model make the overall change
   a risk-class integration (`auth`, `actuation`), even though no edge commands
   or live authentication may be changed. Sol reviews the plan and execution;
   council and independent lead sign-off are final merge gates. No source-only
   or self-reported green result is sufficient. Required artifact and browser
   gates must run independently of Luna before approval.
7. A four-character hex substring is insufficient build-isolation evidence.
   Check full demo identifier prefixes, distinctive runtime/session markers
   and actual source/import boundaries. Preserve the existing stronger checks.
   Compare production output with a same-toolchain main baseline; document any
   approved shared GUI differences. Runtime flags must be compile-time false
   in production. Do not weaken a check merely to allow imported code through.
8. Do not import an entire documentation directory. Import only the three
   website files listed in Owned paths and the release runbook. Audit the
   demo-directory import for main-only files and restore main's additions.
   Keep main's dependency versions, lockfile, locale policy and valve tests.
   Every production file changed by the source gets an explicit disposition.
9. New simulator-only host and guide Luganda may follow the historical
   simulator-only authorization, with the unreviewed notice. Keep main's
   explicit pending-human families in English and production locale resources
   unchanged. Do not claim full Luganda coverage; enumerate retained fallbacks.
10. Port model behavior against actual route responses. A source route-inventory
    test is useful only if it understands method, dynamic segments and callers.
    It must not turn into a second guessed API specification. Maintain explicit
    unsupported actions and targeted rendered-UI contract tests for each public
    workflow. Evidence may come from an actual handler when no fixture exists;
    record that provenance rather than inventing a fixture or stopping solely
    because a route lacks a test.
11. Importing an incomplete historical candidate does not authorize hiding
    failures. Reproduce baseline failures and fix in-scope incompatibilities.
    Ordinary browser/infrastructure failures are diagnosed and retried with
    evidence, not a two-attempt automatic stop. Stop on a domain contradiction
    or a necessary out-of-scope safety change. Preserve all original tests,
    update obsolete expectations only with source-backed explanations, and
    report skipped or unavailable checks as incomplete.
12. No live site edit, upload, analytics service installation, external archive
    push or fabricated destination is authorized. Produce a versioned local
    website package and release instructions. Existing page/browser inspection
    is authorized; test all new UX in the built local app. Automated and manual
    visual checks are separate evidence. Public docs use generic deployment
    descriptions and synthetic identifiers throughout.

## Execution boundaries

First execution task: source port and compatibility (Slices 0-4), including
the shared schedule focus/order repair, build isolation and provenance. Commit
small coherent units; do not push, file a PR or publish. Return at the port gate
with exact checks, failures and deviations so Sol can inspect before UX work.
All heavy checks use `osi-heavy`, serially, with at most two workers.

Second execution task, after Sol's port review: Slices 5-12 and their tests,
then the integrated Slice 13 gate. Keep every requested UX item either delivered
or explicitly disposed with evidence. Do not call an incomplete port green.
