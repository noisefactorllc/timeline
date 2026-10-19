import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

test('subtitle backgrounds have rounded transparent corners with independent padding', async ({ page }) => {
    await page.route('**/text-canvas', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }))
    await page.goto('/text-canvas')
    const result = await page.evaluate(async () => {
        const { GraphicsRenderer } = await import('/js/render/graphics.js')
        const { normalizeProject } = await import('/js/model/normalize.js')
        const { project } = normalizeProject({ sequences: { main: { tracks: [{ clips: [
            { text: 'MMMM', start: 0, duration: 2, size: 0.2, background: '#000000', enter: 'none', exit: 'none' },
            { text: 'MMMM', start: 2, duration: 2, size: 0.2, background: '#000000', backgroundPaddingX: 0.65, backgroundPaddingY: 0.4, backgroundRadius: 0.42, enter: 'none', exit: 'none' },
        ] }] } } })
        const renderer = new GraphicsRenderer({ getProject: () => project })
        const inspect = (clip, key) => {
            const c = renderer.draw(clip, 1, key, 480, 270)
            const g = c.getContext('2d'), pixels = g.getImageData(0, 0, c.width, c.height).data
            let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0
            for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (pixels[(y * c.width + x) * 4 + 3] > 128) {
                x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y)
            }
            const at = (x, y) => [...g.getImageData(x, y, 1, 1).data]
            return { width: x1 - x0 + 1, height: y1 - y0 + 1, corner: at(x0 + 1, y0 + 1), top: at(Math.floor((x0 + x1) / 2), y0 + 2) }
        }
        const [plain, pill] = project.sequences.main.tracks[0].clips
        return { plain: inspect(plain, 'plain'), pill: inspect(pill, 'pill') }
    })
    expect(result.plain.corner[3]).toBe(255)
    expect(result.pill.corner[3]).toBe(0)
    expect(result.pill.top).toEqual([0, 0, 0, 255])
    expect(result.pill.width - result.plain.width).toBeGreaterThan(35)
    expect(result.pill.height - result.plain.height).toBeGreaterThan(8)
})


test('text draws without a background, with an outline, or with a shadow', async ({ page }) => {
    await page.route('**/text-canvas', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }))
    await page.goto('/text-canvas')
    const result = await page.evaluate(async () => {
        const { GraphicsRenderer } = await import('/js/render/graphics.js')
        const { normalizeProject } = await import('/js/model/normalize.js')
        const { project } = normalizeProject({ sequences: { main: { tracks: [{ clips: [
            { text: 'MMMM', start: 0, duration: 2, size: 0.2, background: null, enter: 'none', exit: 'none' },
            { text: 'MMMM', start: 2, duration: 2, size: 0.2, background: null, outline: { color: '#ff0000', width: 0.15 }, enter: 'none', exit: 'none' },
            { text: 'MMMM', start: 4, duration: 2, size: 0.2, background: null, shadow: { color: '#00ff00', blur: 0, x: 0.8, y: 0.5 }, enter: 'none', exit: 'none' },
        ] }] } } })
        const renderer = new GraphicsRenderer({ getProject: () => project })
        return project.sequences.main.tracks[0].clips.map((clip, i) => {
            const c = renderer.draw(clip, 1, 'style-' + i, 480, 270), g = c.getContext('2d')
            const d = g.getImageData(0, 0, 480, 270).data
            let red = 0, green = 0, white = 0
            for (let k = 0; k < d.length; k += 4) {
                if (d[k + 3] < 100) continue
                if (d[k] > 180 && d[k + 1] < 60 && d[k + 2] < 60) red++
                if (d[k] < 60 && d[k + 1] > 180 && d[k + 2] < 60) green++
                if (d[k] > 180 && d[k + 1] > 180 && d[k + 2] > 180) white++
            }
            return { red, green, white, cornerAlpha: d[3] }
        })
    })
    expect(result[0].white).toBeGreaterThan(100)
    expect(result[0].cornerAlpha).toBe(0)
    expect(result[0].red).toBe(0)
    expect(result[0].green).toBe(0)
    expect(result[1].red).toBeGreaterThan(100)
    expect(result[1].white).toBeGreaterThan(100)
    expect(result[2].green).toBeGreaterThan(100)
    expect(result[2].white).toBeGreaterThan(100)
    expect(result[1].cornerAlpha).toBe(0)
    expect(result[2].cornerAlpha).toBe(0)
})


test('the text inspector edits backgrounds, outlines and shadows with undo and project persistence', async ({ page }) => {
    const errors = await boot(page)
    await page.evaluate(async () => {
        const tl = window.__timeline
        await tl.actions.newProject()
        tl.actions.addText()
        const id = [...tl.store.selection.clips][0]
        const clip = tl.store.seq.tracks.flatMap(t => t.clips).find(c => c.id === id)
        delete clip.backgroundPaddingX
        delete clip.backgroundPaddingY
    })
    await expect(page.getByLabel('Horizontal padding %', { exact: true })).toHaveValue('30')
    await expect(page.getByLabel('Vertical padding %', { exact: true })).toHaveValue('30')
    await expect(page.getByLabel('Outline', { exact: true })).toBeVisible()
    await page.getByLabel('Outline', { exact: true }).check()
    await page.getByLabel('Outline width %', { exact: true }).fill('8')
    await page.getByLabel('Outline width %', { exact: true }).press('Tab')
    await page.getByLabel('Shadow', { exact: true }).check()
    await page.getByLabel('Shadow blur %', { exact: true }).fill('12')
    await page.getByLabel('Shadow blur %', { exact: true }).press('Tab')
    await page.getByLabel('Background', { exact: true }).check()
    await page.getByLabel('Corner radius %', { exact: true }).fill('40')
    await page.getByLabel('Corner radius %', { exact: true }).press('Tab')
    const style = await page.evaluate(async () => {
        const tl = window.__timeline
        const id = [...tl.store.selection.clips][0]
        const clip = () => tl.store.seq.tracks.flatMap(t => t.clips).find(c => c.id === id)
        const before = structuredClone(clip())
        tl.store.undo()
        const undone = clip().backgroundRadius
        tl.store.redo()
        const { normalizeProject } = await import('/js/model/normalize.js')
        const again = normalizeProject(JSON.parse(JSON.stringify(tl.store.project))).project
        const saved = again.sequences[tl.store.seq.id].tracks.flatMap(t => t.clips).find(c => c.id === id)
        return { before, undone, saved }
    })
    expect(style.before.outline.width).toBe(0.08)
    expect(style.before.shadow.blur).toBe(0.12)
    expect(style.before.backgroundRadius).toBe(0.4)
    expect(style.undone).toBe(0)
    expect(style.saved.outline).toEqual(style.before.outline)
    expect(style.saved.shadow).toEqual(style.before.shadow)
    expect(style.saved.backgroundRadius).toBe(0.4)
    await page.getByLabel('Background', { exact: true }).uncheck()
    await expect.poll(() => page.evaluate(() => {
        const tl = window.__timeline, id = [...tl.store.selection.clips][0]
        return tl.store.seq.tracks.flatMap(t => t.clips).find(c => c.id === id).background
    })).toBeNull()
    expect(errors).toEqual([])
})


test('a complete multiline text block casts one filled shadow behind its foreground', async ({ page }) => {
    await page.route('**/text-canvas', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' }))
    await page.goto('/text-canvas')
    const result = await page.evaluate(async () => {
        const { GraphicsRenderer } = await import('/js/render/graphics.js')
        const { createTextClip } = await import('/js/model/project.js')
        const renderer = new GraphicsRenderer({ getProject: () => ({}) })
        const inspect = (style, key, region = [0, 0, 800, 400]) => {
            const clip = createTextClip({ text: 'I', size: 0.4, weight: 900, x: 0.25, y: 0.5, enter: { preset: 'none' }, exit: { preset: 'none' }, ...style })
            const c = renderer.draw(clip, 1, key, 800, 400)
            const d = c.getContext('2d').getImageData(...region).data
            let green = 0, white = 0, maxGreenAlpha = 0
            for (let k = 0; k < d.length; k += 4) {
                if (d[k] < 30 && d[k + 1] > 220 && d[k + 2] < 30) {
                    maxGreenAlpha = Math.max(maxGreenAlpha, d[k + 3])
                    if (d[k + 3] > 220) green++
                }
                if (d[k] > 220 && d[k + 1] > 220 && d[k + 2] > 220 && d[k + 3] > 220) white++
            }
            return { green, white, maxGreenAlpha }
        }
        const shadow = { color: '#00ff00', blur: 0, x: 1, y: 0 }
        const outline = { color: '#ff0000', width: 0.01 }
        const multiline = { text: 'I\nI', size: 0.2, x: 0.5 }
        return {
            shadow: inspect({ shadow }, 'shadow'),
            both: inspect({ shadow, outline }, 'both'),
            translucent: inspect({ shadow: { ...shadow, color: '#00ff0080' }, outline }, 'translucent'),
            plainLines: inspect(multiline, 'plain-lines', [0, 100, 800, 100]),
            shadowLines: inspect({ ...multiline, shadow: { ...shadow, x: 0, y: -1.1 } }, 'shadow-lines', [0, 100, 800, 100]),
        }
    })
    expect(result.both.green).toBeGreaterThanOrEqual(result.shadow.green * 0.95)
    expect(result.translucent.maxGreenAlpha).toBeGreaterThanOrEqual(127)
    expect(result.translucent.maxGreenAlpha).toBeLessThanOrEqual(129)
    expect(result.shadowLines.white).toBe(result.plainLines.white)
    expect(result.shadowLines.green).toBe(0)
})
