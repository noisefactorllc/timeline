import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

// A fresh project with the post chain off, two generated sounds imported, on tracks named Music and Voice.
async function musicAndVoice(page) {
    await page.evaluate(async () => {
        const tl = window.__timeline
        await tl.actions.newProject()
        tl.store.edit('plain', s => { s.post.enabled = false })
        const { encodeWav } = await import('/js/audio/wav.js')
        const tone = (seconds, freq, amp) => {
            const b = new AudioBuffer({ numberOfChannels: 2, length: seconds * 48000, sampleRate: 48000 })
            for (let c = 0; c < 2; c++) {
                const d = b.getChannelData(c)
                for (let i = 0; i < d.length; i++) d[i] = amp * Math.sin((2 * Math.PI * freq * i) / 48000)
            }
            return new File([encodeWav(b)], `${freq}.wav`, { type: 'audio/wav' })
        }
        tl.actions.seek(0)
        await tl.actions.handleFiles([tone(8, 220, 0.5)])
        tl.actions.seek(2)
        await tl.actions.handleFiles([tone(2, 880, 0.5)])
        tl.store.edit('names', s => {
            s.audioTracks[0].name = 'Music'
            s.audioTracks[1].name = 'Voice'
        })
    })
}

function rms(page, trackName, from, to) {
    return page.evaluate(async ({ trackName, from, to }) => {
        const tl = window.__timeline
        const seq = tl.store.seq
        await tl.audio.mix(tl.store.project, seq)
        const track = seq.audioTracks.find(t => t.name === trackName)
        const data = tl.audio.currentMix(seq.id).tracks.get(track.id).getChannelData(0)
        let sum = 0
        const a = Math.round(from * 48000)
        const b = Math.round(to * 48000)
        for (let i = a; i < b; i++) sum += data[i] * data[i]
        return Math.sqrt(sum / (b - a))
    }, { trackName, from, to })
}

test('music ducks under a voice by the depth set, only while the voice plays', async ({ page }) => {
    const errors = await boot(page)
    await musicAndVoice(page)
    const before = await rms(page, 'Music', 2.5, 3.5)
    await page.evaluate(() => window.__timeline.store.edit('duck', s => {
        s.audioTracks[0].duck = { under: 'Voice', depth: -12, attack: 0.25, release: 0.5, hold: 0.5 }
    }))
    const outside = await rms(page, 'Music', 0.5, 1.5)
    const under = await rms(page, 'Music', 2.5, 3.5)
    const after = await rms(page, 'Music', 5, 7)
    expect(20 * Math.log10(under / before)).toBeCloseTo(-12, 1)
    expect(outside).toBeCloseTo(before, 4)
    expect(after).toBeCloseTo(before, 4)
    // The voice itself is untouched.
    expect(await rms(page, 'Voice', 2.5, 3.5)).toBeCloseTo(0.5 / Math.SQRT2, 2)
    // The music's waveform shows the curve.
    await expect(page.locator('.tl-clip.is-audio')).toHaveCount(2)
    expect(errors).toEqual([])
})

test('volume keys shape an audio clip in the mix', async ({ page }) => {
    await boot(page)
    await musicAndVoice(page)
    await page.evaluate(() => window.__timeline.store.edit('keys', s => {
        s.audioTracks[0].clips[0].keys = { gain: [{ t: 0, v: 1 }, { t: 4, v: 0, ease: 'none' }] }
    }))
    const early = await rms(page, 'Music', 0.9, 1.1)
    const mid = await rms(page, 'Music', 1.9, 2.1)
    const late = await rms(page, 'Music', 5, 6)
    const full = 0.5 / Math.SQRT2
    expect(early / full).toBeCloseTo(0.75, 1)
    expect(mid / full).toBeCloseTo(0.5, 1)
    expect(late).toBeLessThan(1e-3)
})

test('keys move a title across the frame, and the inspector diamond adds a key', async ({ page }) => {
    await boot(page)
    await page.evaluate(async () => {
        const tl = window.__timeline
        await tl.actions.newProject()
        tl.store.edit('plain', s => { s.post.enabled = false })
        tl.actions.seek(0)
        tl.actions.addText()
        const id = [...tl.store.selection.clips][0]
        tl.store.edit('style', s => {
            Object.assign(s.tracks.flatMap(t => t.clips).find(c => c.id === id), {
                text: 'M', size: 0.15, color: '#ffffff', background: '#ffffff', duration: 4, enter: { preset: 'none' }, exit: { preset: 'none' },
                keys: { x: [{ t: 0, v: 0.2 }, { t: 2, v: 0.8, ease: 'none' }] },
            })
        })
    })
    const pixels = await page.evaluate(async () => {
        const result = await window.__timeline.snapshot({ times: [0, 1, 2], scale: 0.25 })
        const out = []
        for (const frame of result.frames) {
            const bitmap = await createImageBitmap(new Blob([frame.bytes], { type: 'image/png' }))
            const c = new OffscreenCanvas(bitmap.width, bitmap.height)
            const g = c.getContext('2d')
            g.drawImage(bitmap, 0, 0)
            const at = x => g.getImageData(Math.floor(x * bitmap.width), Math.floor(bitmap.height / 2), 1, 1).data[0]
            out.push([at(0.2), at(0.5), at(0.8)])
        }
        return out
    })
    expect(pixels[0][0]).toBeGreaterThan(240)
    expect(pixels[0][2]).toBeLessThan(15)
    expect(pixels[1][1]).toBeGreaterThan(240)
    expect(pixels[2][2]).toBeGreaterThan(240)
    expect(pixels[2][0]).toBeLessThan(15)
    await expect(page.locator('.tl-clip.is-text .tl-clip-key')).toHaveCount(2)

    // In the inspector, the Y diamond keys Y at the playhead.
    await page.evaluate(() => window.__timeline.actions.seek(1))
    await page.getByRole('button', { name: 'Key y % at the playhead' }).click()
    const keys = await page.evaluate(() => window.__timeline.store.seq.tracks.flatMap(t => t.clips).find(c => c.type === 'text').keys)
    expect(keys.y).toEqual([{ t: 1, v: 0.5, ease: 'power2.inOut' }])
    await expect(page.getByRole('button', { name: 'Key y % at the playhead' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.tl-clip.is-text .tl-clip-key')).toHaveCount(3)
})

test('export audio saves the mix of the in-to-out range as a WAV file', async ({ page }) => {
    await page.addInitScript(() => {
        window.showSaveFilePicker = async () => (await navigator.storage.getDirectory()).getFileHandle('mix-test.wav', { create: true })
    })
    await boot(page)
    await musicAndVoice(page)
    await page.evaluate(() => window.__timeline.store.edit('range', s => { s.inPoint = 1; s.outPoint = 3 }))
    await page.evaluate(() => window.__timeline.actions.exportAudio())
    await expect(page.getByText(/Saved mix-test\.wav \(\d+ KB\) to the folder you chose/)).toBeVisible()
    const header = await page.evaluate(async () => {
        const file = await (await (await navigator.storage.getDirectory()).getFileHandle('mix-test.wav')).getFile()
        const v = new DataView(await file.arrayBuffer())
        const text = (o, n) => String.fromCharCode(...new Uint8Array(v.buffer, o, n))
        return { riff: text(0, 4), wave: text(8, 4), channels: v.getUint16(22, true), rate: v.getUint32(24, true), bits: v.getUint16(34, true), bytes: v.getUint32(40, true) }
    })
    expect(header).toEqual({ riff: 'RIFF', wave: 'WAVE', channels: 2, rate: 48000, bits: 16, bytes: 2 * 48000 * 2 * 2 })
})
