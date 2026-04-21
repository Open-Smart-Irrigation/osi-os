import assert from 'node:assert/strict';
import test from 'node:test';

import { JSDOM } from 'jsdom';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { act } from 'react-dom/test-utils';

import { DraginoDendroCalibrationSection } from '../src/components/farming/DraginoDendroCalibrationSection.tsx';
import {
  DraginoSettingsModal,
  getFocusableElements,
} from '../src/components/farming/DraginoSettingsModal.tsx';
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
