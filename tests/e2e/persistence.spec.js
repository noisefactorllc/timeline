import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

test('a first visit opens a blank project and reopens it without edits', async ({ page }) => {
    const demoRequests = []
    page.on('request', request => {
        if (/refinery-.*\.flac/.test(request.url())) demoRequests.push(request.url())
    })
    const errors = await boot(page, { demo: false })
    const id = await page.evaluate(() => window.__timeline.store.project.id)
    await expect(page.getByRole('textbox', { name: 'Project name', exact: true })).toHaveValue('Untitled project')
    await expect(page.locator('.tl-clip')).toHaveCount(0)
    expect(await page.evaluate(() => ({
        media: window.__timeline.store.project.media,
        sequences: window.__timeline.store.project.sequenceOrder.length,
        playhead: window.__timeline.store.playhead,
    }))).toEqual({ media: {}, sequences: 1, playhead: 0 })
    await page.reload()
    await page.waitForFunction(() => window.__timeline?.ready === true, null, { timeout: 180_000 })
    expect(await page.evaluate(() => window.__timeline.store.project.id)).toBe(id)
    expect(demoRequests).toEqual([])
    expect(errors).toEqual([])
})

test('a missing last project opens a blank project', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('timeline.prefs.v1', JSON.stringify({ lastProjectId: 'prj_missing' })))
    await boot(page, { demo: false })
    await expect(page.getByRole('textbox', { name: 'Project name', exact: true })).toHaveValue('Untitled project')
    await expect(page.locator('.tl-clip')).toHaveCount(0)
})

test('unavailable browser storage opens a blank project', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(window, 'indexedDB', { value: undefined }))
    const errors = await boot(page, { demo: false })
    await expect(page.getByRole('textbox', { name: 'Project name', exact: true })).toHaveValue('Untitled project')
    await expect(page.locator('.tl-clip')).toHaveCount(0)
    expect(errors).toEqual([])
})

test('the last opened project takes priority over another saved project', async ({ page }) => {
    await boot(page, { demo: false })
    const id = await page.evaluate(async () => {
        const tl = window.__timeline
        const { saveProject } = await import('/js/storage/db.js')
        const other = tl.model.createProject({ name: 'More recently saved' })
        other.updatedAt += 86400_000
        await saveProject(other)
        const last = tl.model.createProject({ name: 'Last opened' })
        await tl.actions.openProject(last)
        return last.id
    })
    await page.reload()
    await page.waitForFunction(() => window.__timeline?.ready === true, null, { timeout: 180_000 })
    expect(await page.evaluate(() => window.__timeline.store.project.id)).toBe(id)
    await expect(page.getByRole('textbox', { name: 'Project name', exact: true })).toHaveValue('Last opened')
})

test('a saved project from an earlier demo is reopened without replacement', async ({ page }) => {
    await boot(page, { demo: false })
    const id = await page.evaluate(async () => {
        const tl = window.__timeline
        const project = tl.model.createProject({ name: 'My earlier demo edits' })
        project.media.old = { id: 'old', recipe: 'earlier-demo' }
        await tl.actions.openProject(project)
        return project.id
    })
    await page.reload()
    await page.waitForFunction(() => window.__timeline?.ready === true, null, { timeout: 180_000 })
    expect(await page.evaluate(() => window.__timeline.store.project.id)).toBe(id)
    await expect(page.getByRole('textbox', { name: 'Project name', exact: true })).toHaveValue('My earlier demo edits')
})

test('the user can open the demo from File and reopen it as their last project', async ({ page }) => {
    await boot(page, { demo: false })
    await page.getByRole('menuitem', { name: 'file', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Open the demo', exact: true }).click()
    await expect(page.getByRole('textbox', { name: 'Project name', exact: true })).toHaveValue('Demo: Refinery')
    await expect(page.locator('.tl-clip', { hasText: 'Infrastructure' })).toBeVisible()
    const id = await page.evaluate(() => window.__timeline.store.project.id)
    await page.reload()
    await page.waitForFunction(() => window.__timeline?.ready === true, null, { timeout: 180_000 })
    expect(await page.evaluate(() => window.__timeline.store.project.id)).toBe(id)
    await expect(page.getByRole('textbox', { name: 'Project name', exact: true })).toHaveValue('Demo: Refinery')
})

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
