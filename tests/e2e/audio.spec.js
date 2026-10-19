import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

const BAR = 60 / 128 * 4

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
