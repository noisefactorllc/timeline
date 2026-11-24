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

async function toggleUntil(page, play, wanted) {
    await expect.poll(async () => {
        if ((await page.evaluate(() => window.__timeline.store.playing)) !== wanted) await play.click()
        return page.evaluate(() => window.__timeline.store.playing)
    }).toBe(wanted)
}

test('playback renders live frames, and a ruler drag re-renders the frame at the new playhead', async ({ page }) => {
    await boot(page)
    const play = page.locator('.tl-monitor .tl-transport [aria-label="Play or pause (Space)"]')
    const t0 = await page.evaluate(() => window.__timeline.store.playhead)
    const paused = await frameHash(page)

    // Playback: the playhead advances while the frame keeps rendering.
    await toggleUntil(page, play, true)
    await page.waitForFunction(
        t0 => window.__timeline.store.playhead > t0 + 0.5,
        t0,
        { timeout: 30_000 },
    )
    await page.evaluate(() => new Promise(r => setTimeout(r, 700)))
    await settleFrameDuringPlay(page)
    const live = await frameHash(page)
    expect(live).not.toBe(paused)

    // Pause through the transport first, so the view stops scrolling while
    // the drag coordinates are computed.
    await toggleUntil(page, play, false)

    // Scrubbing through the ruler: the drag moves the playhead to the time
    // the drag ends at. Snapping is off, so the requested time is the
    // pointer position itself, not a nearby snap point; the store lands the
    // playhead on the frame grid.
    await page.evaluate(() => window.__timeline.store.setView({ snapping: false }))
    const drag = await page.evaluate(() => {
        const scroll = document.querySelector('.tl-scroll')
        const store = window.__timeline.store
        const pps = store.view.pxPerSecond
        const seq = store.seq
        const rect = scroll.getBoundingClientRect()
        // A time a quarter of the visible ruler away from its left edge,
        // clear of the playhead and not at the very end of the sequence.
        const target = Math.min(seq.duration - 2, scroll.scrollLeft / pps + (rect.width * 0.25) / pps)
        return {
            clientX: rect.left + target * pps - scroll.scrollLeft,
            expected: Math.floor((target + 24 / pps) * seq.fps + 1e-6) / seq.fps,
        }
    })
    const ruler = page.locator('.tl-ruler')
    const box = await ruler.boundingBox()
    const y = box.y + box.height / 2
    const tBeforeDrag = await page.evaluate(() => window.__timeline.store.playhead)
    await page.mouse.move(drag.clientX, y)
    await page.mouse.down()
    await page.mouse.move(drag.clientX + 24, y, { steps: 4 })
    await page.mouse.up()
    const t1 = await page.evaluate(() => window.__timeline.store.playhead)
    expect(t1).toBeCloseTo(drag.expected, 2)
    expect(t1).not.toBeCloseTo(tBeforeDrag, 2)
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
