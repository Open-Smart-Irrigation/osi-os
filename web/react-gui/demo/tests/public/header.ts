import {expect, type FrameLocator} from '@playwright/test';

/**
 * Follow the app header's Settings link. Below the `sm` breakpoint the header
 * keeps Settings inside its Menu panel, so open that panel first when the link
 * is collapsed. The simulator's app frame is phone-width on every project.
 */
export async function openSettingsFromHeader(app: FrameLocator, name: string | RegExp = /settings/i): Promise<void> {
  const link = app.getByRole('link', typeof name === 'string' ? {name, exact: true} : {name});
  const menu = app.locator('header').getByRole('button', {name: /^(menu|menü|menú)$/i});
  await expect(link.or(menu).first()).toBeVisible();
  if (!(await link.isVisible())) await menu.click();
  await link.click();
}
