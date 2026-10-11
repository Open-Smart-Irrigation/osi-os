# Codex Cloud handoff: public OSI OS simulator

The user requested transfer to Codex Cloud. This document records the source checkpoint and remaining work; it does not certify release readiness.

## Source and scope

Cloud release branch: cloud/public-simulator-v1.
Cloud expanded-device reference branch: cloud/public-simulator-devices.
Original local release branch: feat/public-simulator-v1.
Original frozen reviewed source: ecd0a5a964fb4180f9f62337f7dee48db7bd4ac7.
The transfer branch is a source snapshot based on the public original base. Local feature-history SHAs in earlier reviews are provenance labels; those commits are not transferred. The snapshot adds the two unrun regression edits and these handoff records. It makes no product changes beyond the reviewed source.
Original review base: 2e8beead65292bcdcbceba2b239f5ec2e70f2877.
Application: web/react-gui. Read AGENTS.md and docs/engineering-playbook.md first.

Binding plans: docs/superpowers/plans/2026-10-11-public-simulator-v1-release.md, 2026-10-11-public-simulator-website-badge.md, 2026-10-11-public-simulator-device-registration.md, and 2026-10-11-public-simulator-stable-modules.md. Corresponding specs remain in the snapshot. Private review directories are omitted from public Git; final findings and review summaries are supplied in the cloud task prompt. Latest registration/stable amendments supersede earlier experimental-module and modal designs.

All nine native types are addable, with editable random DevEUI and native name/type workflow. Five experimental modules are disabled and absent from Settings/navigation/public direct routes. Standard zone History remains available. Homepage invitation is a compact nonmodal white smartphone badge, visual 10dvh below the right menu, Try me! text, separate close, same-origin /simulator/. Desktop simulation has a white phone frame; mobile is frameless. All interactions stay in memory and must never control field hardware.

The website deployment and GitHub link are already authorized, but nothing is publicly deployed yet. Do not include SSH credentials, access helpers, private host records, customer worktrees or sensitive-terms contents in the task, Git, or public artifacts. Keep current SSH deployment access local unless explicitly configured through a separate supported secure mechanism.

## Outstanding final review repairs

Final whole review: Spec REVISE / Quality REVISE, four Important findings, no Critical. The complete sanitized final review is included in the cloud task prompt; its private directory is omitted from public Git. Earlier ignored raw logs remain local; reported results are historical evidence and must be rerun.

W1: Native RainTodayTile/rainDay requires rain_day, rain_day_timezone and rain_day_timezone_basis. Project dated totals from the same ledger/assigned-zone day policy as rain history. Include each current delta exactly once. Preserve measured zero versus missing, last-report date across rollover, and observed-flow merge. Exercise the real client through rainTodayState and a native/mounted dated 0.0 mm display.

W2: First compatible Sentek Apply A -> save B -> Rollback currently advertises availability but returns success-shaped null and fails to restore A. Retain the last compatible configuration/layout explicitly on completion; return real queued versions, advance versions monotonically, reject unavailable rollback with the native structured error, and bind delayed ACKs to their own deployment generation. Test first apply, repeated apply/rollback, pending boundary, channel/depth readback and preservation of historical rows. Do not edit maintained edge backend/flows/database.

W3: Runtime clears its interval on pagehide and never restarts on pageshow. Support persisted suspension/restoration with exactly one interval, reset the wall-time baseline, preserve pause/active state, and preserve owned object URLs while retained. Test advancement before/after, no suspended-time catch-up, pause and repeated cycles. Existing synthetic lifecycle reproduction is NOT proof of actual BFCache navigation.

W4: Native selected History CSV reproducibly fails to emit a Firefox download; Chrome desktop/mobile passed. Diagnose submission -> CSV -> owned blob URL -> anchor. Synchronous URL revocation is a candidate, not an established cause. Preserve download, notices and errors assertions; no skip, UA spoof or allowlist. Rerun Firefox and affected exports before the complete final browser matrix.

Bounded triage: delayed public CLOSE should return queued rather than acknowledged; document pending cancellation's null estimated amount without converting unobserved into measured zero; align rename rejection reason envelope if a bounded source-grounded fix is made. Record explicit dispositions.

## Current ownership

Local Luna final-review fix-wave agent has stopped at a test-only checkpoint: layout.spec.ts has 49 added lines for retained lifecycle; release.spec.ts has 54 added lines for dry-rain and first compatible Sentek rollback. These 103 added lines have only passed git diff --check. They have not been run and are not proven RED; validate locators and failure causes against the unchanged product before implementing fixes. The pre-existing Firefox CSV failure is already reproduced in the old local artifact. No local product edits are pending. Cloud owns the continuing implementation, builds and tests; local authors must not resume concurrent edits.

User-selected process: Astra reviews, Luna implementation, final whole Astra recheck and a distinct independent verifier. Preserve this when the cloud environment exposes the required model/delegation capabilities; report any limitation plainly.

## Evidence and required verification

Pre-fix independent commands 1-4 passed: demo:test 350 tests; both TypeScript checks; test:unit 232 Node + 2672 Vitest tests. This is a HOLD before commands 5-9, not final release approval. Corrected affected browser preflight had 49 passes, one Firefox CSV failure, four unrun; separate Firefox reproduction failed again. Stable modules 24/24, registration 3/3 and invitation 33/33 passed focused checks, not the final integrated matrix. Separate 139-case inventory remains deferred, never count it as passing.

After repairs and scoped whole-review GREEN, freeze a new HEAD. A distinct independent verifier runs these serially from web/react-gui, with fresh servers and zero public skips:

1. npm run demo:test
2. ./node_modules/.bin/tsc -p demo/tsconfig.json --noEmit
3. npm run typecheck
4. npm run test:unit
5. npm run demo:build
6. env CI=1 ./node_modules/.bin/playwright test --config demo/playwright.config.ts
7. npm run build
8. env CI=1 ./node_modules/.bin/playwright test --config demo/playwright.public.config.ts hosting.spec.ts layout.spec.ts ancestor.spec.ts invitation.spec.ts release.spec.ts registration.spec.ts stable-modules.spec.ts
9. node demo/check-build-isolation.mjs --production build --public public-demo-build --source src

Do not alter installs/lockfiles unnecessarily. Restore only the seven clean-before-run presentation screenshots regenerated by the presentation suite. Run documentation/privacy checks without exposing private terms. Exact verified artifacts must be archived and hashed without rebuilding, then deployed simulator first, versioned badge/plugin second, existing website link third; perform actual HTTPS/native-action/reset/desktop/mobile/menu/WASAG/cache/rollback checks. Physical-device and actual WordPress checks remain pending until observed.

## Expanded scope

Separate feat/public-simulator branch HEAD 202b15a6ffa9e0066c59e4b22e97c7c4f1d91a86 has accepted A/B work and specialist consultations; C has not started and expanded physics is not merged into v1. The cloud/public-simulator-devices snapshot preserves its accepted product source and specialist consultations separately; see its transfer note and accepted B review. A documentation-only privacy cleanup may be applied to that snapshot and recorded explicitly. Do not restart completed specialist consultations or imply that all expanded realism shipped.

## Cloud environment and task handoff

The authenticated Codex CLI lists an osi-os cloud environment for the Open-Smart-Irrigation repository. The cloud task must start from cloud/public-simulator-v1, read this handoff and the final whole review, then confirm the checked-out tree and environment before proceeding. Do not expect local preview servers, ignored reports, credentials or installed dependencies to exist there. Follow the package manager and Node versions pinned in the repository; do not copy local dependency symlinks.

Priority: finish W1-W4 and their bounded triage; get whole-surface review and independent verification; prepare the exact verified website release package with hashes and a concrete deployment checklist. No live website edits have been made. SSH credentials and host backup records stay local. If deployment access is unavailable, provide the ready-to-deploy artifact and report that final live deployment remains outstanding rather than inventing success or requesting credentials in a public task.

After the v1 release source is accepted, reconcile the accepted A/B device source from cloud/public-simulator-devices with those v1 fixes before starting C. Preserve native workflows, all nine device types, experimental exclusions and existing specialist evidence. Do not replace v1 wholesale with the older device snapshot. The LSN50/Chameleon and SDI-12/Tensiomark realism scope remains required in that expansion.

## Transfer verification

The transfer checkpoint passed the demo TypeScript check and diff check. New browser regressions remain unrun. The configured private-term documentation gate passed: 304 files, 2316 allowlisted findings in 52 files. An additional scan of 208 changed/staged files found no supplied SSH username/password literals. Its 1834 private-pattern matches were classified against the already-public original base: 1833 native journal seed/catalog references and one unchanged native API reference; zero unclassified matches. These counts are privacy classifications, not zero-match claims or release acceptance. Original local feature histories are retained locally; only snapshot commits based on the public original base will be pushed. The expanded snapshot also receives the existing two-file documentation privacy cleanup, preserving accepted device product source.

The repository pre-push guard rejected the initial candidate because docs/reviews is a private directory. The published snapshot excludes all eight guarded private document directories and local coordination scratch. The guard remains enabled. Source, plans, public operation notes and pending tests are retained; no private review folders are relocated into public Git.
