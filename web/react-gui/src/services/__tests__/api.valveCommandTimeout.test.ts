import { afterEach, describe, expect, it, vi } from 'vitest';

import api, { VALVE_COMMAND_TIMEOUT_MS, devicesAPI, stregaAPI } from '../api';

// Valve commands are answered only after the radio transport decides, so they wait 30 s;
// every other request keeps the instance default.
describe('valve command timeout', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is 30 s, and the instance default is unchanged', () => {
    expect(VALVE_COMMAND_TIMEOUT_MS).toBe(30_000);
    expect(api.defaults.timeout).toBe(10_000);
  });

  it('applies to POST /api/valve/:deveui', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: {} });
    await devicesAPI.controlValve('0016C001F1000001', { action: 'CLOSE' });
    expect(post).toHaveBeenCalledWith('/api/valve/0016C001F1000001', { action: 'CLOSE' }, { timeout: 30_000 });
  });

  it('applies to the STREGA commands that answer after the transport, not to the model setting', async () => {
    const put = vi.spyOn(api, 'put').mockResolvedValue({ data: {} });
    const eui = '0016C001F1000001';
    await stregaAPI.setUplinkInterval(eui, { closedMinutes: 10 });
    await stregaAPI.setTimedAction(eui, { action: 'OPEN', unit: 'minutes', amount: 2 });
    await stregaAPI.setMagnetEnabled(eui, true);
    await stregaAPI.setPartialOpening(eui, { action: 'OPEN', percentage: 50 });
    await stregaAPI.setFlushing(eui, { returnPosition: 'CLOSE', percentage: 50 });
    await stregaAPI.setModel(eui, 'MOTORIZED');
    const timeouts = put.mock.calls.map(([url, , config]) => [url, config?.timeout]);
    expect(timeouts).toEqual([
      [`/api/devices/${eui}/strega/interval`, 30_000],
      [`/api/devices/${eui}/strega/timed-action`, 30_000],
      [`/api/devices/${eui}/strega/magnet`, 30_000],
      [`/api/devices/${eui}/strega/partial-opening`, 30_000],
      [`/api/devices/${eui}/strega/flushing`, 30_000],
      [`/api/devices/${eui}/strega/model`, undefined],
    ]);
  });
});
