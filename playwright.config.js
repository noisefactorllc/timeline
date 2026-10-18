// End-to-end suite: the real app in Chromium against the live engine CDN.
// Software WebGL is slow, so timeouts are generous and tests run one at a time.
import { defineConfig, devices } from '@playwright/test'

const PORT = Number(process.env.TIMELINE_TEST_PORT || 3047)

export default defineConfig({
    testDir: './tests/e2e',
    workers: 1,
    timeout: 240_000,
    expect: { timeout: 60_000 },
    retries: 0,
    reporter: [['list']],
    use: {
        baseURL: `http://localhost:${PORT}`,
        viewport: { width: 1600, height: 1000 },
        launchOptions: {
            args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'],
        },
    },
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 1000 } } }],
    webServer: {
        command: `node scripts/dev-server.mjs ${PORT}`,
        url: `http://localhost:${PORT}/index.html`,
        reuseExistingServer: false,
        timeout: 30_000,
    },
})
