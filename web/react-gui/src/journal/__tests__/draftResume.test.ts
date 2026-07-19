import { describe, expect, it } from 'vitest';

import { firstMissingRequiredFieldCode } from '../draftResume';
import type { CaptureEntryValueInput, JournalFieldState } from '../../types/journalCapture';

function state(overrides: Partial<JournalFieldState> & { code: string }): JournalFieldState {
  return { visible: true, required: false, required_any_groups: [], ...overrides };
}

function value(overrides: Partial<CaptureEntryValueInput> & { attribute_code: string }): CaptureEntryValueInput {
  return { ...overrides };
}

describe('firstMissingRequiredFieldCode', () => {
  it('returns null when there are no field states', () => {
    expect(firstMissingRequiredFieldCode([], [])).toBeNull();
  });

  it('returns null when every required visible field already has a value', () => {
    const states = [
      state({ code: 'attr.a', required: true }),
      state({ code: 'attr.b', required: true }),
    ];
    const values = [
      value({ attribute_code: 'attr.a', value: 'x' }),
      value({ attribute_code: 'attr.b', value: 12 }),
    ];

    expect(firstMissingRequiredFieldCode(states, values)).toBeNull();
  });

  it('returns the first missing required visible field in field-state order', () => {
    const states = [
      state({ code: 'attr.first', required: true }),
      state({ code: 'attr.second', required: true }),
    ];
    const values = [value({ attribute_code: 'attr.second', value: 'y' })];

    expect(firstMissingRequiredFieldCode(states, values)).toBe('attr.first');
  });

  it('ignores an optional field that has no value', () => {
    const states = [
      state({ code: 'attr.optional', required: false }),
      state({ code: 'attr.required', required: true }),
    ];
    const values = [value({ attribute_code: 'attr.required', value: 'set' })];

    expect(firstMissingRequiredFieldCode(states, values)).toBeNull();
  });

  it('ignores a required field that is not currently visible', () => {
    const states = [
      state({ code: 'attr.hidden', required: true, visible: false }),
      state({ code: 'attr.shown', required: true }),
    ];
    const values = [value({ attribute_code: 'attr.shown', value: 'ok' })];

    expect(firstMissingRequiredFieldCode(states, values)).toBeNull();
  });

  it('treats an explicit non-observed status as satisfying the requirement', () => {
    const states = [state({ code: 'attr.na', required: true })];
    const values = [value({ attribute_code: 'attr.na', value_status: 'not_applicable' })];

    expect(firstMissingRequiredFieldCode(states, values)).toBeNull();
  });

  it('treats an empty string value as missing', () => {
    const states = [state({ code: 'attr.note', required: true })];
    const values = [value({ attribute_code: 'attr.note', value: '' })];

    expect(firstMissingRequiredFieldCode(states, values)).toBe('attr.note');
  });
});
