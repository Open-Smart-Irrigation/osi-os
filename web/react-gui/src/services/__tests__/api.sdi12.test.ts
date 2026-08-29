import { describe, expect, it, vi } from 'vitest';

import { api, normaliseDevice, postSdi12RecipeApply, postSdi12RecipeRollback } from '../api';

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

  it('normalizes only bounded deployment state and a valid discovered address', () => {
    const device = normaliseDevice({
      deveui: 'a840410000000203', type_id: 'DRAGINO_SDI12', latest_data: {},
      sdi12_discovered_address: 'C',
      sdi12_recipe_deployment: {
        desired_version: 3, desired_layout_hash: 'abc', status: 'queued',
        queued_at: '2026-08-29T12:00:00.000Z', queue_drained_at: null,
        commissioning_deadline_at: null, last_observed_at: null, compatible_at: null,
        updated_at: '2026-08-29T12:00:00.000Z', frame_count: 7,
        compatible_available: false, last_error_code: null, queue_item_ids: ['secret'],
      },
    });

    expect(device.sdi12_discovered_address).toBe('C');
    expect(device.sdi12_recipe_deployment).toMatchObject({ desired_version: 3, status: 'queued', frame_count: 7 });
    expect(JSON.stringify(device.sdi12_recipe_deployment)).not.toContain('secret');
    expect(normaliseDevice({
      deveui: 'a840410000000204', type_id: 'DRAGINO_SDI12', latest_data: {},
      sdi12_discovered_address: 'too-long', sdi12_recipe_deployment: { status: 'invented' },
    }).sdi12_recipe_deployment).toBeNull();
  });

  it('posts apply and rollback with no body to encoded device paths', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: {
      desired_version: 2, status: 'queueing', desired_layout_hash: null, queued_at: null,
      queue_drained_at: null, commissioning_deadline_at: null, last_observed_at: null,
      compatible_at: null, updated_at: null, frame_count: 1, compatible_available: false, last_error_code: null,
    } });
    await expect(postSdi12RecipeApply('ab/c')).resolves.toMatchObject({ desired_version: 2, status: 'queueing' });
    await expect(postSdi12RecipeRollback('ab/c')).resolves.toMatchObject({ desired_version: 2, status: 'queueing' });
    expect(post).toHaveBeenNthCalledWith(1, '/api/devices/ab%2Fc/sdi12/recipe/apply');
    expect(post).toHaveBeenNthCalledWith(2, '/api/devices/ab%2Fc/sdi12/recipe/rollback');
    post.mockRestore();
  });
});
