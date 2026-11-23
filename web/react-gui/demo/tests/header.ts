import {expect, type FrameLocator, type Locator} from '@playwright/test';

/**
 * Click a control in the app header's action panel (Add, Settings, Account).
 * Below the `sm` breakpoint the header keeps those controls inside its Menu
 * panel, so open that panel first when the control is collapsed. The
 * simulator's app frame is phone-width on every project.
 */
export async function clickHeaderControl(app: FrameLocator, control: Locator): Promise<void> {
  const menu = app.locator('header').getByRole('button', {name: /^(menu|menü|menú)$/i});
  await expect(control.or(menu).first()).toBeVisible();
  if (!(await control.isVisible())) await menu.click();
  await control.click();
}

/** Follow the app header's Settings link. */
export async function openSettingsFromHeader(app: FrameLocator, name: string | RegExp = /settings/i): Promise<void> {
  await clickHeaderControl(app, app.getByRole('link', typeof name === 'string' ? {name, exact: true} : {name}));
}
