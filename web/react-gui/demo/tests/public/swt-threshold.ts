import {expect, type Locator} from '@playwright/test';

const PRESET_NAMES: Record<string, string> = {20: 'Wet', 30: 'Moist', 50: 'Dry'};

/** Assert the selected current-main SWT preset or its editable custom value. */
export async function expectSwtThreshold(zone: Locator, value: string): Promise<void> {
  const preset = PRESET_NAMES[value];
  if (preset) {
    await expect(zone.getByRole('radio', {name: preset, exact: true})).toBeChecked();
    return;
  }
  await expect(zone.getByRole('radio', {name: 'Custom', exact: true})).toBeChecked();
  await expect(zone.locator('input[id^="swt-custom-threshold-"]')).toHaveValue(value);
}

export async function setCustomSwtThreshold(zone: Locator, value: string): Promise<void> {
  await zone.getByRole('radio', {name: 'Custom', exact: true}).check();
  await zone.locator('input[id^="swt-custom-threshold-"]').fill(value);
}
