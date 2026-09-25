# Soil water status preview

This fixture renders the implemented zone and device components with fixed sample data. Implemented mode is the default and uses the product source directly.

From `web/react-gui`:

```bash
npx vite --config design-preview/vite.config.mjs --host 127.0.0.1 --port 4178
```

Open <http://127.0.0.1:4178/gui/design-preview/>. Expand Zone B, then its device section. The toolbar changes theme, language, display unit, and sample scenario. This fixture disables the optional environment and schedule panels, preserving the full Water card and device sections. Its local API returns only fixed responses; write requests return 405 and no proxy contacts Node-RED.

Run browser checks with a locally installed Playwright:

```bash
node design-preview/capture.mjs
```

Set `PLAYWRIGHT_MODULE` to an existing Playwright `index.mjs` path if it is installed elsewhere. Otherwise `npm install --no-save --package-lock=false playwright` and `npx playwright install chromium` supply local tooling without changing product dependency declarations. Captures go to `docs/superpowers/previews/swt-water-status/implemented/`. The parent directory's `index.html` preserves the approved design gallery.

The script checks 23 viewport/theme/locale/scenario combinations, badge and page overflow, translated labels, no nested buttons or status live regions, browser errors, and external requests. It also opens KIWI and LSN50 history with Tab and Enter. History uses an empty fixture response.

## Final implementation gate

Both commands default to implemented mode, which disables every source transform and requires the real implemented badges to pass the checks. `SWT_PREVIEW_MODE=implemented` may also be set explicitly. Its output goes to `swt-water-status/implemented/`, keeping proposed-mode evidence intact. A proposed-mode pass cannot establish final implementation correctness.

## Historical design preview and limits

The original proposed-mode overlay is preserved at commit `723903425`. It depends on source anchors from before implementation and must be run from that revision. It demonstrates the visual treatment but does not provide complete zone aggregation. Mixed-age selection, per-channel open circuits, and Tensiomark-only zones are covered by production tests in the implementation.

The inherited card headers can truncate names to zero visible width at 320 px because their controls consume the row. Some existing device copy remains English in German and French. The new status labels use the shipped locale resources. Neither inherited issue is evidence of a badge-layout failure.
