import { test, expect } from '@playwright/test'
import { zipSync, strToU8 } from 'fflate'
import { boot } from './helpers.js'

// A portable effect declared as data (definition.json) hands on the texture
// its outputTex field names: the engine's Effect constructor copies that field
// from the configuration, and the expander binds the next effect in the chain
// to it. A blank handed-on name is refused at registration.

const MARK_GLSL = `#version 300 es
precision highp float;
out vec4 outputBuffer;
void main() { outputBuffer = vec4(0.0, 1.0, 0.0, 1.0); }`
const READER_GLSL = `#version 300 es
precision highp float;
uniform sampler2D src;
out vec4 fragColor;
void main() { fragColor = texelFetch(src, ivec2(gl_FragCoord.xy), 0); }`

const PRODUCER = {
    name: 'handOnProducer',
    func: 'handOnProducer',
    textures: { stateTex: { width: '100%', height: '100%', format: 'rgba8unorm' } },
    outputTex: 'stateTex',
    passes: [
        { name: 'mark', program: 'mark', outputs: { color: 'stateTex' } },
    ],
}
const READER = {
    name: 'handOnReader',
    func: 'handOnReader',
    passes: [{ name: 'render', program: 'reader', inputs: { src: 'inputTex' }, outputs: { fragColor: 'outputTex' } }],
}

async function registerEffect(page, effect, shaders) {
    const zip = zipSync({
        [`${effect.func}/definition.json`]: strToU8(JSON.stringify(effect)),
        ...Object.fromEntries(Object.entries(shaders).map(([program, glsl]) => [`${effect.func}/glsl/${program}.glsl`, strToU8(glsl)])),
    })
    await page.evaluate(async ({ func, zip }) => {
        await window.__timeline.actions.handleFiles([new File([zip], `${func}.zip`, { type: 'application/zip' })])
    }, { func: effect.func, zip: new Uint8Array(zip) })
    await expect(page.getByText(`Added the effect ${effect.func}. A program uses it with search user, then .${effect.func}()`)).toBeVisible()
}

test('a portable effect hands on the texture its outputTex names to the next effect', async ({ page }) => {
    const bootErrors = await boot(page)
    const pageErrors = []
    page.on('pageerror', err => pageErrors.push(err.message))
    await registerEffect(page, PRODUCER, { mark: MARK_GLSL })
    await registerEffect(page, READER, { reader: READER_GLSL })
    const result = await page.evaluate(async () => {
        const tl = window.__timeline
        await tl.actions.newProject()
        tl.store.edit('plain', s => { s.post.enabled = false })
        tl.store.edit('probe', s => {
            const track = tl.edits.addTrack(s, 'visual')
            tl.edits.insertClip(track, tl.model.createProgramClip({
                start: 0, duration: 4, dsl: 'search user\nhandOnProducer().handOnReader().write(o0)\nrender(o0)',
            }))
        })
        const shot = await tl.snapshot({ times: [1], scale: 0.25 })
        const bitmap = await createImageBitmap(new Blob([shot.frames[0].bytes], { type: 'image/png' }))
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        canvas.getContext('2d').drawImage(bitmap, 0, 0)
        return {
            pixel: [...canvas.getContext('2d').getImageData(10, 10, 1, 1).data.slice(0, 3)],
            check: await tl.check(),
        }
    })
    // The reader copied the handed-on state texture (green); without the
    // field the reader would have no producer output to read.
    result.pixel.forEach((value, channel) => expect(Math.abs(value - [0, 255, 0][channel]), `channel ${channel}`).toBeLessThanOrEqual(1))
    expect(result.check.errors).toEqual([])
    expect(bootErrors).toEqual([])
    expect(pageErrors).toEqual([])
})

test('a portable effect with a blank handed-on texture name is refused', async ({ page }) => {
    await boot(page)
    const zip = zipSync({
        'blankHand/definition.json': strToU8(JSON.stringify({ ...PRODUCER, func: 'blankHand', name: 'blankHand', outputTex: '' })),
        'blankHand/glsl/mark.glsl': strToU8(MARK_GLSL),
    })
    await page.evaluate(async zip => {
        await window.__timeline.actions.handleFiles([new File([zip], 'blank.zip', { type: 'application/zip' })])
    }, new Uint8Array(zip))
    await expect(page.getByText('blank.zip cannot be used: outputTex must be a nonempty texture name')).toBeVisible()
})
