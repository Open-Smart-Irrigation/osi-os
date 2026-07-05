import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  readDisplayPreferences,
  useDisplayPreferences,
  writeDisplayPreferences,
} from '../displayPreferences';

describe('display preferences', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('defaults the SWT unit to kPa', () => {
    expect(readDisplayPreferences()).toEqual({ swtUnit: 'kPa' });
  });

  it('persists and reloads the SWT unit', () => {
    writeDisplayPreferences({ swtUnit: 'pF' });
    expect(window.localStorage.getItem('osi.display.swtUnit')).toBe('pF');
    expect(readDisplayPreferences()).toEqual({ swtUnit: 'pF' });
  });

  it('treats unknown stored values as kPa', () => {
    window.localStorage.setItem('osi.display.swtUnit', 'bars');
    expect(readDisplayPreferences()).toEqual({ swtUnit: 'kPa' });
  });

  it('updates live consumers when the preference changes', () => {
    const { result } = renderHook(() => useDisplayPreferences());
    expect(result.current.swtUnit).toBe('kPa');
    act(() => {
      writeDisplayPreferences({ swtUnit: 'pF' });
    });
    expect(result.current.swtUnit).toBe('pF');
  });
});
