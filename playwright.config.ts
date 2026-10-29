import { defineConfig } from '@playwright/test';

// Uses the locally installed Google Chrome (no browser download needed).
// Override with PLAYWRIGHT_CHANNEL=chromium after `npx playwright install chromium`.
export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  globalTimeout: 300_000,
  reporter: 'list',
  use: {
    channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome',
    headless: true,
  },
});
