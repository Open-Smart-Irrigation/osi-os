'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { normalize } = require('./index.js');

describe('osi-uc512-normalize', () => {
  it('maps known fields to manifest keys', () => {
    const result = normalize({
      battery: 85,
      valve_1: 'open',
      valve_2: 'close',
      valve_1_pulse: 1000,
      valve_2_pulse: 500,
      pressure: 30.5,
    }, { recordedAt: '2026-01-15T10:00:00Z' });

    assert.deepEqual(result.channels, {
      bat_pct: 85,
      valve_1_state: 'open',
      valve_2_state: 'close',
      valve_1_pulse: 1000,
      valve_2_pulse: 500,
      pipe_pressure_kpa: 30.5,
    });
    assert.deepEqual(result.unknown, {});
    assert.equal(result.recordedAt, '2026-01-15T10:00:00Z');
  });

  it('routes unmapped fields to unknown', () => {
    const result = normalize({
      battery: 90,
      gpio_1: 0,
      gpio_2: 1,
      valve_1_task_status: 'success',
    }, {});

    assert.deepEqual(result.channels, { bat_pct: 90 });
    assert.deepEqual(result.unknown, {
      gpio_1: 0,
      gpio_2: 1,
      valve_1_task_status: 'success',
    });
  });

  it('handles empty decoded', () => {
    const result = normalize({}, {});
    assert.deepEqual(result.channels, {});
    assert.deepEqual(result.unknown, {});
  });

  it('preserves recordedAt from meta', () => {
    const result = normalize({ battery: 50 }, { recordedAt: '2026-07-12T08:00:00Z' });
    assert.equal(result.recordedAt, '2026-07-12T08:00:00Z');
  });

  it('returns null recordedAt when meta has none', () => {
    const result = normalize({ battery: 50 }, {});
    assert.equal(result.recordedAt, null);
  });
});
