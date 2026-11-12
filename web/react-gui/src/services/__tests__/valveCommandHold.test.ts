import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api', () => ({ valvesAPI: { list: vi.fn() } }));

import { valvesAPI } from '../api';
import {
  VALVE_OPEN_HOLD_MS,
  fetchValveReading,
  holdValveOpen,
  isNoAnswerTimeout,
  noteValveReading,
  resetValveCommandHolds,
  valveOpenHeldUntil,
} from '../valveCommandHold';

const EUI = '0016C001F1000001';

describe('valveCommandHold', () => {
  beforeEach(() => {
    resetValveCommandHolds();
    vi.mocked(valvesAPI.list).mockReset();
  });

  it('recognises an axios timeout without a response, and nothing else', () => {
    expect(isNoAnswerTimeout({ code: 'ECONNABORTED', message: 'timeout of 30000ms exceeded' })).toBe(true);
    expect(isNoAnswerTimeout({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isNoAnswerTimeout({ code: 'ECONNABORTED', response: { status: 503 } })).toBe(false);
    expect(isNoAnswerTimeout({ code: 'ERR_NETWORK' })).toBe(false);
    expect(isNoAnswerTimeout(new Error('offline'))).toBe(false);
    expect(isNoAnswerTimeout(null)).toBe(false);
  });

  it('holds open for one minute at most', () => {
    holdValveOpen(EUI, 1_000);
    expect(valveOpenHeldUntil(EUI, 1_000)).toBe(1_000 + VALVE_OPEN_HOLD_MS);
    expect(valveOpenHeldUntil(EUI.toLowerCase(), 1_000 + VALVE_OPEN_HOLD_MS - 1)).toBe(1_000 + VALVE_OPEN_HOLD_MS);
    expect(valveOpenHeldUntil(EUI, 1_000 + VALVE_OPEN_HOLD_MS)).toBeNull();
    expect(valveOpenHeldUntil('0016C001F1000002', 1_000)).toBeNull();
  });

  it('ends the hold with a reading requested after it began, not with one already under way', () => {
    holdValveOpen(EUI, 5_000);
    noteValveReading(4_999);
    expect(valveOpenHeldUntil(EUI, 6_000)).not.toBeNull();
    noteValveReading(5_000);
    expect(valveOpenHeldUntil(EUI, 6_000)).toBeNull();
  });

  it('counts a successful valve list as a reading, a failed one not', async () => {
    holdValveOpen(EUI);
    vi.mocked(valvesAPI.list).mockRejectedValueOnce(new Error('offline'));
    await expect(fetchValveReading()).rejects.toThrow('offline');
    expect(valveOpenHeldUntil(EUI)).not.toBeNull();
    vi.mocked(valvesAPI.list).mockResolvedValueOnce([]);
    await expect(fetchValveReading()).resolves.toEqual([]);
    expect(valveOpenHeldUntil(EUI)).toBeNull();
  });
});
