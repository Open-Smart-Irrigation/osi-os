# Public simulator first release

The user authorized a first public version on opensmartirrigation.org this afternoon, 11 October 2026, while expanded device simulations continue in parallel. This release freezes the accepted Task 8 simulator at `0600139a756cefc4080be05ceabd4ef4ad20aeb6` and adds the website entry points and release checks. The complete device extension and exhaustive native-action audit remain active follow-up work.

The user's later compact homepage badge and white-frame instructions supersede
the invitation modal requirements below. The binding replacement is
[the compact badge specification](../specs/2026-10-11-public-simulator-website-badge.md)
and its [implementation plan](2026-10-11-public-simulator-website-badge.md).
R1's modal implementation/review remain historical evidence; the new badge needs
its own review and affected browser checks. All R2–R4 behavior, final review,
independent verification and publication gates remain binding.

## Binding requirements and constraints

The original specification is [the public simulator design](../specs/2026-10-10-public-simulator-design.md). The original [implementation plan](2026-10-10-public-simulator.md), contracts and accepted native-dialog amendment remain the behavior authority. This amendment changes delivery order and first-release verification, not the requirement that every offered action works in simulation.

- Use only `/home/phil/Repos/osi-os/.worktrees/public-simulator-v1`, branch `feat/public-simulator-v1`. Expanded work remains in the separate `public-simulator` worktree. Preserve both and the dirty original checkout.
- The user chose Astra plan/task/final review, Luna implementation and an independent final verifier. Review this amendment until GREEN before implementing it. Review bounded fixes against reported findings.
- No hardware, cloud commands, external identity/location calls, emails, or osicloud.ch. The app remains browser-local and serves static files without a backend. Preserve the FAO presentation build and ordinary production defaults.
- Host at `https://opensmartirrigation.org/simulator/` on the existing website server when its static upload and scoped headers support is verified. No replacement of the WordPress website. Do not apply simulator CSP to WordPress pages.
- The website invitation shows a real simulator screenshot. Its screen and CTA open the simulator in the same tab. The separate close cross and Escape restore the usable website. Desktop shows a phone frame; mobile has no decorative frame and uses the native app directly after entry.
- The user explicitly authorized public deployment and the GitHub entry point once the concrete artifact passes review and verification. Do not request go-live authorization again. Missing hosting connection details are a factual prerequisite, not discretionary approval.
- Reuse existing node_modules; no dependency installation or lockfile changes. Serialize heavy tests/build writers. The release owns public browser port 4174 until released; expanded browser work must coordinate a different port or time window.

## Release verification policy

Task 8 already has 320 model tests and 26 archived presentation browser tests passing, plus actual Chromium desktop/mobile and Firefox hosting/layout/ancestor evidence. Retain those reports with the frozen commit identity. Re-run affected checks and final release gates on the release artifact; never describe placeholder tests as passing.

The original 139-action browser matrix is currently a skipped inventory, not acceptance evidence. It remains a required expanded-scope follow-up. For version 1, verify all offered route handlers are covered by native-client/model tests and inspect the action inventory for unsupported controls. Add actual release browser journeys covering zone/device changes, valve ACK/open/close/water accounting, schedule firing, trigger outcomes, settings/authentication, analysis/history, journal and downloads, reset, mobile/layout continuity and every native confirmation listed below. Any discovered unsupported offered control blocks release until fixed and reviewed. Do not hide a control merely to avoid verification.

All six native confirmation actions must be tested with actual browser dialogs and both acceptance/dismissal outcomes: disable all schedules, apply time zone to all, Dragino mode change, WATERMARK calibration deletion, legacy dendrometer baseline deletion, and saved analysis view deletion. Chromium and Firefox full-view chains are required. Mobile runs the confirmations offered by the native mobile app; saved analysis view deletion is desktop-only because AnalysisRoute redirects mobile to History. The mobile case must assert that redirect and usable native History instead of changing the user agent or skipping an assertion. Same-origin outer embedding is optional and must be withheld if its actual dialog chain has not passed; preserve full-view links. Cross-origin embedding is withheld for the first release.

Monitor native browser journeys for page errors, unhandled/unsupported local requests and unexpected network access. Require a working fail-closed build guard and scoped CSP/ancestor checks. Inspect downloaded CSV/JSON/ZIP/PNG bytes and major reset state through the actual app. Verify English/light reset and all seven locale choices, focus/touch/contrast, 320px and landscape, reduced motion and an explicitly labelled effective-zoom approximation. Physical Safari/iPhone/Android checks are not available unless an actual device is supplied; report the limitation honestly.

## Task R1: Website invitation and installation package

Owner: fresh Luna. Start after amendment GREEN. Implement original Task 9 in this release branch, using the reviewed Task 8 baseline rather than waiting for expanded devices.

Files: `demo/website/invitation.{js,css,html}`, `preview.html`, actual outer fixture `embed.html`, `osi-os-preview.png` under `web/react-gui/`; `demo/tests/public/invitation.spec.ts`; `demo/tests/public/hosting.spec.ts`; `docs/images/osi-os-simulator.png`; `docs/website/osi-os-demo-page.md`; `docs/website/osi-os-demo-embed.html`; `docs/operations/public-simulator-release.md`; introduction link/screenshot in `README.md`; narrowly affected packaging/server/Playwright config files.

Capture the real public app without a baked-in desktop bezel for mobile. Inspect the capture before building the invitation. Write meaningful browser RED checks before implementation. Require a labelled modal, focus trap/restoration, previous inert/scroll restoration, namespaced tab-session dismissal with memory fallback, idempotent installation, 44px close target, same-tab entry, persistent website link, and no simulator scripts/chunks before entry. Test mobile and narrow/short screens. Configure the destination in one place. Package local screenshot/assets for `/wp-content/uploads/osi-os-demo/` with exact once-only public-page enqueue instructions and independent disable switch.

Keep the real `demo/website/embed.html` fixture separate from the WordPress installation snippet. Both ancestor iframes require `allow-modals` and `allow-downloads`. Include a working full-view link and do not advertise unverified embedding. Extend public fixture builds to include the real website artifact. Replace hosting.spec.ts's obsolete preview404 assertion with packaged preview200/MIME and website-header-scope checks; preserve missing-resource404 checks. Run affected tests, demo and GUI TypeScript gates, public/website build and packaging guard. Commit exact owned files and report checks/captures/limits. Fresh Astra task review must be GREEN before acceptance.

## Task R2: Native release acceptance

Owner: a fresh Luna after R1 integration; acceptance tests and guard repair may be prepared earlier with explicit disjoint ownership of `release.spec.ts`, release-only helpers, `demo/check-build-isolation.mjs`, and `demo/tests/build-isolation.test.ts`. Root serializes commits and all shared artifact writers/browser runs. Do not fill the 139 rows with assertions that merely check rendered headings. Use native controls and persisted outcomes for the release journeys and six real confirmations specified above. Keep fictional compatibility fixtures for legacy capabilities distinct from default public seed.

Before browser implementation, map every offered inventory operation to its existing real-client/model test file and test name, or mark it UI-only and identify its source handler. Inspect dependent-read assertions for writes. Matching an ID or route is insufficient. Record uncovered operations and fix them through the existing client/model harness with source-grounded tests. Keep a separate native-browser coverage column; the deferred 139-row audit remains visible.

Implement these finite named journeys, combining cases only if their outcomes remain identifiable:

| Browser flow | Observable outcome |
| --- | --- |
| farm-device-roundtrip | Create/rename a zone and device; assign/unassign and remove the device; read saved results. |
| valve-lifecycle | Pending, acknowledged opening, timed closure, early CLOSE and water/outcome accounting agree. |
| plan-roundtrip | Save/reopen WEEKLY and ONCE plans, observe firing, reject invalid/conflicting edits while retaining the valid plan. |
| trigger-roundtrip | Dry trigger opens; wet/disabled trigger does not; retained outcome agrees. |
| preferences-auth | Save/reopen preferences and log out/in while retaining farm edits. |
| analysis-history | Select data, save/reopen a view or workspace and compare returned series. |
| journal-roundtrip | Create/edit/reopen an entry and exercise its offered export. |
| network-system-support | Save/reopen a fictional location, change a gateway control and receive a local support receipt. |
| downloads | Inspect actual CSV/JSON/ZIP/PNG bytes against current state. |
| reset-continuity | Reset after edits and during an active run restores seed/auth/clock/valve/preferences and usable navigation. |

Native journal availability also differs by browser class: `JournalPage.tsx` mounts
the desktop workspace with correction and export controls, while its mobile
branch offers capture, filters and the read-only timeline. Test creation and
retained timeline content on mobile; test correction and the offered exports on
desktop Chromium and Firefox. Keep all cases active, preserve the mobile user
agent, and report that distinction in the acceptance map. This follows the
existing native interface, as does the Analysis-to-History mobile behavior.

Use simulation clock controls instead of wall-clock waits. Test all six confirmations through host-to-app in Chromium desktop and Firefox desktop with real confirm events, accept/dismiss and state readback. Chromium mobile tests all offered confirmations and asserts the native Analysis-to-History redirect for the desktop-only saved-view action. Compatibility setup must not replace the native action or change the default public seed. Optional outer embedding remains withheld unless its separate chain passes.

Install a browser monitor before navigation. Retain page errors, failed/non-success resource responses, external requests and transient simulator notice messages across navigation. HTTP events alone cannot detect caught in-memory adapter errors. Scope expected validation notices to the exact negative step. Prove this same monitor detects a deliberately unsupported local operation and a deliberately blocked external transport attempt; ordinary flows must have no unexpected entries. Do not add public debug endpoints or relax transport policy.

Repair the isolation guard with RED fixtures for missing/empty production and source directories, missing/empty production entry, and missing/empty public entries. Require the real source entry and nonempty compiled production JavaScript; retain marker/import/public-entry restrictions. Include a valid minimal fixture and retain known-bad marker/nested-reference/commented-dynamic-import cases. Run the checker against fresh ordinary production and public outputs, so a vacuous scan cannot pass.

Create `docs/reviews/2026-10-11-public-simulator-v1-acceptance.md` mapping each release gate to test names, actual output, artifact commit and remaining full-matrix/device work. Run the following from `web/react-gui`, sequentially, with release-owned port4174 unoccupied. CI=1 must refuse existing servers and use the freshly built artifact:

```sh
npm run demo:test
./node_modules/.bin/tsc -p demo/tsconfig.json --noEmit
npm run typecheck
npm run test:unit
npm run demo:build
CI=1 npm run demo:test:browser
npm run build
CI=1 npm run demo:test:public -- hosting.spec.ts layout.spec.ts ancestor.spec.ts invitation.spec.ts release.spec.ts
node demo/check-build-isolation.mjs --production build --public public-demo-build --source src
```

The complete production unit suite is required because the original-base diff
touches shared API services and farming types alongside multiple GUI consumers;
a component-only selection cannot bound that impact. The public configured server builds both public and website outputs before serving. Require zero skipped cases in these five named release browser files, with actual counts per project. Original actions/plans/triggers skipped inventories remain unselected and explicitly deferred. Keep intentional unsupported-origin negative tests as actual assertions, not skipped rows. Run documentation hygiene, prose and diff checks on written deliverables. Restore generated tracked screenshots and exclude generated build/report/scratch directories from commits. A failed functional gate requires Luna fix and Astra scoped review. Keep command failures distinct from feature failures.

## Task R3: Final review and independent verification

Owner: fresh Astra final reviewer over original baseline `2e8beead65292bcdcbceba2b239f5ec2e70f2877` through the frozen release HEAD, with prior accepted task evidence and deferred findings supplied. A separate fresh verifier independently checks the exact artifact and release gates without authoring changes. Root coordinates focused fixes through Luna and scoped re-review. Neither skipped original matrix rows nor unavailable physical/live-template checks can be reported passed.

The independent verifier re-runs the exact R2 sequence against frozen release HEAD. Retain source-grounded documentation hygiene findings and precise allowlist reasons for legitimate Node-RED IDs. Verify no deployment/customer secrets in committed docs or built artifacts. Archive and hash the verified simulator and invitation outputs with scoped hosting configuration and source commit. Packaging may copy/archive but cannot silently rebuild; source/build changes invalidate affected evidence/hash. Save final reviews and exact artifact SHA256 before upload. Do not destroy either worktree or original evidence while parallel work is active.

## Task R4: Authorized public deployment

Owner: root using the actual hosting connection supplied or already configured. Read-only inspect the web root, routing, Apache/header capability and current site. Use a harmless isolated staging file to verify scoped headers before upload. Build a versioned package with source commit and checksum; back up existing simulator artifacts and touched WordPress configuration/content. Avoid unrelated site edits.

Upload the exact reviewed archived simulator first, compare deployed files/checksums with the pre-upload manifest, and verify HTTPS `/simulator/` and asset responses, scoped headers, desktop/mobile native use, local-only actions and reset at the real URL. Install invitation assets/enqueue next, then persistent Try OSI OS link on `/osi-system/`. Test close/escape/navigation on the actual WordPress pages and normal browsing. Enable only after the direct simulator works. Optional interactive embed remains disabled until its actual template/dialog chain passes.

Publish the narrowly scoped GitHub README entry only after the public URL works, using a clean targeted PR or commit that preserves unrelated repository work. Record the exact published commit/PR and verify the destination. Smoke-test the live invitation and simulator with fresh browser sessions and keep a rollback that independently disables the invitation and restores the prior simulator version. If hosting access is missing, complete all local work and report the precise remaining connection detail without pretending deployment happened.

## Review focus

Reviewers must assess whether the v1 gates expose unsupported actions, whether the frozen baseline has a release-blocking defect, and whether parallel branch ownership/builds remain isolated. Verify modal restoration on WordPress-like pages, actual native-dialog chains, screenshot mobile framing, artifact/header scope, build/network isolation, honest remaining test coverage, and rollback. Deadline pressure cannot justify known broken actions or false completion claims.
