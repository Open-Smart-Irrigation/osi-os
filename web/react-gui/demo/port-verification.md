# Public simulator port and UX verification

This report covers the source port, Sol's required corrections, UX Slices 5–12,
and the integrated release preparation. The public simulator is built with its
own compile-time mode; this work does not change edge runtime, schema, sync,
deployment code, or any live system. The release archive is deferred until Sol
reviews this source revision, so no unreviewed revision is labeled approved.

## Contract and user experience

- Pending valve cancellation now returns the current edge-shaped cancel result,
  and a parser test consumes it. A running actuation returns the current
  `actuation_handed_off` response and remains running in the simulator; no
  physical closure is claimed.
- A public UC512 add attempt returns an explicit unsupported response and
  creates no record. The GUI has no inspectable UC512 device card yet.
- The browser app keeps the same iframe and session through compact and expanded
  layouts. Desktop has native-scale and expanded views; mobile fills the space
  below the host controls. The optional guide navigates through existing advice,
  zone History, timed irrigation, results, and schedule surfaces without
  issuing farm mutations.
- The host confirms reset before clearing state, preserves the selected
  language, and reports the next event in the farm's timezone. The app document
  receives its selected language in the URL and `<html lang>`.
- Seven host locales are available. Luganda remains visibly marked as awaiting
  independent review; no production Luganda locale was changed.
- Account-link and device-registration forms display a browser-local example
  data notice. Schedule writes visibly update the app and focus the saved row.
- A successful schedule write announces “Schedule saved.” in a visible live
  status and focuses the newly saved row. English, German, French, Italian,
  Spanish, and Portuguese copy is supplied; Luganda uses the English fallback
  until its resources are independently reviewed.
- The WordPress package includes a CTA shortcode/style alongside the homepage
  invitation, with a versioned, fail-closed plugin placeholder and a local
  release runbook.

The three inherited public browser files containing only empty skipped test
callbacks were removed. Their 151 inventory rows and trace IDs remain in
`public-coverage-map.json`, mapped to existing substantive model suites where
possible. This map does not claim browser/UI execution for each row. The public
browser suite has no skipped cases. UC512 refusal and the missing visible card
remain an explicit capability limit.

## Commands and results

Heavy commands ran serially through `osi-heavy`. Vitest used at most two workers; Playwright used one worker.

| Command | Result |
|---|---|
| `npm run demo:test` | 378 passed, 0 failed, 0 skipped. |
| `npm run typecheck` | Passed. |
| `npx tsc --noEmit -p demo/tsconfig.json` | Passed. |
| `npm run test:unit:tsx-runner` | 347 passed, 0 failed, 0 skipped. |
| `npm run test:unit:vitest` | 306 files, 3,390 passed, 0 failed. |
| `npm run build` | Production Vite build passed; 90 files. Existing large-chunk warning remains. |
| `npm run demo:build` | Presentation Vite build passed. Existing CSS minifier and large-chunk warnings remain. |
| `npm run demo:build:public` | Public simulator Vite build passed. |
| `npm run demo:build:website` | Website assets packaged locally. No archive was stamped as approved. |
| `CI=1 npm run demo:test:browser -- --workers=1` | 26 passed, 0 failed, 0 skipped. |
| `npm run demo:test:public -- --workers=1` | 171 passed, 0 failed, 0 skipped across Chromium desktop/mobile and Firefox desktop (9.4 minutes). |
| `node demo/check-build-isolation.mjs --production build --public public-demo-build --source src` | Passed: production 90 files, public 19 files. |
| `node scripts/verify-test-inventory.js` | Passed: 1,011 test files; 826 workflow-run, 7 listed-runner, 178 reasoned exclusions. |
| `node scripts/verify-doc-hygiene.js` | Passed built-in pattern scan over 492 files; allowlist staleness was not checked because the private name list was not supplied. |
| `node scripts/verify-agents-size.js` | Passed at 28,250 bytes. |
| `git diff --check` | Passed. |
| `node .claude/skills/anti-slop-writing/slop-check.js …` | Passed for changed prose files (no tier-1 findings). |

`php -l docs/website/osi-os-demo-plugin.php` could not run because PHP is not installed in this environment. The plugin packager tests passed; PHP syntax remains for parent review or an environment with PHP.

The first complete public-browser run had 141 passed and 30 failed. Follow-up
runs exposed host URL/locale expectations, a missing History series-identity
version in the demo response, guide selectors, notice wording/clearing, a
mobile grid row that left most of the iframe outside the phone viewport, and an
informational notice intercepting mobile form clicks. Targeted desktop, phone
valve, and registration paths passed after correction. The final all-project
run passed 171/171 with no failed or skipped tests.

## Scope limits and release status

- The public inventory map preserves all inherited trace rows, but does not
  establish full browser coverage for all 151 actions.
- UC512 registration remains explicitly unsupported until an inspectable GUI
  card is implemented.
- Conditional-irrigation qualification remains false. No conditional
  agronomy claim was introduced.
- The doc hygiene built-in-pattern scan passed. Private allowlist staleness was not checked because the private name list was not available in this environment.
- No archive or live website change was made. Prepare the final package only
  after review approves the source head.

## Visual review captures

Screenshots are in `/tmp/osi-simulator-ux-evidence/`: 12 light/dark × English/
Luganda host captures at 1280×800, 1440×900, and 390×844; guided intro and
expanded desktop captures; saved-schedule desktop and phone captures; and the
website CTA preview at desktop and phone sizes. The Luganda captures show the
independent-review note. These local captures are not release package files.

- Host 1280×800: `/tmp/osi-simulator-ux-evidence/host-1280x800-en-light.png`, `/tmp/osi-simulator-ux-evidence/host-1280x800-en-dark.png`, `/tmp/osi-simulator-ux-evidence/host-1280x800-lg-light.png`, `/tmp/osi-simulator-ux-evidence/host-1280x800-lg-dark.png`
- Host 1440×900: `/tmp/osi-simulator-ux-evidence/host-1440x900-en-light.png`, `/tmp/osi-simulator-ux-evidence/host-1440x900-en-dark.png`, `/tmp/osi-simulator-ux-evidence/host-1440x900-lg-light.png`, `/tmp/osi-simulator-ux-evidence/host-1440x900-lg-dark.png`
- Host 390×844: `/tmp/osi-simulator-ux-evidence/host-390x844-en-light.png`, `/tmp/osi-simulator-ux-evidence/host-390x844-en-dark.png`, `/tmp/osi-simulator-ux-evidence/host-390x844-lg-light.png`, `/tmp/osi-simulator-ux-evidence/host-390x844-lg-dark.png`
- Guided intro: `/tmp/osi-simulator-ux-evidence/guide-1280x800-en-light.png` and `/tmp/osi-simulator-ux-evidence/guide-390x844-lg-dark.png`
- Expanded desktop: `/tmp/osi-simulator-ux-evidence/expanded-1440x900-en-light.png`
- Saved schedule: `/tmp/osi-simulator-ux-evidence/schedule-1280x800-en-light.png` and `/tmp/osi-simulator-ux-evidence/schedule-390x844-en-light.png`
- Website CTA: `/tmp/osi-simulator-ux-evidence/website-cta-1280x800.png` and `/tmp/osi-simulator-ux-evidence/website-cta-390x844.png`
