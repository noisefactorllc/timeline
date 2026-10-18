import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

test('edits are saved and the project reopens after a reload', async ({ page }) => {
    await boot(page)
    await page.evaluate(async () => {
        const tl = window.__timeline
        tl.actions.renameProject('Persistence check')
        tl.store.edit('Add marker', s => { tl.edits.addMarker(s, 12.5, 'Saved marker') })
        await tl.store.saveNow()
    })
    await page.reload()
    await page.waitForFunction(() => window.__timeline?.ready === true, null, { timeout: 180_000 })
    const state = await page.evaluate(() => ({
        name: window.__timeline.store.project.name,
        markers: window.__timeline.store.seq.markers.map(m => m.name),
    }))
    expect(state.name).toBe('Persistence check')
    expect(state.markers).toContain('Saved marker')
})

test('a project file round-trips through save and open', async ({ page }) => {
    await boot(page)
    const result = await page.evaluate(async () => {
        const { projectToFile, projectFromFile } = await import('/js/storage/projectFile.js')
        const tl = window.__timeline
        const file = await projectToFile(tl.store.project)
        const copy = await projectFromFile(file)
        return { name: copy.name, seqs: copy.sequenceOrder.length, sameId: copy.id === tl.store.project.id, clips: Object.values(copy.sequences).flatMap(s => s.tracks.flatMap(t => t.clips)).length }
    })
    expect(result.seqs).toBe(2)
    expect(result.sameId).toBe(false)
    expect(result.clips).toBeGreaterThan(10)
})
