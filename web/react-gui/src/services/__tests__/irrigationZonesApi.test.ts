import { beforeEach, describe, expect, it, vi } from 'vitest';

const { get, put } = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => ({
      get,
      post: vi.fn(),
      put,
      delete: vi.fn(),
      interceptors: {
        request: { use: vi.fn() },
        response: { use: vi.fn() },
      },
    })),
    // toRenameError (api.ts) calls axios.isAxiosError to decide whether a
    // rejection carries a `.reason`. The rest of this file's mock only
    // stubs `default.create`, so without this the rename tests below would
    // throw "axios.isAxiosError is not a function" instead of exercising
    // the seam. Same marker-property convention as valvesAPI.test.ts's mock.
    isAxiosError: vi.fn((error: any) => !!(error && error.isAxiosError)),
  },
}));

import { devicesAPI, irrigationZonesAPI } from '../api';

const baseZone = {
  id: 7,
  name: 'North field',
  device_count: 0,
  created_at: '2026-07-16T08:00:00Z',
  updated_at: '2026-07-16T08:00:00Z',
  schedule: null,
};

beforeEach(() => {
  get.mockReset();
  put.mockReset();
});

/** An axios rejection shaped like the rename routes' `400 { message, reason }`. */
function axiosError(status: number, data: Record<string, unknown>) {
  return { isAxiosError: true, response: { status, data } };
}

describe('irrigationZonesAPI.getAll', () => {
  it('normalizes snake_case zone UUIDs into both typed aliases', async () => {
    get.mockResolvedValue({
      data: [{ ...baseZone, zone_uuid: 'zone-snake' }],
    });

    const [zone] = await irrigationZonesAPI.getAll();

    expect(zone.zone_uuid).toBe('zone-snake');
    expect(zone.zoneUuid).toBe('zone-snake');
  });

  it('normalizes camelCase zone UUIDs into both typed aliases', async () => {
    get.mockResolvedValue({
      data: [{ ...baseZone, zoneUuid: 'zone-camel' }],
    });

    const [zone] = await irrigationZonesAPI.getAll();

    expect(zone.zone_uuid).toBe('zone-camel');
    expect(zone.zoneUuid).toBe('zone-camel');
  });

  it('normalizes a missing zone UUID to null in both aliases', async () => {
    get.mockResolvedValue({
      data: [baseZone],
    });

    const [zone] = await irrigationZonesAPI.getAll();

    expect(zone.zone_uuid).toBeNull();
    expect(zone.zoneUuid).toBeNull();
  });

  it('uses the edge snake_case UUID as the canonical value when aliases conflict', async () => {
    get.mockResolvedValueOnce({ data: [{
      ...baseZone,
      zone_uuid: '11111111-1111-4111-8111-111111111111',
      zoneUuid: '22222222-2222-4222-8222-222222222222',
    }] });

    const [zone] = await irrigationZonesAPI.getAll();

    expect(zone.zone_uuid).toBe('11111111-1111-4111-8111-111111111111');
    expect(zone.zoneUuid).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('preserves timezone and crop metadata aliases at the service boundary', async () => {
    get.mockResolvedValue({
      data: [{
        ...baseZone,
        timezone: 'Europe/Zurich',
        crop_type: 'winter wheat',
      }],
    });

    const [zone] = await irrigationZonesAPI.getAll();

    expect(zone.timezone).toBe('Europe/Zurich');
    expect(zone.crop_type).toBe('winter wheat');
    expect(zone.cropType).toBe('winter wheat');
  });
});

// toRenameError (api.ts) is the only new branching logic the rename helpers add: it turns a
// 400 `{ message, reason }` into an Error carrying `.reason`, so EditableName can show a
// translated sentence instead of the route's English. Untested, its failure mode is silent --
// every one of the eight card/modal surfaces would quietly degrade to the generic
// `rename.failed` text with no test going red.
describe('irrigationZonesAPI.rename', () => {
  it('PUTs the name to the pinned zone rename endpoint', async () => {
    put.mockResolvedValue({
      data: { id: 7, zone_uuid: 'zone-uuid-1', name: 'North block', sync_version: 3, changed: true },
    });

    const result = await irrigationZonesAPI.rename(7, 'North block');

    expect(put).toHaveBeenCalledWith('/api/irrigation-zones/7/name', { name: 'North block' });
    expect(result).toEqual({ id: 7, zone_uuid: 'zone-uuid-1', name: 'North block', sync_version: 3, changed: true });
  });

  it('rejects with the reason code from a 400 name_too_long response', async () => {
    put.mockRejectedValue(axiosError(400, { message: 'Name is too long', reason: 'name_too_long' }));

    await expect(irrigationZonesAPI.rename(7, 'x'.repeat(200)))
      .rejects.toMatchObject({ reason: 'name_too_long' });
  });

  // `.catch(e => e)` resolves whether the call rejected or not, so a bare
  // `reason` assertion would also pass for a call that resolved with a plain
  // object. Each case below proves the rejection first.
  it('leaves reason undefined when the 400 response carries no reason', async () => {
    put.mockRejectedValue(axiosError(400, { message: 'Bad request' }));

    const caught = await irrigationZonesAPI.rename(7, 'x').catch((error) => error);
    expect(caught).toBeInstanceOf(Error);
    expect(caught.reason).toBeUndefined();
  });

  it('leaves reason undefined when the reason field is not a string', async () => {
    put.mockRejectedValue(axiosError(400, { message: 'Bad request', reason: 12345 }));

    const caught = await irrigationZonesAPI.rename(7, 'x').catch((error) => error);
    expect(caught).toBeInstanceOf(Error);
    expect(caught.reason).toBeUndefined();
  });

  it('leaves reason undefined for a non-axios rejection', async () => {
    put.mockRejectedValue(new Error('network down'));

    const caught = await irrigationZonesAPI.rename(7, 'x').catch((error) => error);
    expect(caught).toBeInstanceOf(Error);
    expect(caught.reason).toBeUndefined();
  });
});

describe('devicesAPI.rename', () => {
  it('PUTs the name to the pinned device rename endpoint', async () => {
    put.mockResolvedValue({
      data: { deveui: '70B3D5E75E004202', name: 'Row 4', sync_version: 2, changed: true, chirpstack: 'updated' },
    });

    const result = await devicesAPI.rename('70B3D5E75E004202', 'Row 4');

    expect(put).toHaveBeenCalledWith('/api/devices/70B3D5E75E004202/name', { name: 'Row 4' });
    expect(result).toEqual({
      deveui: '70B3D5E75E004202', name: 'Row 4', sync_version: 2, changed: true, chirpstack: 'updated',
    });
  });

  it('rejects with the reason code from a 400 name_too_long response', async () => {
    put.mockRejectedValue(axiosError(400, { message: 'Name is too long', reason: 'name_too_long' }));

    await expect(devicesAPI.rename('70B3D5E75E004202', 'x'.repeat(200)))
      .rejects.toMatchObject({ reason: 'name_too_long' });
  });

  // `.catch(e => e)` resolves whether the call rejected or not, so a bare
  // `reason` assertion would also pass for a call that resolved with a plain
  // object. Each case below proves the rejection first.
  it('leaves reason undefined when the 400 response carries no reason', async () => {
    put.mockRejectedValue(axiosError(400, { message: 'Bad request' }));

    const caught = await devicesAPI.rename('70B3D5E75E004202', 'x').catch((error) => error);
    expect(caught).toBeInstanceOf(Error);
    expect(caught.reason).toBeUndefined();
  });

  it('leaves reason undefined when the reason field is not a string', async () => {
    put.mockRejectedValue(axiosError(400, { message: 'Bad request', reason: 12345 }));

    const caught = await devicesAPI.rename('70B3D5E75E004202', 'x').catch((error) => error);
    expect(caught).toBeInstanceOf(Error);
    expect(caught.reason).toBeUndefined();
  });

  it('leaves reason undefined for a non-axios rejection', async () => {
    put.mockRejectedValue(new Error('network down'));

    const caught = await devicesAPI.rename('70B3D5E75E004202', 'x').catch((error) => error);
    expect(caught).toBeInstanceOf(Error);
    expect(caught.reason).toBeUndefined();
  });
});
