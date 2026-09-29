import {defineConfig} from '@playwright/test';
export default defineConfig({testDir: './tests', testMatch: '**/*.spec.ts', timeout: 30000, workers: 1,
  use: {actionTimeout: 7000, baseURL: 'http://127.0.0.1:4173', viewport: {width: 1920, height: 1080}, headless: true, screenshot: 'only-on-failure'},
  webServer: {command: 'node demo/serve.mjs', cwd: process.cwd(), url: 'http://127.0.0.1:4173', reuseExistingServer: !process.env.CI},
});
