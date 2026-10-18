import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import { DraginoChameleonSwtSection } from '../src/components/farming/DraginoChameleonSwtSection.tsx';
import { DraginoDendroCalibrationSection } from '../src/components/farming/DraginoDendroCalibrationSection.tsx';
import {
  DraginoSettingsModal,
  getFocusableElements,
} from '../src/components/farming/DraginoSettingsModal.tsx';
import { DraginoTempCard } from '../src/components/farming/DraginoTempCard.tsx';
import { lsn50API } from '../src/services/api.ts';
import type { Device } from '../src/types/farming.ts';

function buildDevice(
  overrides: Partial<Device> = {},
  latestDataOverrides: Partial<Device['latest_data']> = {},
): Device {
  return {
    deveui: 'A8404101FD5ECF41',
    name: 'Dendro 3',
    type_id: 'DRAGINO_LSN50',
    latest_data: {
      lsn50_mode_label: 'MOD3',
      ...latestDataOverrides,
    },
    dendro_enabled: 1,
    temp_enabled: 0,
    rain_gauge_enabled: 0,
    flow_meter_enabled: 0,
    device_mode: 3,
    dendro_force_legacy: 0,
    dendro_stroke_mm: null,
    dendro_ratio_at_retracted: null,
    dendro_ratio_at_extended: null,
    dendro_ratio_zero: null,
    dendro_ratio_span: null,
    dendro_baseline_pending: 0,
    ...overrides,
  };
}

// Focus checks compare elements by identity and describe them in a few words.
// They must not hand the elements to assert.equal: on a mismatch node:assert
// builds its message with util.inspect at depth 1000, and a React-rendered
// jsdom element carries __reactFiber$ / __reactProps$ properties that lead
// into the whole fiber tree. For this modal that walk does not finish and the
// process grows until it is killed (#393).
function describeElement(element: Element | null): string {
  if (!element) return 'no element';
  const tag = element.tagName.toLowerCase();
  const id = element.id ? `#${element.id}` : '';
  const text = ['select', 'input', 'textarea'].includes(tag) ? '' : element.textContent?.trim().slice(0, 40);
  const label = element.getAttribute('aria-label') ?? text ?? '';
  return label ? `<${tag}${id}> "${label}"` : `<${tag}${id}>`;
}

function assertFocused(document: Document, expected: Element, context: string): void {
  const active = document.activeElement;
  if (active !== expected) {
    assert.fail(`${context}: expected focus on ${describeElement(expected)}, found it on ${describeElement(active)}`);
  }
}

function assertNotFocused(document: Document, unexpected: Element, context: string): void {
  if (document.activeElement === unexpected) {
    assert.fail(`${context}: focus is still on ${describeElement(unexpected)}`);
  }
}

// jsdom with pretendToBeVisual runs animation frames on a 1000/60 ms interval
// and calls the callbacks in the order they were requested, so a frame
// requested here runs after every frame the component requested earlier.
function nextAnimationFrame(window: JSDOM['window']): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

test('renders blank dendrometer calibration inputs when saved values are null', () => {
  const html = renderToStaticMarkup(
    React.createElement(DraginoDendroCalibrationSection, {
      device: buildDevice(),
      dendroNeedsCalibration: true,
      onUpdate: () => {},
    }),
  );

  assert.doesNotMatch(html, /value="null"/);
});

test('does not render Invalid Date when the latest mode timestamp is malformed', () => {
  const html = renderToStaticMarkup(
    React.createElement(DraginoSettingsModal, {
      device: buildDevice({}, { lsn50_mode_observed_at: 'not-a-date' }),
      dendroNeedsCalibration: false,
      onUpdate: () => {},
      onClose: () => {},
    }),
  );

  assert.doesNotMatch(html, /Invalid Date/);
});

test('does not coerce missing Chameleon live telemetry to zero', () => {
  const html = renderToStaticMarkup(
    React.createElement(DraginoChameleonSwtSection, {
      device: buildDevice(
        { chameleon_enabled: 1 },
        {
          swt_1: null,
          chameleon_r1_ohm_comp: null,
        },
      ),
      onUpdate: () => {},
    }),
  );

  assert.doesNotMatch(html, /0\.0 kPa/);
  assert.doesNotMatch(html, /0 ohm/);
});

test('renders Chameleon SWT channels without coercing missing kPa to zero', () => {
  const html = renderToStaticMarkup(
    React.createElement(DraginoTempCard, {
      device: buildDevice(
        {
          chameleon_enabled: 1,
          chameleon_swt1_depth_cm: 30,
          chameleon_swt2_depth_cm: 30.5,
          chameleon_swt3_depth_cm: null,
        },
        {
          bat_v: 3.31,
          swt_1: null,
          swt_2: 45.26,
          swt_3: undefined,
        },
      ),
    }),
  );

  assert.match(html, /Chameleon SWT/);
  assert.match(html, /SWT1/);
  assert.match(html, /30 cm/);
  assert.match(html, /30\.5 cm/);
  assert.match(html, /Depth unset/);
  assert.match(html, /45\.3 kPa/);
  assert.doesNotMatch(html, /0\.0 kPa/);
});

test('renders invalid Chameleon samples as unavailable on the LSN50 card', () => {
  const html = renderToStaticMarkup(
    React.createElement(DraginoTempCard, {
      device: buildDevice(
        {
          chameleon_enabled: 1,
        },
        {
          chameleon_i2c_missing: 1,
          swt_1: 12.34,
          swt_2: 45.67,
          swt_3: 89.01,
        },
      ),
    }),
  );

  assert.match(html, /No valid Chameleon sample/);
  assert.doesNotMatch(html, /12\.3 kPa/);
  assert.doesNotMatch(html, /45\.7 kPa/);
  assert.doesNotMatch(html, /89\.0 kPa/);
});

test('does not render generic ADC input when dendrometer is disabled', () => {
  const html = renderToStaticMarkup(
    React.createElement(DraginoTempCard, {
      device: buildDevice(
        {
          dendro_enabled: 0,
        },
        {
          adc_ch0v: 1.234,
        },
      ),
    }),
  );

  assert.doesNotMatch(html, /ADC INPUT/);
});

test('renders Chameleon depth inputs without coefficient workbook controls', () => {
  const html = renderToStaticMarkup(
    React.createElement(DraginoChameleonSwtSection, {
      device: buildDevice({
        chameleon_enabled: 1,
        chameleon_swt1_depth_cm: null,
        chameleon_swt2_depth_cm: 30,
        chameleon_swt3_depth_cm: null,
      }),
      onUpdate: () => {},
    }),
  );
  const dom = new JSDOM(html);
  const swt1Depth = dom.window.document.getElementById('chameleon-A8404101FD5ECF41-SWT1-depth') as HTMLInputElement;
  const swt2Depth = dom.window.document.getElementById('chameleon-A8404101FD5ECF41-SWT2-depth') as HTMLInputElement;
  const swt3Depth = dom.window.document.getElementById('chameleon-A8404101FD5ECF41-SWT3-depth') as HTMLInputElement;

  assert.equal(swt1Depth.value, '');
  assert.equal(swt2Depth.value, '30');
  assert.equal(swt3Depth.value, '');
  assert.equal(swt1Depth.placeholder, '30');
  assert.doesNotMatch(html, /Restore workbook defaults/);
  assert.doesNotMatch(html, /Coefficient/);
});

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

const DOM_GLOBALS = [
  'window',
  'document',
  'HTMLElement',
  'KeyboardEvent',
  'Node',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;

// Creates a visual jsdom page with an opener button and a React root, makes
// it the global DOM for React, and returns a function that puts the previous
// globals back and closes the page.
function installModalDom(): { dom: JSDOM; restore: () => void } {
  const dom = new JSDOM(
    '<!doctype html><html><body><button id="opener">Open</button><div id="root"></div></body></html>',
    { url: 'http://localhost/', pretendToBeVisual: true },
  );
  const runtimeGlobals = globalThis as Record<string, unknown>;
  const previous = DOM_GLOBALS.map((key) => [key, runtimeGlobals[key]] as const);

  Object.assign(runtimeGlobals, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    KeyboardEvent: dom.window.KeyboardEvent,
    Node: dom.window.Node,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
    cancelAnimationFrame: (id: number) => clearTimeout(id),
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  return {
    dom,
    restore: () => {
      for (const [key, value] of previous) {
        if (value === undefined) delete runtimeGlobals[key];
        else runtimeGlobals[key] = value;
      }
      dom.window.close();
    },
  };
}

function renderModal(root: ReturnType<typeof createRoot>, device: Device): void {
  root.render(
    React.createElement(DraginoSettingsModal, {
      device,
      dendroNeedsCalibration: false,
      onUpdate: () => {},
      onClose: () => {},
    }),
  );
}

test('warns before switching temperature-enabled devices away from MOD1', async () => {
  const { dom, restore } = installModalDom();
  const previousSetMode = lsn50API.setMode;

  let confirmCalls = 0;
  let setModeCalls = 0;
  dom.window.confirm = () => {
    confirmCalls += 1;
    return false;
  };
  lsn50API.setMode = async () => {
    setModeCalls += 1;
  };

  let root: ReturnType<typeof createRoot> | null = null;
  try {
    const device = buildDevice(
      {
        temp_enabled: 1,
        dendro_enabled: 1,
        chameleon_enabled: 0,
        device_mode: 1,
      },
      { lsn50_mode_label: 'MOD1' },
    );
    const reactRoot = createRoot(dom.window.document.getElementById('root') as HTMLDivElement);
    root = reactRoot;

    await act(async () => {
      renderModal(reactRoot, device);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const modeSelect = dom.window.document.getElementById(`lsn50-mode-${device.deveui}`) as HTMLSelectElement;
    await act(async () => {
      modeSelect.value = 'MOD3';
      modeSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });

    const applyButton = Array.from(dom.window.document.querySelectorAll('button'))
      .find((button) => button.textContent === 'Apply mode') as HTMLButtonElement | undefined;
    assert.ok(applyButton);

    await act(async () => {
      applyButton.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.equal(confirmCalls, 1);
    assert.equal(setModeCalls, 0);
  } finally {
    const mounted = root;
    if (mounted) {
      act(() => mounted.unmount());
    }
    lsn50API.setMode = previousSetMode;
    restore();
  }
});

test('keeps focus inside the modal when the parent rerenders with a new onClose callback', async () => {
  const { dom, restore } = installModalDom();
  const doc = dom.window.document;
  dom.window.confirm = () => true;

  let root: ReturnType<typeof createRoot> | null = null;
  try {
    const device = buildDevice();
    const opener = doc.getElementById('opener') as HTMLButtonElement;
    const reactRoot = createRoot(doc.getElementById('root') as HTMLDivElement);
    root = reactRoot;

    opener.focus();

    await act(async () => {
      renderModal(reactRoot, device);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const closeButton = Array.from(doc.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Close') as HTMLButtonElement | undefined;
    assert.ok(closeButton);

    // The modal moves focus to its close button one animation frame after it
    // opens. Let that frame run before the user moves focus; otherwise it can
    // land after the move and take focus back, which happened whenever the
    // test ran slowly (#393).
    await act(async () => {
      await nextAnimationFrame(dom.window);
    });
    assertFocused(doc, closeButton, 'after the opening frame');

    const modeSelect = doc.getElementById(`lsn50-mode-${device.deveui}`) as HTMLSelectElement;
    modeSelect.focus();
    assertFocused(doc, modeSelect, 'after focusing the mode select');

    // A new onClose callback on every render, as a parent that does not
    // memoise it would pass.
    await act(async () => {
      renderModal(reactRoot, device);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // If the rerender ran the focus effect again, its cleanup would return
    // focus to the opener at once and its new frame would move it to the
    // close button; wait for that frame so either shows here.
    await act(async () => {
      await nextAnimationFrame(dom.window);
    });

    assertFocused(doc, modeSelect, 'after the parent rerendered');
    assertNotFocused(doc, opener, 'after the parent rerendered');
  } finally {
    const mounted = root;
    if (mounted) {
      act(() => mounted.unmount());
    }
    restore();
  }
});

test('a focus mismatch inside the rendered modal fails at once with a short message', async () => {
  // assert.equal(doc.activeElement, modeSelect) with the close button focused
  // is the check that hung in #393: building its message never finished and
  // the process grew past 3 GB within seconds. assertFocused must fail fast.
  const { dom, restore } = installModalDom();
  const doc = dom.window.document;

  let root: ReturnType<typeof createRoot> | null = null;
  try {
    const device = buildDevice();
    const reactRoot = createRoot(doc.getElementById('root') as HTMLDivElement);
    root = reactRoot;
    await act(async () => {
      renderModal(reactRoot, device);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await nextAnimationFrame(dom.window);
    });

    const modeSelect = doc.getElementById(`lsn50-mode-${device.deveui}`) as HTMLSelectElement;
    assert.ok(Object.keys(modeSelect).some((key) => key.startsWith('__reactFiber$')));

    const started = performance.now();
    let message = '';
    try {
      assertFocused(doc, modeSelect, 'probe');
    } catch (error) {
      assert.ok(error instanceof assert.AssertionError);
      message = error.message;
    }
    const elapsedMs = performance.now() - started;

    assert.equal(
      message,
      `probe: expected focus on <select#lsn50-mode-${device.deveui}>, found it on <button> "Close"`,
    );
    assert.ok(elapsedMs < 1000, `the failing check took ${Math.round(elapsedMs)} ms`);
  } finally {
    const mounted = root;
    if (mounted) {
      act(() => mounted.unmount());
    }
    restore();
  }
});
