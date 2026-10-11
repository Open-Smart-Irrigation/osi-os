# Compact simulator website badge implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development. Astra reviews this amendment, Luna implements it, Astra reviews the result, and the independent release verifier checks the frozen artifact.

**Goal:** Publish the requested compact homepage phone badge and matching white desktop simulator frame.

**Architecture:** Replace the invitation modal with a small nonmodal fixed badge using the existing static screenshot assets. A separate WordPress plugin enqueues it only on the homepage. Keep the simulator runtime, iframe and mobile layout intact.

**Tech Stack:** Plain HTML/CSS/JavaScript, WordPress PHP, existing Vite and Playwright tools.

**Spec:** `docs/superpowers/specs/2026-10-11-public-simulator-website-badge.md`.

## Global constraints

- The badge specification supersedes only conflicting invitation/frame requirements in `2026-10-11-public-simulator-v1-release.md`; all release gates and simulator behavior requirements remain binding.
- Work in the existing `public-simulator-v1` worktree. Root serializes commits, builds, browser sessions and deployment. No dependency changes or unrelated source edits.
- Do not modify R2's active model, native acceptance harness or production components. The R2 source freeze remains independent.
- Preserve the real screenshot, no simulator preloading, same-origin same-tab entry, tab-session dismissal and storage fallback. Use no network service or new backend.
- Keep the visual phone-and-caption block at 10dvh, including the caption. One anchor wraps both, with a minimum 44px square hit area. A sibling minimum 44px square close button sits beside it with an 8px gap. The outer container uses pointer-events:none and each control pointer-events:auto. Only the visual block is 10dvh; hit areas can be taller on short viewports. They must remain disjoint, within the viewport and below the menu.
- Preserve normal browsing and native navigation. Do not use a modal, backdrop, focus trap, inert attributes or overflow lock.
- White decorative frame on the website preview and desktop simulator; no frame on mobile simulator. Retain the existing native breakpoint and simulation controls.
- Actual hosting credentials, addresses and private configuration stay outside public files. Publication is already authorized; no repeated permission request.

## Review focus

- Visible and hidden menu-button layouts: the invitation stays below the correct header geometry and open navigation covers it.
- Resize, mobile orientation and a shrinking fixed header: the badge remains 10% high and within viewport bounds without menu overlap.
- Keyboard and touch: small visual dimensions retain usable entry/close targets and do not steal focus or trap page interaction.
- Dismissal and Back: normal page scrolling, pre-existing inert elements and focus remain intact; duplicate installation and unavailable storage stay safe.
- WordPress integration and caches: homepage-only enqueue, release-specific asset URLs, independent disable and scoped simulator headers remain reviewable.

## Task B1: Replace the modal and document the concrete installation

**Files to modify:**

- `web/react-gui/demo/website/invitation.js`
- `web/react-gui/demo/website/invitation.css`
- `web/react-gui/demo/website/invitation.html`
- `web/react-gui/demo/website/preview.html`
- `web/react-gui/demo/tests/public/invitation.spec.ts`
- `web/react-gui/demo/public/host.css`
- `web/react-gui/demo/tests/public/layout.spec.ts`
- `docs/operations/public-simulator-release.md`
- `docs/website/osi-os-demo-page.md`

**Create:** `docs/website/osi-os-demo-plugin.php`, a standalone site-specific MU plugin with a release-ID placeholder. Its deployed path is `wp-content/mu-plugins/osi-public-simulator.php`; removing or renaming only that file is the independent invitation disable switch. It guards direct access and fails closed unless its release ID is `v1-` followed by exactly 40 lowercase hexadecimal characters. It enqueues the existing four static assets only for `is_front_page()` and retains the reviewed deferred script tag behavior. Root substitutes only the frozen reviewed commit in that placeholder before deployment. It does not change WordPress content or other plugins.

**Interfaces:** The existing website packager still copies its six named static inputs; upload only the four invitation assets. The screenshot and `/simulator/` entry remain unchanged. The preview fixture exposes the real header/button IDs and a small WASAG-like ribbon and navigation overlay for interaction tests; do not import private website files into the repository.

- [ ] Write meaningful browser regressions before changing invitation behavior: nonmodal normal browsing, 10% visual height, white preview frame, menu anchoring/stacking on desktop/mobile, preserved current focus/scroll/inert state, exact Try me! copy, close/Escape/session/memory/idempotence, same-tab link/Back, no app preloading, resize/landscape/reduced motion. Assert disjoint entry/close rectangles, real successful clicks on each, no menu intersection, and 10dvh visual size at 568x320 and both sides of the actual 880/881px menu breakpoint. Retain the existing outer iframe native-confirmation case.
- [ ] Root runs the new focused tests and records actual expected RED against the current modal. Do not claim author syntax checks as browser RED.
- [ ] Replace the modal with an accessible nonmodal badge. Position below max(header bottom, visible menu-button bottom) plus at least 8px. Use the hidden-button desktop header fallback and update on relevant size changes. Remove all page locking and focus trapping. Keep separate entry and dismissal handlers, stable asset-base resolution and defensive installation.
- [ ] Set the desktop host frame to white with a subtle edge/shadow; preserve dimensions, iframe, breakpoint and mobile zero-border rules. Add a desktop white-frame assertion and retain mobile zero-frame assertions in the existing layout test file.
- [ ] Add the standalone PHP plugin and update the runbook/page copy for the new homepage-only design. Record that the earlier R1 modal package is superseded. Keep backup, cache purge, enable/disable/rollback and optional-embed limitations. Root handles the persistent link through the existing site-specific GitHub-button integration after inspecting and backing up its exact source; no unrelated page edit.
- [ ] Freeze owned files for root. Run both existing TypeScript checks, syntax-transpile the Playwright edits, PHP lint if a local PHP executable exists, prose and diff checks. Root runs the affected invitation/layout suites across Chromium desktop/mobile and Firefox desktop, inspects actual captures, then commits exact owned paths after corrections. No skips or changed user agents.
- [ ] Fresh Astra task review returns Spec GREEN and Quality GREEN. Revisions stay scoped to actual findings.

## Task B2: Final integration and publication

- [ ] Root records the plan and review identities, integrates accepted R2 work, and updates final-review/verifier briefs with the superseding badge design. The old 24 modal checks remain historical, not acceptance of the new badge.
- [ ] Fresh whole-branch Astra review and a separate fresh independent verifier run the original release's exact nine-command sequence, documentation/privacy checks and actual build isolation on the frozen source. Use no moving artifact or parallel build writers.
- [ ] Root archives those exact outputs without rebuilding and records source commit and per-file/archive SHA256. Render the reviewed PHP by substituting only the frozen source commit; verify the exact substitution diff, lint those exact bytes using the available host PHP before activation, and include that rendered plugin in the manifest. Verify private backups and harmless scoped-header staging on the actual host, then upload the simulator first. Verify deployed hashes, HTTPS responses and native desktop/mobile use before enabling the badge.
- [ ] Install the rendered independent homepage MU plugin at its exact path and the versioned four assets, add the persistent link near existing GitHub/release buttons, purge affected WordPress caches, and verify the actual WASAG ribbon, menu, 10% badge, close/Escape, entry and Back in fresh desktop/mobile sessions. Check homepage enqueue and negative checks on OSI System/another inner page and admin; ordinary WordPress pages retain their existing headers. Verify removal of the independent plugin disables only the badge, then re-enable and purge caches. Publish the narrowly scoped GitHub link only after the destination works.

The expanded device work remains separate and may continue while this release is verified and deployed.
