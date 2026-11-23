import {defineConfig, devices} from '@playwright/test';

export default defineConfig({
  testDir: './tests/public',
  testMatch: '**/*.spec.ts',
  timeout: 90_000,
  workers: 1,
  use: {
    actionTimeout: 10_000,
    baseURL: 'http://127.0.0.1:4174',
    viewport: {width: 1440, height: 900},
    headless: true,
    screenshot: 'only-on-failure',
    launchOptions: {args: ['--host-resolver-rules=MAP demo.osi.test 127.0.0.1,MAP same.osi.test 127.0.0.1,MAP website.osi.test 127.0.0.1,MAP staging.osi.test 127.0.0.1,MAP simulator.osi.test 127.0.0.1,MAP simulator-staging.osi.test 127.0.0.1,MAP attacker.osi.test 127.0.0.1']},
  },
  projects: [
    {name: 'chromium-desktop', use: {browserName: 'chromium'}},
    {name: 'chromium-mobile', use: {...devices['Pixel 7'], browserName: 'chromium'}},
    {name: 'firefox-desktop', use: {browserName: 'firefox', launchOptions: {}}},
  ],
  webServer: {
    command: 'npm run demo:build:public && npm run demo:build:website && PUBLIC_DEMO_ANCESTOR_TEST=1 npm run demo:serve:public',
    cwd: process.cwd(),
    url: 'http://127.0.0.1:4174/simulator/',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
