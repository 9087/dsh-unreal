import { defineConfig } from '@playwright/test'

/**
 * The real-browser suite: a throwaway `dsh web` booted per file, this plugin
 * linked into its profile, a stand-in Remote Control endpoint, and a Chromium
 * page driving the panel.
 *
 * Serial and single-worker on purpose. Each file owns a host process and a
 * temporary `DSH_HOME`, and two boots at once would be two hosts competing for
 * the same cold-start work.
 */
export default defineConfig({
  testDir: 'e2e',
  testIgnore: ['**/fixtures/**', '**/helpers/**'],
  // A test's first step can be a cold `dsh web` boot plus a Chromium launch.
  timeout: 300_000,
  expect: { timeout: 25_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    viewport: { width: 1440, height: 900 },
    trace: 'off',
    video: 'off',
  },
  projects: [{ name: 'chromium' }],
})
