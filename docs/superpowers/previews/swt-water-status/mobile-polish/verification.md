# Mobile polish verification

Verified on 2026-09-27 in `feat/swt-water-status`, against the working changes after `43840df48`. Nothing was deployed.

The three sensor-card headers now put names above type badges and actions. Names wrap, including unbroken text, and header controls retain 48 px targets. Water tiles use one column below 640 px; tablet and desktop column rules remain.

## Evidence

Before the header change, the browser check failed at 390 px: KIWI had 14 px of name width and the other headings had 56 px; all clipped. Before the Water grid change, the full-width action assertion failed at 390 px.

After the final product change:

- `npm run typecheck`: passed.
- `npm run test:unit`: 193 Node tests and 2,114 Vitest tests passed.
- `npm run build`: passed, with browser-data age and bundle-size warnings.
- `design-preview/capture.mjs`: all 23 viewport/theme/locale/scenario cases passed, including heading clipping and phone Water action width.
- `design-preview/mobile-headers.mjs`: all 16 long-name/edit/cancel/read-only cases passed, including an independent run after the Water change.

The independent verifier found no required changes. They repeated both browser scripts and passed 45 device-card/editor tests plus 71 Water/zone tests. Their final browser evidence was saved under `/tmp/swt-mobile-independent-water` and `/tmp/swt-mobile-independent-capture`; the saved header JSON here comes from that final run.

Both browser scripts used the implemented fixture at `http://127.0.0.1:4179/gui/design-preview/`, with `PLAYWRIGHT_MODULE` pointing to the locally available Playwright module and `SWT_PREVIEW_OUTPUT=/tmp/swt-mobile-polish`. These are fixture checks, not live-device verification. The in-app browser bridge was unavailable; standalone Chromium supplied the screenshots and assertions.

See [320 px overview](320-light-en-kPa-fresh.png), [KIWI](390-dark-en-kPa-fresh-kiwi.png), [LSN50](390-dark-en-kPa-fresh-chameleon.png), and [SDI-12](390-dark-en-kPa-fresh-sdi12.png). Machine-readable results are in `checks.json` and `mobile-headers.json`.
