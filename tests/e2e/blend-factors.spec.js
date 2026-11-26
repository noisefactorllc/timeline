import { test, expect } from '@playwright/test'
import { zipSync, strToU8 } from 'fflate'
import { boot } from './helpers.js'

// A pass's declared blend factors name GL constants, and a zero factor must
// resolve as zero: a pass that blends ["ONE", "ZERO"] replaces its output
// instead of adding onto what the texture already holds, so repeated draws
// stay at the pass's own colour (the engine release of 2026-11-26 fixed the
// zero factor falling back to one).

const GLSL = `#version 300 es
precision highp float;
out vec4 fragColor;
void main() { fragColor = vec4(0.25, 0.5, 0.75, 1.0); }`

const DEFINITION = {
    definition: {
        name: 'blendReplaceProbe',
        func: 'blendReplaceProbe',
        passes: [
            {
                name: 'replace',
                program: 'replace',
                outputs: { fragColor: 'outputTex' },
                blend: ['ONE', 'ZERO'],
            },
        ],
    },
    shaders: { replace: { glsl: GLSL } },
}

async function registerViaZip(page) {
    const zip = zipSync({
        'blendReplaceProbe/definition.json': strToU8(JSON.stringify(DEFINITION.definition)),
        'blendReplaceProbe/glsl/replace.glsl': strToU8(GLSL),
    })
    await page.evaluate(async zip => {
        await window.__timeline.actions.handleFiles([new File([zip], 'blendReplaceProbe.zip', { type: 'application/zip' })])
    }, new Uint8Array(zip))
    await expect(page.getByText('Added the effect blendReplaceProbe. A program uses it with search user, then .blendReplaceProbe()')).toBeVisible()
}

/** Render the probe at two times and read one pixel of each frame. */
async function probePixels(page) {
    return page.evaluate(async () => {
        const tl = window.__timeline
        await tl.actions.newProject()
        tl.store.edit('plain', s => { s.post.enabled = false })
        tl.store.edit('probe', s => {
            const track = tl.edits.addTrack(s, 'visual')
            tl.edits.insertClip(track, tl.model.createProgramClip({
                start: 0, duration: 4, dsl: 'search user\nblendReplaceProbe().write(o0)\nrender(o0)',
            }))
        })
        const shot = await tl.snapshot({ times: [1, 2], scale: 0.25 })
        const pixels = []
        for (const frame of shot.frames) {
            const bitmap = await createImageBitmap(new Blob([frame.bytes], { type: 'image/png' }))
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
            canvas.getContext('2d').drawImage(bitmap, 0, 0)
            pixels.push([...canvas.getContext('2d').getImageData(10, 10, 1, 1).data.slice(0, 3)])
        }
        return { pixels, check: await tl.check() }
    })
}

test('a custom effect blending one over zero replaces its output every frame', async ({ page }) => {
    const bootErrors = await boot(page)
    const pageErrors = []
    page.on('pageerror', err => pageErrors.push(err.message))
    await registerViaZip(page)
    const result = await probePixels(page)
    // (0.25, 0.5, 0.75) in 8-bit channels, at both snapshot times.
    const expected = [64, 128, 191]
    for (const [i, pixel] of result.pixels.entries()) {
        pixel.forEach((value, channel) => {
            expect(Math.abs(value - expected[channel]), `frame ${i} channel ${channel}`).toBeLessThanOrEqual(1)
        })
    }
    expect(result.check.errors).toEqual([])
    expect(bootErrors).toEqual([])
    expect(pageErrors).toEqual([])
})
