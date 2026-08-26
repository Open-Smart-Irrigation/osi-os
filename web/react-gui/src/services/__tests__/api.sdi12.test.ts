import { describe, expect, it } from 'vitest';

import { normaliseDevice } from '../api';

describe('SDI-12 device API normalization', () => {
  it('narrows a canonical snake-case Sentek layout and preserves status', () => {
    const device = normaliseDevice({
      deveui: 'a840410000000201',
      type_id: 'DRAGINO_SDI12',
      latest_data: { vwc_10: 18.2, soil_vic_10: 0.25 },
      sdi12_channel_layout_json: {
        version: 1,
        address: 'L',
        sensors: [{ channel: 10, response_position: 1, depth_cm: 100, type: 'TRISCAN' }],
      },
      sdi12_layout_status: 'configured',
    });

    expect(device.deveui).toBe('A840410000000201');
    expect(device.sdi12_channel_layout_json?.sensors[0]).toEqual({
      channel: 10,
      response_position: 1,
      depth_cm: 100,
      type: 'TRISCAN',
    });
    expect(device.sdi12_layout_status).toBe('configured');
    expect(device.latest_data).toMatchObject({ vwc_10: 18.2, soil_vic_10: 0.25 });
  });

  it('fails malformed or duplicate layouts closed and exposes invalid status', () => {
    const device = normaliseDevice({
      deveui: 'A840410000000202',
      type_id: 'DRAGINO_SDI12',
      sdi12_channel_layout_json: {
        version: 1,
        address: 'L',
        sensors: [
          { channel: 1, response_position: 1, depth_cm: 10, type: 'ENVIROSCAN' },
          { channel: 1, response_position: 2, depth_cm: 20, type: 'ENVIROSCAN' },
        ],
      },
    });

    expect(device.sdi12_channel_layout_json).toBeNull();
    expect(device.sdi12_layout_status).toBe('invalid');
  });
});
