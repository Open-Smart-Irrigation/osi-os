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

test('renders absent Chameleon coefficients as blank values with workbook default placeholders', () => {
  const html = renderToStaticMarkup(
    React.createElement(DraginoChameleonSwtSection, {
      device: buildDevice({
        chameleon_enabled: 1,
        chameleon_swt1_a: null,
        chameleon_swt1_b: null,
        chameleon_swt1_c: null,
      }),
      onUpdate: () => {},
    }),
  );
  const dom = new JSDOM(html);
  const coefficientA = dom.window.document.getElementById('chameleon-A8404101FD5ECF41-SWT1-a') as HTMLInputElement;
  const coefficientB = dom.window.document.getElementById('chameleon-A8404101FD5ECF41-SWT1-b') as HTMLInputElement;
  const coefficientC = dom.window.document.getElementById('chameleon-A8404101FD5ECF41-SWT1-c') as HTMLInputElement;

  assert.equal(coefficientA.value, '');
  assert.equal(coefficientB.value, '');
  assert.equal(coefficientC.value, '');
  assert.equal(coefficientA.placeholder, '10.71');
  assert.equal(coefficientB.placeholder, '0.13');
  assert.equal(coefficientC.placeholder, '7.18');
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

test('warns before switching temperature-enabled devices away from MOD1', async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><button id="opener">Open</button><div id="root"></div></body></html>',
    { url: 'http://localhost/', pretendToBeVisual: true },
  );
  const runtimeGlobals = globalThis as Record<string, unknown> & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousKeyboardEvent = globalThis.KeyboardEvent;
  const previousNode = globalThis.Node;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const previousActEnvironment = runtimeGlobals.IS_REACT_ACT_ENVIRONMENT;
  const previousSetMode = lsn50API.setMode;

  Object.assign(runtimeGlobals, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    KeyboardEvent: dom.window.KeyboardEvent,
    Node: dom.window.Node,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  });
  runtimeGlobals.IS_REACT_ACT_ENVIRONMENT = true;

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
    const container = dom.window.document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);

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
    if (root) {
      act(() => root.unmount());
    }
    lsn50API.setMode = previousSetMode;
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
    if (previousActEnvironment === undefined) delete runtimeGlobals.IS_REACT_ACT_ENVIRONMENT;
    else runtimeGlobals.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    dom.window.close();
  }
});

test('keeps focus inside the modal when the parent rerenders with a new onClose callback', async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><button id="opener">Open</button><div id="root"></div></body></html>',
    { url: 'http://localhost/', pretendToBeVisual: true },
  );
  const runtimeGlobals = globalThis as Record<string, unknown> & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousKeyboardEvent = globalThis.KeyboardEvent;
  const previousNode = globalThis.Node;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
  const previousConfirm = globalThis.window?.confirm;
  const previousActEnvironment = runtimeGlobals.IS_REACT_ACT_ENVIRONMENT;

  Object.assign(runtimeGlobals, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    KeyboardEvent: dom.window.KeyboardEvent,
    Node: dom.window.Node,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) as unknown as number,
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  });
  runtimeGlobals.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.confirm = () => true;

  let root: ReturnType<typeof createRoot> | null = null;
  try {
    const device = buildDevice();
    const opener = dom.window.document.getElementById('opener') as HTMLButtonElement;
    const container = dom.window.document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);

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
  } finally {
    if (root) {
      act(() => root.unmount());
    }
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
    if (previousActEnvironment === undefined) delete runtimeGlobals.IS_REACT_ACT_ENVIRONMENT;
    else runtimeGlobals.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    if (previousConfirm && globalThis.window) globalThis.window.confirm = previousConfirm;
    dom.window.close();
  }
});
