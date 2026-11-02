import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.js',
  use: { baseURL: 'http://127.0.0.1:3111', viewport: { width: 390, height: 844 } },
  webServer: {
    command: 'node server.js',
    cwd: '..',
    url: 'http://127.0.0.1:3111/health',
    env: { PORT: '3111', DATABASE_URL: process.env.TEST_DATABASE_URL ?? '', DATA_DIR: 'memory' },
    reuseExistingServer: false,
  },
});
