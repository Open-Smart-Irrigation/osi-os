import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getDisplayedStregaState,
  getRecognizedStregaModel,
  shouldShowStregaTargetState,
} from '../src/components/farming/StregaValveCard.tsx';
import { buildDeviceFooterMeta } from '../src/components/farming/shared/deviceCardBattery.ts';
import type { Device } from '../src/types/farming.ts';

function buildDevice(overrides: Partial<Device> = {}): Device {
  return {
    deveui: '70B3D57708000334',
    name: 'Valve White',
    type_id: 'STREGA_VALVE',
    latest_data: {},
    current_state: 'CLOSED',
    target_state: 'CLOSED',
    ...overrides,
  };
}

test('explicit motorized model wins over legacy name heuristics', () => {
  const device = buildDevice({
    name: 'Standard valve',
    strega_model: 'MOTORIZED',
  });

  assert.equal(getRecognizedStregaModel(device), 'MOTORIZED');
});

test('unknown model stays locked until explicit metadata or a known name hint exists', () => {
  const device = buildDevice({
    name: 'Valve White',
    strega_model: null,
  });

  assert.equal(getRecognizedStregaModel(device), 'UNKNOWN');
});

test('battery footer renders when STREGA battery percent is available', () => {
  const device = buildDevice({
    latest_data: {
      bat_pct: 88,
    },
  });

  assert.equal(
    buildDeviceFooterMeta({ batPct: device.latest_data?.bat_pct, lastSeenLabel: '5 min ago' }),
    '🔋 88% · 5 min ago',
  );
});

test('current state stays primary while a different target state is shown as pending', () => {
  const device = buildDevice({
    current_state: 'CLOSED',
    target_state: 'OPEN',
  });

  assert.equal(getDisplayedStregaState(device), 'CLOSED');
  assert.equal(shouldShowStregaTargetState(device), true);
});

test('target state becomes the displayed fallback when current state is still missing', () => {
  const device = buildDevice({
    current_state: undefined,
    target_state: 'OPEN',
  });

  assert.equal(getDisplayedStregaState(device), 'OPEN');
  assert.equal(shouldShowStregaTargetState(device), true);
});
