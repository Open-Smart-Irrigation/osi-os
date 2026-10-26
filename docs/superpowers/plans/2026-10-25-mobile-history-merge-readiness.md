# Mobile history Slice 1 merge-readiness plan

## Verdict

The product changes have no remaining code-review blocker. The documentation-hygiene fix is complete at edge commit `f22f7e460`, and the follow-up issues are filed as cloud #390 and edge #516. Edge still needs the test-only Journal clock prerequisite below before its fresh PR gates can be treated as deterministic. Cloud can be reviewed in parallel, with the merge-order constraint described below.

The existing cloud `AnalysisGrid` subsecond rounding defect does not block merging this default-off internal route. It blocks enabling the feature in a production build. Both route and diagnostics gates require literal build-time flags, default builds exclude the lazy route, and the final off-build browser cases passed. The defect therefore belongs in a linked blocking follow-up issue and the rollout gate, not in this implementation PR.

## Required before opening the edge PR

1. Keep the narrow entry added to `scripts/verify-doc-hygiene-allowlist.json`:
   - path: `docs/superpowers/plans/2026-10-24-mobile-history-slice-1-browser-brief.md`
   - max: `8`
   - reason: the eight values are deterministic SHA-256 prefixes generated from synthetic source keys and channels; the EUI pattern cannot distinguish them from device identifiers
   - issue: the repository's existing doc-hygiene tracking issue, consistent with adjacent synthetic-identifier entries

   Keep the exact values in the brief and fixtures. They pin the production series-ID derivation. Removing them in a later commit would not clear the historical pre-push scan.

   This is complete at `f22f7e460`; 95 scanner tests and the 382-file tip scan passed.

2. Land the separate test-only Journal clock prerequisite described in `/tmp/mobile-history-pr-dst-test-determinism-plan.md`. The host clock entered Zurich's repeated hour and exposed four unchanged suites that derive form defaults from the real current minute. Pin only `Date` to an unambiguous instant in those suites, preserve real polling timers and the dedicated fold regression, then rerun the four files and the full edge unit command. Do not change production Journal behavior in this PR.

3. Link the two filed follow-up issues:
   - **Cloud #390: AnalysisGrid must ceil subsecond hour crossings.** Reproduction: a logical end at an exact hour plus 1–999 ms produces coverage ending at the preceding hour. Expected behavior is the next-hour grid boundary and 25 buckets for the 24-hour-plus-offset regression. This blocks any production enablement of mobile history.
   - **Edge #516: paired mobile-history rollout gate.** Keep both build flags false until #390 is fixed, retained-history discovery is decided, real edge/cloud queries are measured, physical mobile behavior is checked, and the paired production-build matrices are rerun against the release candidates. Client abort fences admission but does not prove server-work cancellation.

4. Prepare the edge PR against current `origin/main` with the title **Add default-off mobile water-tension history Slice 1**. The body should state:
   - authenticated internal route and real Analysis adapters;
   - literal default-off build gate and lazy-chunk exclusion;
   - shared bounded loader, selection/revision/read-policy fencing, empty recovery, locale/timezone behavior;
   - no deployment and no navigation exposure;
   - exact verification counts from the execution report;
   - the two follow-up links, with the grid issue called out as a rollout blocker.

5. Append a short **PR-stage verification** section to both execution reports. Preserve the historical counts already recorded. Add the fresh post-merge/pre-PR results separately, including the current edge Node result of 339 passing tests with no skips, so an environment-dependent count does not silently rewrite earlier evidence.

The edge branch already contains current `origin/main` through a clean merge and has no product conflict. Its PR diff is confined to the reviewed history core, edge adapter/route/locales, paired profile backend tests, reproducible browser/benchmark harnesses, and their plans/reviews/report.

## Edge merge and cloud provenance

Both PRs can be ready for review together, but cloud must merge second. The cloud manifest records canonical source commit `e397fd527b4bd9937b71d3098a62b98889b50ea1`, which contains the exact 42-file package.

The edge PR must use **Create a merge commit**. GitHub permits that method in this repository, and it preserves `e397fd527` as an ancestor of edge `main`, so a fresh checkout can perform source-mode provenance verification. Put this dependency prominently in both PR descriptions and in the cloud PR's merge-blocking note.

If a maintainer instead squashes or rebases edge, stop the cloud merge. Fetch the resulting edge `origin/main`, resync cloud from that clean checkout, repin `sourceCommit` to the reachable merged commit, rerun verifier self-tests plus source and manifest modes, and commit the provenance-only update. Never merge cloud while its manifest points only to an unreachable branch commit.

## Cloud PR

Open the cloud PR with the title **Add default-off cloud mobile water-tension history Slice 1**. Explain that it vendors the canonical edge package, adds the cloud adapter/internal route and production harness, and contains backend contract tests without backend production changes. Link the edge PR, both follow-up issues, and the same rollout limitation. Mark it as dependent on edge merging first with a merge commit; record the repin fallback if edge uses squash or rebase.

Cloud CI correctly verifies the vendor manifest before `npm ci`, then runs typecheck, unit tests, and the production build. The new verifier has real-git fixture tests, but the workflow does not execute that test file directly. This is acceptable for this PR because those tests passed independently and manifest mode runs in CI; add verifier self-tests to CI in a separate hardening change if the scripts evolve.

## Final gates

Before marking each PR ready for review:

- Require clean worktrees and `git diff --check`.
- Edge: doc-hygiene tests/scan; canonical core 129-test suite and build; GUI typecheck/unit/build; profile parity, sync and silent-catch checks. The already-green 21-case production browser matrix need not rerun for an allowlist-only change.
- Cloud after repin: verifier fixture tests, source and manifest parity, frontend typecheck/unit/build, and Java 21 backend tests. The already-green 22-case browser matrix need not rerun when only manifest provenance changes.
- Let GitHub required checks complete on the pushed PR heads. Copy exact command outputs or link the committed execution reports in each PR body.

## Rollout limitations

Merging does not authorize enabling either flag. Production enablement remains blocked by the cloud grid precision issue and the paired rollout issue. Other disclosed limits remain: incomplete retained-history discovery, no raw/15-minute or 30/90-day UI, the edge 30,000-row cap without pagination, no physical Pixel or radio/backend latency evidence, and no proof of server-side cancellation.
