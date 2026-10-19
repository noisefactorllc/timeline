import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

// A fresh project with the post chain off, so pixels come straight from the layers.
async function plainProject(page) {
    await page.evaluate(async () => {
        const tl = window.__timeline
        await tl.actions.newProject()
        tl.store.edit('plain', s => { s.post.enabled = false })
    })
}

/** RGB at (x, y), as fractions of the frame, of PNG frames from the snapshot command. */
async function snapshotPixels(page, times, points) {
    return page.evaluate(async ({ times, points }) => {
        const result = await window.__timeline.snapshot({ times, scale: 0.25 })
        const out = []
        for (const frame of result.frames) {
            const bitmap = await createImageBitmap(new Blob([frame.bytes], { type: 'image/png' }))
            const c = new OffscreenCanvas(bitmap.width, bitmap.height)
            const g = c.getContext('2d')
            g.drawImage(bitmap, 0, 0)
            out.push(points.map(([x, y]) => [...g.getImageData(Math.floor(x * (bitmap.width - 1)), Math.floor(y * (bitmap.height - 1)), 1, 1).data.slice(0, 3)]))
        }
        return out
    }, { times, points })
}

test('text and an imported image draw over the tracks beneath, and a program above them reads them', async ({ page }) => {
    const errors = await boot(page)
    await plainProject(page)
    await page.evaluate(async () => {
        const tl = window.__timeline
        const c = new OffscreenCanvas(64, 64)
        const g = c.getContext('2d')
        g.fillStyle = '#ff0000'
        g.fillRect(0, 0, 64, 64)
        const png = await c.convertToBlob({ type: 'image/png' })
        tl.actions.seek(0)
        await tl.actions.handleFiles([new File([png], 'red.png', { type: 'image/png' })])
        const imageId = [...tl.store.selection.clips][0]
        tl.store.edit('fill', s => { s.tracks.flatMap(t => t.clips).find(c => c.id === imageId).fit = 'fill' })
        tl.actions.addText()
        const textId = [...tl.store.selection.clips][0]
        tl.store.edit('style', s => {
            Object.assign(s.tracks.flatMap(t => t.clips).find(c => c.id === textId), {
                text: 'MMMM', size: 0.3, color: '#00ff00', background: '#00ff00', enter: { preset: 'none' }, exit: { preset: 'none' },
            })
        })
    })
    await expect(page.locator('.tl-clip.is-image')).toHaveCount(1)
    await expect(page.locator('.tl-clip.is-text')).toHaveCount(1)
    // The image fills the frame; the text sits over it in the middle.
    let [[edge, middle]] = await snapshotPixels(page, [1], [[0.05, 0.05], [0.5, 0.5]])
    expect(edge[0]).toBeGreaterThan(200)
    expect(edge[1]).toBeLessThan(40)
    expect(middle[1]).toBeGreaterThan(200)
    expect(middle[0]).toBeLessThan(40)

    // A program on the track above that reads media() processes the layers beneath: inverted, red turns cyan and green magenta.
    await page.evaluate(() => {
        const tl = window.__timeline
        tl.store.edit('invert', s => {
            const track = tl.edits.addTrack(s, 'visual')
            tl.edits.insertClip(track, tl.model.createProgramClip({
                name: 'Invert', start: 0, duration: 4, dsl: 'search synth, filter\nmedia()\n  .invert()\n  .write(o0)\nrender(o0)',
            }))
        })
    })
    ;[[edge, middle]] = await snapshotPixels(page, [1], [[0.05, 0.05], [0.5, 0.5]])
    expect(edge[0]).toBeLessThan(40)
    expect(edge[1]).toBeGreaterThan(200)
    expect(edge[2]).toBeGreaterThan(200)
    expect(middle[0]).toBeGreaterThan(200)
    expect(middle[1]).toBeLessThan(40)
    expect(errors).toEqual([])
})

test('enter and exit motion fade a title in and out', async ({ page }) => {
    await boot(page)
    await plainProject(page)
    await page.evaluate(() => {
        const tl = window.__timeline
        tl.actions.seek(0)
        tl.actions.addText()
        const id = [...tl.store.selection.clips][0]
        tl.store.edit('style', s => {
            Object.assign(s.tracks.flatMap(t => t.clips).find(c => c.id === id), {
                text: 'MMMM', size: 0.3, color: '#ffffff', background: '#ffffff', duration: 4,
                enter: { preset: 'fade', duration: 1, ease: 'none' }, exit: { preset: 'fade', duration: 1, ease: 'none' },
            })
        })
    })
    const frames = await snapshotPixels(page, [0, 0.5, 2, 3.5], [[0.5, 0.5]])
    const level = frames.map(([[r]]) => r)
    expect(level[0]).toBeLessThan(10)
    expect(level[1]).toBeGreaterThan(100)
    expect(level[1]).toBeLessThan(160)
    expect(level[2]).toBeGreaterThan(245)
    expect(level[3]).toBeGreaterThan(100)
    expect(level[3]).toBeLessThan(160)
})

test('a video clip shows the frame for each time exactly, from any order of seeks', async ({ page }) => {
    const errors = await boot(page)
    await plainProject(page)
    // A two-second test video whose every frame is a different flat colour.
    const made = await page.evaluate(async () => {
        const mb = await import('mediabunny')
        const codec = (await mb.canEncodeVideo('vp9', { width: 64, height: 64 })) ? 'vp9' : 'vp8'
        const canvas = new OffscreenCanvas(64, 64)
        const g = canvas.getContext('2d')
        const output = new mb.Output({ format: new mb.WebMOutputFormat(), target: new mb.BufferTarget() })
        const source = new mb.CanvasSource(canvas, { codec, bitrate: 2e6, keyFrameInterval: 0.5 })
        output.addVideoTrack(source, { frameRate: 30 })
        await output.start()
        for (let i = 0; i < 60; i++) {
            g.fillStyle = `rgb(${(i * 37) % 256}, 128, 128)`
            g.fillRect(0, 0, 64, 64)
            await source.add(i / 30, 1 / 30)
        }
        source.close()
        await output.finalize()
        const file = new File([output.target.buffer], 'count.webm', { type: 'video/webm' })
        const tl = window.__timeline
        tl.actions.seek(0)
        await tl.actions.handleFiles([file])
        const id = [...tl.store.selection.clips][0]
        tl.store.edit('fill', s => { s.tracks.flatMap(t => t.clips).find(c => c.id === id).fit = 'fill' })
        return { codec, clip: tl.store.seq.tracks.flatMap(t => t.clips).find(c => c.id === id) }
    })
    expect(made.clip.type).toBe('video')
    expect(made.clip.duration).toBeCloseTo(2, 1)
    await expect(page.locator('.tl-clip.is-video')).toHaveCount(1)

    const times = [1.5, 0.2, 0, 1.9, 0.9, 0.95]
    const frames = await snapshotPixels(page, times, [[0.5, 0.5]])
    times.forEach((t, i) => {
        const expected = (Math.floor(t * 30 + 1e-6) * 37) % 256
        expect(Math.abs(frames[i][0][0] - expected), `frame at ${t} s`).toBeLessThan(14)
    })

    // Source in: the clip starts one second into the file.
    await page.evaluate(() => {
        const tl = window.__timeline
        tl.store.edit('offset', s => { s.tracks.flatMap(t => t.clips).find(c => c.type === 'video').offset = 1 })
    })
    const [[[r]]] = await snapshotPixels(page, [0.5], [[0.5, 0.5]])
    expect(Math.abs(r - (45 * 37) % 256)).toBeLessThan(14)
    expect(errors).toEqual([])
})
