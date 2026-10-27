import { beforeEach, describe, expect, it, vi } from 'vitest';

const { get, put, post } = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  post: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => ({
      get,
      put,
      post,
      delete: vi.fn(),
      interceptors: { request: { use: vi.fn() }, response: { use: vi.fn() } },
    })),
    isAxiosError: vi.fn(() => false),
  },
}));

import { irrigationPolicyAPI } from '../api';

beforeEach(() => {
  get.mockReset();
  put.mockReset();
  post.mockReset();
});

describe('irrigationPolicyAPI', () => {
  it('reads the local policy route and normalizes runtime fields', async () => {
    get.mockResolvedValue({
      data: {
        zone: { id: 7, zone_uuid: 'zone-1', name: 'North', timezone: 'Europe/Zurich' },
        policy: null,
        schedules: [],
        source_choices: { SWT: [], VWC: [], DENDRO: [] },
        availability: 'unavailable',
        next_check: null,
        legacy_process_timezone: null,
      },
    });

    const result = await irrigationPolicyAPI.get(7);

    expect(get).toHaveBeenCalledWith('/api/irrigation-zones/7/irrigation-policy');
    expect(result.zone.zoneUuid).toBe('zone-1');
    expect(result.runtime.availability).toBe('unavailable');
    expect(result.runtime.nextCheck).toBeNull();
  });

  it('saves snake_case policy fields and keeps the normalized 202 response', async () => {
    put.mockResolvedValue({
      status: 202,
      data: {
        zone: { zone_uuid: 'zone-1', name: 'North', timezone: 'Europe/Zurich' },
        policy: {
          policy_uuid: 'policy-1', zone_uuid: 'zone-1', sync_version: 8,
          condition: { kind: 'SWT', threshold_kpa: 20, sources: [] }, timezone: 'Europe/Zurich', enabled: true,
        },
        schedules: [],
        pending: { actions: [{ state: 'UPDATING' }] },
        runtime: { availability: 'fresh', valves: [] },
      },
    });

    const result = await irrigationPolicyAPI.save(7, {
      policyUuid: 'policy-1', expectedPolicyVersion: 7, zoneUuid: 'zone-1',
      condition: { kind: 'SWT', threshold: 20, sources: [] },
      schedules: [{ scheduleUuid: 'schedule-1', expectedSyncVersion: 3, deviceEui: 'aa11', detach: false }],
    });

    expect(put).toHaveBeenCalledWith('/api/irrigation-zones/7/irrigation-policy', expect.objectContaining({
      policy_uuid: 'policy-1', expected_policy_version: 7,
      schedules: [expect.objectContaining({ schedule_uuid: 'schedule-1', expected_sync_version: 3, detach: false })],
    }));
    expect(result.policy?.syncVersion).toBe(8);
    expect(result.pending.actions).toHaveLength(1);
    expect(result.httpStatus).toBe(202);
  });

  it('keeps pause and retry actions on the same normalized boundary', async () => {
    post
      .mockResolvedValueOnce({ status: 202, data: { status: 202, policy: { policy_uuid: 'policy-1', sync_version: 8, enabled: false }, cancellations: [{ device_eui: 'AA11', pending: true }] } })
      .mockResolvedValueOnce({ status: 202, data: { status: 202, device_eui: 'AA11', revision: { revision_id: 'rev-1' }, send: { pending: true } } });

    const pause = await irrigationPolicyAPI.pause(7);
    const retry = await irrigationPolicyAPI.retryValve(7, 'aa11');

    expect(post).toHaveBeenNthCalledWith(1, '/api/irrigation-zones/7/irrigation-policy/pause', {});
    expect(post).toHaveBeenNthCalledWith(2, '/api/irrigation-zones/7/irrigation-policy/retry-valve', { device_eui: 'AA11' });
    expect(pause).toMatchObject({ status: 202, cancellations: [{ device_eui: 'AA11', pending: true }] });
    expect(retry).toMatchObject({ status: 202, deviceEui: 'AA11', result: { revision: { revision_id: 'rev-1' } } });
  });

  it('uses the opaque before cursor when loading decision history', async () => {
    get.mockResolvedValue({ data: { decisions: [{ decision: 'SKIP' }], next_cursor: 'cursor-2', limit: 10 } });

    const result = await irrigationPolicyAPI.decisions(7, { before: 'cursor-1', limit: 10 });

    expect(get).toHaveBeenCalledWith('/api/irrigation-zones/7/irrigation-policy/decisions', {
      params: { before: 'cursor-1', limit: 10 },
    });
    expect(result).toEqual({ decisions: [{ decision: 'SKIP' }], nextCursor: 'cursor-2', limit: 10 });
  });
});
