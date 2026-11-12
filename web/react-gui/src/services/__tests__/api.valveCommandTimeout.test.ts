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
    await valvesAPI.updateSchedule(eui, 's1', { fireAt: inSeconds(300), durationMinutes: 5 });
    await valvesAPI.deleteSchedule(eui, 's1');
    await valvesAPI.resendPlan(eui);
    expect(put).toHaveBeenCalledTimes(2);
    expect(del).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledTimes(1);
  });
});
