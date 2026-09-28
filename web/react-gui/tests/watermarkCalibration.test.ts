import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { JSDOM } from 'jsdom';
import type ReactType from 'react';
import type { Device, WatermarkCalibrationState, WatermarkCalibrationValues } from '../src/types/farming.ts';

// react-dom probes `isInputEventSupported`/`canUseDOM` exactly ONCE, at its
// own module top-level evaluation, using whatever `window`/`document` exist
// at that instant, and never recomputes it. This tsx/node:test process has no
// DOM at all until a test sets one up, so if react/react-dom/react-i18next
// were imported normally (statically, at the top of this file, before any
// JSDOM exists), that probe would see no DOM, and react-dom would fall back
// forever to the legacy IE9 "input event polyfill" for controlled <input>
// change detection -- which depends on `attachEvent` and never fires
// onChange in jsdom. A throwaway bootstrap document, installed before any of
// those modules are ever imported, makes the probe see a real DOM once, so
// react-dom picks the modern path for the rest of the process (later
// per-test JSDOM instances are unaffected by this bootstrap document itself,
// only by having made the initial probe succeed).
const bootDom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
Object.assign(globalThis, {
  window: bootDom.window,
  document: bootDom.window.document,
});

const i18nModule = await import('i18next');
const i18n = i18nModule.default;
const { initReactI18next } = await import('react-i18next');
const ReactModule = await import('react');
const React = ReactModule.default as unknown as typeof ReactType;
const { act } = ReactModule;
const { createRoot } = await import('react-dom/client');
const { WatermarkCalibrationSection } = await import('../src/components/farming/WatermarkCalibrationSection.tsx');
const { WatermarkDepthSection } = await import('../src/components/farming/WatermarkDepthSection.tsx');
const { deviceMetadataAPI, lsn50API } = await import('../src/services/api.ts');

// Real English `devices` resources, loaded synchronously with no HTTP
// backend and no suspense, so t() renders the same messages the app shows
// instead of falling back to raw keys (react-i18next's behaviour with no
// initialized instance at all).
const devicesEn = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, '../public/locales/en/devices.json'), 'utf8'),
);
if (!i18n.isInitialized) {
  i18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    ns: ['devices'],
    defaultNS: 'devices',
    resources: { en: { devices: devicesEn } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
}

function buildDevice(overrides: Partial<Device> = {}): Device {
  return {
    deveui: 'A840410100000001',
    name: 'WATERMARK LSN50',
    type_id: 'DRAGINO_LSN50',
    latest_data: {},
    ...overrides,
  } as Device;
}

const VALID_VALUES: WatermarkCalibrationValues = {
  pullup_1_ohm: 47000,
  pulldown_1_ohm: 47000,
  series_fwd_1_ohm: 10,
  series_rev_1_ohm: 10,
  pullup_2_ohm: 47000,
  pulldown_2_ohm: 47000,
  series_fwd_2_ohm: 10,
  series_rev_2_ohm: 10,
};

const EMPTY_CALIBRATION_STATE: WatermarkCalibrationState = { deveui: buildDevice().deveui, sync_version: 0, calibration: null };

type Harness = {
  dom: JSDOM;
  render: (element: ReactType.ReactElement) => Promise<void>;
  type: (input: HTMLInputElement, value: string) => Promise<void>;
  click: (button: HTMLButtonElement) => Promise<void>;
  text: () => string;
  input: (name: string) => HTMLInputElement;
  button: (label: string) => HTMLButtonElement | undefined;
};

/**
 * A minimal JSDOM + React act() harness in the style of
 * tests/draginoSettings.test.ts's interactive tests (global window/document
 * reassignment, requestAnimationFrame shim, IS_REACT_ACT_ENVIRONMENT), but
 * factored into one helper since this file needs it six times.
 */
async function withHarness(run: (h: Harness) => Promise<void>): Promise<void> {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    { url: 'http://localhost/', pretendToBeVisual: true },
  );
  const runtimeGlobals = globalThis as Record<string, unknown> & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    Node: globalThis.Node,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: runtimeGlobals.IS_REACT_ACT_ENVIRONMENT,
  };

  Object.assign(runtimeGlobals, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number,
    cancelAnimationFrame: (id: number) => clearTimeout(id),
  });
  runtimeGlobals.IS_REACT_ACT_ENVIRONMENT = true;

  const container = dom.window.document.getElementById('root') as HTMLDivElement;
  const root = createRoot(container);

  const flush = async (action: () => void) => {
    await act(async () => {
      action();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  const render = async (element: ReactType.ReactElement) => {
    await flush(() => root.render(element));
  };

  // React installs its own `value` property tracker on a mounted controlled
  // input's DOM node, to tell a real user edit apart from a re-render. Setting
  // `input.value = x` directly goes through that same tracker, so it thinks
  // nothing changed and the dispatched 'input' event never reaches onChange
  // (the classic jsdom + React gotcha; this is the same native-setter bypass
  // @testing-library/react's fireEvent.change uses).
  const nativeValueSetter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
  const type = async (input: HTMLInputElement, value: string) => {
    await flush(() => {
      nativeValueSetter.call(input, value);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };

  const click = async (button: HTMLButtonElement) => {
    await flush(() => button.click());
  };

  const text = () => container.textContent ?? '';
  const input = (name: string) => dom.window.document.querySelector(`input[name="${name}"]`) as HTMLInputElement;
  const button = (label: string) =>
    Array.from(dom.window.document.querySelectorAll('button')).find((b) => b.textContent === label) as HTMLButtonElement | undefined;

  try {
    await run({ dom, render, type, click, text, input, button });
  } finally {
    act(() => root.unmount());
    if (previous.window) runtimeGlobals.window = previous.window; else delete runtimeGlobals.window;
    if (previous.document) runtimeGlobals.document = previous.document; else delete runtimeGlobals.document;
    if (previous.HTMLElement) runtimeGlobals.HTMLElement = previous.HTMLElement; else delete runtimeGlobals.HTMLElement;
    if (previous.Node) runtimeGlobals.Node = previous.Node; else delete runtimeGlobals.Node;
    if (previous.requestAnimationFrame) runtimeGlobals.requestAnimationFrame = previous.requestAnimationFrame; else delete runtimeGlobals.requestAnimationFrame;
    if (previous.cancelAnimationFrame) runtimeGlobals.cancelAnimationFrame = previous.cancelAnimationFrame; else delete runtimeGlobals.cancelAnimationFrame;
    if (previous.IS_REACT_ACT_ENVIRONMENT === undefined) delete runtimeGlobals.IS_REACT_ACT_ENVIRONMENT; else runtimeGlobals.IS_REACT_ACT_ENVIRONMENT = previous.IS_REACT_ACT_ENVIRONMENT;
    dom.window.close();
  }
}

async function fillValidValues(h: Harness) {
  for (const [key, value] of Object.entries(VALID_VALUES)) {
    await h.type(h.input(key), String(value));
  }
}

test('(a) WatermarkCalibrationSection loads with no calibration: eight empty inputs, Save disabled', async () => {
  const device = buildDevice();
  const previousGet = lsn50API.getWatermarkCalibration;
  lsn50API.getWatermarkCalibration = async () => ({ ...EMPTY_CALIBRATION_STATE, deveui: device.deveui });
  try {
    await withHarness(async (h) => {
      await h.render(React.createElement(WatermarkCalibrationSection, { device, onUpdate: () => {} }));

      const inputs = Array.from(h.dom.window.document.querySelectorAll('input[name]')) as HTMLInputElement[];
      assert.equal(inputs.length, 8);
      for (const el of inputs) assert.equal(el.value, '');

      const save = h.button('Save calibration');
      assert.ok(save, 'Save calibration button not found');
      assert.equal(save!.disabled, true);
    });
  } finally {
    lsn50API.getWatermarkCalibration = previousGet;
  }
});

test('(b) Preview calls previewWatermarkCalibration with numbers and renders the per-probe result', async () => {
  const device = buildDevice();
  const previousGet = lsn50API.getWatermarkCalibration;
  const previousPreview = lsn50API.previewWatermarkCalibration;
  let previewArgs: [string, WatermarkCalibrationValues] | null = null;
  lsn50API.getWatermarkCalibration = async () => ({ ...EMPTY_CALIBRATION_STATE, deveui: device.deveui });
  lsn50API.previewWatermarkCalibration = async (deveui, values) => {
    previewArgs = [deveui, values];
    return {
      preview: {
        recorded_at: '2026-09-26T00:00:00.000Z',
        channels: [
          { status: 'ok', kpa: 30, kpa_upper_bound: null, r_solved: 1000, r_upper_bound: null, offset_mv: null, r_fwd: 1000, r_rev: 1000 },
          { status: 'open', kpa: null, kpa_upper_bound: null, r_solved: null, r_upper_bound: null, offset_mv: null, r_fwd: null, r_rev: null },
        ],
      },
    };
  };
  try {
    await withHarness(async (h) => {
      await h.render(React.createElement(WatermarkCalibrationSection, { device, onUpdate: () => {} }));
      await fillValidValues(h);

      const preview = h.button('Preview');
      assert.ok(preview, 'Preview button not found');
      await h.click(preview!);

      assert.ok(previewArgs, 'previewWatermarkCalibration was not called');
      assert.equal(previewArgs![0], device.deveui);
      for (const [key, value] of Object.entries(VALID_VALUES)) {
        const got = (previewArgs![1] as Record<string, unknown>)[key];
        assert.equal(typeof got, 'number', `${key} must be a number, got ${typeof got}`);
        assert.equal(got, value);
      }

      // Channel 1 (ok, 30 kPa) and channel 2 (open, faulted) each render.
      // formatSwtValue always shows one decimal place.
      assert.match(h.text(), /30\.0 kPa/);
      assert.match(h.text(), /Dry beyond range or disconnected/);
    });
  } finally {
    lsn50API.getWatermarkCalibration = previousGet;
    lsn50API.previewWatermarkCalibration = previousPreview;
  }
});

test('(b2) editing a draft field after Preview clears the stale preview text', async () => {
  const device = buildDevice();
  const previousGet = lsn50API.getWatermarkCalibration;
  const previousPreview = lsn50API.previewWatermarkCalibration;
  lsn50API.getWatermarkCalibration = async () => ({ ...EMPTY_CALIBRATION_STATE, deveui: device.deveui });
  lsn50API.previewWatermarkCalibration = async () => ({
    preview: {
      recorded_at: '2026-09-26T00:00:00.000Z',
      channels: [
        { status: 'ok', kpa: 30, kpa_upper_bound: null, r_solved: 1000, r_upper_bound: null, offset_mv: null, r_fwd: 1000, r_rev: 1000 },
        { status: 'open', kpa: null, kpa_upper_bound: null, r_solved: null, r_upper_bound: null, offset_mv: null, r_fwd: null, r_rev: null },
      ],
    },
  });
  try {
    await withHarness(async (h) => {
      await h.render(React.createElement(WatermarkCalibrationSection, { device, onUpdate: () => {} }));
      await fillValidValues(h);

      const preview = h.button('Preview');
      assert.ok(preview, 'Preview button not found');
      await h.click(preview!);
      assert.match(h.text(), /30\.0 kPa/, 'expected the preview text to render before the edit');

      await h.type(h.input('pullup_1_ohm'), String(VALID_VALUES.pullup_1_ohm + 1));

      assert.doesNotMatch(h.text(), /30\.0 kPa/, 'stale preview text must be cleared once a draft field changes');
    });
  } finally {
    lsn50API.getWatermarkCalibration = previousGet;
    lsn50API.previewWatermarkCalibration = previousPreview;
  }
});

test('(c) Save calls saveWatermarkCalibration(deveui, values, sync_version) then onUpdate', async () => {
  const device = buildDevice();
  const previousGet = lsn50API.getWatermarkCalibration;
  const previousSave = lsn50API.saveWatermarkCalibration;
  let saveArgs: [string, WatermarkCalibrationValues, number] | null = null;
  let onUpdateCalls = 0;
  lsn50API.getWatermarkCalibration = async () => ({ ...EMPTY_CALIBRATION_STATE, deveui: device.deveui, sync_version: 0 });
  lsn50API.saveWatermarkCalibration = async (deveui, values, expectedSyncVersion) => {
    saveArgs = [deveui, values as WatermarkCalibrationValues, expectedSyncVersion];
    return {
      deveui,
      sync_version: 1,
      calibration: { ...VALID_VALUES, measured_at: null, method: null, worst_residual_pct: null, notes: null, updated_at: '2026-09-26T00:00:00.000Z' },
      backfilled: 3,
    };
  };
  try {
    await withHarness(async (h) => {
      await h.render(React.createElement(WatermarkCalibrationSection, { device, onUpdate: () => { onUpdateCalls += 1; } }));
      await fillValidValues(h);

      const save = h.button('Save calibration');
      assert.ok(save);
      await h.click(save!);

      assert.ok(saveArgs, 'saveWatermarkCalibration was not called');
      assert.equal(saveArgs![0], device.deveui);
      assert.deepEqual(saveArgs![1], VALID_VALUES);
      assert.equal(saveArgs![2], 0);
      assert.equal(onUpdateCalls, 1);
      assert.match(h.text(), /Calibration saved\. 3 waiting readings converted\./);
    });
  } finally {
    lsn50API.getWatermarkCalibration = previousGet;
    lsn50API.saveWatermarkCalibration = previousSave;
  }
});

test('(d) A 409 from save shows the conflict message and reloads via getWatermarkCalibration', async () => {
  const device = buildDevice();
  const previousGet = lsn50API.getWatermarkCalibration;
  const previousSave = lsn50API.saveWatermarkCalibration;
  let getCalls = 0;
  lsn50API.getWatermarkCalibration = async () => {
    getCalls += 1;
    return { ...EMPTY_CALIBRATION_STATE, deveui: device.deveui, sync_version: getCalls === 1 ? 0 : 5 };
  };
  lsn50API.saveWatermarkCalibration = async () => {
    const error = { isAxiosError: true, response: { status: 409, data: {} } };
    throw error;
  };
  try {
    await withHarness(async (h) => {
      await h.render(React.createElement(WatermarkCalibrationSection, { device, onUpdate: () => {} }));
      await fillValidValues(h);

      const save = h.button('Save calibration');
      assert.ok(save);
      await h.click(save!);

      assert.equal(getCalls, 2, 'expected a reload via getWatermarkCalibration after the 409');
      assert.match(
        h.text(),
        /The calibration changed elsewhere\. The current values are loaded; check them and save again\./,
      );
    });
  } finally {
    lsn50API.getWatermarkCalibration = previousGet;
    lsn50API.saveWatermarkCalibration = previousSave;
  }
});

test("(e) A 400 with field 'series_rev_2_ohm' shows the invalid-field message", async () => {
  const device = buildDevice();
  const previousGet = lsn50API.getWatermarkCalibration;
  const previousSave = lsn50API.saveWatermarkCalibration;
  lsn50API.getWatermarkCalibration = async () => ({ ...EMPTY_CALIBRATION_STATE, deveui: device.deveui });
  lsn50API.saveWatermarkCalibration = async () => {
    const error = { isAxiosError: true, response: { status: 400, data: { field: 'series_rev_2_ohm' } } };
    throw error;
  };
  try {
    await withHarness(async (h) => {
      await h.render(React.createElement(WatermarkCalibrationSection, { device, onUpdate: () => {} }));
      await fillValidValues(h);

      const save = h.button('Save calibration');
      assert.ok(save);
      await h.click(save!);

      assert.match(h.text(), /Check series_rev_2_ohm: out of range\./);
    });
  } finally {
    lsn50API.getWatermarkCalibration = previousGet;
    lsn50API.saveWatermarkCalibration = previousSave;
  }
});

test('(f) WatermarkDepthSection shows the saved probe depth and keeps other keys on save', async () => {
  const device = buildDevice({ soil_moisture_probe_depths_json: { swt_1: 20, some_other_probe: 5 } });
  const previousSet = deviceMetadataAPI.setSoilMoistureDepths;
  let setArgs: [string, Record<string, number>] | null = null;
  deviceMetadataAPI.setSoilMoistureDepths = async (deveui, soilMoistureProbeDepths) => {
    setArgs = [deveui, soilMoistureProbeDepths];
    return device;
  };
  try {
    await withHarness(async (h) => {
      await h.render(React.createElement(WatermarkDepthSection, { device, onUpdate: () => {} }));

      const depth1 = h.input('depth_swt_1');
      const depth2 = h.input('depth_swt_2');
      assert.equal(depth1.value, '20');
      assert.equal(depth2.value, '');

      await h.type(depth2, '40');
      const save = h.button('Save depths');
      assert.ok(save);
      await h.click(save!);

      assert.ok(setArgs, 'setSoilMoistureDepths was not called');
      assert.equal(setArgs![0], device.deveui);
      assert.deepEqual(setArgs![1], { swt_1: 20, swt_2: 40, some_other_probe: 5 });
    });
  } finally {
    deviceMetadataAPI.setSoilMoistureDepths = previousSet;
  }
});

test('(g) WatermarkDepthSection rejects "20 cm" without calling the API', async () => {
  const device = buildDevice({ soil_moisture_probe_depths_json: { swt_1: 20, some_other_probe: 5 } });
  const previousSet = deviceMetadataAPI.setSoilMoistureDepths;
  let setCalls = 0;
  deviceMetadataAPI.setSoilMoistureDepths = async () => { setCalls += 1; return device; };
  try {
    await withHarness(async (h) => {
      await h.render(React.createElement(WatermarkDepthSection, { device, onUpdate: () => {} }));

      const depth2 = h.input('depth_swt_2');
      await h.type(depth2, '20 cm');
      const save = h.button('Save depths');
      assert.ok(save);
      await h.click(save!);

      assert.equal(setCalls, 0, 'setSoilMoistureDepths must not be called for an unparseable depth');
      assert.match(h.text(), /Depths must be whole centimetres between 1 and 1000, or blank\./);
    });
  } finally {
    deviceMetadataAPI.setSoilMoistureDepths = previousSet;
  }
});

test('(h) WatermarkDepthSection rejects "20.5" without calling the API', async () => {
  const device = buildDevice({ soil_moisture_probe_depths_json: { swt_1: 20, some_other_probe: 5 } });
  const previousSet = deviceMetadataAPI.setSoilMoistureDepths;
  let setCalls = 0;
  deviceMetadataAPI.setSoilMoistureDepths = async () => { setCalls += 1; return device; };
  try {
    await withHarness(async (h) => {
      await h.render(React.createElement(WatermarkDepthSection, { device, onUpdate: () => {} }));

      const depth2 = h.input('depth_swt_2');
      await h.type(depth2, '20.5');
      const save = h.button('Save depths');
      assert.ok(save);
      await h.click(save!);

      assert.equal(setCalls, 0, 'setSoilMoistureDepths must not be called for a fractional depth');
      assert.match(h.text(), /Depths must be whole centimetres between 1 and 1000, or blank\./);
    });
  } finally {
    deviceMetadataAPI.setSoilMoistureDepths = previousSet;
  }
});

test('(i) WatermarkDepthSection: blanking probe 2 removes swt_2 and keeps the other keys', async () => {
  const device = buildDevice({ soil_moisture_probe_depths_json: { swt_1: 20, swt_2: 15, some_other_probe: 5 } });
  const previousSet = deviceMetadataAPI.setSoilMoistureDepths;
  let setArgs: [string, Record<string, number>] | null = null;
  deviceMetadataAPI.setSoilMoistureDepths = async (deveui, soilMoistureProbeDepths) => {
    setArgs = [deveui, soilMoistureProbeDepths];
    return device;
  };
  try {
    await withHarness(async (h) => {
      await h.render(React.createElement(WatermarkDepthSection, { device, onUpdate: () => {} }));

      const depth2 = h.input('depth_swt_2');
      assert.equal(depth2.value, '15');
      await h.type(depth2, '');

      const save = h.button('Save depths');
      assert.ok(save);
      await h.click(save!);

      assert.ok(setArgs, 'setSoilMoistureDepths was not called');
      assert.equal(setArgs![0], device.deveui);
      assert.deepEqual(setArgs![1], { swt_1: 20, some_other_probe: 5 });
    });
  } finally {
    deviceMetadataAPI.setSoilMoistureDepths = previousSet;
  }
});
