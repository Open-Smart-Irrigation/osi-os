import { defineConfig } from '@playwright/test';

const externalBaseURL = process.env.HISTORY_ZOOM_BASE_URL;

export default defineConfig({
  testDir: './tests/browser',
  timeout: 45_000,
  expect: { timeout: 7_500 },
  workers: 1,
  fullyParallel: false,
  outputDir: 'test-results/playwright',
  reporter: [['list'], ['json', { outputFile: 'test-results/playwright/results.json' }]],
  projects: [{
    name: 'pixel-8-pro-chromium',
    use: {
      browserName: 'chromium',
      baseURL: externalBaseURL ?? 'http://127.0.0.1:4178/',
      viewport: { width: 448, height: 998 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      screenshot: 'only-on-failure',
      trace: 'retain-on-failure',
    },
  }],
  webServer: externalBaseURL ? undefined : {
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4178',
    url: 'http://127.0.0.1:4178/',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
