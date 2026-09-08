import { beforeEach, describe, expect, it, vi } from 'vitest';

const { get } = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => ({
      get,
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      interceptors: {
        request: { use: vi.fn() },
        response: { use: vi.fn() },
      },
    })),
  },
}));

import { irrigationZonesAPI } from '../api';

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
});

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
