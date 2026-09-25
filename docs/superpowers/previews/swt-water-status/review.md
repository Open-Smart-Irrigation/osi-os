> Screenshots referenced below are not in the repository; the full capture set stays on the development branch `feat/swt-water-status`.

# Soil water status preview review

The approved design is now implemented. See [implementation verification](implemented/verification.md) for the actual-source captures, test results, and final review. The notes below record the earlier design review.

The September 25 revision replaces the generated mockup with browser captures of the existing React cards. Open [the gallery](index.html) or run the [interactive fixture](../../../../web/react-gui/design-preview/README.md).

The chosen treatment remains a small dot-and-label pill beside neutral numeric readings. The Water card retains its rain, forecast, action, and soil tiles. KIWI retains light, temperature, and humidity; LSN50 retains temperature, battery, depth labels, and whole-row history controls. SDI-12 retains its combined kPa/pF display.

## Revisions

The spec and plan now limit accepted future timestamps to five minutes, inclusive. Their test cases cover both freshness endpoints, one millisecond outside each, invalid dates, and non-finite clocks. Checkout instructions use the current working-tree state instead of assuming old RAK10701 edits still exist.

The plan also specifies the exact wrapping used in the preview, including the outer LSN50 row and an unbroken pill label. Final acceptance requires the same fixture with `SWT_PREVIEW_MODE=implemented`, which disables the prototype source transform.

## Evidence

- The proposed-mode capture passed 23 cases: 1440, 390, and 320 px; light/dark; English, Swiss German, and French; plus stale, fault, zero, and future-date pF scenarios. Results are in [checks.json](checks.json).
- Browser checks found no document or badge overflow, external requests, or page errors. Badge containment was checked against the immediate value-row container. KIWI and LSN50 history opened with Tab and Enter using empty local history responses.
- Preview TypeScript and repository prose checks passed. Product source files have no changes.
- The implemented-mode negative control failed with `0 !== 7` badges on the current product. This confirms that preview-only code cannot satisfy the final implementation gate.
- Separate Astra and Sol review contexts found no remaining required changes after correcting fixture profile casing, faulted contributor handling, wrapping, and evidence output separation. Sol independently ran the preview typecheck and prose check.

## Remaining limits

This is design evidence. The overlay does not implement the complete production rules for mixed-age contributors, per-channel open circuits, or a Tensiomark-only zone. Those remain tasks in the implementation plan.

At 320 px, the existing card-header controls can consume all available name width. Some existing device copy remains English in translated views. The captures preserve those issues so the preview does not imply that this feature fixes them. Final product acceptance still needs actual-source browser inspection and the planned semantic tests.
