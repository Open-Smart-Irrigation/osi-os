import { defineConfig, devices } from '@playwright/test';

const port = 43_139;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './test/browser',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  snapshotPathTemplate: '{testDir}/screenshots/{arg}{ext}',
  webServer: {
    command: `NODE_ENV=test OSI_BUILDER_FIXTURE_PORT=${port} node --import tsx test/browser/fixture-server.ts`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
  },
  use: {
    baseURL,
    locale: 'en-US',
    timezoneId: 'UTC',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1_440, height: 1_100 },
      },
    },
    {
      name: 'mobile',
      use: {
        ...devices['Pixel 5'],
        viewport: { width: 390, height: 844 },
      },
    },
  ],
});
