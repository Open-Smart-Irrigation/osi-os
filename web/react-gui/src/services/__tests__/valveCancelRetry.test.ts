import { afterEach, describe, expect, it, vi } from 'vitest';

import api from '../api';
import { cancelIrrigationWithAmbiguityRetry } from '../valveCancelRetry';

const EUI = '0016C001F1000001';
const refusal = (error: string, extra: Record<string, unknown> = {}) => ({ response: { status: 409, data: { error, message: `refused: ${error}`, ...extra } } });
const valves = (activeActuation: Record<string, unknown> | null, deviceEui = EUI) => ({
  data: { valves: [{ device_eui: deviceEui, active_actuation: activeActuation }] },
});
const run = { expectation_id: 'vae-b', reconciliation_state: 'PENDING_OBSERVATION', commanded_at: '2026-11-15T08:00:00Z', expected_close_at: '2026-11-15T08:10:00Z' };

// V9: one named retry, and only after a 409 ambiguous_actuation (refused before any queue change).
describe('cancelIrrigationWithAmbiguityRetry', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it.each([
    ['actuation_not_active', refusal('actuation_not_active')],
    ['handed_off', refusal('actuation_handed_off', { outcome: 'handed_off', collateral: [] })],
    ['a 503', { response: { status: 503, data: { error: 'transport_uncertain', outcome: 'uncertain' } } }],
  ])('does not retry %s', async (_label, error) => {
    const post = vi.spyOn(api, 'post').mockRejectedValue(error);
    const get = vi.spyOn(api, 'get');
    await expect(cancelIrrigationWithAmbiguityRetry(EUI)).rejects.toBe(error);
    expect(post).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    ['the fresh read fails', () => Promise.reject(new Error('timeout of 10000ms exceeded'))],
    ['the list has no row for this valve', () => Promise.resolve(valves(run, 'A840410000000001'))],
    ['the row reports no run', () => Promise.resolve(valves(null))],
  ])('rethrows the original refusal when %s', async (_label, read) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const original = refusal('ambiguous_actuation', { ambiguity: 'several_queued' });
    const post = vi.spyOn(api, 'post').mockRejectedValue(original);
    vi.spyOn(api, 'get').mockImplementation(read as () => Promise<never>);
    await expect(cancelIrrigationWithAmbiguityRetry(EUI)).rejects.toBe(original);
    expect(post).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('sends no third request when the retry is refused as ambiguous again', async () => {
    const second = refusal('ambiguous_actuation', { ambiguity: 'several_queued' });
    const post = vi.spyOn(api, 'post')
      .mockRejectedValueOnce(refusal('ambiguous_actuation', { ambiguity: 'several_queued' }))
      .mockRejectedValueOnce(second);
    vi.spyOn(api, 'get').mockResolvedValue(valves(run));
    await expect(cancelIrrigationWithAmbiguityRetry(EUI)).rejects.toBe(second);
    expect(post.mock.calls.map(([, body]) => body)).toEqual([
      { reason: 'operator_cancel' },
      { reason: 'operator_cancel', expectation_id: 'vae-b' },
    ]);
  });
});
