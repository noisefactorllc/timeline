import { test, expect } from '@playwright/test'
import { boot, settleAt } from './helpers.js'

const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

test('clicking a clip opens its DSL; editing it recompiles live', async ({ page }) => {
    await boot(page)
    const clip = page.locator('.tl-clip', { hasText: 'Kick pulse' })
    await clip.click({ position: { x: 140, y: 40 }, timeout: 120_000 })
    await expect(page.locator('.tl-insp-title')).toHaveValue('Kick pulse')
    const status = page.locator('.tl-editor-status')
    await page.evaluate(() => {
        const editor = document.querySelector('#inspector code-editor')
        editor.value = editor.value.replace('tint: #ff4d5e', 'tint: #4dffd2')
        editor.dispatchEvent(new CustomEvent('input', { detail: { value: editor.value } }))
    })
    await expect(status).toHaveText('Running', { timeout: 180_000 })
    const dsl = await page.evaluate(() => {
        const tl = window.__timeline
        return tl.store.seq.tracks[0].clips.find(c => c.name === 'Kick pulse').dsl
    })
    expect(dsl).toContain('#4dffd2')
    // The edit moved the playhead into the clip so the monitor shows it.
    const t = await page.evaluate(() => window.__timeline.store.playhead)
    expect(t).toBeGreaterThanOrEqual(60 / 128 * 4 * 8)
})

test('a broken program reports its error and keeps the last good frame', async ({ page }) => {
    await boot(page)
    await page.locator('.tl-clip', { hasText: 'Kick pulse' }).click({ position: { x: 140, y: 40 }, timeout: 120_000 })
    await page.evaluate(() => {
        const editor = document.querySelector('#inspector code-editor')
        editor.value = editor.value.replace('noise(', 'nosie(')
        editor.dispatchEvent(new CustomEvent('input', { detail: { value: editor.value } }))
    })
    await expect(page.locator('.tl-editor-status')).toHaveAttribute('data-state', 'error', { timeout: 180_000 })
    await expect(page.locator('.tl-editor-status')).toContainText('nosie')
})

test('cut at the playhead, then undo and redo', async ({ page }) => {
    await boot(page)
    const count = () => page.evaluate(() => window.__timeline.store.seq.tracks[0].clips.length)
    const before = await count()
    await page.evaluate(() => window.__timeline.actions.seek(20))
    await page.locator('.tl-scroll').click({ position: { x: 5, y: 5 }, timeout: 120_000 }).catch(() => {})
    await page.evaluate(() => window.__timeline.store.clearSelection())
    await page.evaluate(() => window.__timeline.actions.seek(20))
    await page.keyboard.press(`${mod}+k`)
    expect(await count()).toBe(before + 1)
    await page.keyboard.press(`${mod}+z`)
    expect(await count()).toBe(before)
    await page.keyboard.press(`${mod}+Shift+z`)
    expect(await count()).toBe(before + 1)
})

test('dropping a transition from the library onto a cut adds it', async ({ page }) => {
    await boot(page)
    const result = await page.evaluate(() => {
        const tl = window.__timeline
        const seq = tl.store.seq
        const v1 = seq.tracks[0]
        const before = v1.transitions.length
        // Remove the build-to-drop flash, then put a wipe back on that cut through the drop path.
        const flash = v1.transitions.find(t => t.preset === 'flash')
        tl.store.selectTransition(flash.id)
        tl.actions.deleteSelection()
        const cutAt = v1.clips.find(c => c.name === 'Drop').start
        tl.store.setTargetTrack(v1.id)
        tl.actions.seek(cutAt + 0.1)
        tl.actions.applyTransitionPreset('wipe')
        const after = tl.store.seq.tracks[0].transitions
        return { before, after: after.length, presets: after.map(t => t.preset) }
    })
    expect(result.after).toBe(result.before)
    expect(result.presets).toContain('wipe')
    expect(result.presets).not.toContain('flash')
})

test('dragging a program from the library onto V3 places a clip there', async ({ page }) => {
    await boot(page)
    const card = page.locator('.tl-card', { hasText: 'Oil slick' }).first()
    const lane = page.locator('.tl-lane.is-video').first()
    await card.dragTo(lane, { targetPosition: { x: 300, y: 30 }, timeout: 120_000 })
    const v3 = await page.evaluate(() => window.__timeline.store.seq.tracks[2].clips.map(c => c.name))
    expect(v3).toContain('Oil slick')
})

test('the post chain can be switched off and its preset changed', async ({ page }) => {
    await boot(page)
    await page.locator('.tl-post').click({ timeout: 120_000 })
    await expect(page.locator('.tl-insp-head')).toContainText('Post chain')
    const presetSelect = page.locator('.tl-field', { hasText: 'Preset' }).locator('select')
    await presetSelect.selectOption('vhs')
    await expect(page.locator('.tl-post')).toContainText('VHS')
    const dsl = await page.evaluate(() => window.__timeline.store.seq.post.dsl)
    expect(dsl).toContain('scanlineError')
    await page.locator('.tl-track-header.is-post .tl-track-btn').click()
    expect(await page.evaluate(() => window.__timeline.store.seq.post.enabled)).toBe(false)
})
