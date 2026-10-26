import { HistoryAuthError } from '../history/types';
import type { MobileAnalysisFailureInput, MobileHistoryFailure } from '../shared/types';
import { MobileAnalysisValidationError } from '../shared/types';
import { classifyMobileAnalysisFailure } from './mobileTensionPolicy';

export type MobileHistoryOperationalFailure = Exclude<MobileHistoryFailure, { kind: 'auth' }>;

export class MobileHistoryError extends Error {
  readonly name = 'MobileHistoryError';

  constructor(
    readonly failure: MobileHistoryOperationalFailure,
    readonly original?: unknown,
  ) {
    super(failure.reason);
  }
}

export function mobileHistoryFailureError(
  input: MobileAnalysisFailureInput | MobileAnalysisValidationError,
  original: unknown = input,
): MobileHistoryError | HistoryAuthError {
  const failure = classifyMobileAnalysisFailure(input);
  return failure.kind === 'auth'
    ? new HistoryAuthError(failure.status, failure.reason)
    : new MobileHistoryError(failure, original);
}
