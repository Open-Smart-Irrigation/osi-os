import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { DraginoDendroCalibrationSection } from '../src/components/farming/DraginoDendroCalibrationSection.tsx';
import { DraginoSettingsModal } from '../src/components/farming/DraginoSettingsModal.tsx';
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
