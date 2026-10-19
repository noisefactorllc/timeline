import { test, expect } from '@playwright/test'
import { boot, settleAt, monitorStats } from './helpers.js'

test('the demo opens with its tracks, transitions, markers and post chain', async ({ page }) => {
    const errors = await boot(page)
    await expect(page.locator('.tl-clip', { hasText: 'Infrastructure' })).toBeVisible()
    await expect(page.locator('.tl-clip', { hasText: 'Drop' })).toBeVisible()
    await expect(page.locator('.tl-transition')).toHaveCount(7)
    await expect(page.locator('.tl-marker')).toHaveCount(5)
    await expect(page.locator('.tl-post')).toContainText('Industrial')
    await expect(page.locator('.tl-track-header', { hasText: 'Drums' })).toContainText('channel: 1')
    expect(errors).toEqual([])
})

test('the transport sits under the frame and the time shows once, over the length', async ({ page }) => {
    await boot(page)
    await expect(page.locator('.tl-timecode')).toHaveCount(1)
    await expect(page.locator('.tl-monitor .tl-timecode-total')).toHaveText('/ 00:01:00:00')
    await expect(page.locator('.tl-toolbar [aria-label="Play or pause (Space)"]')).toHaveCount(0)
    const play = page.locator('.tl-monitor .tl-transport [aria-label="Play or pause (Space)"]')
    const [canvas, transport] = await Promise.all([page.locator('.tl-monitor-canvas'), play].map(l => l.boundingBox()))
    expect(transport.y).toBeGreaterThan(canvas.y + canvas.height)
    expect(Math.abs(transport.x + transport.width / 2 - (canvas.x + canvas.width / 2))).toBeLessThan(20)
    await page.locator('.tl-transport [aria-label="Go to end (End)"]').click()
    await expect(page.locator('.tl-monitor .tl-timecode')).toHaveText('00:01:00:00')
})

test('a frame inside the nested drop renders every layer and both post chains', async ({ page }) => {
    await boot(page)
    await settleAt(page, 31)
    const keys = await page.evaluate(() => [...window.__timeline.pool.entries.keys()])
    // the main sequence's post chain, the nested sequence's clip and its own post chain
    expect(keys).toContain('root/post')
    expect(keys.some(k => /^root\/clp_[^/]+\/clp_/.test(k))).toBe(true)
    expect(keys.some(k => /^root\/clp_[^/]+\/post$/.test(k))).toBe(true)
    const errors = await page.evaluate(() => [...window.__timeline.pool.dslErrors.values()])
    expect(errors).toEqual([])
    const stats = await monitorStats(page)
    expect(stats.max - stats.min).toBeGreaterThan(40)
})

test('every transition and post preset compiles', async ({ page }) => {
    await boot(page)
    const results = await page.evaluate(async () => {
        const { TRANSITIONS, POST_PRESETS } = await import('/js/data/presets.js')
        const { ProgramRenderer } = await import('/js/render/programRenderer.js')
        const r = new ProgramRenderer({ width: 64, height: 36, audioState: window.__timeline.audio.state })
        const out = []
        for (const p of [...TRANSITIONS, ...POST_PRESETS]) {
            const res = await r.load(p.dsl)
            out.push({ id: p.id, ok: res.success, error: res.error || null, inputs: r.mediaSteps.length })
        }
        await r.dispose()
        return out
    })
    for (const r of results) {
        expect(r.error, r.id).toBeNull()
        expect(r.inputs, r.id).toBeGreaterThan(0)
    }
})

test('the boot screen reports each step and finishes at 100%', async ({ page }) => {
    await boot(page)
    const state = await page.evaluate(() => ({
        percent: document.querySelector('.tl-boot-percent').textContent,
        steps: Object.fromEntries([...document.querySelectorAll('.tl-boot-steps [data-step]')].map(li => [
            li.dataset.step, { state: li.dataset.state, detail: li.querySelector('.tl-boot-step-detail').textContent },
        ])),
    }))
    expect(state.percent).toBe('100%')
    for (const [id, step] of Object.entries(state.steps)) expect(step.state, id).toBe('done')
    expect(state.steps.engine.detail).toMatch(/KB|MB/)
    expect(state.steps.project.detail).toBe('Demo: Refinery')
    expect(state.steps.audio.detail).toMatch(/MB/)
    expect(state.steps.programs.detail).toMatch(/^\d+ compiled$/)
})
