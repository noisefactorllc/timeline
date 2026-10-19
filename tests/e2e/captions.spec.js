import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

test('captions dropped with a narration clip selected land on a Captions track, timed to it', async ({ page }) => {
    const errors = await boot(page)
    const placed = await page.evaluate(async () => {
        const tl = window.__timeline
        await tl.actions.newProject()
        const { encodeWav } = await import('/js/audio/wav.js')
        const b = new AudioBuffer({ numberOfChannels: 1, length: 48000 * 6, sampleRate: 48000 })
        tl.actions.seek(3)
        await tl.actions.handleFiles([new File([encodeWav(b)], 'narration.wav', { type: 'audio/wav' })])
        const narration = tl.store.seq.audioTracks.flatMap(t => t.clips).find(c => c.name === 'narration')
        tl.store.selectClip(narration.id)
        tl.actions.seek(0)
        const vtt = 'WEBVTT\n\n00:01.000 --> 00:02.500\nMeet Timeline\n\n00:03.000 --> 00:04.000\nCut programs to music\n'
        await tl.actions.handleFiles([new File([vtt], 'narration.vtt', { type: 'text/vtt' })])
        const track = tl.store.seq.tracks.find(t => t.name === 'Captions')
        return track.clips.map(c => [c.type, c.text, c.start, c.duration])
    })
    expect(placed).toEqual([
        ['text', 'Meet Timeline', 4, 1.5],
        ['text', 'Cut programs to music', 6, 1],
    ])
    await expect(page.locator('.tl-clip.is-text')).toHaveCount(2)
    await expect(page.getByText('2 captions from narration.vtt are on the Captions track, timed to narration')).toBeVisible()
    // One undo takes them all away.
    await page.evaluate(() => window.__timeline.store.undo())
    await expect(page.locator('.tl-clip.is-text')).toHaveCount(0)
    expect(errors).toEqual([])
})
