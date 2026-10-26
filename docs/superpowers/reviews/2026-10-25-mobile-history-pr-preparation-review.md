# Mobile history Slice 1 PR-preparation review

## Verdict

The PR-preparation changes reviewed here pass specification and code-quality review. They do not alter mobile-history or Journal production behavior.

Edge PR [#518](https://github.com/Open-Smart-Irrigation/osi-os/pull/518) may be marked ready only after the current full edge rerun and hosted required checks pass on its final head. Those gates were still running when this review was written.

Cloud PR [#391](https://github.com/Open-Smart-Irrigation/osi-server/pull/391) must remain draft. GitHub refused to start its backend and frontend jobs with an account payment or spending-limit annotation. This is an external CI-start failure, not a test failure, but local verification does not replace required hosted checks. Restore account capacity and rerun both workflows on the unchanged final head before marking the cloud PR ready.

## Scoped review results

### Documentation hygiene: PASS

Edge commit `f22f7e460` adds a narrow allowlist entry for the eight deterministic 16-character SHA-256 prefixes in the browser brief. The entry is limited to the exact document, caps the match count at eight, explains why synthetic series IDs resemble device identifiers, and cites the existing hygiene issue. It leaves the fixture derivation and documented expected IDs intact. Reported evidence is 95 scanner tests plus a clean 382-file scan.

### Journal DST test determinism: PASS

Edge commit `4b55ca1b8` changes only four Journal test files. Each suite pins `Date` to `2026-07-16T12:30:00.000Z` with `vi.useFakeTimers({ toFake: ['Date'] })` and restores real timers after each test. Timeout, interval, animation and Testing Library polling behavior remains real. No assertions were weakened.

The focused `JournalCaptureFlow` test that installs full fake timers and pins its own January instant remains intact, including its `finally` restoration. The dedicated occurrence tests still reject the Zurich spring gap, report both offsets for the fall fold, and accept an explicitly selected fold offset. The focused five-file run passed 247 tests. The production auto-now behavior observed during the fold is outside this PR and is tracked in edge issue [#517](https://github.com/Open-Smart-Irrigation/osi-os/issues/517).

### Test inventory: PASS

Edge commit `9c3d58289` changes only `web/react-gui/package.json` and `scripts/verify-test-inventory.json`.

`src/__tests__/AppMobileTensionHistoryRoute.test.tsx` is now an explicit input to `test:unit:vitest`, so the ordinary route test runs in pull-request unit CI. It is not excluded. The production Playwright spec alone has an exact-path inventory exclusion. Its reason names the reproducible `npm run test:browser:mobile-history` command, paired flag-off/flag-on production builds, CDP CPU throttling, frame-timing acceptance and rollout issue [#516](https://github.com/Open-Smart-Irrigation/osi-os/issues/516). This matches the existing policy for production-browser tests that require a controlled local environment.

Reported focused evidence is two passing App route tests, 50 passing inventory tests, a clean 832-file direct scan, and `git diff --check`. Root's independent inventory verification was still running when this review was written.

### Cloud PR-stage appendix: PASS

Cloud commit `19c71c5d6` accurately separates fresh PR-stage local evidence from the earlier execution record. It records 129 canonical-core tests plus build, 292 Node tests, 2,973 Vitest tests with two existing skips, frontend typecheck/build, 42-file source/manifest parity, verifier regressions and Flyway ordering. It does not claim that the blocked hosted workflows passed. The full 5,181-test Java 21 result remains the earlier backend evidence because PR preparation made no backend production or test change.

The report links both PRs and the two rollout blockers. It records that neither PR was merged or deployed and that no production host was accessed.

## Merge and rollout constraints

The edge PR must merge first using GitHub's **Create a merge commit** option. Cloud provenance pins canonical edge commit `e397fd527b4bd9937b71d3098a62b98889b50ea1`; a merge commit keeps that source commit reachable from edge `main`.

If a maintainer squashes or rebases edge, stop the cloud merge. Resync the cloud vendor package from the resulting clean edge `main`, repin the source commit, rerun verifier self-tests and both source and manifest modes, and commit that provenance update before cloud merges.

The existing cloud `AnalysisGrid` subsecond rounding defect, tracked in cloud issue [#390](https://github.com/Open-Smart-Irrigation/osi-server/issues/390), does not block merging the default-off internal route. It blocks production enablement. Both literal build flags must remain false until #390 and the paired rollout checks in edge #516 are complete. The browser matrices are controlled local release evidence and do not establish physical-phone performance, live backend latency or cancellation of server work.

## Remaining PR actions

- Finish the full edge rerun and independent inventory scan; record their exact results without replacing historical counts.
- Ensure both PR checklists explicitly retain and check the template item requiring independent green gates.
- Let all edge required checks pass on the final pushed head.
- Restore cloud GitHub Actions capacity and let backend and frontend required checks run on the final cloud head.
- Keep cloud draft and preserve the edge-first merge instruction until those conditions are satisfied.
