import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

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

/** Wait until nothing is compiling and the frame at the playhead has drawn. */
async function settle(page) {
    await page.waitForFunction(() => {
        const tl = window.__timeline
        const busy = [...tl.pool.entries.values()].some(e => e.job)
        return !tl.store.playing && !busy && tl.renderer.lastMissing === 0
    }, null, { timeout: 180_000 })
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
}

test('playback renders live frames, and a ruler drag re-renders the frame at the new playhead', async ({ page }) => {
    await boot(page)
    const play = page.locator('.tl-monitor .tl-transport [aria-label="Play or pause (Space)"]')
    const t0 = await page.evaluate(() => window.__timeline.store.playhead)
    const paused = await frameHash(page)

    // Playback: the playhead advances while the frame keeps rendering.
    await play.click()
    await expect.poll(() => page.evaluate(() => window.__timeline.store.playing)).toBe(true)
    await page.waitForFunction(
        t0 => window.__timeline.store.playhead > t0 + 0.5,
        t0,
        { timeout: 30_000 },
    )
    await page.evaluate(() => new Promise(r => setTimeout(r, 700)))
    await settleFrameDuringPlay(page)
    const live = await frameHash(page)
    expect(live).not.toBe(paused)

    // Scrubbing through the ruler: the drag pauses playback and moves the playhead.
    const target = await page.evaluate(() => {
        const seq = window.__timeline.store.seq
        return Math.max(0.5, seq.duration * 0.15)
    })
    const ruler = page.locator('.tl-ruler')
    const box = await ruler.boundingBox()
    const x = box.x + (target / (await page.evaluate(() => window.__timeline.store.seq.duration))) * box.width
    await page.mouse.move(x, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(x + 24, box.y + box.height / 2, { steps: 4 })
    await page.mouse.up()
    const t1 = await page.evaluate(() => window.__timeline.store.playhead)
    expect(t1).not.toBe(t0)
    await expect.poll(() => page.evaluate(() => window.__timeline.store.playing)).toBe(false)

    await settle(page)
    const scrubbed = await frameHash(page)
    const stats = await page.evaluate(() => {
        const src = document.querySelector('.tl-monitor-canvas')
        const c = document.createElement('canvas')
        c.width = 64
        c.height = 36
        const g = c.getContext('2d')
        g.drawImage(src, 0, 0, 64, 36)
        const d = g.getImageData(0, 0, 64, 36).data
        let sum = 0
        let min = 255
        let max = 0
        for (let i = 0; i < d.length; i += 4) {
            const v = (d[i] + d[i + 1] + d[i + 2]) / 3
            sum += v
            if (v < min) min = v
            if (v > max) max = v
        }
        return { mean: sum / (d.length / 4), min, max }
    })
    // The scrubbed frame is the program's frame at the new time, not a stall.
    expect(scrubbed).not.toBe(live)
    expect(stats.max - stats.min).toBeGreaterThan(40)
    const tc = await page.evaluate(async () => {
        const { formatTimecode } = await import('/js/model/time.js')
        return formatTimecode(window.__timeline.store.playhead, window.__timeline.store.seq.fps)
    })
    await expect(page.locator('.tl-monitor .tl-timecode')).toHaveText(tc)
})

/** Two rAFs so the playing frame reaches the monitor before it is read. */
async function settleFrameDuringPlay(page) {
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
}
