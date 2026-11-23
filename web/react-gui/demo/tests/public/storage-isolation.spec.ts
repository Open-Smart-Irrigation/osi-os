import {expect, test} from '@playwright/test';

const holdEntries = [
  {name: 'expired', value: '{"0016C001F1000001":0}'},
  {name: 'malformed', value: '{'},
];

for (const entry of holdEntries) {
  test(`public bootstrap preserves native ${entry.name} hold bytes`, async ({page}) => {
    await page.addInitScript((value: string) => {
      const nativeSession = window.sessionStorage;
      const nativeLocal = window.localStorage;
      nativeSession.setItem('osi.valveOpenHolds.v1', value);
      nativeLocal.setItem('osi.valveOpenHolds.v1', value);
      Object.assign(window, {__nativeStorageBeforeDemo: {session: nativeSession, local: nativeLocal}});
    }, entry.value);
    await page.goto('/simulator/app.html');
    await expect(page.locator('#root')).toHaveAttribute('data-public-simulator', 'true');
    await expect(page.locator('#root')).not.toBeEmpty();
    const nativeValues = await page.evaluate(() => {
      const snapshot = (window as Window & {__nativeStorageBeforeDemo: {session: Storage; local: Storage}}).__nativeStorageBeforeDemo;
      return [snapshot.session.getItem('osi.valveOpenHolds.v1'), snapshot.local.getItem('osi.valveOpenHolds.v1')];
    });
    expect(nativeValues).toEqual([entry.value, entry.value]);
  });
}
