import { defineConfig, devices } from '@playwright/test';

const offBaseURL = process.env.MOBILE_HISTORY_EDGE_OFF_BASE_URL ?? 'http://127.0.0.1:4381/gui/';
const onBaseURL = process.env.MOBILE_HISTORY_EDGE_ON_BASE_URL ?? 'http://127.0.0.1:4382/gui/';
const feedBaseURL = process.env.MOBILE_HISTORY_FEED_BASE_URL ?? 'http://127.0.0.1:4383/gui/';
const outputDir = process.env.MOBILE_HISTORY_PLAYWRIGHT_OUTPUT ?? 'test-results/mobile-history';

export default defineConfig({
  testDir: './tests/browser',
  testMatch: ['mobile-tension-real-data.spec.ts', 'release-data-views.spec.ts'],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  outputDir,
  reporter: [['list'], ['json', { outputFile: `${outputDir}/results.json` }]],
  projects: [
    {
      name: 'edge-off',
      use: {
        ...devices['Pixel 5'],
        baseURL: offBaseURL,
        viewport: { width: 448, height: 998 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        locale: 'en-GB',
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
      },
    },
    {
      name: 'edge-on',
      testMatch: 'mobile-tension-real-data.spec.ts',
      use: {
        ...devices['Pixel 5'],
        baseURL: onBaseURL,
        viewport: { width: 448, height: 998 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        locale: 'en-GB',
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
      },
    },
    {
      name: 'release-feed',
      testMatch: 'release-data-views.spec.ts',
      use: {
        baseURL: feedBaseURL,
        viewport: { width: 1440, height: 900 },
        locale: 'en-GB',
      },
    },
    {
      name: 'release-feed-phone',
      testMatch: 'release-data-views.spec.ts',
      use: {
        ...devices['Pixel 5'],
        baseURL: feedBaseURL,
        viewport: { width: 448, height: 998 },
        locale: 'en-GB',
      },
    },
    {
      name: 'release-upgrade-desktop',
      testMatch: 'release-data-views.spec.ts',
      use: {
        baseURL: offBaseURL,
        viewport: { width: 1440, height: 900 },
        locale: 'en-GB',
      },
    },
  ],
});
