import { test, expect } from '@playwright/test'
import { zipSync, strToU8 } from 'fflate'
import { boot } from './helpers.js'

// The engine expands a pass's declared storage textures into its virtual
// namespace: 'outputTex' names the node's own write target, a named texture
// joins the effect's scope. A pass with only storage textures must keep
// rendering after the pipeline falls back from render outputs to storage
// outputs (the engine release of 2026-11-26 fixed exactly that fallback).

const FILL_GLSL = `#version 300 es
precision highp float;
out vec4 outputBuffer;
void main() { outputBuffer = vec4(1.0, 0.5, 0.25, 1.0); }`
const FILL_WGSL = `@group(0) @binding(0) var outputBuffer: texture_storage_2d<rgba8unorm, write>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    textureStore(outputBuffer, vec2<i32>(gid.xy), vec4<f32>(1.0, 0.5, 0.25, 1.0));
}`
const COPY_GLSL = `#version 300 es
precision highp float;
uniform sampler2D workTex;
out vec4 fragColor;
void main() { fragColor = texelFetch(workTex, ivec2(gl_FragCoord.xy), 0); }`
const COPY_WGSL = `@group(0) @binding(0) var workTex: texture_2d<f32>;
@fragment fn main(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
    return textureLoad(workTex, vec2<i32>(pos.xy), 0);
}`

const WORK_TEXTURES = { work: { width: '100%', height: '100%', format: 'rgba8unorm' } }

/** A compute-fill probe: `target` names the storage texture its fill pass writes. */
function definitionOf(func, target) {
    const named = target === 'work'
    return {
        definition: {
            name: func,
            func,
            ...(named ? { textures: WORK_TEXTURES } : {}),
            passes: [
                {
                    name: 'fill',
                    type: 'compute',
                    program: 'fill',
                    workgroups: [8, 8, 1],
                    storageTextures: { outputBuffer: target },
                },
                ...(named
                    ? [{ name: 'copy', program: 'copy', inputs: { workTex: 'work' }, outputs: { fragColor: 'outputTex' } }]
                    : []),
            ],
        },
        shaders: {
            fill: { glsl: FILL_GLSL, wgsl: FILL_WGSL },
            ...(named ? { copy: { glsl: COPY_GLSL, wgsl: COPY_WGSL } } : {}),
        },
    }
}

/** The effect zip in the form the app imports, definition.json plus its shaders. */
async function registerViaZip(page, func, target) {
    const { definition, shaders } = definitionOf(func, target)
    const zip = zipSync({
        [`${func}/definition.json`]: strToU8(JSON.stringify(definition)),
        [`${func}/glsl/fill.glsl`]: strToU8(shaders.fill.glsl),
        [`${func}/wgsl/fill.wgsl`]: strToU8(shaders.fill.wgsl),
        ...(shaders.copy
            ? {
                [`${func}/glsl/copy.glsl`]: strToU8(shaders.copy.glsl),
                [`${func}/wgsl/copy.wgsl`]: strToU8(shaders.copy.wgsl),
            }
            : {}),
    })
    return page.evaluate(async ({ func, zip }) => {
        await window.__timeline.actions.handleFiles([new File([zip], `${func}.zip`, { type: 'application/zip' })])
        return [...document.querySelectorAll('.hf-toast-message')].map(el => el.textContent)
    }, { func, zip: new Uint8Array(zip) })
}

/** Render the probe through the app and read one pixel of the frame. */
async function probePixel(page, func) {
    return page.evaluate(async func => {
        const tl = window.__timeline
        await tl.actions.newProject()
        tl.store.edit('plain', s => { s.post.enabled = false })
        tl.store.edit('probe', s => {
            const track = tl.edits.addTrack(s, 'visual')
            tl.edits.insertClip(track, tl.model.createProgramClip({
                start: 0, duration: 4, dsl: `search user\n${func}().write(o0)\nrender(o0)`,
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
    }, func)
}

test('a custom effect that stores straight to outputTex fills the frame', async ({ page }) => {
    const bootErrors = await boot(page)
    const pageErrors = []
    page.on('pageerror', err => pageErrors.push(err.message))
    const toasts = await registerViaZip(page, 'storageDirectProbe', 'outputTex')
    expect(toasts.at(-1), `the app's status after importing storageDirectProbe; page errors: ${pageErrors.join('; ')}`)
        .toBe('Added the effect storageDirectProbe. A program uses it with search user, then .storageDirectProbe()')
    const result = await probePixel(page, 'storageDirectProbe')
    result.pixel.forEach((value, channel) => expect(Math.abs(value - [255, 128, 64][channel]), `channel ${channel}`).toBeLessThanOrEqual(1))
    expect(result.check.errors).toEqual([])
    expect(bootErrors).toEqual([])
    expect(pageErrors).toEqual([])
})

test('a custom effect that stores to a named work texture copies it out', async ({ page }) => {
    const bootErrors = await boot(page)
    const pageErrors = []
    page.on('pageerror', err => pageErrors.push(err.message))
    const toasts = await registerViaZip(page, 'storageNamedProbe', 'work')
    expect(toasts.at(-1), `the app's status after importing storageNamedProbe; page errors: ${pageErrors.join('; ')}`)
        .toBe('Added the effect storageNamedProbe. A program uses it with search user, then .storageNamedProbe()')
    const result = await probePixel(page, 'storageNamedProbe')
    result.pixel.forEach((value, channel) => expect(Math.abs(value - [255, 128, 64][channel]), `channel ${channel}`).toBeLessThanOrEqual(1))
    expect(result.check.errors).toEqual([])
    expect(bootErrors).toEqual([])
    expect(pageErrors).toEqual([])
})
