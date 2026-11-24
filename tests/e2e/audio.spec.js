import { test, expect } from '@playwright/test'
import { boot, settleAt } from './helpers.js'

const BAR = 60 / 128 * 4

const BLOOM = [
    'search synth, filter',
    'noise(speed: 0, octaves: 3, ridges: true, colorMode: rgb)',
    '  .bloom(intensity: audio(band: audioBand.low, min: 0, max: 0.6))',
    '  .write(o0)',
    'render(o0)',
].join('\n')

function readMonitor(page) {
    return page.evaluate(() => {
        const src = document.querySelector('.tl-monitor-canvas')
        const c = document.createElement('canvas')
        c.width = 64
        c.height = 36
        const g = c.getContext('2d')
        g.drawImage(src, 0, 0, 64, 36)
        return [...g.getImageData(0, 0, 64, 36).data]
    })
}

function meanAbsDiff(a, b) {
    let sum = 0
    for (let i = 0; i < a.length; i += 4) {
        sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])
    }
    return sum / (a.length / 4)
}

test('audio() reads each audio track by channel, and the mix without one', async ({ page }) => {
    await boot(page)
    const values = await page.evaluate(({ BAR }) => {
        const tl = window.__timeline
        const seq = tl.store.seq
        const read = t => {
            tl.audio.feed(seq, t)
            const s = tl.audio.state
            const drums = s.getDefaultChannelState(1)
            const synths = s.getDefaultChannelState(2)
            const named = s.getDeviceChannelState({ name: 'Drums', channel: 1 })
            return { mix: s.low, drums: drums.low, synths: synths.mid, named: named.low }
        }
        // Intro: drone and pads, no drums yet. Build: the first kick lands on bar 9.
        return { intro: read(BAR * 2 + 0.01), kick: read(BAR * 8 + 0.03) }
    }, { BAR })
    expect(values.intro.drums).toBe(0)
    expect(values.intro.synths).toBeGreaterThan(0.2)
    expect(values.kick.drums).toBeGreaterThan(0.3)
    expect(values.kick.named).toBe(values.kick.drums)
    expect(values.kick.mix).toBeGreaterThan(0)
})

test('a program that calls audio() renders the music into its output', async ({ page }) => {
    await boot(page)
    await page.locator('.tl-clip', { hasText: 'Infrastructure' }).click({ position: { x: 140, y: 40 }, timeout: 120_000 })
    await page.evaluate(value => {
        const editor = document.querySelector('#inspector code-editor')
        editor.value = value
        editor.dispatchEvent(new CustomEvent('input', { detail: { value } }))
    }, BLOOM)
    await expect(page.locator('.tl-editor-status')).toHaveText('Running', { timeout: 180_000 })
    await page.evaluate(async () => {
        const tl = window.__timeline
        await tl.audio.mix(tl.store.project, tl.store.seq)
    })

    const t = BAR * 8 + 0.5
    await page.evaluate(t => {
        const tl = window.__timeline
        tl.audio.feed(tl.store.seq, t)
        tl.actions.seek(t)
    }, t)
    await settleAt(page, t)
    const withMusic = await readMonitor(page)

    await page.evaluate(t => {
        const tl = window.__timeline
        tl.audio.feed(tl.store.seq, t)
        const s = tl.audio.state
        for (const band of ['low', 'mid', 'high']) {
            s[band] = 0
            s.getDefaultChannelState(1)[band] = 0
            s.getDefaultChannelState(2)[band] = 0
        }
        tl.actions.seek(t + 1 / 30)
    }, t)
    await settleAt(page, t + 1 / 30)
    const silenced = await readMonitor(page)

    expect(meanAbsDiff(withMusic, silenced)).toBeGreaterThan(10)
})

test('analysis is the same however the playhead got there', async ({ page }) => {
    await boot(page)
    const same = await page.evaluate(() => {
        const tl = window.__timeline
        const seq = tl.store.seq
        const at = t => { tl.audio.feed(seq, t); return [tl.audio.state.low, tl.audio.state.mid, tl.audio.state.high].join() }
        const first = at(20.5)
        at(3); at(44); at(20.4)
        return first === at(20.5)
    })
    expect(same).toBe(true)
})

test('muting a track silences the mix but keeps it driving visuals', async ({ page }) => {
    await boot(page)
    const result = await page.evaluate(async ({ BAR }) => {
        const tl = window.__timeline
        tl.store.edit('mute drums', s => { s.audioTracks[0].muted = true })
        const seq = tl.store.seq
        await tl.audio.mix(tl.store.project, seq)
        const mix = tl.audio.currentMix(seq.id)
        const t = BAR * 8 + 0.03
        const from = Math.round(t * 48000)
        const drumsOnly = mix.tracks.get(seq.audioTracks[0].id).getChannelData(0).subarray(from, from + 2400)
        const master = mix.master.getChannelData(0).subarray(from, from + 2400)
        const synths = mix.tracks.get(seq.audioTracks[1].id).getChannelData(0).subarray(from, from + 2400)
        let diff = 0
        for (let i = 0; i < master.length; i++) diff = Math.max(diff, Math.abs(master[i] - synths[i]))
        tl.audio.feed(seq, t)
        return { diff, drumsPeak: Math.max(...drumsOnly.map(Math.abs)), drumsLow: tl.audio.state.getDefaultChannelState(1).low }
    }, { BAR })
    expect(result.diff).toBeLessThan(1e-6)
    expect(result.drumsPeak).toBeGreaterThan(0.1)
    expect(result.drumsLow).toBeGreaterThan(0.3)
})

test('the demo soundtrack decodes from the stems that ship with the app', async ({ page }) => {
    await boot(page)
    const stems = await page.evaluate(async () => {
        const { cachedAudioBuffer } = await import('/js/audio/media.js')
        const media = Object.values(window.__timeline.store.project.media)
        return media.map(m => {
            const b = cachedAudioBuffer(m)
            return { url: m.url, duration: b?.duration, rate: b?.sampleRate, channels: b?.numberOfChannels }
        })
    })
    expect(stems).toEqual([
        { url: 'media/refinery-drums.flac', duration: 60, rate: 48000, channels: 2 },
        { url: 'media/refinery-synths.flac', duration: 60, rate: 48000, channels: 2 },
    ])
})
