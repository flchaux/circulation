import { defineConfig } from '@playwright/test'

/**
 * Par défaut les tests s'exécutent contre le build local servi par `vite preview`.
 * `PLAYWRIGHT_BASE_URL=https://circulation.chaux.me npx playwright test` les rejoue
 * contre le site déployé, sans démarrer de serveur local.
 */
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4173'
const distant = !baseURL.includes('127.0.0.1') && !baseURL.includes('localhost')

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL,
    headless: true,
    viewport: { width: 1400, height: 900 },
    locale: 'fr-FR',
    screenshot: 'only-on-failure',
  },
  webServer: distant
    ? undefined
    : {
        command: 'npx vite preview --port 4173 --strictPort',
        url: 'http://127.0.0.1:4173',
        reuseExistingServer: true,
        timeout: 60_000,
      },
})
