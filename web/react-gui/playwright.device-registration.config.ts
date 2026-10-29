import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  testMatch: 'device-registration.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  outputDir: './test-results/device-registration',
  reporter: [['list'], ['json', { outputFile: './test-results/device-registration.json' }]],
  use: {
    baseURL: 'http://127.0.0.1:4181',
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
    video: 'off',
    serviceWorkers: 'block',
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4181',
    url: 'http://127.0.0.1:4181/gui/',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
