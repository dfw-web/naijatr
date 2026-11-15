import { defineConfig, devices } from '@playwright/test'

/**
 * Browser tests (npm run test:e2e): the built site in a real Chromium, with
 * the real Monetag Multitag. The site is served by `vite preview` and opened
 * as http://naijatr-e2e.test:4173 (mapped to this machine), so it isn't a
 * "dev host" and the ads run as on the live site. Desktop and mobile.
 * E2E_BASE_URL=https://www.naijatr.com runs the same tests against the live site.
 */
const BASE = process.env.E2E_BASE_URL ?? 'http://naijatr-e2e.test:4173'
const local = !process.env.E2E_BASE_URL
const launchOptions = local ? { args: ['--host-resolver-rules=MAP naijatr-e2e.test 127.0.0.1'] } : {}

export default defineConfig({
  testDir: 'e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: BASE, trace: 'retain-on-failure', serviceWorkers: 'block' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], launchOptions } },
    { name: 'mobile', use: { ...devices['Pixel 7'], launchOptions } },
  ],
  webServer: local
    ? { command: 'npm run build && npx vite preview --port 4173 --strictPort --host 127.0.0.1', url: 'http://127.0.0.1:4173', timeout: 240_000, reuseExistingServer: true }
    : undefined,
})
