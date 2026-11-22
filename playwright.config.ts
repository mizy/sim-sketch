import {defineConfig, devices} from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:18766',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? {executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}
      : undefined
  },
  webServer: {
    command: 'pnpm dev --port 18766 --strictPort',
    url: 'http://127.0.0.1:18766',
    reuseExistingServer: true,
    timeout: 30000
  },
  projects: [
    {name: 'chromium', testIgnore: '**/webgpu-*.spec.ts', use: {...devices['Desktop Chrome']}},
    {
      name: 'webgpu',
      testMatch: '**/webgpu-*.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
            ? {executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}
            : {}),
          args: ['--enable-unsafe-webgpu']
        }
      }
    }
  ]
});
