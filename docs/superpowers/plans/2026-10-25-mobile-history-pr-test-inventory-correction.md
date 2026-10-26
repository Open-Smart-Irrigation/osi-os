# Mobile history PR test-inventory correction

## Scope

Fix the two paths reported by hosted `Test Inventory`. Change only `web/react-gui/package.json` and `scripts/verify-test-inventory.json`. Do not change product code, test behavior, workflow triggers, or the browser runner.

## Unit route test

Add the exact path `src/__tests__/AppMobileTensionHistoryRoute.test.tsx` to `test:unit:vitest` in `web/react-gui/package.json`.

Keep it as an ordinary Vitest input alongside the existing test directories. Do not add an inventory exclusion for this file. The root `src/__tests__` directory is outside the directories currently collected by `test:unit:vitest`, and the hosted failure proves the route test is absent from pull-request CI. Naming the file explicitly gives the inventory verifier a stable path and makes `npm run test:unit` execute it.

## Production browser matrix

Add one exact-path exclusion to `scripts/verify-test-inventory.json`:

```json
{
  "path": "web/react-gui/tests/browser/mobile-tension-real-data.spec.ts",
  "reason": "production-build Playwright matrix run by npm run test:browser:mobile-history; it uses paired flag-off/flag-on production builds, CDP CPU throttling and frame-timing acceptance, so it remains a controlled local release gate tracked by #516 rather than a shared pull-request runner test"
}
```

Use an exact `path`, not a pattern. Keep `test:browser:mobile-history` and the tracked runner unchanged. The matrix is reproducible and already has final raw JSON evidence, but its CPU and frame-timing assertions depend on the controlled local browser environment. This exclusion documents that boundary without excluding the ordinary App route test.

## Verification

Run, in order:

1. The named App test through Vitest to prove it passes as a normal unit test.
2. Use the fresh full-suite run plus the named App test locally; require hosted `npm run test:unit` to pass with the modified aggregate script before marking the PR ready.
3. `node --test scripts/verify-test-inventory.test.js` to exercise the verifier and its repository-clean assertion.
4. `node scripts/verify-test-inventory.js` to confirm the repository inventory is clean.
5. `git diff --check`.

Record the hosted RED evidence verbatim: the inventory verifier reported only the App route test and the mobile browser spec as uncovered. The GREEN evidence must show both the inventory unit suite and direct repository scan passing.

Commit the two metadata changes together as a test-inventory correction. The existing production browser results remain valid because neither the spec nor its runner changes.
