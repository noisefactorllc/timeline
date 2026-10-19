import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { boot } from './helpers.js'

const GLSL = readFileSync(new URL('../fixtures/flip-tone.glsl', import.meta.url), 'utf8')
const DEFINITION = {
    name: 'Flip tone',
    func: 'flipTone',
    passes: [{ name: 'render', program: 'flip', inputs: { inputTex: 'inputTex' }, outputs: { fragColor: 'outputTex' } }],
}

test('a Noisedeck effect zip imports, and a program reaches it with search user', async ({ page }) => {
    const errors = await boot(page)
    const result = await page.evaluate(async ({ definition, glsl }) => {
        const tl = window.__timeline
        await tl.actions.newProject()
        tl.store.edit('plain', s => { s.post.enabled = false })
        const { zipSync, strToU8 } = await import('fflate')
        const zip = zipSync({ 'flipTone/definition.json': strToU8(JSON.stringify(definition)), 'flipTone/glsl/flip.glsl': strToU8(glsl) })
        await tl.actions.handleFiles([new File([zip], 'flipTone.zip', { type: 'application/zip' })])
        // A red frame beneath, and a program above that flips it.
        const c = new OffscreenCanvas(16, 16)
        const g = c.getContext('2d')
        g.fillStyle = '#ff0000'
        g.fillRect(0, 0, 16, 16)
        tl.actions.seek(0)
        await tl.actions.handleFiles([new File([await c.convertToBlob()], 'red.png', { type: 'image/png' })])
        tl.store.edit('fill', s => { s.tracks.flatMap(t => t.clips).find(x => x.type === 'image').fit = 'fill' })
        tl.store.edit('flip', s => {
            const track = tl.edits.addTrack(s, 'visual')
            tl.edits.insertClip(track, tl.model.createProgramClip({ start: 0, duration: 4, dsl: 'search synth, filter, user\nmedia()\n  .flipTone()\n  .write(o0)\nrender(o0)' }))
        })
        const shot = await tl.snapshot({ times: [1], scale: 0.25 })
        const bitmap = await createImageBitmap(new Blob([shot.frames[0].bytes], { type: 'image/png' }))
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        canvas.getContext('2d').drawImage(bitmap, 0, 0)
        const pixel = [...canvas.getContext('2d').getImageData(10, 10, 1, 1).data.slice(0, 3)]
        return { effects: Object.keys(tl.store.project.effects || {}), pixel, check: await tl.check() }
    }, { definition: DEFINITION, glsl: GLSL })
    expect(result.effects).toEqual(['flipTone'])
    expect(result.pixel[0]).toBeLessThan(40)
    expect(result.pixel[1]).toBeGreaterThan(200)
    expect(result.pixel[2]).toBeGreaterThan(200)
    expect(result.check.errors).toEqual([])
    await expect(page.getByText('Added the effect flipTone. A program uses it with search user, then .flipTone()')).toBeVisible()
    expect(errors).toEqual([])
})

test('an effect zip that runs its own code is refused with the reason', async ({ page }) => {
    await boot(page)
    await page.evaluate(async () => {
        const { zipSync, strToU8 } = await import('fflate')
        const zip = zipSync({ 'definition.js': strToU8('export default {}'), 'glsl/x.glsl': strToU8('void main() {}') })
        await window.__timeline.actions.handleFiles([new File([zip], 'coded.zip', { type: 'application/zip' })])
    })
    await expect(page.getByText(/coded\.zip holds a definition\.js, an effect that runs its own code/)).toBeVisible()
    expect(await page.evaluate(() => window.__timeline.store.project.effects)).toBeUndefined()
})
