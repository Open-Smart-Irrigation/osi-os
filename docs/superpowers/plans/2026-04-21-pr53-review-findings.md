# PR 53 Review Findings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the actionable review findings on PR #53 by preventing bogus `0%` battery rendering, adding regression coverage for the coercion edge cases, and making the Dragino settings modal keep focus stable across parent rerenders.

**Architecture:** Keep the battery fix local to the shared footer helper so every card benefits without extra card-level logic. For the modal fix, add a small DOM-capable test harness with `jsdom`, write regressions against the current focus trap behavior, then stabilize the focus effect for the modal lifetime while hardening the `aria-hidden` filter in the same focused patch.

**Tech Stack:** React 18, TypeScript, Vite, Node built-in test runner via `tsx`, `jsdom`, React DOM test utilities.

---

## File Structure

- Modify: `web/react-gui/package.json`
  - Add `jsdom` as a dev dependency for DOM-based modal regression tests.
- Modify: `web/react-gui/package-lock.json`
  - Lock the new `jsdom` dependency tree.
- Modify: `web/react-gui/src/components/farming/shared/deviceCardBattery.ts`
  - Restrict accepted battery inputs to real numbers and non-empty numeric strings.
- Modify: `web/react-gui/tests/deviceCardBattery.test.ts`
  - Add coercion regression coverage for whitespace-only strings and booleans.
- Modify: `web/react-gui/src/components/farming/DraginoSettingsModal.tsx`
  - Harden the focusable-element filter and keep the focus trap effect stable across rerenders by reading `onClose` through a ref instead of effect dependencies.
- Modify: `web/react-gui/tests/draginoSettings.test.ts`
  - Add DOM-backed regression tests for the `aria-hidden` focusable filter and modal focus stability on rerender.

### Task 1: Lock Down Battery Percentage Coercion

**Files:**
- Modify: `web/react-gui/tests/deviceCardBattery.test.ts`
- Modify: `web/react-gui/src/components/farming/shared/deviceCardBattery.ts`

- [ ] **Step 1: Write the failing regression test for bogus zero values**

Add this test block to `web/react-gui/tests/deviceCardBattery.test.ts` after the existing invalid-input test:

```ts
test('rejects values that would otherwise coerce missing battery state to zero', () => {
  assert.equal(getValidBatteryPercent(' '), null);
  assert.equal(getValidBatteryPercent('\t'), null);
  assert.equal(getValidBatteryPercent(false), null);
  assert.equal(getValidBatteryPercent(true), null);
});
```

- [ ] **Step 2: Run the focused battery test to verify the current bug**

Run:

```bash
cd /home/phil/Repos/osi-os/web/react-gui
npx tsx --test tests/deviceCardBattery.test.ts
```

Expected: FAIL because the current helper returns `0` for `' '` and `false`, and `1` for `true`.

- [ ] **Step 3: Implement the minimal battery helper fix**

Replace `getValidBatteryPercent` in `web/react-gui/src/components/farming/shared/deviceCardBattery.ts` with:

```ts
export function getValidBatteryPercent(value: unknown): number | null {
  let numeric: number | null = null;

  if (typeof value === 'number') {
    numeric = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      return null;
    }
    numeric = Number(trimmed);
  } else {
    return null;
  }

  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) {
    return null;
  }

  return Math.round(numeric);
}
```

- [ ] **Step 4: Run the focused battery test to verify the fix**

Run:

```bash
cd /home/phil/Repos/osi-os/web/react-gui
npx tsx --test tests/deviceCardBattery.test.ts
```

Expected: PASS with all battery-helper assertions green, including the new whitespace and boolean cases.

- [ ] **Step 5: Commit the battery-only fix**

Run:

```bash
cd /home/phil/Repos/osi-os
git add web/react-gui/src/components/farming/shared/deviceCardBattery.ts web/react-gui/tests/deviceCardBattery.test.ts
git commit -m "fix: reject coerced battery percentage values"
```

### Task 2: Add DOM Regression Coverage For The Modal

**Files:**
- Modify: `web/react-gui/package.json`
- Modify: `web/react-gui/package-lock.json`
- Modify: `web/react-gui/tests/draginoSettings.test.ts`
- Modify: `web/react-gui/src/components/farming/DraginoSettingsModal.tsx`

- [ ] **Step 1: Add a DOM test dependency**

Run:

```bash
cd /home/phil/Repos/osi-os/web/react-gui
npm install -D jsdom
```

Expected: `package.json` and `package-lock.json` update to include `jsdom`.

- [ ] **Step 2: Export the focusable-element helper for direct regression coverage**

Change the helper signature near the top of `web/react-gui/src/components/farming/DraginoSettingsModal.tsx` from:

```ts
function getFocusableElements(container: HTMLElement | null): HTMLElement[] {
```

to:

```ts
export function getFocusableElements(container: HTMLElement | null): HTMLElement[] {
```

Do not change the body yet. This keeps Step 3 failing for the current `aria-hidden` handling.

- [ ] **Step 3: Add failing DOM-based modal tests**

Extend `web/react-gui/tests/draginoSettings.test.ts` with the imports and tests below:

```ts
import { JSDOM } from 'jsdom';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

import {
  DraginoSettingsModal,
  getFocusableElements,
} from '../src/components/farming/DraginoSettingsModal.tsx';
```

```ts
test('treats aria-hidden="false" as focusable but excludes aria-hidden="true"', () => {
  const dom = new JSDOM(`
    <!doctype html>
    <html>
      <body>
        <div id="root">
          <button id="visible" aria-hidden="false">Visible</button>
          <button id="hidden" aria-hidden="true">Hidden</button>
        </div>
      </body>
    </html>
  `);

  const root = dom.window.document.getElementById('root') as unknown as HTMLElement;
  const ids = getFocusableElements(root).map((element) => element.id);

  assert.deepEqual(ids, ['visible']);
});
```

```ts
test('keeps focus inside the modal when the parent rerenders with a new onClose callback', async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><button id="opener">Open</button><div id="root"></div></body></html>',
    { url: 'http://localhost/', pretendToBeVisual: true },
  );
  const runtimeGlobals = globalThis as Record<string, unknown>;

  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousKeyboardEvent = globalThis.KeyboardEvent;
  const previousNode = globalThis.Node;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const previousConfirm = globalThis.window?.confirm;

  Object.assign(runtimeGlobals, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    KeyboardEvent: dom.window.KeyboardEvent,
    Node: dom.window.Node,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  });
  dom.window.confirm = () => true;

  try {
    const device = buildDevice();
    const opener = dom.window.document.getElementById('opener') as HTMLButtonElement;
    const container = dom.window.document.getElementById('root') as HTMLDivElement;
    const root = createRoot(container);

    opener.focus();

    await act(async () => {
      root.render(
        React.createElement(DraginoSettingsModal, {
          device,
          dendroNeedsCalibration: false,
          onUpdate: () => {},
          onClose: () => {},
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const modeSelect = dom.window.document.getElementById(`lsn50-mode-${device.deveui}`) as HTMLSelectElement;
    modeSelect.focus();
    assert.equal(dom.window.document.activeElement, modeSelect);

    await act(async () => {
      root.render(
        React.createElement(DraginoSettingsModal, {
          device,
          dendroNeedsCalibration: false,
          onUpdate: () => {},
          onClose: () => {},
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(dom.window.document.activeElement, modeSelect);
    assert.notEqual(dom.window.document.activeElement, opener);

    act(() => root.unmount());
  } finally {
    if (previousWindow) runtimeGlobals.window = previousWindow;
    else delete runtimeGlobals.window;
    if (previousDocument) runtimeGlobals.document = previousDocument;
    else delete runtimeGlobals.document;
    if (previousHTMLElement) runtimeGlobals.HTMLElement = previousHTMLElement;
    else delete runtimeGlobals.HTMLElement;
    if (previousKeyboardEvent) runtimeGlobals.KeyboardEvent = previousKeyboardEvent;
    else delete runtimeGlobals.KeyboardEvent;
    if (previousNode) runtimeGlobals.Node = previousNode;
    else delete runtimeGlobals.Node;
    if (previousRequestAnimationFrame) runtimeGlobals.requestAnimationFrame = previousRequestAnimationFrame;
    else delete runtimeGlobals.requestAnimationFrame;
    if (previousCancelAnimationFrame) runtimeGlobals.cancelAnimationFrame = previousCancelAnimationFrame;
    else delete runtimeGlobals.cancelAnimationFrame;
    if (previousConfirm && globalThis.window) globalThis.window.confirm = previousConfirm;
    dom.window.close();
  }
});
```

- [ ] **Step 4: Run the focused modal test to capture the current failures**

Run:

```bash
cd /home/phil/Repos/osi-os/web/react-gui
npx tsx --test tests/draginoSettings.test.ts
```

Expected: FAIL because `getFocusableElements` currently drops `aria-hidden="false"` nodes and the modal rerender test restores focus to the opener on cleanup.

- [ ] **Step 5: Commit the failing-test harness before the fix**

Run:

```bash
cd /home/phil/Repos/osi-os
git add web/react-gui/package.json web/react-gui/package-lock.json web/react-gui/src/components/farming/DraginoSettingsModal.tsx web/react-gui/tests/draginoSettings.test.ts
git commit -m "test: add dragino modal regression coverage"
```

### Task 3: Stabilize The Dragino Settings Modal Focus Trap

**Files:**
- Modify: `web/react-gui/src/components/farming/DraginoSettingsModal.tsx`
- Modify: `web/react-gui/tests/draginoSettings.test.ts`

- [ ] **Step 1: Make the `aria-hidden` filter precise**

Change the filter body in `getFocusableElements` to:

```ts
  ).filter(
    (element) =>
      !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true',
  );
```

- [ ] **Step 2: Make the modal effect stable for the mounted lifetime**

Update the top of `DraginoSettingsModal` to keep the latest `onClose` in a ref:

```ts
  const onCloseRef = useRef(onClose);
```

Add this sync effect just before the focus-trap effect:

```ts
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
```

Then change the focus-trap effect to use the ref and stop depending on `onClose` identity:

```ts
  useEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const restoreFocus = () => {
      openerRef.current?.focus();
    };
    const focusTarget = window.requestAnimationFrame(() => {
      closeButtonRef.current?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }

      const focusable = getFocusableElements(dialogRef.current);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const activeElement = document.activeElement as HTMLElement | null;
      const currentIndex = activeElement ? focusable.indexOf(activeElement) : -1;
      const lastIndex = focusable.length - 1;
      let nextIndex = currentIndex;

      if (event.shiftKey) {
        nextIndex = currentIndex <= 0 ? lastIndex : currentIndex - 1;
      } else {
        nextIndex = currentIndex === -1 || currentIndex >= lastIndex ? 0 : currentIndex + 1;
      }

      if (nextIndex !== currentIndex) {
        event.preventDefault();
        focusable[nextIndex]?.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.cancelAnimationFrame(focusTarget);
      restoreFocus();
    };
  }, []);
```

- [ ] **Step 3: Re-run the focused modal regression suite**

Run:

```bash
cd /home/phil/Repos/osi-os/web/react-gui
npx tsx --test tests/draginoSettings.test.ts
```

Expected: PASS with the `aria-hidden="false"` test and the rerender-focus test both green.

- [ ] **Step 4: Run the full frontend verification**

Run:

```bash
cd /home/phil/Repos/osi-os/web/react-gui
npm run test:unit
npm run build
```

Expected:
- `test:unit` passes for battery and Dragino regression coverage
- `build` succeeds with only the existing bundle-size warning

- [ ] **Step 5: Commit the modal fix**

Run:

```bash
cd /home/phil/Repos/osi-os
git add web/react-gui/src/components/farming/DraginoSettingsModal.tsx web/react-gui/tests/draginoSettings.test.ts
git commit -m "fix: keep dragino settings modal focus stable"
```

### Task 4: Final Review And PR Follow-Through

**Files:**
- Modify: none required unless review feedback reveals a miss

- [ ] **Step 1: Inspect the final diff**

Run:

```bash
cd /home/phil/Repos/osi-os
git diff --stat main...HEAD
git diff --check
```

Expected: only the intended battery helper, modal focus, test, and dependency changes; no whitespace errors.

- [ ] **Step 2: Summarize the review threads addressed**

Record this mapping in the PR update or handoff notes:

```text
- Battery helper now rejects coerced non-battery values (`false`, `true`, whitespace-only strings).
- Battery helper regression tests now cover the coercion cases that produced bogus `0%`.
- Dragino modal focus trap no longer reruns cleanup on `onClose` identity changes.
- Focusable filtering now excludes only `aria-hidden="true"`, not `aria-hidden="false"`.
```

- [ ] **Step 3: Commit any final review-note-only adjustments if needed**

Run:

```bash
cd /home/phil/Repos/osi-os
git status --short
```

Expected: clean working tree after the prior commits, or only intentional follow-up edits if a final tweak was needed.
