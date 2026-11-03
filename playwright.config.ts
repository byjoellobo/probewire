import { defineConfig, devices } from '@playwright/test';

const PORT = 4799;
const CI = !!process.env.CI;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 2 : 0,
  reporter: CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}/`,
    trace: 'on-first-retry',
    // A stale service worker would serve old builds between runs.
    serviceWorkers: 'block',
  },
  webServer: {
    command: 'npm run build && npx vite preview',
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !CI,
    timeout: 240_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
