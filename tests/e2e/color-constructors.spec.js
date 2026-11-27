import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

// A color parameter accepts vec3() and vec4() constructors and keeps the
// supplied components, whatever the parameter's default length is (the engine
// release of 2026-11-27 stopped vec3() and vec4() on a three-component
// default falling back to that default). A constructor must render exactly
// what its array literal renders, and a malformed constructor must keep the
// engine's diagnostic and the parameter's default value.

const RGB = [0.3, 0.2, 0.25]
const RGBA = [0.3, 0.2, 0.25, 0.4]
// (0.3, 0.2, 0.25) in 8-bit channels.
const EXPECTED = [77, 51, 64]
// solid() falls back to its default colour [0.5, 0.5, 0.5].
const DEFAULT = [128, 128, 128]

const VARIANTS = [
    { name: 'vec3 constructor', dsl: `search synth\nsolid(color: vec3(${RGB.join(', ')}))\n  .write(o0)\nrender(o0)` },
    { name: 'array literal', dsl: `search synth\nsolid(color: [${RGB.join(', ')}])\n  .write(o0)\nrender(o0)` },
    { name: 'vec4 constructor', dsl: `search synth\nsolid(color: vec4(${RGBA.join(', ')}))\n  .write(o0)\nrender(o0)` },
    { name: 'four-component array', dsl: `search synth\nsolid(color: [${RGBA.join(', ')}])\n  .write(o0)\nrender(o0)` },
    { name: 'tint vec4 constructor', dsl: `search synth, filter\nsolid(color: [0.2, 0.4, 0.6])\n  .tint(color: vec4(${RGBA.join(', ')}), alpha: 1, mode: 0)\n  .write(o0)\nrender(o0)` },
    { name: 'tint array literal', dsl: `search synth, filter\nsolid(color: [0.2, 0.4, 0.6])\n  .tint(color: [${RGBA.join(', ')}], alpha: 1, mode: 0)\n  .write(o0)\nrender(o0)` },
]

test('a color parameter renders a vector constructor like its array literal', async ({ page }) => {
    const bootErrors = await boot(page, { demo: false })
    const result = await page.evaluate(async variants => {
        const tl = window.__timeline
        await tl.actions.newProject()
        tl.store.edit('plain', s => { s.post.enabled = false })
        tl.store.edit('clips', s => {
            const track = tl.edits.addTrack(s, 'visual')
            for (const [i, variant] of variants.entries()) {
                tl.edits.insertClip(track, tl.model.createProgramClip({
                    start: i * 4, duration: 4, dsl: variant.dsl,
                }))
            }
        })
        const shot = await tl.snapshot({ times: variants.map((_, i) => i * 4 + 1), scale: 0.25 })
        const pixels = []
        for (const frame of shot.frames) {
            const bitmap = await createImageBitmap(new Blob([frame.bytes], { type: 'image/png' }))
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
            canvas.getContext('2d').drawImage(bitmap, 0, 0)
            pixels.push([...canvas.getContext('2d').getImageData(10, 10, 1, 1).data.slice(0, 3)])
        }
        return { pixels, check: await tl.check() }
    }, VARIANTS)
    for (const [i, pixel] of result.pixels.entries()) {
        pixel.forEach((value, channel) => {
            expect(Math.abs(value - EXPECTED[channel]), `${VARIANTS[i].name} channel ${channel}`).toBeLessThanOrEqual(1)
        })
    }
    expect(result.check.errors).toEqual([])
    expect(bootErrors).toEqual([])
})

test('a malformed color constructor keeps the engine diagnostic and the default colour', async ({ page }) => {
    const bootErrors = await boot(page, { demo: false })
    const result = await page.evaluate(async () => {
        const tl = window.__timeline
        await tl.actions.newProject()
        tl.store.edit('plain', s => { s.post.enabled = false })
        tl.store.edit('clips', s => {
            const track = tl.edits.addTrack(s, 'visual')
            for (const [i, color] of ['vec3(0.3, 0.2)', 'vec2(0.3, 0.2)', 'vec4(0.3, 0.2, 0.25)'].entries()) {
                tl.edits.insertClip(track, tl.model.createProgramClip({
                    start: i * 4, duration: 4, dsl: `search synth\nsolid(color: ${color})\n  .write(o0)\nrender(o0)`,
                }))
            }
        })
        const shot = await tl.snapshot({ times: [1, 5, 9], scale: 0.25 })
        const pixels = []
        for (const frame of shot.frames) {
            const bitmap = await createImageBitmap(new Blob([frame.bytes], { type: 'image/png' }))
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
            canvas.getContext('2d').drawImage(bitmap, 0, 0)
            pixels.push([...canvas.getContext('2d').getImageData(10, 10, 1, 1).data.slice(0, 3)])
        }
        return { pixels, check: await tl.check() }
    })
    // The engine's S002 diagnostic is a warning, so the program still compiles
    // and renders with the parameter's default colour.
    for (const [i, pixel] of result.pixels.entries()) {
        pixel.forEach((value, channel) => {
            expect(Math.abs(value - DEFAULT[channel]), `malformed clip ${i} channel ${channel}`).toBeLessThanOrEqual(1)
        })
    }
    expect(result.check.errors).toEqual([])
    expect(bootErrors).toEqual([])
})
