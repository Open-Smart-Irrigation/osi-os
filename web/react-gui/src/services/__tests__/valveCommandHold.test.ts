import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, render, screen } from '@testing-library/react';

vi.mock('../api', () => ({ valvesAPI: { list: vi.fn() } }));

import { valvesAPI } from '../api';
import {
  VALVE_OPEN_HOLD_MS,
  ValveOpenHeldError,
  assertValveOpenNotHeld,
  holdValveOpen,
  isNoAnswerTimeout,
  isUnknownValveOutcome,
  isValveOpenHeld,
  resetValveCommandHoldsForTest,
  useValveOpenHeld,
} from '../valveCommandHold';
import { fetchValveReading } from '../valveReading';
import type { ValveSummary } from '../../types/farming';

const EUI = '0016C001F1000001';
const STORAGE_KEY = 'osi.valveOpenHolds.v1';
// Fake timers that also drive performance.now, the clock the minute runs on.
const FAKE: Parameters<typeof vi.useFakeTimers>[0] = { toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] };

function deferredReading() {
  let resolve: (valves: ValveSummary[]) => void = () => undefined;
  vi.mocked(valvesAPI.list).mockImplementationOnce(() => new Promise<ValveSummary[]>((r) => { resolve = r; }));
  const reading = fetchValveReading();
  return { reading, resolve: (valves: ValveSummary[] = []) => resolve(valves) };
}

function Probe() {
  return createElement('span', null, useValveOpenHeld(EUI) ? 'held' : 'free');
}

describe('valveCommandHold', () => {
  beforeEach(() => {
    resetValveCommandHoldsForTest();
    vi.mocked(valvesAPI.list).mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('recognises an axios timeout without a response, and nothing else', () => {
    expect(isNoAnswerTimeout({ code: 'ECONNABORTED', message: 'timeout of 30000ms exceeded' })).toBe(true);
    expect(isNoAnswerTimeout({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isNoAnswerTimeout({ code: 'ECONNABORTED', response: { status: 503 } })).toBe(false);
    expect(isNoAnswerTimeout({ code: 'ERR_NETWORK' })).toBe(false);
    expect(isNoAnswerTimeout(new Error('offline'))).toBe(false);
    expect(isUnknownValveOutcome(new ValveOpenHeldError(EUI))).toBe(true);
  });

  it('refuses at the dispatch check while held, for any spelling of the EUI', () => {
    holdValveOpen(EUI.toLowerCase());
    expect(() => assertValveOpenNotHeld(EUI)).toThrow(ValveOpenHeldError);
    expect(() => assertValveOpenNotHeld('0016C001F1000002')).not.toThrow();
  });

  describe('release by a reading (S4)', () => {
    it('a reading already under way when the hold began does not release it, even at the same Date.now', async () => {
      vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
      const before = deferredReading();
      holdValveOpen(EUI);
      before.resolve();
      await before.reading;
      expect(isValveOpenHeld(EUI)).toBe(true);

      const after = deferredReading();
      after.resolve();
      await after.reading;
      expect(isValveOpenHeld(EUI)).toBe(false);
    });

    it('an earlier reading does not cancel a hold started after the clock went back', async () => {
      vi.mocked(valvesAPI.list).mockResolvedValueOnce([]);
      await fetchValveReading();
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 3_600_000);
      holdValveOpen(EUI);
      expect(isValveOpenHeld(EUI)).toBe(true);
    });

    it('a failed reading releases nothing', async () => {
      holdValveOpen(EUI);
      vi.mocked(valvesAPI.list).mockRejectedValueOnce(new Error('offline'));
      await expect(fetchValveReading()).rejects.toThrow('offline');
      expect(isValveOpenHeld(EUI)).toBe(true);
    });
  });

  describe('the minute (S5)', () => {
    it('runs on the monotonic clock: a wall clock moved back neither strands nor extends it', () => {
      vi.useFakeTimers(FAKE);
      render(createElement(Probe));
      act(() => { holdValveOpen(EUI); });
      expect(screen.getByText('held')).toBeInTheDocument();
      vi.setSystemTime(Date.now() - 10 * 60_000);
      act(() => { vi.advanceTimersByTime(VALVE_OPEN_HOLD_MS - 1_000); });
      expect(screen.getByText('held')).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(1_000); });
      expect(screen.getByText('free')).toBeInTheDocument();
      expect(isValveOpenHeld(EUI)).toBe(false);
    });

    it('a wall clock moved forward does not end it early', () => {
      vi.useFakeTimers(FAKE);
      holdValveOpen(EUI);
      vi.setSystemTime(Date.now() + 3_600_000);
      act(() => { vi.advanceTimersByTime(1_000); });
      expect(isValveOpenHeld(EUI)).toBe(true);
    });
  });

  describe('page reload (S3)', () => {
    it('keeps the hold for this tab while the valve list has not answered', async () => {
      vi.useFakeTimers(FAKE);
      holdValveOpen(EUI);
      act(() => { vi.advanceTimersByTime(10_000); });
      resetValveCommandHoldsForTest({ keepStorage: true, reload: true });
      expect(isValveOpenHeld(EUI)).toBe(true);
      render(createElement(Probe));
      expect(screen.getByText('held')).toBeInTheDocument();

      vi.mocked(valvesAPI.list).mockImplementationOnce(() => new Promise(() => undefined));
      void fetchValveReading();
      act(() => { vi.advanceTimersByTime(49_000); });
      expect(isValveOpenHeld(EUI)).toBe(true);
      act(() => { vi.advanceTimersByTime(1_000); });
      expect(screen.getByText('free')).toBeInTheDocument();
      expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('is released after a reload by a reading started after it', async () => {
      holdValveOpen(EUI);
      resetValveCommandHoldsForTest({ keepStorage: true, reload: true });
      vi.mocked(valvesAPI.list).mockResolvedValueOnce([]);
      await fetchValveReading();
      expect(isValveOpenHeld(EUI)).toBe(false);
    });

    it('never restores more than one minute, even if the clock went back across the reload', () => {
      vi.useFakeTimers(FAKE);
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ [EUI]: Date.now() + 10 * 60_000 }));
      resetValveCommandHoldsForTest({ keepStorage: true, reload: true });
      expect(isValveOpenHeld(EUI)).toBe(true);
      act(() => { vi.advanceTimersByTime(VALVE_OPEN_HOLD_MS); });
      expect(isValveOpenHeld(EUI)).toBe(false);
    });
  });
});
