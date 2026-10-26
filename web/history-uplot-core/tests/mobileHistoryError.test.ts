import { describe, expect, it } from 'vitest';
import {
  HistoryAuthError,
  MobileAnalysisValidationError,
  MobileHistoryError,
  mobileHistoryFailureError,
} from '../src';

describe('mobile history operational error boundary', () => {
  it('keeps a normalizer failure intact under MobileHistoryError', () => {
    const validation = new MobileAnalysisValidationError({
      kind: 'sources',
      missingIds: ['s2'],
      dropped: [{ seriesId: 's2', reason: 'access_denied' }],
      accessDeniedIds: ['s2'],
      reason: 'selected sources are missing or dropped',
    });

    const error = mobileHistoryFailureError(validation);

    expect(error).toBeInstanceOf(MobileHistoryError);
    if (error instanceof MobileHistoryError) {
      expect(error.failure).toBe(validation.failure);
      expect(error.original).toBe(validation);
    }
  });

  it('maps auth, size and transient transport failures to the shared classes', () => {
    expect(mobileHistoryFailureError({ kind: 'http', status: 401, code: 'unauthorized', message: 'expired' })).toEqual(
      expect.objectContaining({ status: 401, message: 'expired' }),
    );
    expect(mobileHistoryFailureError({ kind: 'http', status: 413, code: null, message: 'too large' })).toMatchObject({
      failure: { kind: 'size', status: 413 },
    });
    expect(mobileHistoryFailureError({ kind: 'network', message: 'offline' })).toMatchObject({
      failure: { kind: 'transient', status: null },
    });
    expect(mobileHistoryFailureError({ kind: 'http', status: 401, code: null, message: 'expired' })).toBeInstanceOf(HistoryAuthError);
  });

});
