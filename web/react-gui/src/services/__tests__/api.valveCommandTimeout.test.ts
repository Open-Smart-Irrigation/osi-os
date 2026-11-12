import { afterEach, describe, expect, it, vi } from 'vitest';

import api, { VALVE_COMMAND_TIMEOUT_MS, devicesAPI, stregaAPI, valvesAPI } from '../api';
import { ValveOpenHeldError, beginValveReading, completeValveReading, holdValveOpen, isValveOpenHeld, resetValveCommandHoldsForTest } from '../valveCommandHold';

// Valve commands are answered only after the radio transport decides, so they wait 30 s;
// every other request keeps the instance default.
describe('valve command timeout', () => {
  afterEach(() => { vi.restoreAllMocks(); resetValveCommandHoldsForTest(); });

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

// The API functions are the one dispatch point for commands that open: while a valve is
// held they refuse without sending, and an opening command that times out starts the hold.
// Close and the closing variants are never held.
describe('dispatch guard for commands that open', () => {
  const eui = '0016C001F1000001';
  const timeout = () => Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' });
  afterEach(() => { vi.restoreAllMocks(); resetValveCommandHoldsForTest(); });

  it('refuses every opening command while held, without sending, and lets closing ones through', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: {} });
    const put = vi.spyOn(api, 'put').mockResolvedValue({ data: {} });
    holdValveOpen(eui);

    await expect(devicesAPI.controlValve(eui, { action: 'OPEN_FOR_DURATION', duration_seconds: 300 })).rejects.toBeInstanceOf(ValveOpenHeldError);
    await expect(devicesAPI.controlValve(eui, { action: 'OPEN' })).rejects.toBeInstanceOf(ValveOpenHeldError);
    await expect(stregaAPI.setTimedAction(eui, { action: 'OPEN', unit: 'minutes', amount: 2 })).rejects.toBeInstanceOf(ValveOpenHeldError);
    await expect(stregaAPI.setPartialOpening(eui, { action: 'OPEN', percentage: 50 })).rejects.toBeInstanceOf(ValveOpenHeldError);
    await expect(stregaAPI.setFlushing(eui, { returnPosition: 'CLOSE', percentage: 50 })).rejects.toBeInstanceOf(ValveOpenHeldError);
    expect(post).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();

    await devicesAPI.controlValve(eui, { action: 'CLOSE' });
    await stregaAPI.setTimedAction(eui, { action: 'CLOSE', unit: 'minutes', amount: 2 });
    await stregaAPI.setPartialOpening(eui, { action: 'CLOSE', percentage: 50 });
    expect(post).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('an opening command that times out starts the hold; a close that times out does not', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(timeout()).mockRejectedValueOnce(timeout());
    await expect(devicesAPI.controlValve(eui, { action: 'CLOSE' })).rejects.toMatchObject({ code: 'ECONNABORTED' });
    expect(isValveOpenHeld(eui)).toBe(false);
    await expect(devicesAPI.controlValve(eui, { action: 'OPEN_FOR_DURATION', duration_seconds: 300 })).rejects.toMatchObject({ code: 'ECONNABORTED' });
    expect(isValveOpenHeld(eui)).toBe(true);
  });

  it('a timed OPEN or a flush that times out starts the hold as well', async () => {
    vi.spyOn(api, 'put').mockRejectedValue(timeout());
    await expect(stregaAPI.setFlushing(eui, { returnPosition: 'OPEN', percentage: 30 })).rejects.toMatchObject({ code: 'ECONNABORTED' });
    expect(isValveOpenHeld(eui)).toBe(true);
    resetValveCommandHoldsForTest();
    await expect(stregaAPI.setTimedAction(eui, { action: 'OPEN', unit: 'minutes', amount: 2 })).rejects.toMatchObject({ code: 'ECONNABORTED' });
    expect(isValveOpenHeld(eui)).toBe(true);
  });

  it('an answered refusal starts no hold', async () => {
    vi.spyOn(api, 'post').mockRejectedValueOnce(Object.assign(new Error('Request failed with status code 409'), { code: 'ERR_BAD_REQUEST', response: { status: 409 } }));
    await expect(devicesAPI.controlValve(eui, { action: 'OPEN_FOR_DURATION', duration_seconds: 300 })).rejects.toBeTruthy();
    expect(isValveOpenHeld(eui)).toBe(false);
  });
});

// A one-time schedule that starts while the hold lasts is an open by another route (S7).
// Planning ahead, weekly schedules, and disabling, deleting or re-sending are never held.
describe('one-time schedules and the open hold', () => {
  const eui = '0016C001F1000001';
  const inSeconds = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
  const okSchedule = { data: { schedule: { schedule_uuid: 's1', kind: 'ONCE' }, pushes_queued: 0 } };
  afterEach(() => { vi.restoreAllMocks(); resetValveCommandHoldsForTest(); });

  it('refuses a due one-time schedule while held, without sending', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(okSchedule);
    holdValveOpen(eui);
    await expect(valvesAPI.createSchedule(eui, { kind: 'ONCE', fireAt: inSeconds(0), durationMinutes: 5, enabled: true }))
      .rejects.toBeInstanceOf(ValveOpenHeldError);
    await expect(valvesAPI.createSchedule(eui, { kind: 'ONCE', fireAt: inSeconds(-120), durationMinutes: 5, enabled: true }))
      .rejects.toBeInstanceOf(ValveOpenHeldError);
    await expect(valvesAPI.createSchedule(eui, { kind: 'ONCE', fireAt: inSeconds(50), durationMinutes: 5, enabled: true }))
      .rejects.toBeInstanceOf(ValveOpenHeldError);
    expect(post).not.toHaveBeenCalled();
  });

  it('accepts a one-time schedule that starts after the hold can end, and a weekly schedule', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(okSchedule);
    holdValveOpen(eui);
    await valvesAPI.createSchedule(eui, { kind: 'ONCE', fireAt: inSeconds(120), durationMinutes: 5, enabled: true });
    await valvesAPI.createSchedule(eui, { kind: 'WEEKLY', weekdaysMask: 127, startTime: '06:00', durationMinutes: 5, enabled: true });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('accepts the same due one-time schedule once the hold has ended', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(okSchedule);
    holdValveOpen(eui);
    completeValveReading(beginValveReading());
    await valvesAPI.createSchedule(eui, { kind: 'ONCE', fireAt: inSeconds(0), durationMinutes: 5, enabled: true });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('refuses re-enabling or moving a one-time schedule into the hold; disabling, deleting and re-sending go through', async () => {
    const put = vi.spyOn(api, 'put').mockResolvedValue({ data: { pushes_queued: 0 } });
    const del = vi.spyOn(api, 'delete').mockResolvedValue({ data: { pushes_queued: 0 } });
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { pushes_queued: 0 } });
    const due = { kind: 'ONCE' as const, fireAt: inSeconds(0), enabled: false };
    holdValveOpen(eui);
    await expect(valvesAPI.updateSchedule(eui, 's1', { enabled: true }, due)).rejects.toBeInstanceOf(ValveOpenHeldError);
    await expect(valvesAPI.updateSchedule(eui, 's1', { fireAt: inSeconds(10), durationMinutes: 5 })).rejects.toBeInstanceOf(ValveOpenHeldError);
    expect(put).not.toHaveBeenCalled();

    await valvesAPI.updateSchedule(eui, 's1', { enabled: false }, { ...due, enabled: true });
    await valvesAPI.updateSchedule(eui, 's1', { fireAt: inSeconds(300), durationMinutes: 5 }, { ...due, enabled: true });
    await valvesAPI.deleteSchedule(eui, 's1');
    await valvesAPI.resendPlan(eui);
    expect(put).toHaveBeenCalledTimes(2);
    expect(del).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
  });

  // Review r3/r4, S7: during a hold the body carries both fields and alone decides. A due move
  // of a row cached as disabled goes out disabled; with no cached row it cannot be completed.
  it('a due move goes out with both fields from the cached row, or is refused when they cannot be filled', async () => {
    const put = vi.spyOn(api, 'put').mockResolvedValue({ data: { pushes_queued: 0 } });
    const cachedDisabled = { kind: 'ONCE' as const, fireAt: inSeconds(600), enabled: false };
    holdValveOpen(eui);
    await expect(valvesAPI.updateSchedule(eui, 's1', { fireAt: inSeconds(0), durationMinutes: 5 }))
      .rejects.toBeInstanceOf(ValveOpenHeldError);
    expect(put).not.toHaveBeenCalled();
    await valvesAPI.updateSchedule(eui, 's1', { fireAt: inSeconds(0), durationMinutes: 5 }, cachedDisabled);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][1]).toMatchObject({ fire_at: expect.any(String), enabled: false });
  });
});

// Review r4: the invariant itself. While the hold is active, every update of a one-time
// schedule that leaves carries both `enabled` and `fire_at`, and never `enabled: true` with a
// due or held start, whatever the cached row says. Outside a hold, updates stay partial.
describe('one-time schedule updates during a hold: the body alone decides', () => {
  const eui = '0016C001F1000001';
  const inSeconds = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
  const holdEnd = () => Date.now() + 60_000;
  afterEach(() => { vi.restoreAllMocks(); resetValveCommandHoldsForTest(); });

  const cachedRows = {
    'enabled, future': { kind: 'ONCE' as const, fireAt: inSeconds(600), enabled: true },
    'enabled, due': { kind: 'ONCE' as const, fireAt: inSeconds(0), enabled: true },
    'disabled, future': { kind: 'ONCE' as const, fireAt: inSeconds(600), enabled: false },
    'disabled, due': { kind: 'ONCE' as const, fireAt: inSeconds(0), enabled: false },
  };
  const patches = {
    'edit start to due': { fireAt: inSeconds(0), durationMinutes: 5, label: null },
    'edit start to later': { fireAt: inSeconds(900), durationMinutes: 5, label: null },
    'duration only': { durationMinutes: 7 },
    'label only': { label: 'Renamed' },
    enable: { enabled: true },
    disable: { enabled: false },
  };

  it('every request that leaves has both fields and never enables a due or held start', async () => {
    const put = vi.spyOn(api, 'put').mockResolvedValue({ data: { pushes_queued: 0 } });
    const outcomes: string[] = [];
    for (const [rowName, row] of Object.entries(cachedRows)) {
      for (const [patchName, patch] of Object.entries(patches)) {
        resetValveCommandHoldsForTest();
        holdValveOpen(eui);
        put.mockClear();
        let refused = false;
        try { await valvesAPI.updateSchedule(eui, 's1', patch, row); } catch (error) {
          expect(error).toBeInstanceOf(ValveOpenHeldError);
          refused = true;
        }
        const label = `${rowName} / ${patchName}`;
        if (refused) { expect(put, label).not.toHaveBeenCalled(); outcomes.push(label + ': refused'); continue; }
        expect(put, label).toHaveBeenCalledTimes(1);
        const body = put.mock.calls[0][1] as Record<string, unknown>;
        expect(typeof body.enabled, label).toBe('boolean');
        expect(typeof body.fire_at, label).toBe('string');
        if (body.enabled === true) expect(Date.parse(body.fire_at as string), label).toBeGreaterThan(holdEnd() - 1_000);
        outcomes.push(label + ': sent');
      }
    }
    // Not trivially refusing everything: disabling always goes out, and so does an edit that
    // keeps a cached-enabled row's start after the hold.
    expect(outcomes).toContain('enabled, due / disable: sent');
    expect(outcomes).toContain('enabled, future / label only: sent');
    expect(outcomes).toContain('disabled, future / enable: sent');
    expect(outcomes).toContain('enabled, future / edit start to due: refused');
    expect(outcomes).toContain('disabled, due / enable: refused');
  });

  it('a body that cannot be completed is refused unless it only disables', async () => {
    const put = vi.spyOn(api, 'put').mockResolvedValue({ data: { pushes_queued: 0 } });
    holdValveOpen(eui);
    await expect(valvesAPI.updateSchedule(eui, 's1', { enabled: true })).rejects.toBeInstanceOf(ValveOpenHeldError);
    await expect(valvesAPI.updateSchedule(eui, 's1', { durationMinutes: 5 })).rejects.toBeInstanceOf(ValveOpenHeldError);
    await valvesAPI.updateSchedule(eui, 's1', { enabled: false });
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][1]).toEqual({ enabled: false });
  });

  it('weekly updates and every update outside a hold stay partial', async () => {
    const put = vi.spyOn(api, 'put').mockResolvedValue({ data: { pushes_queued: 0 } });
    holdValveOpen(eui);
    await valvesAPI.updateSchedule(eui, 'w1', { label: 'Weekly', weekdaysMask: 2, startTime: '06:00', durationMinutes: 5 });
    await valvesAPI.updateSchedule(eui, 'w1', { enabled: true }, { kind: 'WEEKLY', fireAt: null, enabled: false });
    resetValveCommandHoldsForTest();
    await valvesAPI.updateSchedule(eui, 's1', { durationMinutes: 7 }, cachedRows['disabled, due']);
    expect(put.mock.calls.map(([, body]) => body)).toEqual([
      { label: 'Weekly', weekdays_mask: 2, start_time: '06:00', duration_minutes: 5 },
      { enabled: true },
      { duration_minutes: 7 },
    ]);
  });
});
