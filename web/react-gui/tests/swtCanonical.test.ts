import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectDeviceSwtValues,
  summarizeSwtValues,
} from '../src/utils/swt.ts';
import type { Device } from '../src/types/farming.ts';

function device(latest_data: Partial<Device['latest_data']>): Pick<Device, 'latest_data'> {
  return { latest_data: latest_data as Device['latest_data'] };
}

test('uses canonical SWT channels from Chameleon-only devices', () => {
  const values = collectDeviceSwtValues([
    device({ swt_1: 12, swt_2: 18, swt_3: 30 }),
  ]);

  assert.deepEqual(values, [12, 18, 30]);
  assert.deepEqual(summarizeSwtValues(values), { label: 'Moderate', swt: 20 });
});

test('uses legacy Kiwi SWT fields only as fallback aliases', () => {
  const values = collectDeviceSwtValues([
    device({ swt_wm1: 99, swt_wm2: 88, swt_1: 11, swt_2: 22 }),
    device({ swt_wm1: 30, swt_wm2: 40 }),
  ]);

  assert.deepEqual(values, [11, 22, 30, 40]);
  assert.deepEqual(summarizeSwtValues(values), { label: 'Moderate', swt: 25.75 });
});
