# SWT mobile card polish

The KIWI header currently gives the device name only a few pixels at phone widths. LSN50 and SDI-12 use the same competing name-and-actions row. This pass gives each name a separate row while retaining existing controls and sensor behavior.

## Scope and implementation

Work in `.worktrees/swt-water-status` from `43840df48`. Product changes are confined to the headers in `KiwiSensorCard.tsx`, `DraginoTempCard.tsx`, and `Sdi12SoilCard.tsx` under `web/react-gui/src/components/farming/`. Preview changes may extend `design-preview/main.tsx`, `capture.mjs`, and a new `mobile-headers.mjs`.

1. Change the header wrapper to `flex flex-col gap-1 mb-2`. Stretch both rows to card width.
2. Give each EditableName heading `flex-1 text-base font-semibold text-[var(--text)] leading-snug [overflow-wrap:anywhere]`. Remove truncation so long and unbroken names remain readable. Preserve the shared editor behavior and its 48 px pencil target.
3. Keep the type badge and existing actions together on the second row. Use `flex flex-wrap items-center gap-1.5`; give the type badge `mr-auto`. Retain relative positioning where configuration controls use it.
4. Preserve the existing device identifier, settings, removal confirmation, read-only behavior, status badges, and history buttons.

Apply this layout at every card width. A desktop grid can contain phone-width cards, so a viewport breakpoint cannot reliably decide whether its header fits.

## Verification

Extend `web/react-gui/design-preview/capture.mjs` to assert all three names are fully visible: positive heading width, scroll dimensions within client dimensions, and contained within the card. This must fail before the CSS change. Assert header buttons retain 48 px targets and remain contained. Use the existing 23-case matrix across desktop, 390 px, and 320 px; screenshots go to a separate mobile-polish evidence directory.

Run from `web/react-gui`:

```bash
node node_modules/vite/bin/vite.js --config design-preview/vite.config.mjs --host 127.0.0.1 --port 4179
```

In another process, run the existing browser capture with `SWT_PREVIEW_URL=http://127.0.0.1:4179/gui/design-preview/`, a local `PLAYWRIGHT_MODULE`, and `SWT_PREVIEW_OUTPUT=/tmp/swt-mobile-polish`. Inspect the phone screenshots. Run `npm run typecheck`, `npm run test:unit`, and `npm run build`. Review the diff independently before handoff. No deployment is part of this pass.

Long-name, edit/cancel, and read-only checks must exercise the real components in the browser fixture; DOM class assertions alone do not establish visible layout.

## Review amendments

Visual inspection also exposed cramped Water action text at 320 px. Extend product scope to the Water metric grid in `IrrigationZoneCard.tsx`: replace `grid-cols-2` with `grid-cols-1 sm:grid-cols-2`, retaining the existing desktop column map. Add a browser assertion that the action tile spans the metric grid width below 640 px; observe failure before this class change, then repeat the matrix. This keeps translated advice readable on phones.

The independent reviewer accepted the two-row approach and required explicit fixture and interaction coverage. The pre-change browser run failed at 390 px: the KIWI heading had 14 px of width; the other two headings had 56 px and all three clipped.

Keep the exact existing JSX children and replace only classes. All header wrappers become `flex flex-col gap-1 mb-2`. KIWI's action wrapper becomes `relative flex flex-wrap items-center gap-1.5`; LSN50 uses the same classes, retaining its modal inside that wrapper. SDI-12 uses `flex flex-wrap items-center gap-1.5`. Prefix each type badge's existing classes with `mr-auto`. Device identifiers and removal confirmations remain outside these wrappers.

The preview accepts `names=long` and `names=unbroken`, both within the 100-code-point device-name limit, plus `readonly=true` forwarded as `canWrite={false}`. Existing normal names stay unchanged for the 23-case matrix.

The new browser script locates each card through its unique device EUI, which remains mounted while its name is edited, then checks that heading and header button rectangles lie within that card. It requires at least 100 px heading width and no horizontal or vertical clipping. At 320 and 390 px in each theme, test both long-name forms and read-only variants. Editable cases require three header buttons, each at least 48 px wide and tall. Click the first (rename), check the input rectangle and width, press Escape, and assert the original full name and pencil focus return. Read-only cases require zero header buttons. Save representative captures and JSON evidence outside the previous implementation captures.
