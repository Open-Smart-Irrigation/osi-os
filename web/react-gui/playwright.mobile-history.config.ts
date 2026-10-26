import { defineConfig, devices } from '@playwright/test';

const offBaseURL = process.env.MOBILE_HISTORY_EDGE_OFF_BASE_URL ?? 'http://127.0.0.1:4181/gui/';
const onBaseURL = process.env.MOBILE_HISTORY_EDGE_ON_BASE_URL ?? 'http://127.0.0.1:4182/gui/';
const outputDir = process.env.MOBILE_HISTORY_PLAYWRIGHT_OUTPUT ?? 'test-results/mobile-history';

export default defineConfig({
  testDir: './tests/browser',
  testMatch: 'mobile-tension-real-data.spec.ts',
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
  ],
});
