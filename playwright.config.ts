import process from 'node:process'
import { defineConfig, devices } from '@playwright/test'

const baseURL = 'http://127.0.0.1:4174/einvoice-excel-change-checker/'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL,
    headless: !!process.env.CI,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    },
  ],
  webServer: {
    command: process.env.CI
      ? 'npm run preview -- --host 127.0.0.1 --port 4174'
      : 'npm run build && npm run preview -- --host 127.0.0.1 --port 4174',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
  },
})
