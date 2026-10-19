import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

test('importing a song into an empty sequence places it and sets the tempo from it', async ({ page }) => {
    await boot(page)
    const result = await page.evaluate(async () => {
        const tl = window.__timeline
        await tl.actions.newProject()
        // A 12 second click track at 100 BPM whose first beat is at 0.25 s, as a WAV file.
        const sr = 48000
        const seconds = 12
        const n = sr * seconds
        const pcm = new Int16Array(n)
        for (let k = 0; 0.25 + k * 0.6 < seconds; k++) {
            const start = Math.round((0.25 + k * 0.6) * sr)
            for (let i = 0; i < 2400 && start + i < n; i++) {
                pcm[start + i] = Math.round(26000 * Math.exp(-i / 300) * Math.sin(2 * Math.PI * 90 * i / sr))
            }
        }
        const header = new DataView(new ArrayBuffer(44))
        const w = (o, s) => [...s].forEach((c, i) => header.setUint8(o + i, c.charCodeAt(0)))
        w(0, 'RIFF'); header.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ')
        header.setUint32(16, 16, true); header.setUint16(20, 1, true); header.setUint16(22, 1, true)
        header.setUint32(24, sr, true); header.setUint32(28, sr * 2, true); header.setUint16(32, 2, true)
        header.setUint16(34, 16, true); w(36, 'data'); header.setUint32(40, n * 2, true)
        const file = new File([header.buffer, pcm.buffer], 'click 100.wav', { type: 'audio/wav' })
        await tl.actions.handleFiles([file])
        const seq = tl.store.seq
        const clips = seq.audioTracks.flatMap(t => t.clips)
        return {
            clips: clips.map(c => c.name),
            media: Object.values(tl.store.project.media).map(m => m.name),
            bpm: seq.bpm,
            gridOffset: seq.gridOffset,
            duration: seq.duration,
        }
    })
    expect(result.clips).toEqual(['click 100'])
    expect(result.media).toContain('click 100')
    expect(result.bpm).toBe(100)
    expect(Math.abs(result.gridOffset - 0.25)).toBeLessThan(0.03)
})

test('right-clicking a clip offers split here, which cuts it where you clicked', async ({ page }) => {
    await boot(page)
    const before = await page.evaluate(() => window.__timeline.store.seq.tracks[0].clips.length)
    const box = await page.locator('.tl-clip', { hasText: 'Infrastructure' }).boundingBox()
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
    await page.locator('.tl-context-menu .hf-menu-item', { hasText: 'Split here' }).click({ timeout: 120_000 })
    const after = await page.evaluate(() => window.__timeline.store.seq.tracks[0].clips.filter(c => c.name === 'Infrastructure').length)
    expect(after).toBe(2)
    expect(await page.evaluate(() => window.__timeline.store.seq.tracks[0].clips.length)).toBe(before + 1)
    await expect(page.locator('.tl-context-menu')).toHaveCount(0)
})
