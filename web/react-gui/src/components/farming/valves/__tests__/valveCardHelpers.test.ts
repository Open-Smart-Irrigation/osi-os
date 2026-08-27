import { describe, expect, it } from 'vitest';
import {
  describeLastSeen,
  getRecognizedStregaModel,
  normaliseStregaModel,
  renderLastSeen,
  type Translate,
} from '../valveCardHelpers';
import type { Device } from '../../../../types/farming';

function makeDevice(overrides: Partial<Device> = {}): Device {
  return {
    deveui: '0016C001F1000001',
    name: 'Valve A',
    type_id: 'STREGA_VALVE',
    latest_data: {},
    ...overrides,
  } as Device;
}

// Records exactly which key + options were requested, so a test can assert both the key
// (proves renderLastSeen picked the right tier/suffix) and the interpolation value.
const translateForTest: Translate = (key, options) => `${key}|${JSON.stringify(options ?? {})}`;

describe('describeLastSeen tiers (I6)', () => {
  it('reports "never" for a null timestamp', () => {
    expect(describeLastSeen(null)).toEqual({ key: 'never' });
  });

  it('reports "never" for an unparseable timestamp rather than throwing', () => {
    expect(describeLastSeen('not-a-date')).toEqual({ key: 'never' });
  });

  it('reports "justNow" for a contact under a minute old', () => {
    expect(describeLastSeen(new Date(Date.now() - 30_000).toISOString())).toEqual({ key: 'justNow' });
  });

  it('reports "justNow" for a clamped future timestamp rather than a negative count', () => {
    expect(describeLastSeen(new Date(Date.now() + 60_000).toISOString())).toEqual({ key: 'justNow' });
  });

  it('reports whole minutes under an hour', () => {
    expect(describeLastSeen(new Date(Date.now() - 5 * 60_000).toISOString())).toEqual({ key: 'minutesAgo', count: 5 });
  });

  it('reports whole hours under a day, not 1440 minutes', () => {
    expect(describeLastSeen(new Date(Date.now() - 3 * 3_600_000).toISOString())).toEqual({ key: 'hoursAgo', count: 3 });
  });

  it('reports whole days at and beyond 24 hours', () => {
    expect(describeLastSeen(new Date(Date.now() - 2 * 86_400_000).toISOString())).toEqual({ key: 'daysAgo', count: 2 });
  });
});

describe('renderLastSeen (I6)', () => {
  it('renders the never key with no count', () => {
    expect(renderLastSeen({ key: 'never' }, translateForTest)).toBe('lastSeen.never|{}');
  });

  it('renders the justNow key with no count', () => {
    expect(renderLastSeen({ key: 'justNow' }, translateForTest)).toBe('lastSeen.justNow|{}');
  });

  it('picks the singular suffix for a count of exactly 1', () => {
    expect(renderLastSeen({ key: 'minutesAgo', count: 1 }, translateForTest)).toBe('lastSeen.minutesAgo_one|{"count":1}');
  });

  it('picks the plural suffix for a count other than 1', () => {
    expect(renderLastSeen({ key: 'hoursAgo', count: 4 }, translateForTest)).toBe('lastSeen.hoursAgo_other|{"count":4}');
    expect(renderLastSeen({ key: 'daysAgo', count: 0 }, translateForTest)).toBe('lastSeen.daysAgo_other|{"count":0}');
  });
});

describe('normaliseStregaModel / getRecognizedStregaModel (relocated from StregaValveCard)', () => {
  it('recognizes an explicit strega_model field regardless of case', () => {
    expect(normaliseStregaModel('motorized')).toBe('MOTORIZED');
    expect(normaliseStregaModel('Standard')).toBe('STANDARD');
    expect(normaliseStregaModel('bogus')).toBeNull();
  });

  it('prefers the explicit field over the name heuristic', () => {
    const device = makeDevice({ name: 'Solenoid North', strega_model: 'MOTORIZED' });
    expect(getRecognizedStregaModel(device)).toBe('MOTORIZED');
  });

  it('falls back to a name heuristic when strega_model is absent', () => {
    expect(getRecognizedStregaModel(makeDevice({ name: 'North Motor Valve' }))).toBe('MOTORIZED');
    expect(getRecognizedStregaModel(makeDevice({ name: 'Standard solenoid' }))).toBe('STANDARD');
  });

  it('reports UNKNOWN when neither the field nor the name resolve a model', () => {
    expect(getRecognizedStregaModel(makeDevice({ name: 'Valve 3' }))).toBe('UNKNOWN');
  });
});
