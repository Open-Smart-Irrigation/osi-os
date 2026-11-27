import {expect, test as base, type FrameLocator, type Page} from '@playwright/test';
import type {ZoneEnvironmentSummary} from '../../../react-gui/src/types/farming';
import {providerOrPlace, shipped, locales} from '../phone-spec';
import {builtFile} from './serve.mjs';

type Locale = typeof locales[number];
export const baseUrl = 'http://127.0.0.1:4275';
export const PHONE_FRAME = 'iframe[title="OSI OS phone"]';

declare global {
  interface Window {
    __phoneCsp?: string[];
  }
}

export const test = base.extend<{checkPhoneBoundary: void}>({
  checkPhoneBoundary: [async ({page}, use) => {
    const errors: string[] = [];
    const unexpectedRequests: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin !== baseUrl || !builtFile(url.pathname)) unexpectedRequests.push(url.href);
    });
    await page.addInitScript(() => {
      window.__phoneCsp = [];
      document.addEventListener('securitypolicyviolation', event => {
        window.__phoneCsp!.push(event.effectiveDirective + ' ' + event.blockedURI);
      });
    });
    await use();
    const violations = (await Promise.all(page.frames().map(frame => frame.evaluate(() => window.__phoneCsp ?? [])))).flat();
    expect(violations, 'CSP violations').toEqual([]);
    expect(unexpectedRequests, 'Requests outside the production artifacts').toEqual([]);
    expect(errors, 'Console and page errors').toEqual([]);
  }, {auto: true}],
});

export async function raisePhone(page: Page, search = '', path = '/phone-host.html'): Promise<FrameLocator> {
  await page.goto(path + '?probe&' + search);
  await expect(page.locator(PHONE_FRAME)).toHaveCount(0);
  await page.getByRole('button', {name: 'Raise phone'}).click();
  const phone = page.frameLocator(PHONE_FRAME);
  await expect(phone.getByRole('heading', {name: 'Tomato bed', exact: true})).toBeVisible();
  return phone;
}

export function translate(locale: Locale, key: string): string {
  const value = shipped(locale, key) ?? shipped('en', key);
  if (!value) throw new Error('Missing shipped string ' + key);
  return value;
}

export async function selectEnvironmentTab(phone: FrameLocator, locale: Locale, tab: 'water' | 'weather' | 'agronomic' | 'soil' | 'sensors') {
  const environment = phone.getByRole('button', {name: new RegExp(translate(locale, 'devices:environment.sectionTitle'), 'i')});
  if (await environment.getAttribute('aria-expanded') === 'false') await environment.click();
  await phone.getByRole('button', {name: translate(locale, 'devices:environment.tabs.' + tab), exact: true}).click();
}

export async function showZoneDevices(phone: FrameLocator, locale: Locale) {
  const devices = phone.getByRole('button', {name: translate(locale, 'devices:zone.devicesInZone'), exact: false});
  if (await devices.getAttribute('aria-expanded') === 'false') await devices.click();
}

export async function startTimedDrip(phone: FrameLocator, minutes: string) {
  await showZoneDevices(phone, 'en');
  await phone.locator('input[id^="strega-duration-"]').fill(minutes);
  for (const key of ['openFor', 'confirmOpen']) {
    const button = translate('en', 'devices:stregaValve.' + key).replace('{{minutes}}', minutes);
    await phone.getByRole('button', {name: button, exact: true}).click();
  }
}

export async function scanPhone(phone: FrameLocator) {
  const badText = await phone.locator('body').evaluate(body => [
    (body as HTMLElement).innerText,
    ...Array.from(body.querySelectorAll('[title], [aria-label], [placeholder], option'))
      .flatMap(el => [el.getAttribute('title'), el.getAttribute('aria-label'), el.getAttribute('placeholder'),
        el.tagName === 'OPTION' ? el.textContent : null]),
  ].filter((value): value is string => typeof value === 'string'));
  expect(badText.join('\n')).not.toMatch(providerOrPlace);
}

export async function currentSummary(page: Page): Promise<Pick<ZoneEnvironmentSummary, 'forecast' | 'water'>> {
  return page.evaluate(() => {
    const response = window.farmSimPhone!.request('GET', '/api/irrigation-zones/1/environment-summary', undefined);
    const {forecast, water} = response.data as ZoneEnvironmentSummary;
    return {forecast, water};
  });
}
