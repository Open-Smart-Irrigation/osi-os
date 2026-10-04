# Valve-panel help implementation plan

> For agentic workers: use `superpowers:executing-plans` for native implementation, then request independent verification.

Goal: replace the valve panel's permanent subtitle with the user-approved tooltip.

Architecture: keep the change inside `ValveControlPanel.tsx`. Use a real button beside the heading and a non-interactive tooltip. No valve commands, API requests, role behavior, or schedule semantics change.

Tech stack: React, TypeScript, i18next, Vitest and Testing Library.

Spec: the approved design below records the owner's 2026-09-28 confirmation.

## Approved design and constraints

Remove “All valves, all zones. Weekly plans run on the valve itself.” The information button opens “Weekly schedules run on each valve.” by tap, hover or keyboard focus. Escape, blur or an outside tap dismisses it. Keep a 48 px button target and contain the text at 320 px viewport width. Translate the copy in all seven locale files; Luganda keeps the English text pending human translation and is listed in `docs/i18n/pending-luganda-translations.md`.

This is edge GUI work only. It touches no schema, no flows and no sync contract.

## Review focus

- The first tap must open the help even if focus fires before click.
- Escape must dismiss while focus stays on the button.
- Outside taps on non-focusable elements must dismiss.
- Narrow translated text must wrap without leaving the card.
- Read-only users must still be able to read help; opening it must issue no valve command.

## Task 1: replace the subtitle

Files: `web/react-gui/src/components/farming/valves/ValveControlPanel.tsx`, its existing `__tests__/ValveControlPanel.test.tsx`, `web/react-gui/tests/valveControlLocales.test.ts`, and `web/react-gui/public/locales/{en,de-CH,fr,it,es,pt,lg}/valves.json`.

Interfaces: preserve `ValveControlPanelProps`, all service calls, and refresh callbacks. Add locale keys `scheduleHelp` and `scheduleHelpLabel`; remove the retired subtitle and help keys.

- [ ] Add real-component tests to the existing panel suite. Mock `valvesAPI.list` with an empty list, then assert the following behavior:

```tsx
render(<ValveControlPanel onUpdate={vi.fn()} canWrite={false} />);
expect(screen.queryByText('All valves, all zones. Weekly plans run on the valve itself.')).not.toBeInTheDocument();
const help = screen.getByRole('button', { name: 'About weekly schedules' });
expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
fireEvent.focus(help);
expect(screen.getByRole('tooltip')).toHaveTextContent('Weekly schedules run on each valve.');
fireEvent.click(help);
expect(screen.getByRole('tooltip')).toBeInTheDocument();
fireEvent.keyDown(help, { key: 'Escape' });
expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
fireEvent.click(help);
fireEvent.pointerDown(document.body);
expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
```

Add separate hover/leave and blur assertions. Check `aria-describedby` references the visible tooltip. Extend the test translation table with the two new strings.

- [ ] Run `npx vitest run src/components/farming/valves/__tests__/ValveControlPanel.test.tsx` from `web/react-gui`; confirm failure because the subtitle still exists and the help button is absent.
- [ ] Add `useId`, `useRef`, the open state, and an outside-pointer listener to the panel. Focus and hover open the tooltip; a click after focus must not close it, so the first tap always opens. Close on Escape and blur. On mouse leave, retain the tooltip if the button still has focus. Remove listeners on unmount.
- [ ] Replace the subtitle with a relative wrapper around a `type="button"` information icon. Give it `min-h-12 min-w-12`, a translated accessible name and `aria-describedby` only while open. Render the text with `role="tooltip"`, the `useId()` ID, `absolute right-0 top-full z-20 w-56 max-w-[calc(100vw-4rem)] whitespace-normal`, and existing surface/text/border tokens. Keep the heading and help wrapper in a flex row with `justify-between`.
- [ ] Add the approved English sentence and accessible label “About weekly schedules” to all locale files, translating the five European languages and keeping the English text in Luganda. Remove the retired entries. Run the focused tests again.
- [ ] Run `npm run typecheck`, `npm run test:unit`, and `npm run build`. Verify 320 px and 390 px browser rendering, both themes, English and German, including tap/focus/Escape/outside dismissal. Request an independent review and run `git diff --check` before handoff.

Execution recommendation: native implementation; this is one local UI change with no new API or shared abstraction.

## Execution note

`main` already carried an earlier version of this help (keys `help` and `helpLabel`, a 32 px button, the text “All zones. Weekly schedules run on each valve.” and the label “About valve control”). The implementation moved it to the approved design: new keys and copy, a 48 px target, wrapping classes, the shared focus ring, no `aria-controls` pointing at an absent element, and a document-level Escape so hover-opened help can be dismissed without moving the pointer. A click on a pinned tooltip still closes it, as the existing tests and the presentation browser test assert.
