// A lost WebGL context: the engine rebuilds the program on a fresh canvas
// and presents there, so the timeline must follow the engine's canvas —
// the preview, thumbnails and export composite read `renderer.canvas`.
import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

test('a renderer follows the engine onto its fresh canvas after a context restore', async ({ page }) => {
    await boot(page, { demo: false })
    const result = await page.evaluate(async () => {
        const readBlue = canvas => {
            const c = document.createElement('canvas')
            c.width = 8
            c.height = 8
            const g = c.getContext('2d')
            g.drawImage(canvas, 0, 0, 8, 8)
            const d = g.getImageData(0, 0, 8, 8).data
            let max = 0
            for (let i = 2; i < d.length; i += 4) max = Math.max(max, d[i])
            return max
        }
        const { TRANSITIONS } = await import('/js/data/presets.js')
        const { ProgramRenderer } = await import('/js/render/programRenderer.js')
        const r = new ProgramRenderer({ width: 64, height: 36, audioState: window.__timeline.audio.state })
        const loaded = await r.load(TRANSITIONS[0].dsl)
        if (!loaded.success) return { error: loaded.error }
        // Upload the two media() inputs so the renderer holds applied sizes.
        const source = (red, green, blue) => {
            const c = document.createElement('canvas')
            c.width = 48
            c.height = 24
            const g = c.getContext('2d')
            g.fillStyle = `rgb(${red},${green},${blue})`
            g.fillRect(0, 0, 48, 24)
            return c
        }
        r.setInputs([source(0, 0, 255), source(255, 0, 0)])
        r.renderAt(0.5)
        const before = r.canvas
        const blueBefore = readBlue(before)
        const gl = before.getContext('webgl2')
        const lose = gl.getExtension('WEBGL_lose_context')
        lose.loseContext()
        lose.restoreContext()
        // The engine rebuilds on a fresh canvas in the old one's place, and
        // only after that rebuild completes does onContextRestored clear the
        // applied input sizes. Wait for both, so the assertions read the
        // restored state and not a rebuild still in progress.
        const deadline = performance.now() + 30_000
        while ((r.canvas === before || r._sizes.length !== 0) && performance.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 100))
        }
        const followed = r.canvas !== before
        // The restore clears the applied input sizes, so the next upload
        // re-applies imageSize to the rebuilt pipeline.
        const cleared = r._sizes.length === 0
        r.setInputs([source(0, 0, 255), source(255, 0, 0)])
        const reapplied = r._sizes[0]?.[0] === 48 && r._sizes[0]?.[1] === 24
        r.renderAt(0.5)
        const blueAfter = readBlue(r.canvas)
        const lost = r.contextLost
        await r.dispose()
        return { error: null, blueBefore, followed, cleared, reapplied, blueAfter, lost }
    })
    expect(result.error, JSON.stringify(result)).toBeNull()
    expect(result.blueBefore).toBeGreaterThan(20)
    expect(result.followed, JSON.stringify(result)).toBe(true)
    expect(result.cleared, JSON.stringify(result)).toBe(true)
    expect(result.reapplied, JSON.stringify(result)).toBe(true)
    expect(result.lost, JSON.stringify(result)).toBe(false)
    expect(result.blueAfter).toBeGreaterThan(20)
})
