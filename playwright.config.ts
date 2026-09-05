import { defineConfig, devices } from '@playwright/test';

/** e2e runs against the production build via `vite preview` at the real base path. */
export default defineConfig({
  testDir: 'e2e',
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://localhost:4173/magpie/',
    reuseExistingServer: !process.env.CI,
  },
  // The service worker would swallow route-stubbed requests; nothing here tests offline behaviour.
  use: { baseURL: 'http://localhost:4173/magpie/', serviceWorkers: 'block' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
