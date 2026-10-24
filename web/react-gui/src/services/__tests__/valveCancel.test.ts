import { describe, expect, it } from 'vitest';
import { parseValveCancelResult, removedCollateral, valveCancelResultFromError } from '../valveCancel';

const collateral = [
  { owner_type: 'push', owner_id: 'p-mon', purpose: 'WEEKDAY_PLAN', weekday: 1, queue_id: 'q1', phase_before: 'ACCEPTED', in_queue: true },
  { owner_type: 'expectation', owner_id: 'e2', expectation_id: 'e2', queue_id: 'q2', phase_before: 'ACCEPTED', in_queue: false },
  { owner_type: 'opaque', owner_id: 'q3', fport: 11, queue_id: 'q3', phase_before: 'ACCEPTED', in_queue: true },
];

describe('valve cancel result parsing (D19/Q01 = (a))', () => {
  it('reads the outcome and the structured collateral of a successful cancel', () => {
    const result = parseValveCancelResult({ status: 'cancelled', outcome: 'cancelled', collateral });
    expect(result?.outcome).toBe('cancelled');
    expect(result?.collateral).toEqual([
      { ownerType: 'push', ownerId: 'p-mon', purpose: 'WEEKDAY_PLAN', weekday: 1, fport: null, inQueue: true },
      { ownerType: 'expectation', ownerId: 'e2', purpose: null, weekday: null, fport: null, inQueue: false },
      { ownerType: 'opaque', ownerId: 'q3', purpose: null, weekday: null, fport: 11, inQueue: true },
    ]);
    expect(removedCollateral(result!).map((item) => item.ownerId)).toEqual(['p-mon', 'q3']);
  });

  it('treats a reply from an older gateway (no outcome) as a plain cancel without collateral', () => {
    expect(parseValveCancelResult({ status: 'cancelled', dropped_opens: null })).toEqual({ outcome: 'cancelled', collateral: [] });
    expect(parseValveCancelResult(undefined)).toBeNull();
  });

  it('reads a handed-off or uncertain refusal from the HTTP error body', () => {
    const handedOff = valveCancelResultFromError({ response: { status: 409, data: { error: 'actuation_handed_off', outcome: 'handed_off', collateral } } });
    expect(handedOff?.outcome).toBe('handed_off');
    expect(handedOff?.collateral).toHaveLength(3);
    const uncertain = valveCancelResultFromError({ response: { status: 503, data: { error: 'transport_uncertain', outcome: 'uncertain', collateral: null } } });
    expect(uncertain).toEqual({ outcome: 'uncertain', collateral: [] });
  });

  it('returns null for an error that carries no cancel outcome', () => {
    expect(valveCancelResultFromError(new Error('boom'))).toBeNull();
    expect(valveCancelResultFromError({ response: { status: 409, data: { message: 'More than one actuation is active' } } })).toBeNull();
  });
});
