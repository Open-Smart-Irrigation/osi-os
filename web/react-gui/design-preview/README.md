# Soil water status preview

This fixture renders the existing zone and device components with fixed sample data. The proposed mode adds status pills through a Vite transform in memory. Product source files are unchanged. The transform rejects changed source anchors instead of silently producing an incomplete preview.

From `web/react-gui`:

```bash
npx vite --config design-preview/vite.config.mjs --host 127.0.0.1 --port 4178
```

Open <http://127.0.0.1:4178/gui/design-preview/>. Expand Zone B, then its device section. The toolbar changes theme, language, display unit, and sample scenario. This fixture disables the optional environment and schedule panels, preserving the full Water card and device sections. Its local API returns only fixed responses; write requests return 405 and no proxy contacts Node-RED.

Run browser checks with a locally installed Playwright:

```bash
node design-preview/capture.mjs
```

Set `PLAYWRIGHT_MODULE` to an existing Playwright `index.mjs` path if it is installed elsewhere. Otherwise `npm install --no-save --package-lock=false playwright` and `npx playwright install chromium` supply local tooling without changing product dependency declarations. Captures go to `docs/superpowers/previews/swt-water-status/`. Open its `index.html` for a gallery of the actual card captures.

The script checks 23 viewport/theme/locale/scenario combinations, badge and page overflow, translated labels, no nested buttons or status live regions, browser errors, and external requests. It also opens KIWI and LSN50 history with Tab and Enter. History uses an empty fixture response.

## Final implementation gate

Set `SWT_PREVIEW_MODE=implemented` on both the server and capture commands. That mode disables every source transform and requires the real implemented badges to pass the same checks. Its default output goes to `swt-water-status/implemented/`, keeping proposed-mode evidence intact. A proposed-mode pass cannot establish final implementation correctness.

## Preview limits

The overlay demonstrates the visual treatment and the supplied scenarios. It is not the production classifier or complete zone aggregation implementation. In particular, it does not implement mixed-age contributor selection, per-channel open-circuit handling, or routing a Tensiomark-only zone into the tension summary. Those remain covered by the implementation plan and must pass production tests and the implemented-mode gate.

The inherited card headers can truncate names to zero visible width at 320 px because their controls consume the row. Some existing device copy remains English in German and French. The new status labels use the shipped locale resources. Neither inherited issue is evidence of a badge-layout failure.
