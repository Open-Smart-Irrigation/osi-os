import axios from 'axios';
import { describe, expect, it } from 'vitest';
import { isDisabledAccountError } from '../api';

function responseError(status: number, data: unknown) {
  return new axios.AxiosError(
    'request failed',
    undefined,
    undefined,
    undefined,
    { status, data, statusText: '', headers: {}, config: {} as never },
  );
}

describe('disabled account responses', () => {
  it('recognizes only a 403 account-disabled response', () => {
    expect(isDisabledAccountError(responseError(403, { message: 'Account disabled' }))).toBe(true);
    expect(isDisabledAccountError(responseError(403, { message: 'Forbidden' }))).toBe(false);
    expect(isDisabledAccountError(responseError(401, { message: 'Account disabled' }))).toBe(false);
  });
});
