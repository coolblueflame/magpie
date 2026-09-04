import { defineConfig, devices } from '@playwright/test';

/** e2e runs against the production build via `vite preview` at the real base path. */
export default defineConfig({
  testDir: 'e2e',
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://localhost:4173/magpie/',
    reuseExistingServer: !process.env.CI,
  },
  use: { baseURL: 'http://localhost:4173/magpie/' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
