// Shared helpers: boot the app and wait until a frame is fully compiled.

export async function boot(page, { pauseThumbnails = true, demo = true } = {}) {
    const errors = []
    page.on('pageerror', err => errors.push(err.message))
    await page.goto('/index.html')
    await page.waitForFunction(() => window.__timeline?.ready === true, null, { timeout: 180_000 })
    if (pauseThumbnails) await page.evaluate(() => { window.__timeline.thumbs.paused = true })
    if (demo) {
        await page.evaluate(async () => {
            const tl = window.__timeline
            await tl.actions.openDemo()
            const drop = tl.store.seq.markers.find(m => m.name === 'Drop')
            if (drop) tl.actions.seek(drop.time + 1)
        })
        await settleAt(page, await page.evaluate(() => window.__timeline.store.playhead))
    }
    return errors
}

/** Seek and wait until every layer of the frame has compiled and drawn. */
export async function settleAt(page, t) {
    await page.evaluate(t => window.__timeline.actions.seek(t), t)
    await page.waitForFunction(() => {
        const tl = window.__timeline
        const busy = [...tl.pool.entries.values()].some(e => e.job)
        return !busy && tl.renderer.lastMissing === 0
    }, null, { timeout: 180_000 })
    // Two animation frames so the settled frame reaches the monitor.
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
}

/** Mean brightness and colour spread of the monitor canvas. */
export async function monitorStats(page) {
    return page.evaluate(() => {
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
}
