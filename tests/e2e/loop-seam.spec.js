import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

// The main post chain's loop length in the demo (BAR * 8 at 128 BPM).
const SEAM = (60 / 128) * 4 * 8

/** A short hash of the presented frame, so two frames compare without image files. */
async function frameHash(page) {
    return page.evaluate(() => {
        const src = document.querySelector('.tl-monitor-canvas')
        const c = document.createElement('canvas')
        c.width = 64
        c.height = 36
        const g = c.getContext('2d')
        g.drawImage(src, 0, 0, 64, 36)
        const d = g.getImageData(0, 0, 64, 36).data
        let h = 0x811c9dc5
        for (let i = 0; i < d.length; i += 4) {
            h ^= d[i] | (d[i + 1] << 8) | (d[i + 2] << 16)
            h = Math.imul(h, 0x01000193)
        }
        return (h >>> 0).toString(16)
    })
}

test('playback keeps rendering across the post chain loop seam', async ({ page }) => {
    await boot(page)
    const errors = []
    page.on('pageerror', err => errors.push(err.message))

    // Settle the frame just before the seam, so playback starts on a drawn frame.
    await page.evaluate(t => window.__timeline.actions.seek(t), SEAM - 2)
    await page.waitForFunction(() => {
        const tl = window.__timeline
        const busy = [...tl.pool.entries.values()].some(e => e.job)
        return !tl.store.playing && !busy && tl.renderer.lastMissing === 0
    }, null, { timeout: 180_000 })

    const play = page.locator('.tl-monitor .tl-transport [aria-label="Play or pause (Space)"]')
    await expect.poll(async () => {
        if ((await page.evaluate(() => window.__timeline.store.playing)) !== true) await play.click()
        return page.evaluate(() => window.__timeline.store.playing)
    }).toBe(true)

    // The playhead crosses the seam while the frame keeps moving: the phase
    // wraps 1 -> 0 without a seek, so the engine integrates the wrapped delta.
    await page.waitForFunction(
        seam => window.__timeline.store.playhead > seam + 1.5,
        SEAM,
        { timeout: 60_000 },
    )
    const afterSeam = await frameHash(page)
    await page.evaluate(() => new Promise(r => setTimeout(r, 700)))
    const stillMoving = await frameHash(page)

    expect(stillMoving).not.toBe(afterSeam)
    expect(errors).toEqual([])
})

test('a wrapped phase steps by the wrapped delta through the app renderer', async ({ page }) => {
    await boot(page)
    const delta = await page.evaluate(async () => {
        const tl = window.__timeline
        const entry = [...tl.pool.entries.values()].find(e => e.renderer.ready && e.renderer._renderer?.pipeline)
        if (!entry) throw new Error('no ready renderer with a pipeline')
        const r = entry.renderer
        // Drive the app's own render entry across the wrap without a seek,
        // then read the delta the engine integrated for that step.
        await r.renderAt(0.99, { seek: true })
        await r.renderAt(0.01)
        return r._renderer.pipeline.globalUniforms.deltaTime
    })
    // The step across the wrap is the distance from 0.99 to 1.01, one full
    // frame of the loop: not a small fudge step, not a negative one.
    expect(delta).toBeGreaterThan(0.015)
    expect(delta).toBeLessThan(0.025)
})
