import { test, expect } from '@playwright/test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { settleAt } from './helpers.js'

// Every path an image takes keeps it the way it was authored: not flipped,
// not mirrored. The source has four quadrants of different colours, so a
// flip or a mirror changes the colour read at each quadrant's centre.
const QUADRANTS = { tl: 'red', tr: 'green', bl: 'blue', br: 'white' }
const W = 320
const H = 180
const PASS_THROUGH = 'search synth\nmedia()\n  .write(o0)\nrender(o0)'

// Times in the main sequence, one for each path through it.
const PATHS = {
    'image clip': 0.5,
    'video clip': 1.5,
    'media() on the track above': 2.5,
    'nested sequence': 3.5,
    'transition between two nested sequences': 5,
}
const NAMES = Object.keys(PATHS)
const TIMES = Object.values(PATHS)

const image = start => ({ mediaId: 'quad', start, duration: 1, fit: 'fill' })
const nested = (sequenceId, start, id) => ({ id, sequenceId, start, duration: 1 })
const plain = (duration, tracks, post = { enabled: false }) => ({ width: W, height: H, fps: 30, duration, post, tracks })

function writeProject(dir) {
    writeFileSync(join(dir, 'project.json'), JSON.stringify({
        name: 'Orientation',
        media: { quad: { path: 'media/quad.png' }, quadVideo: { path: 'media/quad.webm' } },
        mainSequenceId: 'main',
        sequences: {
            main: plain(7, [
                {
                    clips: [
                        image(0),
                        { mediaId: 'quadVideo', start: 1, duration: 1, fit: 'fill' },
                        image(2),
                        nested('inner', 3, 'nest'),
                        nested('inner', 4, 'outgoing'),
                        nested('inner2', 5, 'incoming'),
                    ],
                    transitions: [{ from: 'outgoing', to: 'incoming', duration: 1, preset: 'dissolve' }],
                },
                { clips: [{ name: 'Pass through', start: 2, duration: 1, dsl: PASS_THROUGH }] },
            ]),
            inner: plain(1, [{ clips: [image(0)] }]),
            inner2: plain(1, [{ clips: [image(0)] }]),
            post: plain(1, [{ clips: [image(0)] }], { enabled: true, dsl: PASS_THROUGH }),
        },
    }))
}

/** Adds window.__quadrants: the colour at the centre of each quadrant of a drawable, by name. */
const READ_QUADRANTS = `
    window.__quadrants = (source, width, height) => {
        const c = new OffscreenCanvas(width, height)
        const g = c.getContext('2d')
        g.drawImage(source, 0, 0, width, height)
        const hi = v => v > 170
        const lo = v => v < 90
        const name = ([r, gr, b]) => {
            if (hi(r) && hi(gr) && hi(b)) return 'white'
            if (hi(r) && lo(gr) && lo(b)) return 'red'
            if (lo(r) && hi(gr) && lo(b)) return 'green'
            if (lo(r) && lo(gr) && hi(b)) return 'blue'
            return 'rgb(' + r + ', ' + gr + ', ' + b + ')'
        }
        const at = (x, y) => name([...g.getImageData(Math.floor(x * width), Math.floor(y * height), 1, 1).data.slice(0, 3)])
        return { tl: at(0.25, 0.25), tr: at(0.75, 0.25), bl: at(0.25, 0.75), br: at(0.75, 0.75) }
    }
`

async function openApp(page, url) {
    await page.goto(url)
    await page.waitForFunction(() => window.__timeline?.ready === true, null, { timeout: 180_000 })
    await page.addScriptTag({ content: READ_QUADRANTS })
}

test('no path shows an image flipped or mirrored from how it was authored', async ({ page }) => {
    test.setTimeout(600_000)
    const dir = mkdtempSync(join(tmpdir(), 'timeline-orientation-test-'))
    const errors = []
    page.on('pageerror', err => errors.push(err.message))
    try {
        // The quadrant image, and a two-second video of it, made in the browser.
        await openApp(page, '/index.html')
        const media = await page.evaluate(async ({ W, H }) => {
            const canvas = new OffscreenCanvas(W, H)
            const g = canvas.getContext('2d')
            const paint = () => {
                g.fillStyle = '#ff0000'
                g.fillRect(0, 0, W / 2, H / 2)
                g.fillStyle = '#00ff00'
                g.fillRect(W / 2, 0, W / 2, H / 2)
                g.fillStyle = '#0000ff'
                g.fillRect(0, H / 2, W / 2, H / 2)
                g.fillStyle = '#ffffff'
                g.fillRect(W / 2, H / 2, W / 2, H / 2)
            }
            paint()
            const toBase64 = bytes => {
                let s = ''
                for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
                return btoa(s)
            }
            const png = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())
            const mb = await import('mediabunny')
            const codec = (await mb.canEncodeVideo('vp9', { width: W, height: H })) ? 'vp9' : 'vp8'
            const output = new mb.Output({ format: new mb.WebMOutputFormat(), target: new mb.BufferTarget() })
            const source = new mb.CanvasSource(canvas, { codec, bitrate: 2e6, keyFrameInterval: 0.5 })
            output.addVideoTrack(source, { frameRate: 30 })
            await output.start()
            for (let i = 0; i < 60; i++) {
                paint()
                await source.add(i / 30, 1 / 30)
            }
            source.close()
            await output.finalize()
            return { png: toBase64(png), webm: toBase64(new Uint8Array(output.target.buffer)), source: window.__quadrants(canvas, W, H) }
        }, { W, H })
        expect(media.source, 'source image').toEqual(QUADRANTS)
        mkdirSync(join(dir, 'media'))
        writeFileSync(join(dir, 'media', 'quad.png'), Buffer.from(media.png, 'base64'))
        writeFileSync(join(dir, 'media', 'quad.webm'), Buffer.from(media.webm, 'base64'))
        writeProject(dir)

        // Open the folder the way the command line does: ?project= names a path the page reads it from.
        const root = resolve(dir)
        const TYPES = { '.json': 'application/json', '.png': 'image/png', '.webm': 'video/webm' }
        await page.route('**/orientation-project/**', route => {
            const relative = decodeURIComponent(new URL(route.request().url()).pathname.split('/orientation-project/')[1])
            const path = resolve(root, relative)
            if (!path.startsWith(root + sep)) return route.fulfill({ status: 403 })
            try {
                return route.fulfill({ status: 200, body: readFileSync(path), contentType: TYPES[extname(path)] || 'application/octet-stream' })
            } catch {
                return route.fulfill({ status: 404 })
            }
        })
        await openApp(page, '/index.html?project=orientation-project/&name=Orientation')
        expect(await page.evaluate(() => window.__timeline.store.seq.id)).toBe('main')
        const report = await page.evaluate(() => window.__timeline.check())
        expect(report.errors, 'check errors').toEqual([])

        // The monitor canvas at each path of the main sequence.
        for (const [name, t] of Object.entries(PATHS)) {
            await settleAt(page, t)
            const monitor = await page.evaluate(() => {
                const canvas = document.querySelector('.tl-monitor-canvas')
                return window.__quadrants(canvas, canvas.width, canvas.height)
            })
            expect(monitor, `monitor, ${name}`).toEqual(QUADRANTS)
        }

        // The clip thumbnails of the image and the video.
        const thumbnails = await page.evaluate(async () => {
            const tl = window.__timeline
            const read = async (media, time) => {
                for (let i = 0; i < 600; i++) {
                    const picture = tl.graphics.thumbnail(media, time)
                    if (picture) return window.__quadrants(picture, picture.width, picture.height)
                    await new Promise(r => setTimeout(r, 100))
                }
                return null
            }
            const { media } = tl.store.project
            return { image: await read(media.quad, 0), video: await read(media.quadVideo, 0.5) }
        })
        expect(thumbnails.image, 'thumbnail, image').toEqual(QUADRANTS)
        expect(thumbnails.video, 'thumbnail, video').toEqual(QUADRANTS)

        // The frames the snapshot command writes: each path of the main sequence, and the post chain.
        const snapshot = async (sequence, times) => page.evaluate(async ({ sequence, times }) => {
            const result = await window.__timeline.snapshot({ sequence, times })
            const out = []
            for (const frame of result.frames) {
                const bitmap = await createImageBitmap(new Blob([frame.bytes], { type: 'image/png' }))
                out.push(window.__quadrants(bitmap, bitmap.width, bitmap.height))
            }
            return { size: [result.width, result.height], frames: out }
        }, { sequence, times })
        const shots = await snapshot('main', TIMES)
        expect(shots.size).toEqual([W, H])
        shots.frames.forEach((q, i) => expect(q, `snapshot, ${NAMES[i]}`).toEqual(QUADRANTS))
        const postShot = await snapshot('post', [0.5])
        expect(postShot.frames[0], 'snapshot, post chain').toEqual(QUADRANTS)

        // The video file the render command writes: a frame of it at each path.
        const rendered = await page.evaluate(async times => {
            const tl = window.__timeline
            const info = await tl.render({ sequence: 'main', start: 0, end: 6, format: 'webm', quality: 'medium', includeAudio: false })
            const mb = await import('mediabunny')
            const input = new mb.Input({ source: new mb.BlobSource(tl.rendered), formats: mb.ALL_FORMATS })
            const sink = new mb.CanvasSink(await input.getPrimaryVideoTrack())
            const frames = []
            for (const t of times) {
                const { canvas } = await sink.getCanvas(t)
                frames.push(window.__quadrants(canvas, canvas.width, canvas.height))
            }
            return { size: [info.width, info.height], frames }
        }, TIMES)
        expect(rendered.size).toEqual([W, H])
        rendered.frames.forEach((q, i) => expect(q, `render, ${NAMES[i]}`).toEqual(QUADRANTS))
        expect(errors).toEqual([])
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})
