import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

// The lexer reads its keyword table's own properties only (the engine release
// that carries the fix stops Object.prototype names such as `constructor` and
// `toString` coming out of the lexer as keyword tokens). A program may bind
// such a name as a variable and pass it to an effect argument, and a member
// path ending in one reaches condition validation as an unknown enum path
// diagnostic instead of a lexer failure.

const NAMES = ['toString', 'valueOf', 'constructor', 'hasOwnProperty', '__proto__']

const program = name => `search synth\nlet ${name} = 2\nnoise(scaleX: ${name}).write(o0)\nrender(o0)`
const memberProgram = 'search synth\nnoise().write(o0)\nif (oscKind.toString) { noise().write(o1) }\nrender(o0)'

test('a variable named after an Object.prototype property binds through the app', async ({ page }) => {
    const bootErrors = await boot(page, { demo: false })
    const result = await page.evaluate(async programs => {
        const tl = window.__timeline
        await tl.actions.newProject()
        tl.store.edit('plain', s => { s.post.enabled = false })
        tl.store.edit('clips', s => {
            const track = tl.edits.addTrack(s, 'visual')
            for (const [i, dsl] of programs.entries()) {
                tl.edits.insertClip(track, tl.model.createProgramClip({
                    start: i * 4, duration: 4, dsl,
                }))
            }
        })
        // The check compiles every program through a renderer whose effect
        // manifest is loaded, which also warms the registry that the bundle's
        // compile shares, so the direct compile below sees every effect.
        const check = await tl.check()
        const engine = await import('/js/noisemaker/bundle.js')
        const diagnostics = programs.map(dsl => engine
            .compile(dsl)
            .diagnostics.map(d => `${d.code} ${d.message}`))
        const shot = await tl.snapshot({ times: programs.map((_, i) => i * 4 + 1), scale: 0.25 })
        return { check, diagnostics, frameSizes: shot.frames.map(f => f.bytes.length) }
    }, NAMES.map(program))
    expect(result.diagnostics).toEqual(NAMES.map(() => []))
    expect(result.check.errors).toEqual([])
    for (const size of result.frameSizes) expect(size).toBeGreaterThan(0)
    expect(bootErrors).toEqual([])
})

test('a member path ending in a prototype-property name keeps the unknown-enum diagnostic', async ({ page }) => {
    const bootErrors = await boot(page, { demo: false })
    const result = await page.evaluate(async memberProgram => {
        const tl = window.__timeline
        await tl.actions.newProject()
        tl.store.edit('plain', s => { s.post.enabled = false })
        tl.store.edit('clips', s => {
            const track = tl.edits.addTrack(s, 'visual')
            tl.edits.insertClip(track, tl.model.createProgramClip({
                start: 0, duration: 4, dsl: memberProgram,
            }))
        })
        // Check first: its renderer loads the effect manifest that the
        // bundle's compile shares.
        const check = await tl.check()
        const engine = await import('/js/noisemaker/bundle.js')
        return {
            diagnostics: engine.compile(memberProgram).diagnostics.map(d => `${d.code} ${d.message}`),
            check,
        }
    }, memberProgram)
    expect(result.diagnostics).toEqual(["S001 Unknown enum path: 'oscKind.toString'"])
    // The path is an unknown state value, so the renderer reports it as the
    // program's compile error.
    expect(result.check.errors).toHaveLength(1)
    expect(result.check.errors[0].message).toBe("Unknown enum path: 'oscKind.toString'")
    expect(bootErrors).toEqual([])
})
