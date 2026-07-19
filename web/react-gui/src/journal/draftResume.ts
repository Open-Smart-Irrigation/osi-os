import type { CaptureEntryValueInput, JournalFieldState } from '../types/journalCapture';

function hasEnteredValue(input: CaptureEntryValueInput): boolean {
  if (input.value_status != null && input.value_status !== 'observed') return true;
  const value = input.value ?? input.value_text ?? input.entered_value_num ?? input.value_num;
  return value !== undefined && value !== null && value !== '';
}

/**
 * The field a resumed draft should move focus to: the first visible,
 * required field (in field-state/definition order) that has no entered
 * value yet. Used by the drafts queue's Resume action to open the shared
 * EntryForm capture engine already pointed at what still needs completing.
 * Returns null when nothing required is missing.
 */
export function firstMissingRequiredFieldCode(
  fieldStates: readonly JournalFieldState[],
  values: readonly CaptureEntryValueInput[],
): string | null {
  const missing = fieldStates.find((state) => {
    if (!state.visible || !state.required) return false;
    return !values.some(
      (value) => value.attribute_code === state.code && hasEnteredValue(value),
    );
  });
  return missing ? missing.code : null;
}
